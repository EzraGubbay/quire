import { describe, expect, it } from 'vitest';
import { isWorking, streamPhase } from './stream-state';

describe('streamPhase', () => {
  it('is thinking while pending before the first token', () => {
    expect(streamPhase({ pending: true, content: '', error: null })).toBe('thinking');
    // Whitespace-only content is not a real token yet.
    expect(streamPhase({ pending: true, content: '   \n', error: null })).toBe('thinking');
  });

  it('is streaming once a delta has arrived', () => {
    expect(streamPhase({ pending: true, content: 'Mock ans', error: null })).toBe('streaming');
  });

  it('is done when the stream settles with no error', () => {
    expect(streamPhase({ pending: false, content: 'A full answer.', error: null })).toBe('done');
    // A settled message with no pending flag (e.g. loaded from history) is done too.
    expect(streamPhase({ content: '', error: null })).toBe('done');
  });

  it('is error whenever the stream failed', () => {
    // Budget / provider failure before any token.
    expect(streamPhase({ pending: false, content: '', error: 'Budget exceeded' })).toBe('error');
    // Cut off after some text streamed: still reads as stopped, not working, so the user knows it
    // will never finish — even if `pending` was somehow still set.
    expect(streamPhase({ pending: true, content: 'half an answer', error: 'connection closed' })).toBe(
      'error',
    );
  });

  it('only animates while the answer is still coming', () => {
    expect(isWorking('thinking')).toBe(true);
    expect(isWorking('streaming')).toBe(true);
    expect(isWorking('done')).toBe(false);
    expect(isWorking('error')).toBe(false);
  });
});
