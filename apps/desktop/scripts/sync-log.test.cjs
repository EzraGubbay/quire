const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncLog } = require(path.join(__dirname, '..', 'dist', 'engine', 'sync-log.js'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synclog-'));

test('line() creates the log with an ISO timestamp prefix', () => {
  const dir = path.join(tmp(), 'logs');
  new SyncLog(dir, { mirror: false }).line('x');
  const text = fs.readFileSync(path.join(dir, 'lemida-sync.log'), 'utf8');
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z x\n$/);
});

test('rotates at maxBytes keeping 3 files', () => {
  const dir = tmp();
  const log = new SyncLog(dir, { maxBytes: 200, mirror: false });
  for (let i = 0; i < 50; i++) log.line(`line number ${i} padding padding`);
  const f = (n) => path.join(dir, `lemida-sync.log${n}`);
  assert.ok(fs.existsSync(f('')));
  assert.ok(fs.existsSync(f('.1')));
  assert.ok(fs.existsSync(f('.2')));
  assert.ok(!fs.existsSync(f('.3')));
  for (const n of ['', '.1', '.2']) assert.ok(fs.statSync(f(n)).size <= 200 + 100);
});

test('an unwritable directory does not throw', () => {
  const base = tmp();
  const file = path.join(base, 'afile');
  fs.writeFileSync(file, 'x');
  assert.doesNotThrow(() => new SyncLog(path.join(file, 'sub'), { mirror: false }).line('x'));
});
