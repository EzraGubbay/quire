// Provider adapter. OpenAI's SDK speaks to OpenAI and to any OpenAI-compatible endpoint (DeepSeek, Kimi, Ollama).
import OpenAI from 'openai';
import { aiMock, mockChat, mockEmbedding } from './mock';
import { type AiSettings, getAiSettings } from './settings';

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface Usage {
  input: number;
  cached: number;
  output: number;
}
export interface ChatResult {
  text: string;
  usage: Usage;
  model: string;
}

export class ProviderError extends Error {
  /** Text streamed before the failure, if any (the answer was cut off rather than never started). */
  partial = '';
  constructor(
    message: string,
    public readonly kind: 'quota' | 'rate_limit' | 'auth' | 'other',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  /** Server-side or transient: worth another attempt (or the light model). Never auth or quota. */
  get retryable(): boolean {
    return (
      this.kind === 'rate_limit' ||
      (this.kind === 'other' && (this.status === undefined || this.status >= 500))
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function classifyError(err: unknown): ProviderError {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    error?: { code?: string; message?: string };
  };
  const code = e.code ?? e.error?.code ?? '';
  const msg = e.error?.message ?? e.message ?? 'Unknown provider error';
  if (e.status === 429 && /insufficient_quota|billing|budget/i.test(`${code} ${msg}`))
    return new ProviderError(msg, 'quota', 429);
  if (e.status === 429) return new ProviderError(msg, 'rate_limit', 429);
  if (e.status === 401 || e.status === 403) return new ProviderError(msg, 'auth', e.status);
  return new ProviderError(msg, 'other', e.status);
}

let cached: { key: string; client: OpenAI } | null = null;

export function getClient(s: AiSettings): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  const baseURL = s.provider === 'openai-compatible' ? s.baseUrl : undefined;
  const key = `${apiKey}|${baseURL ?? ''}`;
  if (!cached || cached.key !== key)
    cached = {
      key,
      client: new OpenAI({ apiKey: apiKey || 'missing', baseURL, maxRetries: 2, timeout: 120_000 }),
    };
  return cached.client;
}

export const aiConfigured = (): boolean => aiMock() || Boolean(process.env.OPENAI_API_KEY);

function usageOf(
  u:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | null
    | undefined,
): Usage {
  return {
    input: u?.prompt_tokens ?? 0,
    cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
    output: u?.completion_tokens ?? 0,
  };
}

export async function chat(
  messages: ChatMessageIn[],
  opts: { model: string; maxTokens?: number; settings?: AiSettings },
): Promise<ChatResult> {
  if (aiMock()) return mockChat(messages, opts.model);
  const s = opts.settings ?? (await getAiSettings());
  const client = getClient(s);
  try {
    const res = await client.chat.completions.create({
      model: opts.model,
      messages,
      max_completion_tokens: opts.maxTokens ?? 4000,
    });
    return {
      text: res.choices[0]?.message?.content ?? '',
      usage: usageOf(res.usage),
      model: res.model ?? opts.model,
    };
  } catch (err) {
    throw classifyError(err);
  }
}

/** Streams text deltas; resolves with the full text and usage when done. */
export async function chatStream(
  messages: ChatMessageIn[],
  opts: {
    model: string;
    maxTokens?: number;
    settings?: AiSettings;
    onDelta: (delta: string) => void;
    signal?: AbortSignal;
  },
): Promise<ChatResult> {
  if (aiMock()) {
    let r: ChatResult;
    try {
      r = mockChat(messages, opts.model);
    } catch (err) {
      throw classifyError(err);
    }
    for (const word of r.text.split(/(?<= )/)) opts.onDelta(word);
    return r;
  }
  const s = opts.settings ?? (await getAiSettings());
  const client = getClient(s);
  // The SDK only retries before the stream opens; OpenAI's occasional "server had an error" 500s also arrive as
  // the first (and only) chunk of a stream. Retry ourselves while nothing has been shown to the user yet.
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    let text = '';
    let usage: Usage = { input: 0, cached: 0, output: 0 };
    let model = opts.model;
    try {
      const stream = await client.chat.completions.create(
        {
          model: opts.model,
          messages,
          max_completion_tokens: opts.maxTokens ?? 4000,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: opts.signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          text += delta;
          opts.onDelta(delta);
        }
        if (chunk.usage) usage = usageOf(chunk.usage);
        if (chunk.model) model = chunk.model;
      }
      return { text, usage, model };
    } catch (err) {
      const pe = classifyError(err);
      pe.partial = text;
      const aborted = opts.signal?.aborted ?? false;
      if (text || aborted || !pe.retryable || attempt >= attempts) throw pe;
      await sleep(400 * 2 ** attempt);
    }
  }
}

export async function embed(
  texts: string[],
  opts: { model: string; settings?: AiSettings },
): Promise<{ vectors: number[][]; usage: Usage }> {
  if (texts.length === 0) return { vectors: [], usage: { input: 0, cached: 0, output: 0 } };
  if (aiMock())
    return {
      vectors: texts.map((t) => mockEmbedding(t)),
      usage: { input: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0), cached: 0, output: 0 },
    };
  const s = opts.settings ?? (await getAiSettings());
  const client = getClient(s);
  try {
    const res = await client.embeddings.create({ model: opts.model, input: texts, dimensions: 1536 });
    return {
      vectors: res.data.map((d) => d.embedding),
      usage: { input: res.usage?.prompt_tokens ?? 0, cached: 0, output: 0 },
    };
  } catch (err) {
    throw classifyError(err);
  }
}

/** Lists model ids the provider offers, for the settings page. */
export async function listModels(s?: AiSettings): Promise<string[]> {
  if (aiMock()) return ['gpt-5.6-sol', 'gpt-5.6-terra', 'text-embedding-3-small'];
  const st = s ?? (await getAiSettings());
  const client = getClient(st);
  try {
    const res = await client.models.list();
    return res.data.map((m) => m.id).sort();
  } catch (err) {
    throw classifyError(err);
  }
}
