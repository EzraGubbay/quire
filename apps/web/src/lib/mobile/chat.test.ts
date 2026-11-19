import { describe, expect, it } from 'vitest';
import { errorCodeFor, mobileStreamShape, toCitations, toMessage, toThread } from './chat';
import { ChatMessage, ChatStreamEvent, Thread } from './schema';

const at = new Date('2026-01-02T03:04:05.000Z');

describe('toCitations', () => {
  it('drops the web-only href and null pageNo', () => {
    const out = toCitations([
      { n: 1, kind: 'document', id: 'd1', title: 'T', href: '/x', pageNo: 3 },
      { n: 2, kind: 'note', id: 'n1', title: 'N', href: '/y', pageNo: null },
    ]);
    expect(out).toEqual([
      { n: 1, kind: 'document', id: 'd1', title: 'T', pageNo: 3 },
      { n: 2, kind: 'note', id: 'n1', title: 'N' },
    ]);
    expect(out[0]).not.toHaveProperty('href');
  });

  it('tolerates junk', () => {
    expect(toCitations(null)).toEqual([]);
    expect(toCitations('x')).toEqual([]);
  });
});

describe('toMessage / toThread', () => {
  it('maps a message row to the contract shape', () => {
    const m = toMessage({
      id: 'm1',
      role: 'assistant',
      content: 'hi',
      citations: [{ n: 1, kind: 'document', id: 'd', title: 'T', href: '/h', pageNo: 1 }],
      error: null,
      createdAt: at,
    });
    expect(ChatMessage.parse(m)).toEqual(m);
    expect(m.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('maps a thread row', () => {
    const t = toThread(
      {
        id: 't1',
        title: 'New chat',
        documentId: null,
        createdAt: at,
        updatedAt: at,
      },
      'c',
    );
    expect(Thread.parse(t)).toEqual(t);
    expect(t.courseSlug).toBe('c');
  });
});

describe('error codes and stream shape', () => {
  it('maps kinds to contract codes', () => {
    expect(errorCodeFor('budget')).toBe('rate_limited');
    expect(errorCodeFor('rate_limit')).toBe('rate_limited');
    expect(errorCodeFor('quota')).toBe('ai_unavailable');
    expect(errorCodeFor('auth')).toBe('ai_unavailable');
    expect(errorCodeFor('other')).toBe('internal');
  });

  it('shapes events that satisfy ChatStreamEvent', () => {
    const row = {
      id: 'm1',
      role: 'user',
      content: 'q',
      citations: [],
      error: null,
      createdAt: at,
    };
    const s = mobileStreamShape();
    expect(ChatStreamEvent.parse(s.user(row))).toBeTruthy();
    expect(ChatStreamEvent.parse(s.done(row, true))).toMatchObject({
      fallback: true,
    });
    const e = ChatStreamEvent.parse(s.error({ message: 'm', kind: 'budget', saved: row }));
    expect(e).toMatchObject({
      type: 'error',
      code: 'rate_limited',
      kind: 'budget',
    });
  });
});
