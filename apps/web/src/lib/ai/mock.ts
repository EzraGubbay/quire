// Deterministic stand-in for the provider so the app (and e2e) can run without an API key: AI_MOCK=1.
import type { ChatMessageIn, ChatResult, Usage } from './provider';

export const aiMock = (): boolean => process.env.AI_MOCK === '1';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Bag-of-words style vector: similar texts get similar vectors, which is enough to test retrieval ordering. */
export function mockEmbedding(text: string, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    const i = hash(w) % dims;
    v[i] = (v[i] ?? 0) + 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const failedOnce = new Set<string>();

const textOf = (m: ChatMessageIn | undefined): string =>
  !m
    ? ''
    : typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** One-shot jobs mark their system prompt with `[task:synthesis]` etc. so the mock can answer in the right shape. */
function taskOf(system: string): string | null {
  return system.match(/\[task:([a-z-]+)\]/)?.[1] ?? null;
}

const MOCK_SYNTHESIS = `> **Course**: mock · **Source**: raw notes

## Overview

**Definition:** A *mock synthesis* is the deterministic output used when \`AI_MOCK=1\`.

**Theorem:** Every raw note has a synthesized counterpart.

The raw note was read in full and expanded with context, filled tables and inline math such as $O(n \\log n)$.

> **Q: What does the synthesized note add?**
> Definitions, worked examples and a Q&A block for revision.

> **Q: Where do slide references point?**
> *(See slide 3)* markers name the slide a figure came from.
`;

const MOCK_TEST = JSON.stringify({
  title: 'Mock test',
  questions: [
    {
      n: 1,
      body: 'Define a **race condition** and give one example from the lectures.',
      modelAnswer:
        'Two threads access shared state without synchronisation and the result depends on timing.',
      concept: 'race conditions',
      points: 2,
    },
    {
      n: 2,
      body: 'State the condition under which a reduction is parallelisable and justify it in two sentences.',
      modelAnswer: 'The operator must be associative; then partial results can be combined in any order.',
      concept: 'reductions',
      points: 3,
    },
  ],
});

/** Points at the first note and heading listed in the prompt's index, so the e2e re-read list has one real target. */
function mockReread(prompt: string): string {
  const note = prompt.match(/note "[^"]*" id=([0-9a-f-]{36})/);
  const heading = prompt.match(/\(slug: ([^)]+)\)/);
  const items = note
    ? [
        {
          questionN: 1,
          kind: 'note',
          noteId: note[1],
          heading: heading?.[1] ?? '',
          reason: 'The missed definition is in this section. (AI_MOCK)',
        },
      ]
    : [];
  return JSON.stringify({ items });
}

export function mockChat(
  messages: ChatMessageIn[],
  model: string,
  opts: { json?: boolean } = {},
): ChatResult {
  const last = textOf(messages[messages.length - 1]);
  // Test hook: the first attempt at a question containing MOCK_FAIL_ONCE fails like an OpenAI 500; the next succeeds.
  if (last.includes('MOCK_FAIL_ALWAYS')) {
    const err = new Error('The server had an error processing your request. (mock)') as Error & {
      status: number;
    };
    err.status = 500;
    throw err;
  }
  if (last.includes('MOCK_FAIL_ONCE') && !failedOnce.has(last)) {
    failedOnce.add(last);
    const err = new Error('The server had an error processing your request. (mock)') as Error & {
      status: number;
    };
    err.status = 500;
    throw err;
  }
  const system = textOf(messages.find((m) => m.role === 'system'));
  const task = taskOf(system);
  let text: string;
  if (task === 'synthesis') text = MOCK_SYNTHESIS;
  else if (task === 'test') text = MOCK_TEST;
  else if (task === 'reread') text = mockReread(last);
  else if (opts.json) text = '{}';
  else {
    const cites = [...system.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]).slice(0, 2);
    text = `Mock answer to “${last.slice(0, 60)}”.${cites.length ? ` Based on ${cites.map((c) => `[${c}]`).join(' and ')}.` : ''} (AI_MOCK)`;
  }
  const usage: Usage = {
    input: Math.ceil(messages.reduce((n, m) => n + textOf(m).length, 0) / 4),
    cached: 0,
    output: Math.ceil(text.length / 4),
  };
  return { text, usage, model: `${model}-mock` };
}
