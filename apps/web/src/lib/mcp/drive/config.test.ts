import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveConfig, parseDriveConfig, resetDriveConfig } from './config';

const INBOX = '1PrV6lIDdZVi5xw_il9mxg3qfFr3pdteH';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const sa = (over: Record<string, unknown> = {}) => ({
  type: 'service_account',
  client_email: 'x@y.iam.gserviceaccount.com',
  private_key: pem,
  ...over,
});
const env = (cred: string | undefined, folder: string | null = INBOX) => ({
  DRIVE_SERVICE_ACCOUNT_JSON_BASE64: cred,
  QUIRE_DRIVE_INBOX_FOLDER_ID: folder ?? undefined,
});
const reason = (c: ReturnType<typeof parseDriveConfig>) => (c.enabled ? 'ok' : c.reason);

afterEach(() => {
  resetDriveConfig();
  vi.restoreAllMocks();
});

describe('parseDriveConfig', () => {
  it('reports each failure as a fixed reason', () => {
    expect(reason(parseDriveConfig(env(undefined)))).toBe('missing');
    expect(reason(parseDriveConfig(env('not base64!!')))).toBe('bad_base64');
    expect(reason(parseDriveConfig(env(Buffer.from('nope').toString('base64'))))).toBe('bad_json');
    expect(reason(parseDriveConfig(env(b64(sa({ type: 'authorized_user' })))))).toBe('wrong_type');
    expect(reason(parseDriveConfig(env(b64(sa({ client_email: undefined })))))).toBe(
      'missing_field:client_email',
    );
    expect(reason(parseDriveConfig(env(b64(sa({ private_key: undefined })))))).toBe(
      'missing_field:private_key',
    );
    expect(reason(parseDriveConfig(env(b64(sa({ private_key: 'garbage' })))))).toBe('bad_private_key');
  });

  it('checks the folder id', () => {
    expect(reason(parseDriveConfig(env(b64(sa()), null)))).toBe('missing_folder');
    expect(reason(parseDriveConfig(env(b64(sa()), '../x')))).toBe('bad_folder');
    expect(reason(parseDriveConfig(env(b64(sa()), 'abc')))).toBe('bad_folder');
    expect(parseDriveConfig(env(b64(sa()))).enabled).toBe(true);
  });

  it('accepts literal \\n in the key, and whitespace in the base64', () => {
    const escaped = pem.replace(/\n/g, '\\n');
    const c = parseDriveConfig(env(b64(sa({ private_key: escaped }))));
    expect(c.enabled && c.privateKey).toBe(pem);
    const wrapped = `${b64(sa()).replace(/(.{60})/g, '$1\n')}\n`;
    expect(parseDriveConfig(env(wrapped)).enabled).toBe(true);
  });

  it('defaults the caps to 80 MB / 2 MB and reads them from env', () => {
    const c = parseDriveConfig(env(b64(sa())));
    expect(c.enabled && [c.maxPdfBytes, c.maxMdBytes]).toEqual([80 * 1024 * 1024, 2 * 1024 * 1024]);
    const d = parseDriveConfig({
      ...env(b64(sa())),
      DRIVE_IMPORT_MAX_PDF_BYTES: '1000',
      DRIVE_IMPORT_MAX_MD_BYTES: '50',
    });
    expect(d.enabled && [d.maxPdfBytes, d.maxMdBytes]).toEqual([1000, 50]);
  });

  it('never leaks key material in a reason or a log line', () => {
    const sentinel = 'SENTINEL-KEY-MATERIAL';
    const spies = (['log', 'warn', 'error', 'info'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    const bad = { private_key: `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----` };
    const c = parseDriveConfig(env(b64(sa(bad))));
    expect(JSON.stringify(c)).not.toContain(sentinel);
    driveConfig(env(b64(sa(bad))));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(sentinel);
    expect(spies[1]).toHaveBeenCalledWith('[drive] disabled: bad_private_key');
  });
});
