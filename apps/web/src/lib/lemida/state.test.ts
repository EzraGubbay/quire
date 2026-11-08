import { lemidaIndicator } from './indicator';

describe('lemidaIndicator', () => {
  // A fixed "now": 2026-11-07 14:30 local time. Local midnight of this day is 2026-11-07 00:00 local.
  const now = new Date(2026, 10, 7, 14, 30, 0);
  const atLocal = (...args: [number, number, number, number, number, number]) =>
    new Date(...args).toISOString();

  it('is red whenever the session was confirmed signed out, regardless of when', () => {
    expect(
      lemidaIndicator({ sessionStatus: 'expired', checkedAt: atLocal(2026, 10, 7, 14, 0, 0) }, now),
    ).toBe('red');
    expect(lemidaIndicator({ sessionStatus: 'expired', checkedAt: null }, now)).toBe('red');
  });

  it('is green when valid and the last check happened earlier today', () => {
    expect(lemidaIndicator({ sessionStatus: 'valid', checkedAt: atLocal(2026, 10, 7, 9, 0, 0) }, now)).toBe(
      'green',
    );
  });

  it('is green exactly at the local-midnight boundary (on/after counts as today)', () => {
    expect(lemidaIndicator({ sessionStatus: 'valid', checkedAt: atLocal(2026, 10, 7, 0, 0, 0) }, now)).toBe(
      'green',
    );
  });

  it('is orange when valid but the last check was before today (a new local day began)', () => {
    expect(
      lemidaIndicator({ sessionStatus: 'valid', checkedAt: atLocal(2026, 10, 6, 23, 59, 59) }, now),
    ).toBe('orange');
    expect(lemidaIndicator({ sessionStatus: 'valid', checkedAt: atLocal(2026, 10, 6, 10, 0, 0) }, now)).toBe(
      'orange',
    );
  });

  it('is orange when valid but never actually checked, or the timestamp is unparseable', () => {
    expect(lemidaIndicator({ sessionStatus: 'valid', checkedAt: null }, now)).toBe('orange');
    expect(lemidaIndicator({ sessionStatus: 'valid', checkedAt: 'not-a-date' }, now)).toBe('orange');
  });

  it('is orange for an unknown (never-probed) session', () => {
    expect(lemidaIndicator({ sessionStatus: 'unknown', checkedAt: null }, now)).toBe('orange');
    expect(lemidaIndicator({ sessionStatus: 'unknown', checkedAt: atLocal(2026, 10, 7, 9, 0, 0) }, now)).toBe(
      'orange',
    );
  });
});
