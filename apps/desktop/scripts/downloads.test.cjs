const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { collectActivity } = require(path.join(__dirname, '..', 'dist', 'engine', 'downloads.js'));
const { SessionExpired } = require(path.join(__dirname, '..', 'dist', 'engine', 'errors.js'));

const BASE = 'https://lemida.biu.ac.il';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const res = (type, id = 1) => ({
  name: 'n',
  href: `${BASE}/mod/${type.replace('mod_', '')}/view.php?id=${id}`,
  moduleType: type,
  sectionTitle: 'S',
});

function resp(requestedUrl, o = {}) {
  const hops = o.hops ?? [];
  return {
    requestedUrl,
    hops,
    finalUrl: hops.length ? hops[hops.length - 1] : requestedUrl,
    status: o.status ?? 200,
    headers: o.headers ?? {},
    body: o.body === undefined ? Buffer.from('') : o.body,
  };
}
const file = (url, bytes, o = {}) =>
  resp(url, {
    headers: { 'content-type': 'application/pdf', ...(o.etag ? { etag: o.etag } : {}) },
    body: Buffer.from(bytes),
    ...o,
  });
const page = (url, body, o = {}) =>
  resp(url, { headers: { 'content-type': 'text/html' }, body: Buffer.from(body), ...o });

function harness(routes, extra = {}) {
  const calls = [];
  const lines = [];
  const get = async (url, opts) => {
    calls.push({ url, ifNoneMatch: opts.ifNoneMatch });
    const r = routes[url];
    if (!r) throw new Error(`unexpected request ${url}`);
    return typeof r === 'function' ? r(opts) : r;
  };
  return { calls, lines, ctx: { get, records: undefined, full: false, log: (l) => lines.push(l), ...extra } };
}

const folderPage = (links) =>
  `<html><body id="page-mod-folder-view">${links.map((l) => `<a href="${l}">f</a>`).join('')}</body></html>`;

test('1. resource returning a file directly', async () => {
  const r = res('mod_resource');
  const final = `${BASE}/pluginfile.php/1/mod_resource/content/8/t1.pdf`;
  const h = harness({ [r.href]: file(r.href, '%PDF-1', { hops: [final] }) });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].sourceUrl, final);
  assert.equal(out.files[0].sha256, sha('%PDF-1'));
});

test('2. resource embed page -> second request', async () => {
  const r = res('mod_resource');
  const link = `${BASE}/pluginfile.php/1/mod_resource/content/8/t1.pdf`;
  const h = harness({
    [r.href]: page(r.href, `<html><a href="${link}">dl</a></html>`),
    [link]: file(link, '%PDF-2'),
  });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 1);
  assert.equal(h.calls.length, 2);
  assert.ok(h.lines[0].includes('outcome=resource_page'), h.lines[0]);
});

test('3. bug 1: resource HTML without a link is a failure, not silence', async () => {
  const r = res('mod_resource');
  const h = harness({ [r.href]: page(r.href, '<html><body>oops</body></html>') });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 0);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].outcome, 'html_no_link');
});

test('4. bug 1: file link answering 403 is a non_2xx failure', async () => {
  const r = res('mod_folder');
  const link = `${BASE}/pluginfile.php/1/mod_folder/content/3/a.pdf`;
  const h = harness({
    [r.href]: page(r.href, folderPage([link])),
    [link]: resp(link, { status: 403 }),
  });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 0);
  assert.equal(out.failures[0].outcome, 'non_2xx');
  assert.equal(out.failures[0].status, 403);
});

test('5. bug 1: redirect to login (hop only) throws SessionExpired', async () => {
  const r = res('mod_folder');
  const link = `${BASE}/pluginfile.php/1/mod_folder/content/3/a.pdf`;
  const h = harness({
    [r.href]: page(r.href, folderPage([link])),
    [link]: page(link, '<html>x</html>', { hops: [`${BASE}/login/index.php`] }),
  });
  await assert.rejects(collectActivity(r, h.ctx), (e) => e instanceof SessionExpired);
});

test('6. relative links resolve against the requested URL when there are no hops', async () => {
  const r = res('mod_folder');
  const rel = '/pluginfile.php/1/mod_folder/content/3/a.pdf';
  const abs = `${BASE}${rel}`;
  const h = harness({ [r.href]: page(r.href, folderPage([rel])), [abs]: file(abs, 'A') });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 1);
  assert.equal(out.failures.length, 0);
});

test('7. assignment without attachments: no files, no failures', async () => {
  const r = res('mod_assign');
  const h = harness({ [r.href]: page(r.href, '<html><body id="page-mod-assign-view"></body></html>') });
  const out = await collectActivity(r, h.ctx);
  assert.deepEqual([out.files.length, out.failures.length], [0, 0]);
});

test('8. folder answered by an interstitial is html_no_link', async () => {
  const r = res('mod_folder');
  const h = harness({ [r.href]: page(r.href, '<html><body>please wait</body></html>') });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.failures[0].outcome, 'html_no_link');
});

test('9. bug 6: new file in an existing folder; a and b are 304', async () => {
  const r = res('mod_folder');
  const L = (n) => `${BASE}/pluginfile.php/1/mod_folder/content/3/${n}.pdf`;
  const records = {
    files: {
      [L('a')]: { sha256: sha('A'), etag: '"ea"', at: '2026-01-01' },
      [L('b')]: { sha256: sha('B'), etag: '"eb"', at: '2026-01-01' },
    },
  };
  const h = harness(
    {
      [r.href]: page(r.href, folderPage([L('a'), L('b'), L('c')])),
      [L('a')]: resp(L('a'), { status: 304 }),
      [L('b')]: resp(L('b'), { status: 304 }),
      [L('c')]: file(L('c'), 'C'),
    },
    { records },
  );
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].fileUrl, L('c'));
  assert.equal(out.unchanged.length, 2);
  const byUrl = Object.fromEntries(h.calls.map((c) => [c.url, c.ifNoneMatch]));
  assert.equal(byUrl[L('a')], '"ea"');
  assert.equal(byUrl[L('b')], '"eb"');
  assert.equal(byUrl[L('c')], undefined);
});

test('10. bug 6: in-place replace of a mod_resource (etag E1 -> E2)', async () => {
  const r = res('mod_resource');
  const records = { files: { [r.href]: { sha256: sha('old'), etag: 'E1', at: '2026-01-01' } } };
  const final = `${BASE}/pluginfile.php/1/mod_resource/content/9/t1.pdf`;
  const h = harness({ [r.href]: file(r.href, 'new', { hops: [final], etag: 'E2' }) }, { records });
  const out = await collectActivity(r, h.ctx);
  assert.equal(h.calls[0].ifNoneMatch, 'E1');
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].etag, 'E2');
});

test('11. hash short-circuit re-keys a revision-bumped URL', async () => {
  const r = res('mod_folder');
  const oldL = `${BASE}/pluginfile.php/1/mod_folder/content/3/a.pdf`;
  const newL = `${BASE}/pluginfile.php/1/mod_folder/content/4/a.pdf`;
  const records = { files: { [oldL]: { sha256: sha('A'), at: '2026-01-01' } } };
  const h = harness({ [r.href]: page(r.href, folderPage([newL])), [newL]: file(newL, 'A') }, { records });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 0);
  assert.equal(out.unchanged[0].fileUrl, newL);
});

test('12. full: no If-None-Match, everything re-downloaded', async () => {
  const r = res('mod_folder');
  const L = `${BASE}/pluginfile.php/1/mod_folder/content/3/a.pdf`;
  const records = { files: { [L]: { sha256: sha('A'), etag: '"ea"', at: '2026-01-01' } } };
  const h = harness({ [r.href]: page(r.href, folderPage([L])), [L]: file(L, 'A') }, { records, full: true });
  const out = await collectActivity(r, h.ctx);
  assert.equal(out.files.length, 1);
  assert.ok(h.calls.every((c) => c.ifNoneMatch === undefined));
});

test('13. exactly one req log line per request', async () => {
  const r = res('mod_folder');
  const L = `${BASE}/pluginfile.php/1/mod_folder/content/3/a.pdf`;
  const h = harness({ [r.href]: page(r.href, folderPage([L])), [L]: file(L, 'A') });
  await collectActivity(r, h.ctx);
  assert.equal(h.lines.length, h.calls.length);
  assert.ok(h.lines.every((l) => l.startsWith('req ')));
});
