// Claude generation backends, behind the same ChatResult contract as provider.ts.
//   claude-api → the Anthropic API (@anthropic-ai/sdk), billed per token (ANTHROPIC_API_KEY).
//   claude-sub → the `claude` CLI driven as a plain, tool-less completion (`-p --tools ""`), authed by a Max
//                subscription token in CLAUDE_CODE_OAUTH_TOKEN. Flat-rate: callers price it at $0.
// Embeddings are never handled here — neither route offers them — so OpenAI stays the embeddings provider.
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { classifyAnthropic, classifyClaudeCli, ProviderError } from './errors';
import type { ChatMessageIn, ChatResult, ContentPart, Usage } from './provider';

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_TIMEOUT_MS = 120_000;

interface Opts {
  model: string;
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ---- shared message shaping --------------------------------------------------------------------------------

const partsText = (content: string | ContentPart[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

export const hasImages = (messages: ChatMessageIn[]): boolean =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

/** Drop image parts, keeping text — used when the sub (CLI) route, which is text-only, meets a vision prompt. */
export const stripImages = (messages: ChatMessageIn[]): ChatMessageIn[] =>
  messages.map((m) => (Array.isArray(m.content) ? { role: m.role, content: partsText(m.content) } : m));

/** Anthropic wants the system prompt as a top-level param, not a message; concatenate any system turns out. */
function splitSystem(messages: ChatMessageIn[]): { system: string; rest: ChatMessageIn[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsText(m.content))
    .join('\n\n');
  return { system, rest: messages.filter((m) => m.role !== 'system') };
}

function imageBlock(url: string): Anthropic.ImageBlockParam {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (m?.[1] && m[2])
    return { type: 'image', source: { type: 'base64', media_type: m[1] as never, data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function toContent(content: string | ContentPart[]): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : imageBlock(p.image_url.url),
  );
}

function toMessages(rest: ChatMessageIn[]): Anthropic.MessageParam[] {
  return rest.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: toContent(m.content),
  }));
}

function anthropicUsage(u: Anthropic.Usage | null | undefined): Usage {
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheCreate = u?.cache_creation_input_tokens ?? 0;
  // Our Usage.input is total prompt tokens (cached included); costFor subtracts `cached` for the cheaper rate.
  return {
    input: (u?.input_tokens ?? 0) + cacheRead + cacheCreate,
    cached: cacheRead,
    output: u?.output_tokens ?? 0,
  };
}

const textOfBlocks = (content: Anthropic.ContentBlock[]): string =>
  content.map((b) => (b.type === 'text' ? b.text : '')).join('');

// ---- claude-api --------------------------------------------------------------------------------------------

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client)
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? 'missing',
      maxRetries: 2,
      timeout: DEFAULT_TIMEOUT_MS,
    });
  return client;
}

export async function claudeApiChat(messages: ChatMessageIn[], opts: Opts): Promise<ChatResult> {
  const { system, rest } = splitSystem(messages);
  const msgs = toMessages(rest);
  // No response_format on Anthropic: prefill an opening brace so the reply is a JSON object, then restore it.
  if (opts.json) msgs.push({ role: 'assistant', content: '{' });
  try {
    const res = await anthropic().messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: msgs,
      },
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    const body = textOfBlocks(res.content);
    return {
      text: opts.json ? `{${body}` : body,
      usage: anthropicUsage(res.usage),
      model: res.model ?? opts.model,
    };
  } catch (err) {
    throw classifyAnthropic(err);
  }
}

export async function claudeApiStream(
  messages: ChatMessageIn[],
  opts: Opts & { onDelta: (d: string) => void },
): Promise<ChatResult> {
  const { system, rest } = splitSystem(messages);
  let acc = '';
  try {
    const stream = anthropic().messages.stream(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: toMessages(rest),
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
    stream.on('text', (t) => {
      acc += t;
      opts.onDelta(t);
    });
    const final = await stream.finalMessage();
    return {
      text: textOfBlocks(final.content) || acc,
      usage: anthropicUsage(final.usage),
      model: final.model ?? opts.model,
    };
  } catch (err) {
    const pe = classifyAnthropic(err);
    pe.partial = acc;
    throw pe;
  }
}

// ---- claude-sub (CLI) --------------------------------------------------------------------------------------

const claudeBin = (): string => process.env.CLAUDE_CLI_PATH || 'claude';

/** Flatten a conversation into one prompt string. Prior assistant turns are labelled so context survives. */
function flatten(rest: ChatMessageIn[]): string {
  if (rest.length === 1) return partsText(rest[0]!.content);
  return rest
    .map((m) => (m.role === 'assistant' ? `Assistant: ${partsText(m.content)}` : partsText(m.content)))
    .join('\n\n');
}

/** Pull the first JSON object/array out of CLI prose (there is no response_format over the CLI). */
function toJsonText(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? s;
  const start = body.search(/[[{]/);
  if (start < 0) return body.trim();
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return end > start ? body.slice(start, end + 1) : body.slice(start).trim();
}

function runSub(messages: ChatMessageIn[], opts: Opts, onDelta?: (d: string) => void): Promise<ChatResult> {
  const { system, rest } = splitSystem(messages);
  const prompt = flatten(rest);
  return new Promise<ChatResult>((resolve, reject) => {
    const args = ['-p', '--model', opts.model, '--output-format', 'stream-json', '--verbose', '--tools', ''];
    if (onDelta) args.push('--include-partial-messages');
    if (system) args.push('--system-prompt', system);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudeBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      return reject(classifyClaudeCli(null, String((err as Error).message)));
    }

    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new ProviderError('claude CLI timed out', 'other')));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      child.kill('SIGKILL');
      done(() => reject(new ProviderError('aborted', 'other')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let acc = '';
    let finalText = '';
    let usage: Usage = { input: 0, cached: 0, output: 0 };
    let model = opts.model;
    let errText = '';
    let resultError = '';
    let buf = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard NDJSON line-splitting loop.
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'system' && typeof ev.model === 'string') model = ev.model;
        else if (ev.type === 'stream_event') {
          const e = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
            acc += e.delta.text;
            onDelta?.(e.delta.text);
          }
        } else if (ev.type === 'result') {
          if (typeof ev.result === 'string') finalText = ev.result;
          if (ev.usage) usage = anthropicUsage(ev.usage as Anthropic.Usage);
          if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype !== 'success'))
            resultError = (typeof ev.result === 'string' && ev.result) || String(ev.subtype ?? 'error');
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      errText += d;
    });
    child.on('error', (e: Error) => done(() => reject(classifyClaudeCli(null, e.message))));
    child.on('close', (code: number | null) => {
      opts.signal?.removeEventListener('abort', onAbort);
      done(() => {
        const text = finalText || acc;
        if (code !== 0 || resultError || (!text && errText)) {
          const pe = classifyClaudeCli(code, resultError || errText);
          pe.partial = acc;
          return reject(pe);
        }
        resolve({ text: opts.json ? toJsonText(text) : text, usage, model });
      });
    });

    child.stdin?.end(prompt);
  });
}

export const claudeSubChat = (messages: ChatMessageIn[], opts: Opts): Promise<ChatResult> =>
  runSub(messages, opts);

export const claudeSubStream = (
  messages: ChatMessageIn[],
  opts: Opts & { onDelta: (d: string) => void },
): Promise<ChatResult> => runSub(messages, opts, opts.onDelta);

// ---- model listing (settings "Test connection") ------------------------------------------------------------

/** Sensible Claude ids for the subscription route, where there is no models endpoint to query. */
export const KNOWN_CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
];

export async function listClaudeApiModels(): Promise<string[]> {
  try {
    const res = await anthropic().models.list({ limit: 100 });
    return res.data.map((m) => m.id).sort();
  } catch (err) {
    throw classifyAnthropic(err);
  }
}
