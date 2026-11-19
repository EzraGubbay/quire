import { describe, expect, it } from 'vitest';
import { BudgetError, ProviderError } from '@/lib/ai/answer';
import { type ChatStreamDeps, type ChatStreamShape, chatEventStream, errorKind } from './chat-stream';

async function lines(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(stream).text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const res = {
  text: 'hi',
  citations: [],
  model: 'm',
  usage: { input: 1, cached: 0, output: 2 },
  costUsd: 0.1,
};

function deps(over: Partial<ChatStreamDeps<string>> = {}): ChatStreamDeps<string> {
  return {
    userMessage: 'U',
    run: async (onDelta) => {
      onDelta('a');
      onDelta('b');
      return res;
    },
    saveAnswer: async () => 'SAVED',
    saveFailure: async (message, partial) => `FAIL:${message}:${partial}`,
    ...over,
  };
}

describe('chatEventStream (web shape)', () => {
  it('emits user, deltas in order, then done', async () => {
    const events = await lines(chatEventStream(deps()));
    expect(events).toEqual([
      { type: 'user', message: 'U' },
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'done', message: 'SAVED', fallback: false },
    ]);
  });

  it('emits error with kind and the saved stub, and closes', async () => {
    const events = await lines(
      chatEventStream(
        deps({
          run: async () => {
            throw new Error('boom');
          },
        }),
      ),
    );
    expect(events).toEqual([
      { type: 'user', message: 'U' },
      { type: 'error', message: 'boom', kind: 'other', saved: 'FAIL:boom:' },
    ]);
  });

  it('passes a provider error partial through to saveFailure', async () => {
    const err = new ProviderError('quota hit', 'quota');
    err.partial = 'part';
    const events = await lines(
      chatEventStream(
        deps({
          run: async () => {
            throw err;
          },
        }),
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'quota', saved: 'FAIL:quota hit:part' });
  });
});

describe('chatEventStream (custom shape)', () => {
  it('uses the supplied shape for every event', async () => {
    const shape: ChatStreamShape<string> = {
      user: (m) => ({ type: 'user', message: `m-${m}` }),
      done: (m) => ({ type: 'done', message: `m-${m}` }),
      error: (info) => ({ type: 'error', code: 'internal', message: info.message, kind: info.kind }),
    };
    const events = await lines(
      chatEventStream(
        deps({
          shape,
          run: async () => {
            throw new Error('x');
          },
        }),
      ),
    );
    expect(events).toEqual([
      { type: 'user', message: 'm-U' },
      { type: 'error', code: 'internal', message: 'x', kind: 'other' },
    ]);
  });
});

describe('errorKind', () => {
  it('classifies budget, provider and unknown errors', () => {
    expect(errorKind(new ProviderError('x', 'rate_limit'))).toBe('rate_limit');
    expect(errorKind(new Error('x'))).toBe('other');
    expect(errorKind(Object.create(BudgetError.prototype))).toBe('budget');
  });
});
