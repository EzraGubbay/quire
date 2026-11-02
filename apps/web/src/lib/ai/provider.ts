// Provider adapter. OpenAI's SDK speaks to OpenAI and to any OpenAI-compatible endpoint (DeepSeek, Kimi, Ollama);
// generation can also be routed to Claude (the Anthropic API, or the `claude` CLI on a subscription token). A
// Claude route that keeps failing falls over to OpenAI for a cooldown window (see lib/ai/failover.ts). Embeddings
// are ALWAYS OpenAI — no Claude route offers them — so OPENAI_API_KEY stays required whatever the provider.
import OpenAI from 'openai';
import {
  claudeApiChat,
  claudeApiStream,
  claudeSubChat,
  claudeSubStream,
  hasImages,
  KNOWN_CLAUDE_MODELS,
  listClaudeApiModels,
  stripImages,
} from './claude';
import { classifyError, ProviderError } from './errors';
import { effectiveProvider, noteClaudeFailure, noteClaudeSuccess } from './failover';
import { aiMock, mockChat, mockEmbedding } from './mock';
import { type AiSettings, getAiSettings } from './settings';

export { classifyError, ProviderError };

/** A message part: text, or an image (data URL or https URL) for vision-capable models. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
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
  /** Set when this result came from the failover provider/model rather than the configured one. */
  fallback?: boolean;
}

/** The text of a message, ignoring images (for logging, mocks and token estimates). */
export function messageText(m: ChatMessageIn): string {
  return typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export const aiConfigured = (): boolean =>
  aiMock() ||
  Boolean(process.env.OPENAI_API_KEY) ||
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);

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

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  settings?: AiSettings;
  /** Ask for a JSON object (response_format json_object); the prompt must still say "JSON". */
  json?: boolean;
  /** Long one-shot jobs (synthesis, tests) can wait longer than a chat turn. */
  timeoutMs?: number;
}

export interface ChatStreamOptions {
  model: string;
  maxTokens?: number;
  settings?: AiSettings;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ---- OpenAI backends (unchanged behaviour, extracted so Claude routes can fall back to them) ----------------

async function openaiChat(messages: ChatMessageIn[], opts: ChatOptions, s: AiSettings): Promise<ChatResult> {
  const client = getClient(s);
  try {
    const res = await client.chat.completions.create(
      {
        model: opts.model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        max_completion_tokens: opts.maxTokens ?? 4000,
        ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
      },
      opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
    return {
      text: res.choices[0]?.message?.content ?? '',
      usage: usageOf(res.usage),
      model: res.model ?? opts.model,
    };
  } catch (err) {
    throw classifyError(err);
  }
}

async function openaiChatStream(
  messages: ChatMessageIn[],
  opts: ChatStreamOptions,
  s: AiSettings,
): Promise<ChatResult> {
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
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
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

// ---- dispatch ----------------------------------------------------------------------------------------------

export async function chat(messages: ChatMessageIn[], opts: ChatOptions): Promise<ChatResult> {
  if (aiMock()) return mockChat(messages, opts.model, { json: opts.json });
  const s = opts.settings ?? (await getAiSettings());
  const eff = effectiveProvider(s);
  if (eff === 'claude-api' || eff === 'claude-sub') {
    try {
      const res = await claudeGenerate(eff, messages, opts);
      await noteClaudeSuccess(s);
      return res;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      await noteClaudeFailure(s);
      // Graceful: serve this call via OpenAI (the failover model — the Claude id is not valid at OpenAI) so the
      // user is never left empty-handed on a Claude blip; mark it so the UI can show it was rerouted.
      const res = await openaiChat(messages, { ...opts, model: s.failoverModel, settings: s }, s);
      return { ...res, fallback: true };
    }
  }
  return openaiChat(messages, { ...opts, settings: s }, s);
}

/** Routes a single non-streamed call to the right Claude backend, using the API for vision when the sub can't. */
function claudeGenerate(
  eff: 'claude-api' | 'claude-sub',
  messages: ChatMessageIn[],
  opts: ChatOptions,
): Promise<ChatResult> {
  const o = { model: opts.model, maxTokens: opts.maxTokens, json: opts.json, timeoutMs: opts.timeoutMs };
  if (eff === 'claude-api') return claudeApiChat(messages, o);
  if (hasImages(messages))
    return process.env.ANTHROPIC_API_KEY
      ? claudeApiChat(messages, o)
      : claudeSubChat(stripImages(messages), o);
  return claudeSubChat(messages, o);
}

/** Streams text deltas; resolves with the full text and usage when done. */
export async function chatStream(messages: ChatMessageIn[], opts: ChatStreamOptions): Promise<ChatResult> {
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
  const eff = effectiveProvider(s);
  if (eff === 'claude-api' || eff === 'claude-sub') {
    try {
      const o = {
        model: opts.model,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        onDelta: opts.onDelta,
      };
      let res: ChatResult;
      if (eff === 'claude-api') res = await claudeApiStream(messages, o);
      else if (hasImages(messages) && process.env.ANTHROPIC_API_KEY) res = await claudeApiStream(messages, o);
      else res = await claudeSubStream(hasImages(messages) ? stripImages(messages) : messages, o);
      await noteClaudeSuccess(s);
      return res;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (opts.signal?.aborted) throw err; // user aborted: not a Claude failure, don't fail over
      await noteClaudeFailure(s);
      if (err.partial) throw err; // already streamed text: can't cleanly re-answer via OpenAI
      const res = await openaiChatStream(messages, { ...opts, model: s.failoverModel, settings: s }, s);
      return { ...res, fallback: true };
    }
  }
  return openaiChatStream(messages, { ...opts, settings: s }, s);
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
  // Embeddings always go through OpenAI (or an OpenAI-compatible endpoint); Claude routes have no embeddings API.
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
  if (aiMock()) return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'text-embedding-3-small'];
  const st = s ?? (await getAiSettings());
  if (st.provider === 'claude-api') return listClaudeApiModels();
  if (st.provider === 'claude-sub') return KNOWN_CLAUDE_MODELS;
  const client = getClient(st);
  try {
    const res = await client.models.list();
    return res.data.map((m) => m.id).sort();
  } catch (err) {
    throw classifyError(err);
  }
}
