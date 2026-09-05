import { describe, expect, it } from 'vitest';
import { pinchMath } from './use-pinch';

describe('pinchMath', () => {
  it('measures distance and midpoint', () => {
    expect(pinchMath.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pinchMath.midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
  it('keeps the focal point still after a zoom', () => {
    // Content point under the finger: scroll 100 + mid 50 = 150. After 2x it sits at 300; scrolling to 250 puts it back at 50.
    expect(pinchMath.scrollAfterZoom(100, 50, 2)).toBe(250);
    // Zooming out below zero clamps at the caller (scrollTo ignores negatives); the maths is symmetric.
    expect(pinchMath.scrollAfterZoom(250, 50, 0.5)).toBe(100);
  });
  it('puts the anchored content point under the finger that ends the gesture', () => {
    // Anchor at content x=150 (scroll 100 + finger 50); fingers drift to x=80 while zooming 2x: content 300 sits under 80.
    expect(pinchMath.scrollForAnchor(150, 80, 2)).toBe(220);
    // Same maths for a double tap (start = end): identical to scrollAfterZoom.
    expect(pinchMath.scrollForAnchor(150, 50, 2)).toBe(pinchMath.scrollAfterZoom(100, 50, 2));
  });
  it('clamps', () => {
    expect(pinchMath.clamp(5, 1, 4)).toBe(4);
    expect(pinchMath.clamp(0.2, 1, 4)).toBe(1);
    expect(pinchMath.clamp(2, 1, 4)).toBe(2);
  });
});
