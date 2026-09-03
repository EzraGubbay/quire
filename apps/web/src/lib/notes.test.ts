import { extractWikiLinks } from './markdown';

describe('wiki link extraction for link sync', () => {
  it('handles aliases, whitespace, and duplicates', () => {
    expect(extractWikiLinks('a [[ ELBO tightness ]] b [[ELBO tightness|the lemma]] [[Other]]')).toEqual([
      'ELBO tightness',
      'Other',
    ]);
  });
});
