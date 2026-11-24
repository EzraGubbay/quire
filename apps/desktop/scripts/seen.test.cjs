const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SeenStore } = require(path.join(__dirname, '..', 'dist', 'engine', 'seen.js'));

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seen-')), 'lemida-seen.json');
const KEY = 'https://lemida.biu.ac.il/course/view.php?id=1';

test('bug 2: v1 file is discarded once and logged', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ [KEY]: ['https://lemida.biu.ac.il/mod/resource/view.php?id=103'] }));
  const lines = [];
  const s = new SeenStore(f, (m) => lines.push(m));
  await s.load();
  assert.deepEqual(s.course(KEY), {});
  assert.ok(lines.some((l) => /seen cache v1 discarded \(1 courses, 1 activities\)/.test(l)));
});

test('v2 round trip', async () => {
  const f = tmpFile();
  const s = new SeenStore(f);
  await s.load();
  s.recordFile(KEY, 'act1', 'file1', { sha256: 'abc', etag: 'E1', at: '2026-01-01T00:00:00Z' });
  await s.save();
  const s2 = new SeenStore(f);
  await s2.load();
  assert.deepEqual(s2.course(KEY), s.course(KEY));
});

test('corrupt JSON starts empty without throwing', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not json');
  const s = new SeenStore(f);
  await s.load();
  assert.deepEqual(s.course(KEY), {});
});

test('save leaves no tmp file and writes version 2', async () => {
  const f = tmpFile();
  const s = new SeenStore(f);
  await s.load();
  await s.save();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).version, 2);
  assert.deepEqual(
    fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test('course() is live: mutation + save persists', async () => {
  const f = tmpFile();
  const s = new SeenStore(f);
  await s.load();
  s.course(KEY).act = { files: { u: { sha256: 'x', at: 't' } } };
  await s.save();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).courses[KEY].act.files.u.sha256, 'x');
});
