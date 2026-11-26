// Env -> Drive-inbox config. Mirrors lib/mobile/push/config.ts: a fixed-enum failure reason, never an error
// message (a message could quote the credential, and deploy.yml's rollback dumps app logs into the Actions log).
import { createPrivateKey } from 'node:crypto';

export type DriveConfig =
  | {
      enabled: true;
      clientEmail: string;
      privateKey: string;
      inboxFolderId: string;
      maxPdfBytes: number;
      maxMdBytes: number;
    }
  | { enabled: false; reason: string };

export type EnabledDriveConfig = Extract<DriveConfig, { enabled: true }>;

const REQUIRED = ['client_email', 'private_key'] as const;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const MB = 1024 * 1024;
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

/** Pure: env -> config. Whitespace (a pasted secret's line breaks) is stripped before decoding. */
export function parseDriveConfig(env: Record<string, string | undefined>): DriveConfig {
  const raw = (env.DRIVE_SERVICE_ACCOUNT_JSON_BASE64 ?? '').replace(/\s+/g, '');
  if (!raw) return { enabled: false, reason: 'missing' };
  if (!BASE64.test(raw)) return { enabled: false, reason: 'bad_base64' };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    // Deliberately no binding: the error message would quote the credential.
    return { enabled: false, reason: 'bad_json' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return { enabled: false, reason: 'bad_json' };
  const sa = json as Record<string, unknown>;
  if (sa.type !== 'service_account') return { enabled: false, reason: 'wrong_type' };
  for (const f of REQUIRED) {
    const v = sa[f];
    if (typeof v !== 'string' || !v.trim()) return { enabled: false, reason: `missing_field:${f}` };
  }
  const privateKey = (sa.private_key as string).replace(/\\n/g, '\n');
  try {
    createPrivateKey(privateKey);
  } catch {
    // Deliberately no binding: the error could describe the key.
    return { enabled: false, reason: 'bad_private_key' };
  }
  const folder = (env.QUIRE_DRIVE_INBOX_FOLDER_ID ?? '').trim();
  if (!folder) return { enabled: false, reason: 'missing_folder' };
  if (!DRIVE_ID_RE.test(folder)) return { enabled: false, reason: 'bad_folder' };
  return {
    enabled: true,
    clientEmail: sa.client_email as string,
    privateKey,
    inboxFolderId: folder,
    maxPdfBytes: num(env.DRIVE_IMPORT_MAX_PDF_BYTES, 80 * MB),
    maxMdBytes: num(env.DRIVE_IMPORT_MAX_MD_BYTES, 2 * MB),
  };
}

const g = globalThis as unknown as { __quireDriveConfig?: DriveConfig };

/** Memoised config for this process. Logs once: `[drive] disabled: <reason>` or `[drive] enabled`. */
export function driveConfig(env: Record<string, string | undefined> = process.env): DriveConfig {
  if (g.__quireDriveConfig) return g.__quireDriveConfig;
  const c = parseDriveConfig(env);
  g.__quireDriveConfig = c;
  if (!c.enabled) console.warn(`[drive] disabled: ${c.reason}`);
  else console.log('[drive] enabled');
  return c;
}

/** Tests only: forget the memoised config. */
export function resetDriveConfig() {
  g.__quireDriveConfig = undefined;
}
