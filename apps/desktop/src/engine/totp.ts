// RFC 6238 time-based one-time passwords, computed locally so the sign-in helper can offer the current
// 6-digit code without a phone. Pure Node `crypto` (HMAC-SHA1) — no Electron, no third-party dependency —
// so it unit-tests headlessly (see scripts/smoke-totp.cjs). The shared secret is the Base32 "setup key"
// Microsoft shows when you add a software authenticator; it lives in the Keychain-backed vault (credentials.ts),
// never here.
import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode an RFC 4648 Base32 string to bytes. Padding, whitespace and separators (e.g. spaced setup keys) are
 *  ignored; unknown characters are skipped so a copy-pasted key with stray punctuation still decodes. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // skip spaces, hyphens, and any non-Base32 noise
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  /** Wall-clock time in ms (defaults to now); parameterised so tests can pin RFC vectors. */
  t?: number;
  algorithm?: string;
}

/** The current TOTP for a Base32 secret. Defaults match Microsoft/Google Authenticator: 6 digits, 30s, SHA-1. */
export function generateTOTP(secretBase32: string, opts: TotpOptions = {}): string {
  const { digits = 6, period = 30, t = Date.now(), algorithm = 'sha1' } = opts;
  const key = base32Decode(secretBase32);
  // 8-byte big-endian counter = number of periods since the epoch. Built by repeated division rather than bit
  // shifts so it stays correct past 2^32 periods.
  const buf = Buffer.alloc(8);
  let counter = Math.floor(t / 1000 / period);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = createHmac(algorithm, key).update(buf).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks a 4-byte window, whose high bit
  // is masked off. readUInt32BE/readUInt8 keep this in-bounds-checked (no undefined from indexed access).
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Seconds left in the current period — drives the helper's countdown. */
export function secondsRemaining(period = 30, t = Date.now()): number {
  return period - (Math.floor(t / 1000) % period);
}

/** Accept either a raw Base32 setup key or a full `otpauth://totp/...?secret=...` URI and return the
 *  normalised Base32 secret (uppercased, whitespace stripped). The dialog lets the user paste either. */
export function parseOtpauthOrSecret(input: string): string {
  const s = input.trim();
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const secret = new URL(s).searchParams.get('secret');
      if (secret) return secret.replace(/\s+/g, '').toUpperCase();
    } catch {
      // Not a valid URI — fall through and treat the whole thing as a raw key.
    }
  }
  return s.replace(/\s+/g, '').toUpperCase();
}
