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

export function mockChat(messages: ChatMessageIn[], model: string): ChatResult {
  const last = messages[messages.length - 1]?.content ?? '';
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const cites = [...system.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]).slice(0, 2);
  const text = `Mock answer to “${last.slice(0, 60)}”.${cites.length ? ` Based on ${cites.map((c) => `[${c}]`).join(' and ')}.` : ''} (AI_MOCK)`;
  const usage: Usage = {
    input: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4),
    cached: 0,
    output: Math.ceil(text.length / 4),
  };
  return { text, usage, model: `${model}-mock` };
}
