const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = (m) => require(path.join(__dirname, '..', 'dist', 'engine', `${m}.js`));
const { runSync, summariseSync, classifyImport, safeUpload } = dist('sync-run');
const { NotEnrolled, SessionExpired } = dist('errors');
const { emptyStats } = dist('reconcile');

const course = (label) => ({ slug: label.toLowerCase(), label });
const stats = (o = {}) => ({ ...emptyStats(), ...o });
const report = (totals = {}, courses = [], extra = {}) => ({
  full: false,
  courses,
  totals: stats(totals),
  ...extra,
});

function run(courses, behaviour, full = false) {
  const called = [];
  const syncCourse = async (c, opts) => {
    called.push({ label: c.label, full: opts.full });
    return behaviour[c.label](c);
  };
  return runSync(courses, { syncCourse, log: () => {}, full }).then((r) => ({ r, called }));
}

test('bug 7: NotEnrolled does not stop other courses or expire the session', async () => {
  const { r, called } = await run([course('A'), course('B')], {
    A: () => {
      throw new NotEnrolled('https://x/enrol/index.php?id=1');
    },
    B: () => stats({ activities: 3 }),
  });
  assert.equal(r.courses[0].reason, 'not enrolled');
  assert.equal(r.courses[1].ok, true);
  assert.equal(r.sessionExpired, undefined);
  assert.deepEqual(called.map((c) => c.label), ['A', 'B']);
});

test('generic error: later courses still run', async () => {
  const { r, called } = await run([course('A'), course('B'), course('C')], {
    A: () => {
      throw new Error('boom');
    },
    B: () => stats(),
    C: () => stats(),
  });
  assert.equal(r.courses[0].reason, 'boom');
  assert.equal(called.length, 3);
});

test('SessionExpired stops the sync, keeps earlier stats, skips the rest', async () => {
  const { r, called } = await run([course('A'), course('B'), course('C')], {
    A: () => stats({ activities: 5, imported: 1, downloaded: 1 }),
    B: () => {
      throw new SessionExpired('https://x/login/');
    },
    C: () => stats(),
  });
  assert.deepEqual(called.map((c) => c.label), ['A', 'B']);
  assert.equal(r.courses[2].reason, 'skipped (signed out)');
  assert.equal(r.courses[0].stats.imported, 1);
  assert.equal(r.totals.imported, 1);
  assert.ok(r.sessionExpired);
});

test('full is passed to every syncCourse call', async () => {
  const { called } = await run([course('A'), course('B')], { A: () => stats(), B: () => stats() }, true);
  assert.ok(called.every((c) => c.full === true));
});

test('summariseSync formats', () => {
  assert.equal(summariseSync(report({ activities: 48 })), 'nothing new (48 activities checked)');
  assert.equal(summariseSync(report({ imported: 2, alreadyHad: 1 })), '3 downloaded (2 new, 1 already had)');
  assert.match(summariseSync(report({ downloadFailed: 1, uploadFailed: 1 })), /2 failed \(1 download, 1 upload\)/);
  assert.match(
    summariseSync(report({}, [{ label: 'AI', slug: 'ai', ok: false, loaded: false, reason: 'not enrolled' }])),
    /courses failed: AI \(not enrolled\)/,
  );
  assert.match(summariseSync(report({}, [], { sessionExpired: 'x' })), /stopped: signed out of Lemida/);
  assert.ok(!/ 0 /.test(summariseSync(report({ imported: 2 }))));
});

test('summariseSync caps long failed-course lists at 480 chars ending with +N more', () => {
  const courses = Array.from({ length: 30 }, (_, i) => ({
    label: `A very long course name number ${i}`,
    slug: `c${i}`,
    ok: false,
    loaded: false,
    reason: 'not enrolled',
  }));
  const s = summariseSync(report({ imported: 1 }, courses));
  assert.ok(s.length <= 480);
  assert.match(s, /\+\d+ more$/);
});

test('totals integrity: downloaded = imported + review + alreadyHad + uploadFailed', async () => {
  const { r } = await run([course('A'), course('B')], {
    A: () => stats({ downloaded: 4, imported: 1, review: 1, alreadyHad: 1, uploadFailed: 1 }),
    B: () => stats({ downloaded: 2, imported: 2 }),
  });
  const t = r.totals;
  assert.equal(t.downloaded, t.imported + t.review + t.alreadyHad + t.uploadFailed);
});

test('classifyImport: duplicate:true is accepted whatever the status; imported/needs_review accepted; error/unknown rejected', () => {
  for (const status of ['imported', 'needs_review', 'duplicate']) {
    const o = classifyImport({ status, duplicate: true });
    assert.equal(o.ok, true, status);
    assert.equal(o.duplicate, true, status);
  }
  assert.deepEqual(classifyImport({ status: 'imported' }), { ok: true, status: 'imported', duplicate: false });
  assert.deepEqual(classifyImport({ status: 'needs_review' }), { ok: true, status: 'needs_review', duplicate: false });
  assert.equal(classifyImport({ status: 'error' }).ok, false);
  assert.equal(classifyImport({ status: 'error', duplicate: true }).ok, false);
  assert.equal(classifyImport({ status: 'error', error: 'bad pdf' }).error, 'server import error: bad pdf');
  assert.equal(classifyImport({ status: 'weird' }).ok, false);
});

test('safeUpload: a throw (non-2xx / network) is a failed outcome', async () => {
  const o = await safeUpload(async () => {
    throw new Error('import x → 500');
  });
  assert.deepEqual(o, { ok: false, error: 'import x → 500' });
  assert.equal((await safeUpload(async () => ({ status: 'imported' }))).ok, true);
});
