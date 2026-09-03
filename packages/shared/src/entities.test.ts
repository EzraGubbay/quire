import { slugify } from './entities';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Sparse Attention Survey')).toBe('sparse-attention-survey');
  });
  it('strips accents and punctuation', () => {
    expect(slugify('Étude: Vérité & friends!')).toBe('etude-verite-friends');
  });
  it('falls back for empty input', () => {
    expect(slugify('   ')).toBe('untitled');
  });
});
