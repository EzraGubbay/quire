// Synthesize a raw note into an exam-ready note: one model call in the background, status tracked on the note row.
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { documentPages, links, type Note, notes } from '@/db/schema';
import { builtinFolder } from '@/lib/documents';
import { mergedMacros } from '@/lib/macros';
import { createNote, getNote, syncLinks, updateNote } from '@/lib/notes';
import { getProjectById, projectMeta } from '@/lib/projects';
import { getSession } from '@/lib/sessions';
import { IMAGE_TOKENS_HIGH, renderPageImages, slideDataUrl } from '@/lib/slides';
import { indexOwner } from './index';
import { assertBudget, estimateTokens, recordUsage } from './ledger';
import { buildSynthesisPrompt } from './prompts/synthesis';
import { type ContentPart, chat, ProviderError } from './provider';
import { costFor, getAiSettings } from './settings';

const MAX_OUTPUT_TOKENS = 12_000;

export interface SynthesisEstimate {
  slides: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

/** Decks attached to the raw note's session (its slides are sent as text and images). */
async function sessionDecks(projectId: string, sessionId: string | null) {
  if (!sessionId) return [];
  const s = await getSession(projectId, sessionId);
  if (!s) return [];
  return s.documents.filter((d) => d.kind === 'pdf' && d.filePath);
}

export async function estimateSynthesis(projectId: string, rawNoteId: string): Promise<SynthesisEstimate> {
  const [s, note] = await Promise.all([getAiSettings(), getNote(projectId, rawNoteId)]);
  if (!note) throw new Error('note not found');
  const decks = await sessionDecks(projectId, note.sessionId);
  const slides = decks.reduce((n, d) => n + (d.pageCount ?? 0), 0);
  const pageText = decks.length
    ? await db
        .select({ text: documentPages.text })
        .from(documentPages)
        .where(
          inArray(
            documentPages.documentId,
            decks.map((d) => d.id),
          ),
        )
    : [];
  const text = pageText.reduce((n, p) => n + p.text.length, 0) + note.body.length + 6000;
  const inputTokens = estimateTokens(' '.repeat(text)) + slides * IMAGE_TOKENS_HIGH;
  const outputTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(2500, estimateTokens(note.body) * 3 + slides * 60),
  );
  const model = s.models.synthesis;
  return {
    slides,
    inputTokens,
    outputTokens,
    costUsd: costFor(s.prices, model, { input: inputTokens, cached: 0, output: outputTokens }),
    model,
  };
}

/**
 * Creates the target note (status generating, in the Synthesized folder, linked to the raw note) after a budget check.
 * The caller schedules `runSynthesis(targetId)` with `after()`.
 */
export async function startSynthesis(projectId: string, rawNoteId: string, title: string): Promise<Note> {
  const est = await estimateSynthesis(projectId, rawNoteId);
  await assertBudget(est.costUsd);
  const raw = await getNote(projectId, rawNoteId);
  if (!raw) throw new Error('note not found');
  const folder = await builtinFolder(projectId, 'synthesized');
  const target = await createNote(projectId, title, '', {
    folderId: folder?.id ?? null,
    sessionId: raw.sessionId,
    status: 'generating',
  });
  await db
    .insert(links)
    .values({
      projectId,
      fromKind: 'note',
      fromId: target.id,
      toKind: 'note',
      toId: raw.id,
      kind: 'synthesized',
    })
    .onConflictDoNothing();
  return target;
}

/** The raw note a synthesized note was made from, if any. */
export async function synthesizedFrom(projectId: string, noteId: string): Promise<Note | undefined> {
  const [l] = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.projectId, projectId),
        eq(links.fromKind, 'note'),
        eq(links.fromId, noteId),
        eq(links.kind, 'synthesized'),
      ),
    )
    .limit(1);
  return l ? getNote(projectId, l.toId) : undefined;
}

/** Synthesized notes made from a raw note, newest first. */
export async function synthesizedInto(projectId: string, rawNoteId: string): Promise<Note[]> {
  const rows = await db
    .select({ fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.projectId, projectId),
        eq(links.toKind, 'note'),
        eq(links.toId, rawNoteId),
        eq(links.kind, 'synthesized'),
      ),
    );
  if (rows.length === 0) return [];
  return db
    .select()
    .from(notes)
    .where(
      inArray(
        notes.id,
        rows.map((r) => r.fromId),
      ),
    )
    .orderBy(asc(notes.createdAt));
}

export async function setSynthesizedFrom(
  projectId: string,
  noteId: string,
  rawNoteId: string | null,
): Promise<void> {
  await db
    .delete(links)
    .where(
      and(
        eq(links.projectId, projectId),
        eq(links.fromKind, 'note'),
        eq(links.fromId, noteId),
        eq(links.kind, 'synthesized'),
      ),
    );
  if (rawNoteId)
    await db
      .insert(links)
      .values({
        projectId,
        fromKind: 'note',
        fromId: noteId,
        toKind: 'note',
        toId: rawNoteId,
        kind: 'synthesized',
      })
      .onConflictDoNothing();
}

/** Runs in the background: reads the raw note and slides, calls the model, fills the target note. */
export async function runSynthesis(projectId: string, targetId: string): Promise<void> {
  const s = await getAiSettings();
  const model = s.models.synthesis;
  const fail = (message: string) =>
    updateNote(projectId, targetId, { status: 'failed', error: message.slice(0, 2000) });
  try {
    const [target, project] = await Promise.all([getNote(projectId, targetId), getProjectById(projectId)]);
    if (!target || !project) return;
    const raw = await synthesizedFrom(projectId, targetId);
    if (!raw) {
      await fail('The raw note this was synthesized from no longer exists.');
      return;
    }
    const decks = await sessionDecks(projectId, raw.sessionId);
    const deckInputs = [];
    const images: ContentPart[] = [];
    for (const d of decks) {
      const pages = await db
        .select({ pageNo: documentPages.pageNo, text: documentPages.text })
        .from(documentPages)
        .where(eq(documentPages.documentId, d.id))
        .orderBy(asc(documentPages.pageNo));
      deckInputs.push({ title: d.title, pages });
      const imgs = await renderPageImages(d).catch(() => []);
      for (const img of imgs) {
        images.push({ type: 'image_url', image_url: { url: await slideDataUrl(img.path), detail: 'high' } });
      }
    }
    const meta = projectMeta(project);
    const macros = (await mergedMacros(projectId)).map((m) => ({
      name: m.name,
      definition: m.definition,
      arity: m.arity,
    }));
    const prompt = buildSynthesisPrompt({
      courseName: project.name,
      courseDescription: project.description,
      courseType: meta.type,
      macros,
      decks: deckInputs,
      rawTitle: raw.title,
      rawBody: raw.body,
      imageCount: images.length,
    });
    const res = await chat(
      [
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: images.length ? [{ type: 'text', text: prompt.user }, ...images] : prompt.user,
        },
      ],
      { model, maxTokens: MAX_OUTPUT_TOKENS, settings: s, timeoutMs: 600_000 },
    );
    await recordUsage({ projectId, task: 'synthesize', model: res.model, usage: res.usage, settings: s });
    const body = stripWrapping(res.text);
    await updateNote(projectId, targetId, { body, status: 'ready', error: null });
    await syncLinks(projectId, 'note', targetId, body);
    await indexOwner(projectId, 'note', targetId).catch(() => {});
    // Keep the synthesized edge: syncLinks only rewrites wiki edges.
  } catch (err) {
    const message = err instanceof ProviderError ? `${err.kind}: ${err.message}` : (err as Error).message;
    await recordUsage({
      projectId,
      task: 'synthesize',
      model,
      usage: { input: 0, cached: 0, output: 0 },
      ok: false,
      error: message,
    }).catch(() => {});
    await fail(message);
  }
}

/** Models sometimes wrap the whole answer in a fence or add an H1 despite instructions; undo that. */
export function stripWrapping(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence?.[1]) t = fence[1].trim();
  t = t.replace(/^#\s+[^\n]+\n+/, '');
  return t;
}

/** Boot cleanup: a note still "generating" long after its start was killed with the process. */
export async function failStaleGenerating(olderThanMinutes = 20): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await db
    .update(notes)
    .set({ status: 'failed', error: 'Interrupted by a restart. Retry to synthesize again.' })
    .where(and(eq(notes.status, 'generating'), lt(notes.updatedAt, cutoff)))
    .returning({ id: notes.id });
  return rows.length;
}
