// The in-process push loop (ADR 0003 §3.3). Started from instrumentation.ts on every nodejs boot. Idempotent across
// dev hot reloads (globalThis flag); every timer is unref()'d so it never keeps a process (tests, scripts) alive.
// S2b adds `scanDeadlines` here on a 10-minute tick.
import { pushConfig } from './config';
import { dispatchDue } from './dispatcher';
import { dbOutbox, errTag } from './outbox';
import { currentTransport } from './runtime';

export const DISPATCH_EVERY_MS = 30_000;
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 5_000;

export interface LoopTasks {
  dispatch(): Promise<unknown>;
  purge(): Promise<unknown>;
}

export const defaultTasks: LoopTasks = {
  async dispatch() {
    const transport = currentTransport();
    if (!transport) return null; // push disabled: nothing can be sent
    return dispatchDue(new Date(), { store: dbOutbox, transport });
  },
  async purge() {
    return dbOutbox.purge(new Date(Date.now() - PURGE_AFTER_MS));
  },
};

type Timer = ReturnType<typeof setInterval>;
const g = globalThis as unknown as { __quirePushLoop?: Timer[] };

const guarded = (name: string, fn: () => Promise<unknown>) => async () => {
  try {
    await fn();
  } catch (e) {
    console.warn(`[push] ${name} failed (${errTag(e)})`);
  }
};

/** Start the loop once per process; returns false when it is already running. */
export function startPushLoop(tasks: LoopTasks = defaultTasks): boolean {
  if (g.__quirePushLoop) return false;
  pushConfig(); // logs `[push] disabled: <reason>` or the transport once, at boot
  const dispatch = guarded('dispatch', tasks.dispatch);
  const purge = guarded('purge', tasks.purge);
  const timers: Timer[] = [
    setInterval(dispatch, DISPATCH_EVERY_MS),
    setInterval(purge, PURGE_EVERY_MS),
    setTimeout(() => {
      void dispatch();
      void purge();
    }, FIRST_RUN_MS),
  ];
  for (const t of timers) t.unref?.();
  g.__quirePushLoop = timers;
  return true;
}

/** Tests only. */
export function stopPushLoop() {
  for (const t of g.__quirePushLoop ?? []) clearInterval(t);
  g.__quirePushLoop = undefined;
}
