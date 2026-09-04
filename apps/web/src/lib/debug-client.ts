'use client';

// Debug mode: a switch (Settings, stored server-side, mirrored in localStorage) that turns on client-side
// capture of errors, console warnings, viewer events and heartbeats, batched to the server with sendBeacon
// so the last entries survive a tab being killed. Off by default; costs nothing when off.

export const DEBUG_KEY = 'quire.debug';
export const CRASH_MARK = 'quire.debug.open';
const ENDPOINT = '/api/client-log';
const FLUSH_MS = 1500;
const MAX_BATCH = 200;

export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Entry {
  ts: string;
  level: Level;
  source: string;
  message: string;
  data?: unknown;
  url: string;
}

let enabled = false;
let installed = false;
let queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const session =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const debugSession = (): string => session;
export const isDebug = (): boolean => enabled;

export function setDebug(on: boolean): void {
  enabled = on;
  try {
    if (on) window.localStorage.setItem(DEBUG_KEY, '1');
    else window.localStorage.removeItem(DEBUG_KEY);
  } catch {}
  if (on) install();
}

/** Called once at startup with the server-side setting; localStorage wins for this device. */
export function initDebug(serverDefault: boolean): void {
  let local: string | null = null;
  try {
    local = window.localStorage.getItem(DEBUG_KEY);
  } catch {}
  enabled = local === '1' || (local === null && serverDefault);
  if (enabled) install();
}

function safe(v: unknown, depth = 0): unknown {
  if (v instanceof Error)
    return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 8).join('\n') };
  if (v === null || typeof v !== 'object') return v;
  if (depth > 3) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safe(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40))
    out[k] = safe(val, depth + 1);
  return out;
}

export function log(level: Level, source: string, message: string, data?: unknown): void {
  if (!enabled) return;
  queue.push({
    ts: new Date().toISOString(),
    level,
    source,
    message: message.slice(0, 2000),
    ...(data !== undefined ? { data: safe(data) } : {}),
    url: location.href,
  });
  if (queue.length >= MAX_BATCH) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const body = JSON.stringify({ session, platform: platformCookie(), entries: batch });
  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
  } catch {}
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

function platformCookie(): string | undefined {
  return document.cookie.match(/(?:^|;\s*)quire\.platform=(\w+)/)?.[1];
}

/** Device facts that matter for memory problems. */
export function deviceInfo(): Record<string, unknown> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    standalone?: boolean;
    connection?: { effectiveType?: string };
  };
  return {
    ua: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    deviceMemoryGb: nav.deviceMemory,
    standalone: nav.standalone ?? window.matchMedia?.('(display-mode: standalone)').matches,
    touchPoints: navigator.maxTouchPoints,
    connection: nav.connection?.effectiveType,
  };
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  log('info', 'debug', 'debug session started', deviceInfo());
  // A marker set while a viewer is open; found again at startup, it means the page died without unloading cleanly.
  try {
    const mark = window.sessionStorage.getItem(CRASH_MARK);
    if (mark) {
      log('error', 'crash', 'page reopened after an unclean end; last known state', JSON.parse(mark));
      window.sessionStorage.removeItem(CRASH_MARK);
    }
  } catch {}
  window.addEventListener('error', (e) =>
    log('error', 'window', e.message, { file: `${e.filename}:${e.lineno}:${e.colno}`, error: e.error }),
  );
  window.addEventListener('unhandledrejection', (e) =>
    log('error', 'promise', 'unhandled rejection', e.reason),
  );
  for (const level of ['warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      log(
        level,
        'console',
        args
          .map((a) => (typeof a === 'string' ? a : (safeString(a) ?? String(a))))
          .join(' ')
          .slice(0, 1000),
      );
    };
  }
  const flushNow = () => flush();
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
  setInterval(() => {
    if (queue.length) flush();
  }, 5000);
}

function safeString(a: unknown): string | null {
  try {
    return JSON.stringify(safe(a)).slice(0, 500);
  } catch {
    return null;
  }
}

/** Updates the crash marker with the current state (called by the viewer as it renders). */
export function setCrashMark(state: Record<string, unknown> | null): void {
  if (!enabled) return;
  try {
    if (state)
      window.sessionStorage.setItem(CRASH_MARK, JSON.stringify({ ...state, at: new Date().toISOString() }));
    else window.sessionStorage.removeItem(CRASH_MARK);
  } catch {}
}
