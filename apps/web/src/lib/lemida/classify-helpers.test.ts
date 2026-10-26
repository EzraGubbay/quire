import { homeworkNumber, parseDueDate } from './classify';

describe('homeworkNumber', () => {
  it('reads the number after a homework keyword', () => {
    expect(homeworkNumber('תרגיל בית 3.pdf')).toBe(3);
    expect(homeworkNumber('HW5 - sorting.pdf')).toBe(5);
    expect(homeworkNumber('assignment-2.pdf')).toBe(2);
    expect(homeworkNumber('ps1.pdf')).toBe(1);
  });
  it('falls back to the first integer, else undefined', () => {
    expect(homeworkNumber('sheet 4 final.pdf')).toBe(4);
    expect(homeworkNumber('problems.pdf')).toBeUndefined();
  });
});

describe('parseDueDate', () => {
  const now = new Date('2026-10-01T00:00:00');
  it('parses a Hebrew "due by" date on the sheet', () => {
    const d = parseDueDate('להגשה עד 12.11 בשעה 23:55', now);
    expect(d?.getMonth()).toBe(10); // November (0-based)
    expect(d?.getDate()).toBe(12);
    expect(d?.getFullYear()).toBe(2026);
  });
  it('parses an explicit year', () => {
    const d = parseDueDate('due 5/3/2027', now);
    expect(d?.getFullYear()).toBe(2027);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(5);
  });
  it('rolls a long-past bare date into next year', () => {
    const d = parseDueDate('הגשה 5.1', now); // Jan 5 already passed relative to Oct
    expect(d?.getFullYear()).toBe(2027);
  });
  it('returns null when there is no date', () => {
    expect(parseDueDate('no deadline here', now)).toBeNull();
    expect(parseDueDate(undefined, now)).toBeNull();
  });
});
