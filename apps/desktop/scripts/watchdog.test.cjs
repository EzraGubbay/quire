// Sync watchdog: an abandoned sync must stop between courses/activities, and the idle deadline must restart on
// progress so a long but advancing (full rescan) sync is never cut off.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = (m) => require(path.join(__dirname, '..', 'dist', 'engine', `${m}.js`));
const { runSync } = dist('sync-run');
const { reconcileResources, emptyStats } = dist('reconcile');
const { runWithHeartbeat } = dist('lifecycle');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const course = (label) => ({ slug: label.toLowerCase(), label });

test('sync-run: abort stops between courses and reports the rest as skipped', async () => {
  const ac = new AbortController();
  const called = [];
  const r = await runSync([course('A'), course('B'), course('C')], {
    full: false,
    log: () => {},
    signal: ac.signal,
    syncCourse: async (c) => {
      called.push(c.label);
      if (c.label === 'A') ac.abort(); // the watchdog gives up while A is running
      return emptyStats();
    },
  });
  assert.deepEqual(called, ['A']);
  assert.equal(r.aborted, true);
  assert.deepEqual(
    r.courses.map((c) => [c.label, c.ok, c.reason]),
    [
      ['A', true, undefined],
      ['B', false, 'skipped (timed out)'],
      ['C', false, 'skipped (timed out)'],
    ],
  );
});

test('sync-run: shouldStop reflects the signal and progress is forwarded', async () => {
  const ac = new AbortController();
  let progress = 0;
  let seen;
  await runSync([course('A')], {
    full: false,
    log: () => {},
    signal: ac.signal,
    onProgress: () => {
      progress += 1;
    },
    syncCourse: async (_c, opts) => {
      seen = [opts.shouldStop()];
      opts.onProgress();
      ac.abort();
      seen.push(opts.shouldStop());
      return emptyStats();
    },
  });
  assert.deepEqual(seen, [false, true]);
  assert.ok(progress >= 2, `progress=${progress}`);
});

test('reconcile: shouldStop ends the crawl before the next activity; onProgress after each', async () => {
  const collected = [];
  let stop = false;
  let progress = 0;
  const stats = await reconcileResources(
    [{ href: 'a' }, { href: 'b' }, { href: 'c' }],
    { records: {}, full: false },
    {
      collect: async (r) => {
        collected.push(r.href);
        if (r.href === 'a') stop = true;
        return { files: [], unchanged: [], failures: [] };
      },
      upload: async () => ({ ok: true, status: 'imported', duplicate: false }),
      recordFile: () => {},
      persist: async () => {},
      log: () => {},
      shouldStop: () => stop,
      onProgress: () => {
        progress += 1;
      },
    },
  );
  assert.deepEqual(collected, ['a']);
  assert.equal(progress, 1);
  assert.equal(stats.activities, 3);
});

test('progress fires per download (collectActivity) and per upload (reconcile)', async () => {
  const { collectActivity } = dist('downloads');
  const BASE = 'https://lemida.biu.ac.il';
  const link = (n) => `${BASE}/pluginfile.php/1/mod_folder/content/0/f${n}.pdf`;
  const folder = {
    name: 'F',
    href: `${BASE}/mod/folder/view.php?id=1`,
    moduleType: 'mod_folder',
    sectionTitle: 'S',
  };
  const html = `<html><body id="page-mod-folder-view">${[1, 2, 3].map((n) => `<a href="${link(n)}">f</a>`).join('')}</body></html>`;
  const mk = (url, type, body) => ({
    requestedUrl: url,
    hops: [],
    finalUrl: url,
    status: 200,
    headers: { 'content-type': type },
    body: Buffer.from(body),
  });
  let downloads = 0;
  const out = await collectActivity(folder, {
    get: async (url) => (url === folder.href ? mk(url, 'text/html', html) : mk(url, 'application/pdf', url)),
    records: undefined,
    full: false,
    log: () => {},
    onProgress: () => {
      downloads += 1;
    },
  });
  assert.equal(out.files.length, 3);
  assert.equal(downloads, 4, 'one page + three files');

  let uploads = 0;
  await reconcileResources(
    [folder],
    { records: {}, full: false },
    {
      collect: async () => out,
      upload: async () => ({ ok: true, status: 'imported', duplicate: false }),
      recordFile: () => {},
      persist: async () => {},
      log: () => {},
      onProgress: () => {
        uploads += 1;
      },
    },
  );
  assert.equal(uploads, 4, 'three uploads + one per activity');
});

test('SeenStore: overlapping saves are serialized and leave valid JSON with the latest content', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { SeenStore } = dist('seen');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seen-')), 'lemida-seen.json');
  const s = new SeenStore(f);
  await s.load();
  const rec = (n) => ({ sha256: `s${n}`, at: '2026-01-01T00:00:00Z' });
  const saves = [];
  for (let i = 0; i < 20; i++) {
    s.recordFile('course', 'act', `file${i}`, rec(i));
    saves.push(s.save()); // not awaited: overlap
  }
  await Promise.all(saves);
  const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(Object.keys(parsed.courses.course.act.files).length, 20);
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('runWithHeartbeat: progress restarts the idle deadline (advancing run survives, stalled run times out)', async () => {
  const advancing = await runWithHeartbeat({
    run: async (progress) => {
      for (let i = 0; i < 4; i++) {
        await sleep(50);
        progress();
      }
      return 'done';
    },
    beat: () => {},
    intervalMs: 1000,
    deadlineMs: 120, // a wall-clock deadline would fire at 120ms, the run takes ~200ms
  });
  assert.deepEqual(advancing, { kind: 'ok', value: 'done' });

  const stalled = await runWithHeartbeat({
    run: async (progress) => {
      progress();
      await new Promise(() => {});
    },
    beat: () => {},
    intervalMs: 1000,
    deadlineMs: 80,
  });
  assert.deepEqual(stalled, { kind: 'timeout' });
});
