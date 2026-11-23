// Push configuration (ADR 0003 §3.3, §5). Reads FCM_SERVICE_ACCOUNT_JSON_BASE64 once per process. The disabled
// reason is a fixed enum and is the only thing ever logged: never `err.message` (a JSON.parse error quotes its
// input, which is key material, and deploy.yml's rollback dumps app logs into the Actions log).
import { createPrivateKey } from 'node:crypto';

export type DisabledReason =
  | 'missing'
  | 'bad_base64'
  | 'bad_json'
  | 'wrong_type'
  | 'missing_field:project_id'
  | 'missing_field:client_email'
  | 'missing_field:private_key'
  | 'bad_private_key';

export type PushConfig =
  | { enabled: true; transport: 'fcm'; projectId: string; clientEmail: string; privateKey: string }
  | { enabled: true; transport: 'fake' }
  | { enabled: false; reason: DisabledReason };

export type FcmConfig = Extract<PushConfig, { transport: 'fcm' }>;

const REQUIRED = ['project_id', 'client_email', 'private_key'] as const;
// Standard or URL-safe alphabet, optional padding. Buffer.from(…, 'base64') never throws, so check first.
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Pure: env → config. Whitespace (a pasted secret's line breaks) is stripped before decoding. */
export function parsePushConfig(env: Record<string, string | undefined>): PushConfig {
  if (env.PUSH_TRANSPORT === 'fake') return { enabled: true, transport: 'fake' };
  const raw = (env.FCM_SERVICE_ACCOUNT_JSON_BASE64 ?? '').replace(/\s+/g, '');
  if (!raw) return { enabled: false, reason: 'missing' };
  if (!BASE64.test(raw)) return { enabled: false, reason: 'bad_base64' };
  const text = Buffer.from(raw, 'base64').toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
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
  // A key pasted through an extra layer of escaping keeps literal "\n" sequences; PEM needs real newlines.
  const privateKey = (sa.private_key as string).replace(/\\n/g, '\n');
  try {
    createPrivateKey(privateKey);
  } catch {
    // Deliberately no binding: the error could describe the key.
    return { enabled: false, reason: 'bad_private_key' };
  }
  return {
    enabled: true,
    transport: 'fcm',
    projectId: sa.project_id as string,
    clientEmail: sa.client_email as string,
    privateKey,
  };
}

const g = globalThis as unknown as { __quirePushConfig?: PushConfig };

/** Memoised config for this process. Logs once: `[push] disabled: <reason>` or the active transport. */
export function pushConfig(env: Record<string, string | undefined> = process.env): PushConfig {
  if (g.__quirePushConfig) return g.__quirePushConfig;
  const c = parsePushConfig(env);
  g.__quirePushConfig = c;
  if (!c.enabled) console.warn(`[push] disabled: ${c.reason}`);
  else console.log(`[push] enabled (${c.transport} transport)`);
  return c;
}

/** Tests only: forget the memoised config. */
export function resetPushConfig() {
  g.__quirePushConfig = undefined;
}
