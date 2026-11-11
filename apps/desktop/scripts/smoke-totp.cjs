// Headless unit check for the TOTP module against the RFC 6238 SHA-1 test vectors. Runs the COMPILED CommonJS
// output (dist/engine/totp.js), proving the TS→CJS port computes correct codes at runtime (same spirit as
// smoke-parser.cjs). No Electron needed — totp.ts is pure Node crypto.
const assert = require('node:assert/strict');
const path = require('node:path');

const { base32Decode, generateTOTP, secondsRemaining, parseOtpauthOrSecret } = require(
  path.join(__dirname, '..', 'dist', 'engine', 'totp.js'),
);

// RFC 6238 Appendix B, SHA-1 (secret = ASCII "12345678901234567890" = Base32 below). The RFC lists 8-digit
// codes; the 6-digit code is the low 6 digits. We pin `t` to each vector's timestamp.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS = [
  { t: 59, six: '287082' }, // RFC 8-digit 94287082
  { t: 1111111109, six: '081804' }, // 07081804
  { t: 1111111111, six: '050471' }, // 14050471
  { t: 1234567890, six: '005924' }, // 89005924
  { t: 2000000000, six: '279037' }, // 69279037
];

for (const v of VECTORS) {
  const got = generateTOTP(SECRET, { t: v.t * 1000 });
  assert.equal(got, v.six, `TOTP at t=${v.t}s expected ${v.six}, got ${got}`);
}

// Base32 decode: the vector secret decodes to the ASCII seed.
assert.equal(base32Decode(SECRET).toString('utf8'), '12345678901234567890', 'base32 decode roundtrip');

// Spaces / lowercase in a pasted setup key are tolerated.
assert.equal(
  generateTOTP('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', { t: 59000 }),
  '287082',
  'spaced/lowercase key still decodes',
);

// secondsRemaining is within the period and lines up with the counter boundary.
assert.equal(secondsRemaining(30, 59000), 1, 'secondsRemaining at t=59s');
assert.equal(secondsRemaining(30, 60000), 30, 'secondsRemaining at a period boundary');

// otpauth:// URI parsing pulls out just the secret.
assert.equal(
  parseOtpauthOrSecret(`otpauth://totp/BIU:me@biu.ac.il?secret=${SECRET}&issuer=BIU&period=30`),
  SECRET,
  'otpauth URI → secret',
);
assert.equal(parseOtpauthOrSecret('  gezd gnbv  '), 'GEZDGNBV', 'raw key normalised');

console.log('smoke-totp: OK — RFC 6238 vectors, base32 decode, spaced key, countdown, otpauth parsing.');
