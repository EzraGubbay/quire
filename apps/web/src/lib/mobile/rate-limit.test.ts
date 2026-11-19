import { describe, expect, it } from 'vitest';
import { FailureLimiter } from './rate-limit';

describe('FailureLimiter', () => {
  it('blocks an ip after 5 failures in the window, not before', () => {
    const l = new FailureLimiter(5, 600_000);
    const t = 1000;
    for (let i = 0; i < 4; i++) l.fail('1.1.1.1', t);
    expect(l.blocked('1.1.1.1', t)).toBe(false);
    l.fail('1.1.1.1', t);
    expect(l.blocked('1.1.1.1', t)).toBe(true);
    expect(l.blocked('2.2.2.2', t)).toBe(false);
  });

  it('forgets failures after the window', () => {
    const l = new FailureLimiter(5, 600_000);
    for (let i = 0; i < 5; i++) l.fail('a', 0);
    expect(l.blocked('a', 599_999)).toBe(true);
    expect(l.blocked('a', 600_001)).toBe(false);
  });
});
