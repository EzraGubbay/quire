// Retrieval-augmented answering: builds the prompt with numbered context, streams the answer, records usage.
import type { EntityKind } from '@quire/shared';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { documents } from '@/db/schema';
import type { Citation } from '../chat';
import { indexedCounts, retrieve } from './index';
import { assertBudget, BudgetError, estimateTokens, markProviderBlocked, recordUsage } from './ledger';
import { type ChatMessageIn, chatStream, ProviderError } from './provider';
import { costFor, getAiSettings } from './settings';

export interface AnswerInput {
  projectId: string;
  slug: string;
  projectName: string;
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Restrict retrieval to one document. */
  documentId?: string | null;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AnswerResult {
  text: string;
  citations: Citation[];
  model: string;
  usage: { input: number; cached: number; output: number };
  costUsd: number;
}

const KIND_LABEL: Record<string, string> = {
  document: 'Document',
  note: 'Note',
  source: 'Source',
  annotation: 'Annotation',
  run: 'Run',
};

const SYSTEM = (projectName: string, scope: string | null, counts: string) =>
  `You are Quire, a research assistant inside the user's research project “${projectName}”. The numbered context below is drawn from the user's own material in this project: their notes, the documents (papers and write-ups) they added, their annotations, and their sources. Each passage is labelled with its kind and title. Treat notes and annotations as the user's own thinking and refer to them as such. Answer from the context when it is relevant, citing passages inline as [n]. When the context does not cover the question, say so plainly, then answer from general knowledge and mark it as such. Use Markdown; write math in TeX between $ or $$. Be precise and concise.${scope ? ` The user is asking about the document “${scope}”; keep to it unless they broaden the question.` : ''}${counts ? ` Indexed in this project: ${counts}.` : ''}`;

export async function answer(input: AnswerInput): Promise<AnswerResult> {
  const s = await getAiSettings();
  const model = s.models.answer;
  let scopeTitle: string | null = null;
  if (input.documentId) {
    const [d] = await db
      .select({ title: documents.title })
      .from(documents)
      .where(eq(documents.id, input.documentId));
    scopeTitle = d?.title ?? null;
  }
  const chunks = await retrieve(input.projectId, input.slug, input.question, {
    k: input.documentId ? 10 : 8,
    documentId: input.documentId ?? null,
  });
  const citations: Citation[] = chunks.map((c, i) => ({
    n: i + 1,
    kind: c.kind as EntityKind,
    id: c.id,
    title: c.title,
    href: c.href,
    pageNo: c.pageNo,
  }));
  const context = chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${KIND_LABEL[c.kind] ?? c.kind}: ${c.title}${c.pageNo ? ` (p.${c.pageNo})` : ''}\n${c.text}`,
    )
    .join('\n\n');
  const counts = await indexedCounts(input.projectId);
  const messages: ChatMessageIn[] = [
    {
      role: 'system',
      content: `${SYSTEM(input.projectName, scopeTitle, counts)}\n\nContext:\n${context || '(nothing indexed matches this question; say so)'}`,
    },
    ...input.history.slice(-12),
    { role: 'user', content: input.question },
  ];
  const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  const estimate = costFor(s.prices, model, { input: promptTokens, cached: 0, output: 1200 });
  await assertBudget(estimate, s);
  try {
    const res = await chatStream(messages, {
      model,
      settings: s,
      onDelta: input.onDelta,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const costUsd = await recordUsage({
      projectId: input.projectId,
      task: 'answer',
      model: res.model,
      usage: res.usage,
      settings: s,
    });
    const used = new Set([...res.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return {
      text: res.text,
      citations: citations.filter((c) => used.has(c.n)),
      model: res.model,
      usage: res.usage,
      costUsd,
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.kind === 'quota') await markProviderBlocked(err.message);
      await recordUsage({
        projectId: input.projectId,
        task: 'answer',
        model,
        usage: { input: promptTokens, cached: 0, output: 0 },
        ok: false,
        error: err.message,
        settings: s,
      });
    }
    throw err;
  }
}

export { BudgetError, ProviderError };
