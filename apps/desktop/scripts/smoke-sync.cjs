// Headless check of the sync reconcile step (dist/engine/reconcile.js). Proves the fix: a resource that
// yields no download is NOT marked seen (so it retries next sync), while one that yields a file is. Runs
// against the compiled CommonJS output, like smoke-parser.cjs.
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
  const A = res(1); // downloads a file
  const B = res(2); // yields no download (transient / challenge page)
  const C = res(3); // already seen

  const seen = new Set([C.href]);
  const handled = [];
  const collect = async (r) =>
    r === B ? [] : [{ name: 'f', bytes: new ArrayBuffer(1), contentType: 'x', sourceUrl: 'u' }];
  const onFile = async (_dl, r) => {
    handled.push(r.href);
  };

  const stats = await reconcileResources([A, B, C], { seen, full: false }, { collect, onFile });
  assert.equal(stats.resources, 3, 'counts all resources');
  assert.equal(stats.skipped, 1, 'C already seen → skipped');
  assert.equal(stats.downloaded, 1, 'only A produced a file');
  assert.ok(seen.has(A.href), 'A downloaded → marked seen');
  assert.ok(!seen.has(B.href), 'B produced no file → NOT marked seen, retries next sync');
  assert.ok(seen.has(C.href), 'C stays seen');
  assert.deepEqual(handled, [A.href], 'onFile called once, for A only');

  // full=true ignores the seen set and reprocesses anything that yields a file.
  const seen2 = new Set([A.href, B.href, C.href]);
  const stats2 = await reconcileResources([A, B, C], { seen: seen2, full: true }, { collect, onFile });
  assert.equal(stats2.downloaded, 2, 'full mode re-downloads A and C; B still yields nothing');

  console.log('smoke-sync OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
