// Unit tests for src/engine/session-policy.ts (electron-free). Regression for bug 8 (duplicated cookies).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  lemidaHost,
  isPersistable,
  toSetDetails,
  cookiesToRestore,
  duplicateDomainCopies,
  encodeCookieFile,
  decodeCookieFile,
  desktopUserAgent,
} = require(path.join(__dirname, '..', 'dist', 'engine', 'session-policy.js'));

const HOST = 'lemida.biu.ac.il';
const hostOnly = (name, extra = {}) => ({
  name,
  value: 'v',
  domain: HOST,
  hostOnly: true,
  path: '/',
  secure: true,
  ...extra,
});
const domainCk = (name, extra = {}) => ({
  name,
  value: 'v2',
  domain: `.${HOST}`,
  hostOnly: false,
  path: '/',
  secure: true,
  ...extra,
});

test('lemidaHost parses the home URL (stand-ins too)', () => {
  assert.equal(lemidaHost('https://lemida.biu.ac.il/my/'), HOST);
  assert.equal(lemidaHost('http://localhost:4599/my/'), 'localhost');
  assert.equal(lemidaHost('not a url'), '');
});

test('bug 8 regression: a host-only cookie is set WITHOUT domain; a domain cookie keeps it', () => {
  const h = toSetDetails(hostOnly('MoodleSessionprod'));
  assert.equal('domain' in h, false);
  assert.equal(h.url, 'https://lemida.biu.ac.il/');
  const d = toSetDetails(domainCk('x'));
  assert.equal(d.domain, '.lemida.biu.ac.il');
  assert.equal(toSetDetails(hostOnly('a', { secure: false })).url, 'http://lemida.biu.ac.il/');
});

test('toSetDetails: hostOnly undefined + no leading dot is host-only', () => {
  const c = { name: 'n', value: 'v', domain: HOST, path: '/x', secure: true };
  const r = toSetDetails(c);
  assert.equal('domain' in r, false);
  assert.equal(r.url, 'https://lemida.biu.ac.il/x');
  assert.equal('domain' in toSetDetails({ ...c, domain: `.${HOST}` }), true);
});

test('isPersistable: only MoodleSession* on the Lemida host', () => {
  assert.equal(isPersistable(hostOnly('MoodleSessionprod'), HOST), true);
  assert.equal(isPersistable(hostOnly('__uzmc'), HOST), false);
  assert.equal(isPersistable({ ...hostOnly('ESTSAUTH'), domain: 'login.microsoftonline.com' }, HOST), false);
  assert.equal(isPersistable({ ...hostOnly('MoodleSessionprod'), domain: 'other.host' }, HOST), false);
});

test('cookiesToRestore: skips name+path already live, restores missing, never non-persistable', () => {
  const saved = [
    hostOnly('MoodleSessionprod'),
    hostOnly('__uzmc'),
    hostOnly('MoodleSessionother', { path: '/a' }),
  ];
  assert.deepEqual(
    cookiesToRestore(saved, [], HOST).map((c) => c.name),
    ['MoodleSessionprod', 'MoodleSessionother'],
  );
  assert.deepEqual(
    cookiesToRestore(saved, [hostOnly('MoodleSessionprod')], HOST).map((c) => c.name),
    ['MoodleSessionother'],
  );
  assert.deepEqual(
    cookiesToRestore(saved, [hostOnly('MoodleSessionother', { path: '/b' })], HOST).map((c) => c.name),
    ['MoodleSessionprod', 'MoodleSessionother'],
    'same name, different path is not live',
  );
});

test('duplicateDomainCopies: exactly the domain twin of a host-only cookie', () => {
  const live = [hostOnly('__uzmc'), domainCk('__uzmc'), hostOnly('MoodleSessionprod')];
  const d = duplicateDomainCopies(live, HOST);
  assert.equal(d.length, 1);
  assert.equal(d[0].name, '__uzmc');
  assert.equal(d[0].domain, `.${HOST}`);
  // domain cookie without a host-only twin and other hosts are ignored
  assert.deepEqual(duplicateDomainCopies([domainCk('lone')], HOST), []);
  assert.deepEqual(
    duplicateDomainCopies(
      [
        { ...hostOnly('a'), domain: 'other.host' },
        { ...domainCk('a'), domain: '.other.host' },
      ],
      HOST,
    ),
    [],
  );
});

test('encode/decode round-trip, legacy shape accepted, garbage -> []', () => {
  const cookies = [hostOnly('MoodleSessionprod')];
  assert.deepEqual(decodeCookieFile(encodeCookieFile(cookies, '2026-11-24T00:00:00.000Z')), cookies);
  assert.deepEqual(decodeCookieFile(JSON.stringify({ cookies })), cookies);
  assert.deepEqual(decodeCookieFile('not json'), []);
  assert.deepEqual(decodeCookieFile('null'), []);
  assert.deepEqual(decodeCookieFile(JSON.stringify({ cookies: [1, null, { name: 'a' }] })), []);
});

test('desktopUserAgent follows the bundled Chromium major', () => {
  const ua = desktopUserAgent('156.0.7258.5');
  assert.ok(ua.includes('Chrome/156.0.0.0'));
  assert.ok(ua.includes('Macintosh; Intel Mac OS X 10_15_7'));
  assert.ok(!ua.includes('Electron'));
  assert.ok(!ua.includes('131'));
  assert.ok(desktopUserAgent(undefined).includes('Chrome/131.0.0.0'));
});
