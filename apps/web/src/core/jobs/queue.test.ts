import { describe, expect, it } from 'vitest';
import { backoffMs } from './queue';

describe('backoffMs', () => {
  it('doubles from 30 s and caps at 1 h', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(8)).toBe(3_600_000);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(1000)).toBe(3_600_000);
  });
  it('treats 0 (and below) as the first attempt', () => {
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(-3)).toBe(30_000);
  });
});
