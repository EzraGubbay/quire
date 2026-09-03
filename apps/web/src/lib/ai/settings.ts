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
  provider: z.enum(['openai', 'openai-compatible']).default('openai'),
  /** For openai-compatible providers (DeepSeek, Kimi, a local Ollama). Ignored for 'openai'. */
  baseUrl: z.string().url().optional(),
  models: z
    .object({
      answer: z.string().min(1).default('gpt-5.6-sol'),
      light: z.string().min(1).default('gpt-5.6-terra'),
      embeddings: z.string().min(1).default('text-embedding-3-small'),
    })
    .default({ answer: 'gpt-5.6-sol', light: 'gpt-5.6-terra', embeddings: 'text-embedding-3-small' }),
  /** Monthly hard cap in USD; calls are refused once month-to-date spend reaches it. */
  monthlyCapUsd: z.number().min(0).default(25),
  warnAtFraction: z.number().min(0).max(1).default(0.8),
  prices: z.record(z.string(), priceSchema).default({
    'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
    'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
    'text-embedding-3-small': { input: 0.02, cachedInput: 0.02, output: 0 },
  }),
  /** Set when the provider refuses for budget reasons; cleared on the 1st or by hand. */
  providerBlocked: z.object({ at: z.string(), message: z.string() }).nullable().default(null),
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
