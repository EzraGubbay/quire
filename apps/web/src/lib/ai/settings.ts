import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { settings } from '@/db/schema';

/** Per-1M-token prices in USD, editable in settings because model prices change. */
export const priceSchema = z.object({
  input: z.number().min(0),
  cachedInput: z.number().min(0),
  output: z.number().min(0),
});

export const aiSettingsSchema = z.object({
  /**
   * Which backend answers generation (chat, synthesis, tests, discover). Embeddings ALWAYS go through OpenAI —
   * neither Claude route offers an embeddings API — so OPENAI_API_KEY stays required whatever this is set to.
   * - 'openai'            → the OpenAI API (ChatGPT), as before.
   * - 'openai-compatible' → an OpenAI-shaped endpoint at `baseUrl` (DeepSeek, Kimi, a local Ollama).
   * - 'claude-api'        → the Anthropic API with ANTHROPIC_API_KEY.
   * - 'claude-sub'        → the `claude` CLI driven as a plain completion, authed by a Max subscription token
   *                         (CLAUDE_CODE_OAUTH_TOKEN). Flat-rate, so these calls record $0 in the ledger.
   * When a Claude route fails `CLAUDE_FAILOVER_STRIKES` times in a row, generation falls over to OpenAI for
   * `CLAUDE_FAILOVER_HOURS` (see claudeFailover + lib/ai/failover.ts).
   */
  provider: z.enum(['openai', 'openai-compatible', 'claude-api', 'claude-sub']).default('openai'),
  /** For openai-compatible providers (DeepSeek, Kimi, a local Ollama). Ignored for the other providers. */
  baseUrl: z.string().url().optional(),
  models: z
    .object({
      answer: z.string().min(1).default('gpt-5.6-sol'),
      light: z.string().min(1).default('gpt-5.6-terra'),
      embeddings: z.string().min(1).default('text-embedding-3-small'),
      /** Note synthesis: the middle tier (Sol > Terra > Luna). */
      synthesis: z.string().min(1).default('gpt-5.6-terra'),
      /** Weekly recall tests. */
      testWeekly: z.string().min(1).default('gpt-5.6-terra'),
      /** Tri-weekly exam-style tests, which imitate the practice exams. */
      testTriweekly: z.string().min(1).default('gpt-5.6-sol'),
    })
    .default({
      answer: 'gpt-5.6-sol',
      light: 'gpt-5.6-terra',
      embeddings: 'text-embedding-3-small',
      synthesis: 'gpt-5.6-terra',
      testWeekly: 'gpt-5.6-terra',
      testTriweekly: 'gpt-5.6-sol',
    }),
  /**
   * OpenAI model that answers when a Claude route fails over (3-strike cooldown, or a single blip). Must be a
   * real OpenAI chat model — the Claude model ids in `models` are not valid at OpenAI. Only used on the Claude
   * routes; the OpenAI providers fall back within `models` (heavy → light) as before.
   */
  failoverModel: z.string().min(1).default('gpt-5.6-terra'),
  /** Monthly hard cap in USD; calls are refused once month-to-date spend reaches it. */
  monthlyCapUsd: z.number().min(0).default(25),
  warnAtFraction: z.number().min(0).max(1).default(0.8),
  /** List prices as of 2026-10 (confirm on the provider's pricing page; the cap depends on them). */
  prices: z.record(z.string(), priceSchema).default({
    'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
    'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
    'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
    'text-embedding-3-small': { input: 0.02, cachedInput: 0.02, output: 0 },
  }),
  /** Set when the provider refuses for budget reasons; cleared on the 1st or by hand. */
  providerBlocked: z.object({ at: z.string(), message: z.string() }).nullable().default(null),
  /**
   * Circuit breaker for the Claude routes. `consecutiveFails` counts Claude failures since the last success;
   * once it reaches the strike limit, `until` is set and generation uses OpenAI until that time passes. Reset
   * on any Claude success. Only meaningful when `provider` is a Claude route. See lib/ai/failover.ts.
   */
  claudeFailover: z
    .object({ consecutiveFails: z.number().int().min(0), until: z.string().nullable() })
    .default({ consecutiveFails: 0, until: null }),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export async function getAiSettings(): Promise<AiSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const data = (row?.data as { ai?: unknown } | undefined)?.ai ?? {};
  const parsed = aiSettingsSchema.safeParse(data);
  return parsed.success ? parsed.data : aiSettingsSchema.parse({});
}

export async function saveAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await getAiSettings();
  const next = aiSettingsSchema.parse({
    ...current,
    ...patch,
    models: { ...current.models, ...(patch.models ?? {}) },
    prices: { ...current.prices, ...(patch.prices ?? {}) },
  });
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const data = { ...((row?.data as Record<string, unknown>) ?? {}), ai: next };
  if (row) await db.update(settings).set({ data, updatedAt: new Date() }).where(eq(settings.id, 1));
  else await db.insert(settings).values({ id: 1, data });
  return next;
}

export function costFor(
  prices: AiSettings['prices'],
  model: string,
  usage: { input: number; cached: number; output: number },
): number {
  const p = prices[model] ??
    prices[Object.keys(prices).find((k) => model.startsWith(k)) ?? ''] ?? {
      input: 0,
      cachedInput: 0,
      output: 0,
    };
  const uncached = Math.max(0, usage.input - usage.cached);
  return (uncached * p.input + usage.cached * p.cachedInput + usage.output * p.output) / 1_000_000;
}
