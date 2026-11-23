// In-memory twin of dbRegistrations + dbOutbox for tests (like the AuthStore in auth.test.ts). It mirrors the SQL
// semantics, including the FK cascade (deleting a registration deletes its outbox rows) and revoke cleanup.
import { randomUUID } from 'node:crypto';
import type { Principal } from '../auth';
import { COALESCE_CAP_MS, COALESCE_DELAY_MS, type DueRow, type OutboxRow, type OutboxStore } from './outbox';
import type { RegistrationRow, RegistrationStore } from './registrations';

interface Device {
  id: string;
  ownerLogin: string;
  bearer: string;
  revokedAt: Date | null;
}

export function memoryPushStore() {
  const devices: Device[] = [];
  let regs: RegistrationRow[] = [];
  let rows: OutboxRow[] = [];

  const isPending = (r: OutboxRow) => !r.sentAt && !r.deadAt;
  const activeReg = (registrationId: string) => {
    const reg = regs.find((r) => r.id === registrationId);
    const dev = reg && devices.find((d) => d.id === reg.tokenId);
    return reg && dev && !dev.revokedAt ? reg : null;
  };
  const withToken = (r: OutboxRow): DueRow[] => {
    const reg = activeReg(r.registrationId);
    return reg ? [{ ...r, fcmToken: reg.fcmToken }] : [];
  };
  const deleteReg = (pred: (r: RegistrationRow) => boolean) => {
    const gone = new Set(regs.filter(pred).map((r) => r.id));
    regs = regs.filter((r) => !gone.has(r.id));
    rows = rows.filter((r) => !gone.has(r.registrationId)); // ON DELETE CASCADE
  };
  const sameInput = (r: RegistrationRow, i: Parameters<RegistrationStore['upsert']>[1]) =>
    r.fcmToken === i.fcmToken &&
    r.platform === i.platform &&
    r.appVersion === i.appVersion &&
    r.categories.join(',') === i.categories.join(',');

  const registrations: RegistrationStore = {
    async upsert(tokenId, input, now) {
      deleteReg((r) => r.fcmToken === input.fcmToken && r.tokenId !== tokenId);
      const existing = regs.find((r) => r.tokenId === tokenId);
      if (existing) {
        if (!sameInput(existing, input)) {
          if (existing.fcmToken !== input.fcmToken) existing.lastError = null;
          Object.assign(existing, input, { categories: [...input.categories], updatedAt: now });
        }
        return { ...existing };
      }
      const row: RegistrationRow = {
        id: randomUUID(),
        tokenId,
        ...input,
        categories: [...input.categories],
        createdAt: now,
        updatedAt: now,
        lastSentAt: null,
        lastError: null,
      };
      regs.push(row);
      return { ...row };
    },
    async getByTokenId(tokenId) {
      const r = regs.find((x) => x.tokenId === tokenId);
      return r ? { ...r } : null;
    },
    async deleteByTokenId(tokenId) {
      deleteReg((r) => r.tokenId === tokenId);
    },
  };

  const unbatched = (registrationId: string, groupKey: string) =>
    rows.filter(
      (r) => r.registrationId === registrationId && r.groupKey === groupKey && !r.batchId && isPending(r),
    );
  const byBatch = (batchId: string) => rows.filter((r) => r.batchId === batchId && isPending(r));

  const outbox: OutboxStore = {
    async targets(owners, category) {
      return regs
        .filter((r) => {
          const dev = devices.find((d) => d.id === r.tokenId);
          return dev && !dev.revokedAt && owners.includes(dev.ownerLogin) && r.categories.includes(category);
        })
        .map((r) => r.id);
    },
    async insert(row, now) {
      if (!regs.some((r) => r.id === row.registrationId)) throw new Error('foreign key violation');
      if (rows.some((r) => r.registrationId === row.registrationId && r.dedupeKey === row.dedupeKey))
        return false;
      let notBefore = row.notBefore ?? now;
      if (row.groupKey && !row.batchId) {
        // Mirrors the SQL: cap at the group's oldest unbatched pending row (or now) + 10 min.
        const oldest = Math.min(
          now.getTime(),
          ...unbatched(row.registrationId, row.groupKey).map((r) => r.createdAt.getTime()),
        );
        notBefore = new Date(Math.min(notBefore.getTime(), oldest + COALESCE_CAP_MS));
      }
      rows.push({
        id: randomUUID(),
        batchId: null,
        attempts: 0,
        sentAt: null,
        deadAt: null,
        lastError: null,
        ...row,
        notBefore,
        createdAt: now,
      });
      return true;
    },
    async slideGroup(registrationId, groupKey, now) {
      const group = unbatched(registrationId, groupKey);
      if (group.length === 0) return;
      const oldest = Math.min(...group.map((r) => r.createdAt.getTime()));
      const target = Math.min(now.getTime() + COALESCE_DELAY_MS, oldest + COALESCE_CAP_MS);
      for (const r of group) r.notBefore = new Date(Math.max(r.notBefore.getTime(), target));
    },
    async due(now, limit) {
      return rows
        .filter((r) => isPending(r) && r.notBefore <= now)
        .sort(
          (a, b) =>
            a.notBefore.getTime() - b.notBefore.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .flatMap(withToken)
        .slice(0, limit);
    },
    async hasPendingBatch(registrationId, groupKey) {
      return rows.some(
        (r) => r.registrationId === registrationId && r.groupKey === groupKey && r.batchId && isPending(r),
      );
    },
    async stampBatch(ids, batchId) {
      const hit = rows.filter((r) => ids.includes(r.id) && !r.batchId && isPending(r));
      for (const r of hit) r.batchId = batchId;
      return hit.map((r) => r.id);
    },
    async batchRows(batchId) {
      return byBatch(batchId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .flatMap(withToken);
    },
    async markSent(batchId, now) {
      for (const r of byBatch(batchId)) r.sentAt = now;
    },
    async markBatchDead(batchId, now, code) {
      for (const r of byBatch(batchId)) Object.assign(r, { deadAt: now, lastError: code });
    },
    async markRowsDead(ids, now, code) {
      for (const r of rows.filter((x) => ids.includes(x.id) && isPending(x)))
        Object.assign(r, { deadAt: now, lastError: code });
    },
    async retryBatch(batchId, attempts, notBefore) {
      for (const r of byBatch(batchId)) Object.assign(r, { attempts, notBefore });
    },
    async purge(before) {
      const n = rows.length;
      rows = rows.filter(
        (r) =>
          !(
            (r.sentAt && r.sentAt < before) ||
            (r.deadAt && r.deadAt < before) ||
            (isPending(r) && r.expiresAt < before)
          ),
      );
      return n - rows.length;
    },
    async deleteRegistration(registrationId) {
      deleteReg((r) => r.id === registrationId);
    },
    async registrationSent(registrationId, now) {
      const r = regs.find((x) => x.id === registrationId);
      if (r) r.lastSentAt = now;
    },
    async registrationError(registrationId, code) {
      const r = regs.find((x) => x.id === registrationId);
      if (r) r.lastError = code;
    },
  };

  return {
    registrations,
    outbox,
    /** Live views for assertions. */
    get regs() {
      return regs;
    },
    get rows() {
      return rows;
    },
    /** Pair a device; returns its token id and raw bearer. */
    addDevice(ownerLogin = 'local') {
      const d: Device = { id: randomUUID(), ownerLogin, bearer: randomUUID(), revokedAt: null };
      devices.push(d);
      return d;
    },
    /** Mirrors `dbStore.revoke`: soft-revoke the token and delete its registration (rows cascade). */
    revoke(tokenId: string, now = new Date()) {
      const d = devices.find((x) => x.id === tokenId);
      if (d && !d.revokedAt) d.revokedAt = now;
      deleteReg((r) => r.tokenId === tokenId);
    },
    /** An `authenticate` stand-in resolving `Bearer <bearer>` for non-revoked devices. */
    async auth(req: Request): Promise<Principal | null> {
      const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '');
      const d = m && devices.find((x) => x.bearer === m[1] && !x.revokedAt);
      return d ? { login: d.ownerLogin, tokenId: d.id, deviceName: 'test', createdAt: new Date(0) } : null;
    },
  };
}
