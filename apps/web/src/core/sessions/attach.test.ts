import type { SessionKind } from '@quire/shared';
import { describe, expect, it } from 'vitest';
import { checkAttach } from './attach';

const lec = (number: number) => ({ kind: 'lecture' as SessionKind, number });
const rec = (number: number) => ({ kind: 'recitation' as SessionKind, number });

describe('checkAttach', () => {
  it.each([
    ['same number and kind', lec(3), 'Lecture 3 - Locks.pdf'],
    ['no number at all', lec(3), 'Course overview.pdf'],
    ['leading index is not a session number', lec(3), '07 Memory models.pdf'],
    ['kind word without number', lec(3), 'Lecture - Intro.pdf'],
    ['week without session number', lec(3), 'שבוע 2 - הרצאה.pdf'],
    ['week is not the session number', lec(3), 'שבוע 2 - הרצאה 3.pdf'],
    ['homework never mismatches', rec(5), 'תרגיל בית 3.pdf'],
    ['empty name', lec(3), ''],
  ])('ok: %s', (_label, session, name) => {
    expect(checkAttach(session, name)).toEqual({ ok: true });
  });

  it('flags a different number', () => {
    expect(checkAttach(lec(5), 'Lecture 3.pdf')).toEqual({
      ok: false,
      mismatch: true,
      fileNumber: 3,
      sessionNumber: 5,
      fileKind: 'lecture',
      sessionKind: 'lecture',
    });
  });

  it('flags a different kind with the same number', () => {
    expect(checkAttach(lec(3), 'Recitation 3.pdf')).toMatchObject({
      ok: false,
      fileNumber: 3,
      sessionNumber: 3,
      fileKind: 'recitation',
      sessionKind: 'lecture',
    });
  });

  it('flags the week name against another session number', () => {
    expect(checkAttach(lec(2), 'שבוע 2 - הרצאה 3.pdf')).toMatchObject({
      ok: false,
      fileNumber: 3,
      sessionNumber: 2,
    });
  });

  it('flags a glued name', () => {
    expect(checkAttach(lec(4), 'ABC Lecture3.pptx')).toMatchObject({
      ok: false,
      fileNumber: 3,
      sessionNumber: 4,
    });
  });
});
