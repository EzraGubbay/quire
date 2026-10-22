// Retrieval-augmented answering: builds the prompt with numbered context, streams the answer, records usage.
import type { EntityKind } from '@quire/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { documents } from '@/db/schema';
import type { Citation } from '../chat';
import { deckNote } from '../notes';
import { indexedCounts, retrieve } from './index';
import { assertBudget, BudgetError, estimateTokens, markProviderBlocked, recordUsage } from './ledger';
import { type ChatMessageIn, chatStream, messageText, ProviderError } from './provider';
import { costFor, getAiSettings } from './settings';

export interface AnswerInput {
  projectId: string;
  /** URL prefix of the workspace, for citation hrefs. */
  base: string;
  projectName: string;
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Restrict retrieval to one document. */
  documentId?: string | null;
  /** default | tutor-hint | tutor-full (homework question chats). */
  mode?: string;
  /** Course workspace: the material is lectures and notes rather than papers. */
  course?: boolean;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AnswerResult {
  text: string;
  citations: Citation[];
  model: string;
  usage: { input: number; cached: number; output: number };
  costUsd: number;
  /** The configured answer model failed with a server error and the light model answered instead. */
  fallback?: boolean;
}

/** `[[Title]]` references in a question, resolved to this project's documents (case-insensitive exact title). */
export async function resolveMentions(
  projectId: string,
  text: string,
): Promise<{ id: string; title: string }[]> {
  const names = [
    ...new Set([...text.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1]!.trim().toLowerCase())),
  ];
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), inArray(sql`lower(${documents.title})`, names)));
  return rows;
}

const KIND_LABEL: Record<string, string> = {
  document: 'Document',
  note: 'Note',
  source: 'Source',
  annotation: 'Annotation',
  run: 'Run',
};

const SYSTEM = (projectName: string, scope: string | null, counts: string, course: boolean) =>
  course
    ? `You are Quire, a study assistant inside the student's course workspace “${projectName}”. The numbered context below is drawn from the student's own material: lecture and recitation slides (page text; often Hebrew), their raw and synthesized notes, annotations, and homework sheets. Each passage is labelled with its kind and title. Treat notes and annotations as the student's own thinking; they are written live and may hold misunderstandings, so when one that bears on the question gets something wrong, say so plainly and correct it. Answer from the context when it is relevant, citing passages inline as [n]; slides are cited by number. When the context does not cover the question, say so plainly, then answer from general knowledge and mark it as such. Answer in English; keep key Hebrew terms in parentheses when they appear in the slides. Use Markdown; write math in TeX between $ or $$; mark definitions and theorems with **Definition:** / **Theorem:** labels. Be precise and concise.${scope ? ` The student is asking about “${scope}”; keep to it unless they broaden the question.` : ''}${counts ? ` Indexed in this course: ${counts}.` : ''}`
    : `You are Quire, a research assistant inside the user's research project “${projectName}”. The numbered context below is drawn from the user's own material in this project: their notes, the documents (papers and write-ups) they added, their annotations, and their sources. Each passage is labelled with its kind and title. Treat notes and annotations as the user's own thinking and refer to them as such. Answer from the context when it is relevant, citing passages inline as [n]. When the context does not cover the question, say so plainly, then answer from general knowledge and mark it as such. Use Markdown; write math in TeX between $ or $$. Be precise and concise.${scope ? ` The user is asking about the document “${scope}”; keep to it unless they broaden the question.` : ''}${counts ? ` Indexed in this project: ${counts}.` : ''}`;

const TUTOR_HINT = `

Tutor mode (hints). The student is working on a graded homework question and has chosen NOT to be given the solution. Do not solve the question, write the final code, or state the final answer, even if asked directly; if they ask, remind them the "Full solution" toggle exists. Instead: ask what they have tried; point at the relevant definition, theorem, lecture or slide; give the next small hint rather than the whole path; check the reasoning they show and say precisely where it is right or wrong; work through an analogous, different example if that helps. Keep answers short so they do the thinking.`;

const TUTOR_FULL = `

Tutor mode (full solution allowed). The student has switched this chat to full solutions: you may give complete worked solutions and code when asked. Still show the reasoning step by step, name the lecture material each step rests on, and point out the common mistakes a grader looks for.`;

/** Longer working notes keep their end, which is where the lecture currently is. */
export const NOTE_MAX_CHARS = 30_000;

/** Instructions for the working note of the lecture or recitation the student is asking from, cited as [n]. */
const WORKING_NOTE = (n: number, sessionKind: string) => `

Working note. Below the context is the note the student is taking for this ${sessionKind}, cited as [${n}]. They write it live, so it is terse and unfinished; that is expected. It is the best record of how they understand the material right now: connect your answer to what they wrote and cite it as [${n}] when you do. Beyond the question asked, read the note for misunderstandings: a statement the slides or the field contradict, a confused or swapped definition, a reversed implication or condition, a wrong mechanism, bound or number. If you find one, end with a short "**About your note**" section: quote the line, say what is off, and give the correction with the slide it comes from. Flag real errors only, not terseness, typos, gaps or style. Leave the section out when the note is sound or the point was already raised earlier in this chat. Lines starting **Question:** are open questions the student wrote down; if your answer settles one, say so in a sentence.`;

/** The working note as it appears after the context passages. */
export function workingNoteBlock(n: number, title: string, body: string): string {
  const text =
    body.length > NOTE_MAX_CHARS
      ? `[… earlier part of the note omitted …]\n${body.slice(body.length - NOTE_MAX_CHARS)}`
      : body;
  return `\n\nWorking note [${n}] “${title}”:\n<<<\n${text.trim()}\n>>>`;
}

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
  // Documents named as [[Title]] in the question get their own retrieval so the answer can lean on them.
  const mentions = await resolveMentions(input.projectId, input.question);
  const general = await retrieve(input.projectId, input.base, input.question, {
    k: input.documentId ? 10 : 8,
    documentId: input.documentId ?? null,
  });
  const mentioned = (
    await Promise.all(
      mentions
        .filter((m) => m.id !== input.documentId)
        .map((m) => retrieve(input.projectId, input.base, input.question, { k: 5, documentId: m.id })),
    )
  ).flat();
  const seen = new Set<string>();
  const chunks = [...mentioned, ...general].filter((c) => {
    const key = `${c.kind}:${c.id}:${c.pageNo ?? ''}:${c.text.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const citations: Citation[] = chunks.map((c, i) => ({
    n: i + 1,
    kind: c.kind as EntityKind,
    id: c.id,
    title: c.title,
    href: c.href,
    pageNo: c.pageNo,
  }));
  // Asking from a lecture or recitation deck: the note being taken beside it goes in whole, not as retrieved chunks.
  const working =
    input.course && input.documentId ? await deckNote(input.projectId, input.documentId) : undefined;
  const noteN = citations.length + 1;
  if (working)
    citations.push({
      n: noteN,
      kind: 'note',
      id: working.note.id,
      title: working.note.title,
      href: `${input.base}/notes/${working.note.slug}`,
      pageNo: null,
    });
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
      content: `${SYSTEM(input.projectName, scopeTitle, counts, input.course ?? false)}${
        mentions.length
          ? ` The user names documents as [[Title]]; in this question ${mentions.map((m) => `[[${m.title}]]`).join(', ')} ${mentions.length === 1 ? 'is a document' : 'are documents'} in the project, and passages from ${mentions.length === 1 ? 'it' : 'them'} are included in the context.`
          : ''
      }${input.mode === 'tutor-hint' ? TUTOR_HINT : input.mode === 'tutor-full' ? TUTOR_FULL : ''}${
        working ? WORKING_NOTE(noteN, working.sessionKind) : ''
      }\n\nContext:\n${context || (working ? '(no indexed passages match this question)' : '(nothing indexed matches this question; say so)')}${
        working ? workingNoteBlock(noteN, working.note.title, working.note.body) : ''
      }`,
    },
    ...input.history.slice(-12),
    { role: 'user', content: input.question },
  ];
  const promptTokens = messages.reduce((n, m) => n + estimateTokens(messageText(m)), 0);
  const estimate = costFor(s.prices, model, { input: promptTokens, cached: 0, output: 1200 });
  await assertBudget(estimate, s);
  try {
    let fallback = false;
    let res: Awaited<ReturnType<typeof chatStream>>;
    try {
      res = await chatStream(messages, {
        model,
        settings: s,
        onDelta: input.onDelta,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      // The heavy model's server errors are usually short-lived; the light model answers rather than nothing.
      const light = s.models.light;
      if (
        !(err instanceof ProviderError) ||
        !err.retryable ||
        err.partial ||
        light === model ||
        input.signal?.aborted
      )
        throw err;
      await recordUsage({
        projectId: input.projectId,
        task: 'answer',
        model,
        usage: { input: promptTokens, cached: 0, output: 0 },
        ok: false,
        error: `${err.message} (falling back to ${light})`,
        settings: s,
      });
      fallback = true;
      res = await chatStream(messages, {
        model: light,
        settings: s,
        onDelta: input.onDelta,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
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
      ...(fallback ? { fallback: true } : {}),
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
