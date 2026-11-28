import { type Upload, uploadReducer } from './upload-reducer';

const start = (): Upload[] => uploadReducer([], { type: 'enqueue', id: 'a', name: 'deck.pdf' });

describe('uploadReducer', () => {
  it('enqueue adds an uploading item at 0%', () => {
    expect(start()).toEqual([{ id: 'a', name: 'deck.pdf', progress: 0, status: 'uploading' }]);
  });
  it('progress updates only the matching item and clamps to 0..1', () => {
    const two = uploadReducer(start(), { type: 'enqueue', id: 'b', name: 'b.pdf' });
    const next = uploadReducer(two, { type: 'progress', id: 'a', progress: 0.4 });
    expect(next[0]?.progress).toBe(0.4);
    expect(next[1]?.progress).toBe(0);
    expect(uploadReducer(next, { type: 'progress', id: 'a', progress: 7 })[0]?.progress).toBe(1);
  });
  it('done marks complete at 100%', () => {
    const next = uploadReducer(start(), { type: 'done', id: 'a' });
    expect(next[0]).toMatchObject({ status: 'done', progress: 1 });
  });
  it('done keeps a server warning', () => {
    const next = uploadReducer(start(), { type: 'done', id: 'a', warning: 'Looks like Lecture 3' });
    expect(next[0]).toMatchObject({ status: 'done', warning: 'Looks like Lecture 3' });
  });
  it('done without a warning leaves it undefined', () => {
    expect(uploadReducer(start(), { type: 'done', id: 'a' })[0]?.warning).toBeUndefined();
  });
  it('error keeps the message', () => {
    const next = uploadReducer(start(), { type: 'error', id: 'a', error: 'Too big' });
    expect(next[0]).toMatchObject({ status: 'error', error: 'Too big' });
  });
  it('progress does not resurrect a finished upload', () => {
    const done = uploadReducer(start(), { type: 'done', id: 'a' });
    expect(uploadReducer(done, { type: 'progress', id: 'a', progress: 0.2 })[0]?.status).toBe('done');
  });
  it('dismiss removes the item', () => {
    expect(uploadReducer(start(), { type: 'dismiss', id: 'a' })).toEqual([]);
  });
});
