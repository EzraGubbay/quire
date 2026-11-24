// Unit tests for src/engine/lifecycle.ts (electron-free). Regressions for bug 3 (sign-in hang) live here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { withTimeout, waitForSignIn, runWithHeartbeat, autoSyncDue } = require(
  path.join(__dirname, '..', 'dist', 'engine', 'lifecycle.js'),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

test('withTimeout: never-settling promise -> fallback; fast promise wins; rejection -> fallback', async () => {
  const t0 = Date.now();
  assert.equal(await withTimeout(never(), 50, 'fb'), 'fb');
  assert.ok(Date.now() - t0 >= 40);
  assert.equal(await withTimeout(Promise.resolve('v'), 500, 'fb'), 'v');
  assert.equal(await withTimeout(Promise.reject(new Error('x')), 500, 'fb'), 'fb');
});

test('withTimeout: rejection after the timeout causes no unhandledRejection', async () => {
  let unhandled = 0;
  const spy = () => {
    unhandled += 1;
  };
  process.on('unhandledRejection', spy);
  try {
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60));
    assert.equal(await withTimeout(late, 20, 'fb'), 'fb');
    await sleep(120);
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', spy);
  }
});

test('bug 3 regression: sign-in with a check that never settles still times out at the deadline', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const r = await waitForSignIn({
    check: never,
    deadlineMs: 200,
    checkTimeoutMs: 50,
    intervalMs: 20,
    signal: ac.signal,
  });
  assert.equal(r, 'timeout');
  assert.ok(Date.now() - t0 < 400, `took ${Date.now() - t0}ms`);
});

test('bug 3 regression: closing the window during a hung check ends the wait quickly', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await waitForSignIn({
    check: never,
    deadlineMs: 5000,
    checkTimeoutMs: 5000,
    intervalMs: 20,
    signal: ac.signal,
  });
  assert.equal(r, 'closed');
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0}ms`);
});

test('waitForSignIn: true on the 3rd check -> signed-in, onTick twice', async () => {
  let n = 0;
  let ticks = 0;
  const r = await waitForSignIn({
    check: async () => ++n === 3,
    deadlineMs: 2000,
    checkTimeoutMs: 100,
    intervalMs: 5,
    signal: new AbortController().signal,
    onTick: () => {
      ticks += 1;
    },
  });
  assert.equal(r, 'signed-in');
  assert.equal(ticks, 2);
});

test('waitForSignIn: a throwing check counts as false and the loop continues', async () => {
  let n = 0;
  const r = await waitForSignIn({
    check: async () => {
      n += 1;
      if (n < 3) throw new Error('navigated');
      return true;
    },
    deadlineMs: 2000,
    checkTimeoutMs: 100,
    intervalMs: 5,
    signal: new AbortController().signal,
  });
  assert.equal(r, 'signed-in');
  assert.equal(n, 3);
});

test('waitForSignIn: an already-aborted signal -> closed immediately', async () => {
  const ac = new AbortController();
  ac.abort();
  let called = false;
  const r = await waitForSignIn({
    check: async () => {
      called = true;
      return true;
    },
    deadlineMs: 1000,
    checkTimeoutMs: 100,
    intervalMs: 5,
    signal: ac.signal,
  });
  assert.equal(r, 'closed');
  assert.equal(called, false);
});

test('runWithHeartbeat: ok result, beats while running and none afterwards', async () => {
  let beats = 0;
  const r = await runWithHeartbeat({
    run: async () => {
      await sleep(120);
      return 42;
    },
    beat: () => {
      beats += 1;
    },
    intervalMs: 30,
    deadlineMs: 2000,
  });
  assert.deepEqual(r, { kind: 'ok', value: 42 });
  assert.ok(beats >= 3 && beats <= 4, `beats=${beats}`);
  const after = beats;
  await sleep(100);
  assert.equal(beats, after);
});

test('runWithHeartbeat: never-settling run -> timeout and beats stop', async () => {
  let beats = 0;
  const r = await runWithHeartbeat({
    run: never,
    beat: () => {
      beats += 1;
    },
    intervalMs: 20,
    deadlineMs: 100,
  });
  assert.deepEqual(r, { kind: 'timeout' });
  const after = beats;
  await sleep(80);
  assert.equal(beats, after);
});

test('runWithHeartbeat: rejection -> error; a late rejection after timeout is swallowed', async () => {
  const boom = new Error('boom');
  const r = await runWithHeartbeat({
    run: () => Promise.reject(boom),
    beat: () => {},
    intervalMs: 20,
    deadlineMs: 500,
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.error, boom);

  let unhandled = 0;
  const spy = () => {
    unhandled += 1;
  };
  process.on('unhandledRejection', spy);
  try {
    const t = await runWithHeartbeat({
      run: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60)),
      beat: () => {},
      intervalMs: 20,
      deadlineMs: 20,
    });
    assert.equal(t.kind, 'timeout');
    await sleep(120);
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', spy);
  }
});

test('autoSyncDue table', () => {
  const now = 10_000_000;
  const base = {
    intervalMs: 1000,
    sessionStatus: 'valid',
    signInInProgress: false,
    now,
    lastSyncEndedAt: now - 5000,
    lastAutoRequestAt: 0,
  };
  assert.equal(autoSyncDue(base), true);
  assert.equal(autoSyncDue({ ...base, sessionStatus: 'expired' }), false);
  assert.equal(autoSyncDue({ ...base, sessionStatus: 'unknown' }), false);
  assert.equal(autoSyncDue({ ...base, signInInProgress: true }), false);
  assert.equal(autoSyncDue({ ...base, intervalMs: 0 }), false);
  assert.equal(
    autoSyncDue({ ...base, lastAutoRequestAt: now - 100 }),
    false,
    'recent request limits retries',
  );
  assert.equal(autoSyncDue({ ...base, lastSyncEndedAt: now - 100 }), false, 'sync just ended');
  assert.equal(autoSyncDue({ ...base, lastSyncEndedAt: 0 }), true, 'sync at app start');
});
