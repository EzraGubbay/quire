// The Lemida credential vault: the user's BIU username, password and TOTP setup key, so the sign-in helper can
// autofill them. Stored ONLY in <userData>/lemida-credentials.enc, encrypted with Electron `safeStorage` (which
// derives its key from the macOS Keychain). Never written to .env, never committed, never sent to the Pi, never
// logged. The password and TOTP secret are read only in the main process (getters below); a renderer only ever
// receives the derived 6-digit code, never the secret itself.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { base32Decode, generateTOTP, parseOtpauthOrSecret, secondsRemaining } from './totp';

/** A secret is usable only if it decodes to at least one byte; an all-non-Base32 string would otherwise
 *  silently yield a (meaningless) code, making junk input look valid in the dialog preview. */
function isUsableSecret(secret: string | undefined): secret is string {
  return !!secret && base32Decode(secret).length > 0;
}

interface Vault {
  username?: string;
  password?: string;
  totpSecret?: string;
}

export interface CredStatus {
  /** Whether OS-backed encryption is available at all (false ⇒ we refuse to store anything). */
  available: boolean;
  hasUsername: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
}

export interface CredInput {
  username?: string;
  password?: string;
  /** Raw Base32 setup key or an `otpauth://` URI; normalised on save. */
  totpSecret?: string;
}

export interface TotpCode {
  code: string;
  secondsRemaining: number;
}

function credFile(): string {
  return path.join(app.getPath('userData'), 'lemida-credentials.enc');
}

async function read(): Promise<Vault> {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const enc = await readFile(credFile());
    return JSON.parse(safeStorage.decryptString(enc)) as Vault;
  } catch {
    return {}; // no file yet, or unreadable/undecryptable — treat as empty
  }
}

async function write(v: Vault): Promise<void> {
  const enc = safeStorage.encryptString(JSON.stringify(v));
  await writeFile(credFile(), enc);
}

export async function status(): Promise<CredStatus> {
  const available = safeStorage.isEncryptionAvailable();
  const v = available ? await read() : {};
  return {
    available,
    hasUsername: !!v.username,
    hasPassword: !!v.password,
    hasTotp: !!v.totpSecret,
  };
}

/** Save the given fields. A blank/omitted field keeps the stored value, so the dialog never has to echo a
 *  secret back just to edit one field. Refuses if OS encryption isn't available (no plaintext fallback). */
export async function save(input: CredInput): Promise<{ ok: boolean; reason?: string }> {
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'keychain-unavailable' };
  const cur = await read();
  const next: Vault = {
    username: input.username?.trim() ? input.username.trim() : cur.username,
    password: input.password ? input.password : cur.password,
    totpSecret: input.totpSecret?.trim() ? parseOtpauthOrSecret(input.totpSecret) : cur.totpSecret,
  };
  await write(next);
  return { ok: true };
}

export async function getUsername(): Promise<string | undefined> {
  return (await read()).username;
}

export async function getPassword(): Promise<string | undefined> {
  return (await read()).password;
}

export async function getTotpSecret(): Promise<string | undefined> {
  return (await read()).totpSecret;
}

/** The current code from the *stored* secret (for the helper bar). Null if no secret is set. */
export async function currentCode(): Promise<TotpCode | null> {
  const secret = (await read()).totpSecret;
  if (!isUsableSecret(secret)) return null;
  try {
    return { code: generateTOTP(secret), secondsRemaining: secondsRemaining() };
  } catch {
    return null;
  }
}

/** The current code from a *provided* secret (for the settings dialog's live preview, before saving). */
export function previewCode(secretInput: string): TotpCode | null {
  const secret = parseOtpauthOrSecret(secretInput);
  if (!isUsableSecret(secret)) return null;
  try {
    return { code: generateTOTP(secret), secondsRemaining: secondsRemaining() };
  } catch {
    return null;
  }
}
