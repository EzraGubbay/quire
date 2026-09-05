'use client';

import { type RefObject, useEffect, useRef } from 'react';

export interface Point {
  x: number;
  y: number;
}

export interface PinchHandlers {
  /** Live pinch ratio relative to the gesture start, with the current midpoint (viewer-relative). */
  onPreview?: (ratio: number, mid: Point) => void;
  /** The gesture ended; commit the ratio. */
  onCommit?: (ratio: number, mid: Point) => void;
  onDoubleTap?: (point: Point) => void;
  /** A single tap (fires after the double-tap window unless a second tap came). */
  onTap?: (point: Point) => void;
}

const TAP_MOVE = 10;
const TAP_MS = 300;
const DOUBLE_MS = 300;
const DOUBLE_DIST = 40;

/** Pure gesture maths, exported for tests. */
export const pinchMath = {
  distance: (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y),
  midpoint: (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
  /** Scroll offset that keeps `mid` (viewport-relative) over the same content after scaling by `ratio`. */
  scrollAfterZoom: (scroll: number, mid: number, ratio: number) => (scroll + mid) * ratio - mid,
  clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
};

/**
 * Touch pinch, single tap and double tap on a scrolling element. The element should set
 * `touch-action: pan-x pan-y` so the browser keeps scrolling and leaves pinch to us.
 */
export function usePinch(ref: RefObject<HTMLElement | null>, handlers: PinchHandlers, enabled = true) {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let pinch: { start: number; mid: Point; ratio: number } | null = null;
    let tap: { at: number; point: Point; moved: boolean } | null = null;
    let lastTap: { at: number; point: Point } | null = null;
    let tapTimer: ReturnType<typeof setTimeout> | null = null;

    const rel = (t: Touch): Point => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const a = rel(e.touches[0]!);
        const b = rel(e.touches[1]!);
        pinch = { start: pinchMath.distance(a, b), mid: pinchMath.midpoint(a, b), ratio: 1 };
        tap = null;
        return;
      }
      if (e.touches.length === 1 && !pinch) {
        const target = e.target as HTMLElement;
        if (target.closest('a, button, input, textarea, select')) return;
        tap = { at: Date.now(), point: rel(e.touches[0]!), moved: false };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const a = rel(e.touches[0]!);
        const b = rel(e.touches[1]!);
        pinch.ratio = pinchMath.distance(a, b) / pinch.start;
        pinch.mid = pinchMath.midpoint(a, b);
        h.current.onPreview?.(pinch.ratio, pinch.mid);
        return;
      }
      if (tap && e.touches.length === 1) {
        const p = rel(e.touches[0]!);
        if (pinchMath.distance(p, tap.point) > TAP_MOVE) tap.moved = true;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length < 2) {
          h.current.onCommit?.(pinch.ratio, pinch.mid);
          pinch = null;
        }
        return;
      }
      if (!tap) return;
      const t = tap;
      tap = null;
      if (t.moved || Date.now() - t.at > TAP_MS || e.touches.length > 0) return;
      const now = Date.now();
      if (
        lastTap &&
        now - lastTap.at < DOUBLE_MS &&
        pinchMath.distance(lastTap.point, t.point) < DOUBLE_DIST
      ) {
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = null;
        lastTap = null;
        if (h.current.onDoubleTap) {
          e.preventDefault();
          h.current.onDoubleTap(t.point);
        }
        return;
      }
      lastTap = { at: now, point: t.point };
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(
        () => {
          tapTimer = null;
          h.current.onTap?.(t.point);
        },
        h.current.onDoubleTap ? DOUBLE_MS - 50 : 0,
      );
    };
    const onCancel = () => {
      pinch = null;
      tap = null;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
      if (tapTimer) clearTimeout(tapTimer);
    };
  }, [ref, enabled]);
}
