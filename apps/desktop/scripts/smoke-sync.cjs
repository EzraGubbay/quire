// Headless check of the sync reconcile step (dist/engine/reconcile.js). Proves: an activity whose file the
// server did not accept is NOT recorded (so it retries next sync), while an accepted one is. Runs against
// the compiled CommonJS output, like smoke-parser.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');

const { reconcileResources } = require(path.join(__dirname, '..', 'dist', 'engine', 'reconcile.js'));

const res = (id) => ({
  name: `n${id}`,
  href: `https://lemida.biu.ac.il/mod/resource/view.php?id=${id}`,
  moduleType: 'mod_resource',
  sectionTitle: '',
});

(async () => {
  const A = res(1); // accepted
  const B = res(2); // upload rejected

  const recorded = new Set();
  const collect = async (r) => ({
    files: [{ name: 'f', bytes: new ArrayBuffer(1), contentType: 'x', sourceUrl: 'u', fileUrl: r.href, sha256: 'h' }],
    unchanged: [],
    failures: [],
  });
  const upload = async (_dl, r) => (r === B ? { ok: false, error: 'boom' } : { ok: true, status: 'imported', duplicate: false });
  const deps = {
    collect,
    upload,
    recordFile: (href) => recorded.add(href),
    persist: async () => {},
    log: () => {},
  };

  const stats = await reconcileResources([A, B], { records: {}, full: false }, deps);
  assert.equal(stats.activities, 2);
  assert.equal(stats.imported, 1);
  assert.equal(stats.uploadFailed, 1);
  assert.ok(recorded.has(A.href), 'A accepted -> recorded');
  assert.ok(!recorded.has(B.href), 'B rejected -> NOT recorded, retries next sync');

  // full=true re-processes everything the collector hands back.
  const stats2 = await reconcileResources([A, B], { records: {}, full: true }, deps);
  assert.equal(stats2.downloaded, 2, 'full mode re-processes both');

  console.log('smoke-sync OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
