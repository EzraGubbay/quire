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
