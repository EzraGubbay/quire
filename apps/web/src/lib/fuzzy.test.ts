import { fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('rewards substrings over scattered matches and rejects misses', () => {
    expect(fuzzyScore('elbo', 'the ELBO tightness lemma')).toBeGreaterThan(
      fuzzyScore('elbo', 'entropy lower bound of'),
    );
    expect(fuzzyScore('elbo', 'entropy lower bound of')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'entropy lower bound')).toBe(0);
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
});
