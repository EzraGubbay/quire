import { describe, expect, it } from 'vitest';
import { cleanPdfText } from './pdf';

describe('cleanPdfText', () => {
  it('strips NUL bytes that Postgres text cannot store', () => {
    expect(cleanPdfText('f (\u0000 I, Drive\u0000)')).toBe('f ( I, Drive)');
  });

  it('strips other C0/C1 control characters but keeps tab and newline', () => {
    expect(cleanPdfText('a\u0007b\u001Fc\u007Fd\u0085e')).toBe('abcde');
    expect(cleanPdfText('line1\ncol\tcol')).toBe('line1\ncol\tcol');
  });

  it('removes unpaired surrogates', () => {
    expect(cleanPdfText('x\uD800y')).toBe('xy');
    expect(cleanPdfText('x\uDC00y')).toBe('xy');
  });

  it('keeps valid surrogate pairs (astral characters)', () => {
    // U+1D538 MATHEMATICAL DOUBLE-STRUCK CAPITAL A and an emoji.
    expect(cleanPdfText('set \u{1D538} and \u{1F600}')).toBe('set \u{1D538} and \u{1F600}');
  });

  it('leaves ordinary math unicode untouched', () => {
    expect(cleanPdfText('Π = ⟨ P, A, I, G ⟩, S ⊆ C')).toBe('Π = ⟨ P, A, I, G ⟩, S ⊆ C');
  });
});
