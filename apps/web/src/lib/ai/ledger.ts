import { and, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiUsage } from '@/db/schema';
import { type AiSettings, costFor, getAiSettings, saveAiSettings } from './settings';

export interface SpendSummary {
  monthToDate: number;
  cap: number;
  fraction: number;
  /** 'ok' | 'warn' (past warnAtFraction) | 'capped' | 'blocked' (provider refused for budget). */
  state: 'ok' | 'warn' | 'capped' | 'blocked';
  resetsOn: string;
  blockedMessage?: string;
  byTask: { task: string; cost: number; calls: number }[];
  byDay: { day: string; cost: number }[];
}

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function spendSummary(settingsIn?: AiSettings): Promise<SpendSummary> {
  const s = settingsIn ?? (await getAiSettings());
  const start = monthStart();
  const [tot] = await db
    .select({ cost: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, start));
  const byTask = await db
    .select({
      task: aiUsage.task,
      cost: sql<number>`sum(${aiUsage.costUsd})::float`,
      calls: sql<number>`count(*)::int`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, start))
    .groupBy(aiUsage.task)
    .orderBy(sql`sum(${aiUsage.costUsd}) desc`);
  const byDay = await db
    .select({
      day: sql<string>`to_char(${aiUsage.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      cost: sql<number>`sum(${aiUsage.costUsd})::float`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, start))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const monthToDate = tot?.cost ?? 0;
  const cap = s.monthlyCapUsd;
  const fraction = cap > 0 ? monthToDate / cap : 0;
  // A provider block from a previous month no longer applies.
  const blocked = s.providerBlocked && new Date(s.providerBlocked.at) >= start ? s.providerBlocked : null;
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const state: SpendSummary['state'] = blocked
    ? 'blocked'
    : cap > 0 && monthToDate >= cap
      ? 'capped'
      : fraction >= s.warnAtFraction
        ? 'warn'
        : 'ok';
  const out: SpendSummary = {
    monthToDate,
    cap,
    fraction,
    state,
    resetsOn: next.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    byTask,
    byDay,
  };
  if (blocked) out.blockedMessage = blocked.message;
  return out;
}

export class BudgetError extends Error {
  constructor(
    public readonly summary: SpendSummary,
    public readonly estimateUsd: number,
  ) {
    super(
      summary.state === 'blocked'
        ? `OpenAI is refusing requests: ${summary.blockedMessage ?? 'budget exceeded on the provider side'}`
        : `Monthly AI budget reached ($${summary.monthToDate.toFixed(2)} of $${summary.cap.toFixed(2)}). Resets ${summary.resetsOn}. Raise it in Settings.`,
    );
    this.name = 'BudgetError';
  }
}

/** Refuses when the cap is hit or a provider block is active; estimate is a rough pre-flight cost of the call. */
export async function assertBudget(estimateUsd: number, s?: AiSettings): Promise<SpendSummary> {
  const summary = await spendSummary(s);
  if (summary.state === 'blocked' || summary.state === 'capped') throw new BudgetError(summary, estimateUsd);
  if (summary.cap > 0 && summary.monthToDate + estimateUsd > summary.cap)
    throw new BudgetError({ ...summary, state: 'capped' }, estimateUsd);
  return summary;
}

export async function recordUsage(input: {
  projectId?: string | null;
  task: string;
  model: string;
  usage: { input: number; cached: number; output: number };
  ok?: boolean;
  error?: string;
  settings?: AiSettings;
}): Promise<number> {
  const s = input.settings ?? (await getAiSettings());
  const cost = costFor(s.prices, input.model, input.usage);
  await db.insert(aiUsage).values({
    projectId: input.projectId ?? null,
    task: input.task,
    model: input.model,
    inputTokens: input.usage.input,
    cachedTokens: input.usage.cached,
    outputTokens: input.usage.output,
    costUsd: cost,
    ok: input.ok ?? true,
    error: input.error ?? null,
  });
  return cost;
}

/** Called when the provider answers 429 insufficient_quota (its own budget). */
export async function markProviderBlocked(message: string): Promise<void> {
  await saveAiSettings({ providerBlocked: { at: new Date().toISOString(), message } });
}

export async function clearProviderBlock(): Promise<void> {
  await saveAiSettings({ providerBlocked: null });
}

/** Rough token estimate: ~4 characters per token for English and code. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export { and, costFor };
