'use server';

import { revalidatePath } from 'next/cache';
import { type SpendSummary, spendSummary } from '@/lib/ai/ledger';
import { aiConfigured, listModels } from '@/lib/ai/provider';
import { type AiSettings, getAiSettings, saveAiSettings } from '@/lib/ai/settings';

export async function spendSummaryAction(): Promise<{ summary: SpendSummary; configured: boolean }> {
  return { summary: await spendSummary(), configured: aiConfigured() };
}

export interface ActionState {
  error?: string;
  ok?: boolean;
  models?: string[];
}

export async function saveAiSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const cap = Number(formData.get('monthlyCapUsd'));
  const warn = Number(formData.get('warnAtPercent'));
  const patch: Partial<AiSettings> = {
    provider: (formData.get('provider') === 'openai-compatible'
      ? 'openai-compatible'
      : 'openai') as AiSettings['provider'],
    models: {
      answer: String(formData.get('answer') ?? '').trim() || 'gpt-5.6-sol',
      light: String(formData.get('light') ?? '').trim() || 'gpt-5.6-terra',
      embeddings: String(formData.get('embeddings') ?? '').trim() || 'text-embedding-3-small',
    },
    monthlyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : 25,
    warnAtFraction: Number.isFinite(warn) ? Math.min(1, Math.max(0, warn / 100)) : 0.8,
  };
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();
  if (baseUrl) patch.baseUrl = baseUrl;
  const prices: AiSettings['prices'] = {};
  for (const [k, v] of formData.entries()) {
    const m = k.match(/^price:(.+):(input|cachedInput|output)$/);
    if (!m?.[1] || !m[2]) continue;
    const model = m[1];
    const cur = prices[model] ?? { input: 0, cachedInput: 0, output: 0 };
    prices[model] = { ...cur, [m[2]]: Number(v) || 0 };
  }
  if (Object.keys(prices).length) patch.prices = prices;
  try {
    await saveAiSettings(patch);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath('/settings');
  return { ok: true };
}

export async function testConnectionAction(): Promise<ActionState> {
  if (!aiConfigured()) return { error: 'OPENAI_API_KEY is not set on the server.' };
  try {
    const models = await listModels(await getAiSettings());
    return { ok: true, models: models.filter((m) => /gpt|embedding|o[0-9]/i.test(m)).slice(0, 60) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
