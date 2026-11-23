// Handlers for /api/mobile/v1/push/* (ADR 0003 §3.1). The route files are thin wrappers; every dependency is
// injected so tests run the real handlers against in-memory stores and the fake transport.
import { authenticate, type Principal } from '../auth';
import { requireDevice } from '../device-auth';
import { FailureLimiter } from '../rate-limit';
import { fail, ok } from '../respond';
import {
  type PushRegistration,
  PushRegistrationRequest,
  type PushRegistrationState,
  type TestPushResult,
} from '../schema';
import { type PushConfig, pushConfig } from './config';
import { sendTestPush } from './dispatcher';
import { dbOutbox, errTag, type OutboxStore } from './outbox';
import {
  dbRegistrations,
  normalizeCategories,
  type RegistrationRow,
  type RegistrationStore,
} from './registrations';
import { currentTransport } from './runtime';
import type { PushTransport } from './transport';

export const TEST_PUSH_WINDOW_MS = 30_000;

export interface PushApiDeps {
  auth: (req: Request) => Promise<Principal | null>;
  registrations: RegistrationStore;
  outbox: OutboxStore;
  config: () => PushConfig;
  transport: () => PushTransport | null;
  /** 1 test push per 30 s per device. */
  testLimiter: FailureLimiter;
  now: () => Date;
}

export function toRegistrationView(r: RegistrationRow): PushRegistration {
  return {
    deviceId: r.tokenId,
    platform: 'android',
    appVersion: r.appVersion,
    categories: normalizeCategories(r.categories),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Field paths only: zod messages for an oversized token would otherwise describe the secret. */
const describeIssues = (issues: ReadonlyArray<{ path: PropertyKey[] }>) =>
  [...new Set(issues.map((i) => i.path.map(String).join('.') || 'body'))]
    .map((p) => `${p}: invalid`)
    .join('; ');

type Handler = (req: Request) => Promise<Response>;

/**
 * An unexpected error answers 500 `internal` and is logged by class/SQLSTATE only. Left to Next, it would be logged
 * whole, and a Postgres unique-violation `detail` can quote the FCM token.
 */
const guarded =
  (name: string, fn: Handler): Handler =>
  async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      console.error(`[push] ${name} failed (${errTag(e)})`);
      return fail('internal', 'Internal server error');
    }
  };

export function pushHandlers(deps: () => PushApiDeps) {
  const h = rawHandlers(deps);
  return {
    putRegistration: guarded('PUT /push/registration', h.putRegistration),
    getRegistration: guarded('GET /push/registration', h.getRegistration),
    deleteRegistration: guarded('DELETE /push/registration', h.deleteRegistration),
    sendTest: guarded('POST /push/test', h.sendTest),
  };
}

function rawHandlers(deps: () => PushApiDeps) {
  return {
    async putRegistration(req: Request): Promise<Response> {
      const d = deps();
      const a = await requireDevice(req, d.auth);
      if ('response' in a) return a.response;
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return fail('invalid_request', 'Body must be JSON');
      }
      const parsed = PushRegistrationRequest.safeParse(body);
      if (!parsed.success) return fail('invalid_request', describeIssues(parsed.error.issues));
      const { fcmToken, platform, appVersion, categories } = parsed.data;
      const row = await d.registrations.upsert(
        a.principal.tokenId,
        { fcmToken, platform, appVersion: appVersion ?? null, categories: normalizeCategories(categories) },
        d.now(),
      );
      return ok({ registration: toRegistrationView(row), pushEnabled: d.config().enabled });
    },

    async getRegistration(req: Request): Promise<Response> {
      const d = deps();
      const a = await requireDevice(req, d.auth);
      if ('response' in a) return a.response;
      const row = await d.registrations.getByTokenId(a.principal.tokenId);
      const state: PushRegistrationState = {
        registration: row ? toRegistrationView(row) : null,
        pushEnabled: d.config().enabled,
      };
      return ok(state);
    },

    async deleteRegistration(req: Request): Promise<Response> {
      const d = deps();
      const a = await requireDevice(req, d.auth);
      if ('response' in a) return a.response;
      await d.registrations.deleteByTokenId(a.principal.tokenId);
      return new Response(null, { status: 204 });
    },

    async sendTest(req: Request): Promise<Response> {
      const d = deps();
      const a = await requireDevice(req, d.auth);
      if ('response' in a) return a.response;
      const transport = d.config().enabled ? d.transport() : null;
      if (!transport) return fail('push_unavailable', 'Push notifications are not set up on this server');
      const reg = await d.registrations.getByTokenId(a.principal.tokenId);
      if (!reg) return fail('invalid_request', 'This device has no push registration');
      const now = d.now();
      const key = a.principal.tokenId;
      if (d.testLimiter.blocked(key, now.getTime()))
        return fail('rate_limited', 'One test notification per 30 seconds');
      d.testLimiter.fail(key, now.getTime());
      const result: TestPushResult = await sendTestPush(reg, { store: d.outbox, transport, now });
      return ok(result);
    },
  };
}

const testLimiter = new FailureLimiter(1, TEST_PUSH_WINDOW_MS);

/** Production wiring (lazy: nothing touches the DB or env at import). */
export const pushRoutes = pushHandlers(() => ({
  auth: (req) => authenticate(req),
  registrations: dbRegistrations,
  outbox: dbOutbox,
  config: () => pushConfig(),
  transport: () => currentTransport(),
  testLimiter,
  now: () => new Date(),
}));
