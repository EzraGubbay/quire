// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePushConfig, pushConfig, resetPushConfig } from './config';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const SECRET = 'TOPSECRET-KEY-MATERIAL-123';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
/** PEM-shaped but not a key; carries a marker so a leak would show in logs. */
const BAD_KEY = `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`;
const sa = (over: Record<string, unknown> = {}) => ({
  type: 'service_account',
  project_id: 'quire-push-test',
  client_email: 'fcm@quire-push-test.iam.gserviceaccount.com',
  private_key: PEM,
  ...over,
});
const env = (v: string | undefined) => ({ FCM_SERVICE_ACCOUNT_JSON_BASE64: v });

afterEach(() => {
  resetPushConfig();
  vi.restoreAllMocks();
});

describe('parsePushConfig', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', ' \r\n '],
  ])('missing when %s', (_, v) => {
    expect(parsePushConfig(env(v))).toEqual({ enabled: false, reason: 'missing' });
  });

  it('bad_base64 for characters outside the alphabet', () => {
    expect(parsePushConfig(env(`${SECRET}!!*`))).toEqual({ enabled: false, reason: 'bad_base64' });
  });

  it.each([
    ['not JSON', `{"private_key": "${SECRET}"`],
    ['a JSON array', '[1,2]'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
  ])('bad_json for %s', (_, text) => {
    expect(parsePushConfig(env(b64(text)))).toEqual({ enabled: false, reason: 'bad_json' });
  });

  it('wrong_type unless type is service_account', () => {
    expect(parsePushConfig(env(b64(JSON.stringify(sa({ type: 'authorized_user' })))))).toEqual({
      enabled: false,
      reason: 'wrong_type',
    });
    const { type: _t, ...noType } = sa();
    expect(parsePushConfig(env(b64(JSON.stringify(noType))))).toMatchObject({ reason: 'wrong_type' });
  });

  it.each(['project_id', 'client_email', 'private_key'])(
    'missing_field:%s when absent, blank or not a string',
    (f) => {
      for (const v of [undefined, '', '  ', 7]) {
        const json = JSON.stringify(sa({ [f]: v }));
        expect(parsePushConfig(env(b64(json)))).toEqual({ enabled: false, reason: `missing_field:${f}` });
      }
    },
  );

  it('accepts a valid credential, stripping whitespace a pasted secret may carry', () => {
    const value = b64(JSON.stringify(sa()));
    const wrapped = `${value.slice(0, 20)}\r\n${value.slice(20, 40)} \n${value.slice(40)}\n`;
    expect(parsePushConfig(env(wrapped))).toEqual({
      enabled: true,
      transport: 'fcm',
      projectId: 'quire-push-test',
      clientEmail: 'fcm@quire-push-test.iam.gserviceaccount.com',
      privateKey: sa().private_key,
    });
  });

  it('turns literal \\n sequences in the key into newlines', () => {
    const escaped = PEM.replace(/\n/g, '\\n');
    const c = parsePushConfig(env(b64(JSON.stringify(sa({ private_key: escaped })))));
    expect(c).toMatchObject({ enabled: true, privateKey: PEM });
  });

  it('bad_private_key when the key does not parse', () => {
    expect(parsePushConfig(env(b64(JSON.stringify(sa({ private_key: BAD_KEY })))))).toEqual({
      enabled: false,
      reason: 'bad_private_key',
    });
  });

  it('PUSH_TRANSPORT=fake enables the fake transport without a credential', () => {
    expect(parsePushConfig({ PUSH_TRANSPORT: 'fake' })).toEqual({ enabled: true, transport: 'fake' });
  });
});

describe('pushConfig', () => {
  it('is memoised and logs exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = pushConfig(env(undefined));
    const b = pushConfig(env(b64(JSON.stringify(sa()))));
    expect(a).toBe(b);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[push] disabled: missing');
  });

  it('never logs any byte of the input, whatever the failure', () => {
    const calls: unknown[][] = [];
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void calls.push(a));
    const inputs = [
      `${SECRET}!!`,
      b64(`{"private_key":"${SECRET}"`),
      b64(JSON.stringify(sa({ type: SECRET }))),
      b64(JSON.stringify(sa({ project_id: '' }))),
      b64(JSON.stringify(sa({ private_key: BAD_KEY }))),
      b64(JSON.stringify(sa())),
    ];
    for (const v of inputs) {
      resetPushConfig();
      pushConfig(env(v));
    }
    expect(calls.length).toBe(inputs.length);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('quire-push-test');
    for (const v of inputs) expect(logged).not.toContain(v.slice(0, 16));
    expect(logged).toMatch(/\[push\] disabled: bad_base64/);
    expect(logged).toMatch(/\[push\] disabled: bad_json/);
    expect(logged).toMatch(/\[push\] disabled: wrong_type/);
    expect(logged).toMatch(/\[push\] disabled: missing_field:project_id/);
    expect(logged).toMatch(/\[push\] disabled: bad_private_key/);
    expect(logged).not.toContain('PRIVATE KEY');
  });
});
