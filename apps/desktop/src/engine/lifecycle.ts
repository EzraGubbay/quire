// Electron-free lifecycle helpers for the engine: bounded waits, the sign-in loop, the command heartbeat
// wrapper and the auto-sync schedule. Kept free of `electron` imports so they run under node:test.

/**
 * Resolve to `p`, or to `fallback` if it rejects or has not settled within `ms`. The timer is always cleared,
 * and a rejection of `p` after the timeout is swallowed (no unhandled rejection).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export type SignInWait = 'signed-in' | 'timeout' | 'closed';

/**
 * Poll `check` until it reports signed in. Always returns within `deadlineMs` (`'timeout'`) or as soon as
 * `signal` aborts (`'closed'`), whatever `check` does: each check and each sleep is raced against one "stop"
 * promise, and each check is itself capped at `checkTimeoutMs` (a hung page counts as "not yet").
 */
export async function waitForSignIn(o: {
  check: () => Promise<boolean>;
  intervalMs: number;
  checkTimeoutMs: number;
  deadlineMs: number;
  signal: AbortSignal;
  onTick?: () => void;
}): Promise<SignInWait> {
  if (o.signal.aborted) return 'closed';
  let deadlineTimer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'timeout' | 'closed'>((resolve) => {
    deadlineTimer = setTimeout(() => resolve('timeout'), o.deadlineMs);
    onAbort = () => resolve('closed');
    o.signal.addEventListener('abort', onAbort, { once: true });
  });
  const safeCheck = async (): Promise<boolean> => {
    try {
      return await o.check();
    } catch {
      return false; // e.g. the page navigated mid-check: not signed in yet
    }
  };
  try {
    for (;;) {
      const checked = await Promise.race([
        withTimeout(safeCheck(), o.checkTimeoutMs, false).then((v) => (v ? 'yes' : 'no') as 'yes' | 'no'),
        stop,
      ]);
      if (checked === 'yes') return 'signed-in';
      if (checked !== 'no') return checked;
      try {
        o.onTick?.();
      } catch {
        // a failing heartbeat must not end the sign-in
      }
      let sleepTimer: NodeJS.Timeout | undefined;
      const slept = await Promise.race([
        new Promise<'slept'>((resolve) => {
          sleepTimer = setTimeout(() => resolve('slept'), o.intervalMs);
        }),
        stop,
      ]);
      if (sleepTimer) clearTimeout(sleepTimer);
      if (slept !== 'slept') return slept;
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (onAbort) o.signal.removeEventListener('abort', onAbort);
  }
}

export type HeartbeatRun<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/**
 * Run `run()` while calling `beat` every `intervalMs` (lease proof-of-life). Gives up with `{ kind: 'timeout' }`
 * after `deadlineMs` without progress (the deadline restarts whenever `run` calls its `progress` argument). Known limitation: an abandoned `run()` may still finish in the background; its late
 * result or rejection is ignored here (and the server ignores a completion for a row that is no longer running).
 */
export function runWithHeartbeat<T>(o: {
  run: (progress: () => void) => Promise<T>;
  beat: () => void;
  intervalMs: number;
  deadlineMs: number;
}): Promise<HeartbeatRun<T>> {
  return new Promise<HeartbeatRun<T>>((resolve) => {
    let settled = false;
    let interval: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (r: HeartbeatRun<T>) => {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (deadline) clearTimeout(deadline);
      resolve(r);
    };
    interval = setInterval(() => {
      try {
        o.beat();
      } catch {
        // a failed beat is not fatal; the lease only lapses after several misses
      }
    }, o.intervalMs);
    const armDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => finish({ kind: 'timeout' }), o.deadlineMs);
    };
    armDeadline();
    // `deadlineMs` is an idle limit: each `progress()` call from the command restarts it, so a long but
    // advancing sync is never cut off, while a stalled one still is.
    const progress = () => {
      if (!settled) armDeadline();
    };
    let p: Promise<T>;
    try {
      p = o.run(progress);
    } catch (error) {
      finish({ kind: 'error', error });
      return;
    }
    p.then(
      (value) => finish({ kind: 'ok', value }),
      (error) => finish({ kind: 'error', error }),
    );
  });
}

/** Should the engine queue an automatic sync now? */
export function autoSyncDue(s: {
  intervalMs: number;
  sessionStatus: 'valid' | 'expired' | 'unknown';
  signInInProgress: boolean;
  now: number;
  lastSyncEndedAt: number;
  lastAutoRequestAt: number;
}): boolean {
  if (s.intervalMs <= 0) return false;
  if (s.sessionStatus !== 'valid' || s.signInInProgress) return false;
  return s.now - Math.max(s.lastSyncEndedAt, s.lastAutoRequestAt) >= s.intervalMs;
}
