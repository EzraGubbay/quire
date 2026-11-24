const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { reconcileResources } = require(path.join(__dirname, '..', 'dist', 'engine', 'reconcile.js'));

const res = (id) => ({
  name: `n${id}`,
  href: `https://lemida.biu.ac.il/mod/resource/view.php?id=${id}`,
  moduleType: 'mod_resource',
  sectionTitle: '',
});
const dl = (n) => ({
  name: n,
  bytes: new ArrayBuffer(1),
  contentType: 'x',
  sourceUrl: 'u',
  fileUrl: `f-${n}`,
  sha256: `h-${n}`,
});
const oneFile = (n) => async () => ({ files: [dl(n)], unchanged: [], failures: [] });

function deps(over = {}) {
  const recorded = [];
  let persisted = 0;
  const d = {
    collect: oneFile('a'),
    upload: async () => ({ ok: true, status: 'imported', duplicate: false }),
    recordFile: (href, fileUrl, rec) => recorded.push({ href, fileUrl, rec }),
    persist: async () => {
      persisted++;
    },
    log: () => {},
    ...over,
  };
  return { d, recorded, persisted: () => persisted };
}
const opts = { records: {}, full: false };

test('bug 5: upload throws -> not recorded, uploadFailed; retried next run', async () => {
  let calls = 0;
  const upload = async () => {
    calls++;
    return { ok: false, error: 'HTTP 500' };
  };
  const h = deps({ upload });
  const s = await reconcileResources([res(1)], opts, h.d);
  assert.equal(s.uploadFailed, 1);
  assert.equal(h.recorded.length, 0);
  await reconcileResources([res(1)], opts, h.d);
  assert.equal(calls, 2);
});

test('bug 5: server status error -> not recorded', async () => {
  const h = deps({ upload: async () => ({ ok: false, error: 'server import error' }) });
  const s = await reconcileResources([res(1)], opts, h.d);
  assert.equal(h.recorded.length, 0);
  assert.equal(s.uploadFailed, 1);
});

test('duplicate:true is recorded and counted alreadyHad, not imported', async () => {
  const h = deps({ upload: async () => ({ ok: true, status: 'imported', duplicate: true }) });
  const s = await reconcileResources([res(1)], opts, h.d);
  assert.equal(h.recorded.length, 1);
  assert.deepEqual([s.alreadyHad, s.imported], [1, 0]);
});

test('needs_review is recorded and counted as review', async () => {
  const h = deps({ upload: async () => ({ ok: true, status: 'needs_review', duplicate: false }) });
  const s = await reconcileResources([res(1)], opts, h.d);
  assert.equal(h.recorded.length, 1);
  assert.equal(s.review, 1);
});

test('bug 7: progress persisted before a later collect throws', async () => {
  const h = deps({
    collect: async (r) => {
      if (r.href.endsWith('=3')) throw new Error('boom');
      return { files: [dl(r.href.slice(-1))], unchanged: [], failures: [] };
    },
  });
  await assert.rejects(reconcileResources([res(1), res(2), res(3)], opts, h.d), /boom/);
  assert.equal(h.persisted(), 2);
  assert.deepEqual(
    h.recorded.map((r) => r.href.slice(-1)),
    ['1', '2'],
  );
});

test('collect failures counted as downloadFailed', async () => {
  const h = deps({
    collect: async () => ({
      files: [],
      unchanged: [],
      failures: [{ url: 'u', outcome: 'non_2xx', status: 403, detail: 'HTTP 403' }],
    }),
  });
  const s = await reconcileResources([res(1)], opts, h.d);
  assert.equal(s.downloadFailed, 1);
  assert.equal(s.failures.length, 1);
});

test('unchanged files are recorded (re-keyed), counted, and never uploaded', async () => {
  let uploads = 0;
  const h = deps({
    collect: async () => ({
      files: [],
      unchanged: [{ fileUrl: 'new-url', etag: 'E', sha256: 'h' }],
      failures: [],
    }),
    upload: async () => {
      uploads++;
      return { ok: true, status: 'imported', duplicate: false };
    },
  });
  const s = await reconcileResources([res(1)], opts, h.d);
  assert.equal(uploads, 0);
  assert.equal(s.unchanged, 1);
  assert.equal(h.recorded[0].fileUrl, 'new-url');
});
