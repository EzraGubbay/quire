// Self-tests: generated in the background from notes, slides and practice exams; marked by hand; followed by an
// AI-picked re-read list.
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import GithubSlugger from 'github-slugger';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  assignments,
  documentPages,
  documents,
  notes,
  rereadItems,
  sessions,
  type Test,
  testQuestions,
  tests,
} from '@/db/schema';
import { listPracticeExams } from '@/lib/documents';
import { getProjectById, projectMeta } from '@/lib/projects';
import { PRACTICE_EXAMS_REQUIRED, practiceExamCount } from '@/lib/tests';
import { renderTestPdf } from '@/lib/tests-pdf';
import { assertBudget, estimateTokens, recordUsage } from './ledger';
import { REREAD_SYSTEM, TRIWEEKLY_SYSTEM, TYPE_HINT, WEEKLY_SYSTEM } from './prompts/tests';
import { chat, ProviderError } from './provider';
import { costFor, getAiSettings } from './settings';

export const testOutputSchema = z.object({
  title: z.string().trim().max(200).optional(),
  questions: z
    .array(
      z.object({
        n: z.coerce.number().int().min(1),
        body: z.string().trim().min(1),
        modelAnswer: z.string().default(''),
        concept: z.string().trim().max(120).default(''),
        points: z.coerce.number().min(0).default(1),
      }),
    )
    .min(1),
});
export type TestOutput = z.infer<typeof testOutputSchema>;

export const rereadOutputSchema = z.object({
  items: z
    .array(
      z.object({
        questionN: z.coerce.number().int().min(1),
        kind: z.enum(['note', 'slide']),
        noteId: z.string().uuid().optional(),
        heading: z.string().trim().max(200).optional(),
        documentId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).optional(),
        reason: z.string().trim().max(400).default(''),
      }),
    )
    .default([]),
});

interface TestInput {
  kind: 'weekly' | 'triweekly';
  sessionIds: string[];
}

export interface TestEstimate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  practiceExams: number;
}

/** Notes that cover the given sessions: synthesized where they exist, else raw. */
async function notesForSessions(projectId: string, sessionIds: string[] | null) {
  const rows = await db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.projectId, projectId),
        eq(notes.status, 'ready'),
        sessionIds ? inArray(notes.sessionId, sessionIds) : sql`true`,
      ),
    )
    .orderBy(asc(notes.createdAt));
  // A session with a synthesized note uses that; otherwise its raw note(s). Notes without a session count once.
  const bySession = new Map<string, typeof rows>();
  const loose: typeof rows = [];
  for (const n of rows) {
    if (!n.sessionId) {
      loose.push(n);
      continue;
    }
    bySession.set(n.sessionId, [...(bySession.get(n.sessionId) ?? []), n]);
  }
  const synthIds = new Set(
    (
      await db
        .select({ id: notes.id })
        .from(notes)
        .innerJoin(sql`folders f`, sql`f.id = ${notes.folderId}`)
        .where(and(eq(notes.projectId, projectId), sql`f.builtin = 'synthesized'`))
    ).map((r) => r.id),
  );
  const chosen: typeof rows = [];
  for (const list of bySession.values()) {
    const synth = list.filter((n) => synthIds.has(n.id));
    chosen.push(...(synth.length ? synth : list));
  }
  return { chosen: [...chosen, ...loose], coveredSessions: new Set(chosen.map((n) => n.sessionId)) };
}

async function slideText(projectId: string, sessionIds: string[]) {
  if (sessionIds.length === 0) return [];
  const docs = await db
    .select({ id: documents.id, title: documents.title, sessionId: documents.sessionId })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), inArray(documents.sessionId, sessionIds)));
  if (docs.length === 0) return [];
  const pages = await db
    .select({ documentId: documentPages.documentId, pageNo: documentPages.pageNo, text: documentPages.text })
    .from(documentPages)
    .where(
      inArray(
        documentPages.documentId,
        docs.map((d) => d.id),
      ),
    )
    .orderBy(asc(documentPages.documentId), asc(documentPages.pageNo));
  return docs.map((d) => ({
    title: d.title,
    text: pages
      .filter((p) => p.documentId === d.id)
      .map((p) => `[slide ${p.pageNo}] ${p.text}`)
      .join('\n'),
  }));
}

async function buildTestInput(
  projectId: string,
  input: TestInput,
): Promise<{ system: string; user: string }> {
  const project = await getProjectById(projectId);
  if (!project) throw new Error('project not found');
  const meta = projectMeta(project);
  const allSessions = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(asc(sessions.kind), asc(sessions.number));
  const scope =
    input.kind === 'weekly' ? allSessions.filter((s) => input.sessionIds.includes(s.id)) : allSessions;
  const { chosen, coveredSessions } = await notesForSessions(
    projectId,
    input.kind === 'weekly' ? input.sessionIds : null,
  );
  const uncovered = scope.filter((s) => !coveredSessions.has(s.id)).map((s) => s.id);
  const slides = await slideText(projectId, uncovered);
  const parts: string[] = [];
  parts.push(
    `# Course\n${project.name}${project.description ? `\n${project.description}` : ''}\n${TYPE_HINT[meta.type]}`,
  );
  parts.push(
    `# Sessions covered\n${scope.map((s) => `- ${s.kind} ${s.number}${s.title ? `: ${s.title}` : ''}`).join('\n') || '(none listed)'}`,
  );
  for (const n of chosen) parts.push(`# Note: ${n.title}\n\n${n.body}`);
  for (const d of slides) parts.push(`# Slides (no notes for this session): ${d.title}\n\n${d.text}`);
  if (input.kind === 'weekly') {
    const missed = await db
      .select({ concept: testQuestions.concept })
      .from(testQuestions)
      .innerJoin(tests, eq(tests.id, testQuestions.testId))
      .where(and(eq(tests.projectId, projectId), sql`${testQuestions.result} in ('fail','partial')`))
      .orderBy(desc(tests.createdAt))
      .limit(12);
    const concepts = [...new Set(missed.map((m) => m.concept).filter(Boolean))];
    if (concepts.length)
      parts.push(`# Concepts missed on recent tests\n${concepts.map((c) => `- ${c}`).join('\n')}`);
  } else {
    const { exams } = await listPracticeExams(projectId);
    const solutionIds = new Set(exams.map((e) => e.examMeta?.solutionDocumentId).filter(Boolean));
    const examDocs = exams.filter((e) => !solutionIds.has(e.id));
    for (const e of examDocs) {
      const pages = await db
        .select({ pageNo: documentPages.pageNo, text: documentPages.text })
        .from(documentPages)
        .where(eq(documentPages.documentId, e.id))
        .orderBy(asc(documentPages.pageNo));
      parts.push(
        `# Practice exam: ${e.title}${e.examMeta?.term ? ` (${e.examMeta.term})` : ''}\n\n${pages.map((p) => p.text).join('\n\n')}`,
      );
      const solId = e.examMeta?.solutionDocumentId;
      if (solId) {
        const sol = await db
          .select({ pageNo: documentPages.pageNo, text: documentPages.text })
          .from(documentPages)
          .where(eq(documentPages.documentId, solId))
          .orderBy(asc(documentPages.pageNo));
        if (sol.length) parts.push(`# Solutions for: ${e.title}\n\n${sol.map((p) => p.text).join('\n\n')}`);
      }
    }
    const lost = await db
      .select({ title: assignments.title, lost: assignments.lostPoints })
      .from(assignments)
      .where(and(eq(assignments.projectId, projectId), sql`${assignments.lostPoints} <> ''`));
    if (lost.length)
      parts.push(
        `# What I lost points on (homework)\n${lost.map((l) => `- ${l.title}: ${l.lost}`).join('\n')}`,
      );
  }
  parts.push('Return only the JSON object.');
  return {
    system: input.kind === 'weekly' ? WEEKLY_SYSTEM : TRIWEEKLY_SYSTEM,
    user: parts.join('\n\n---\n\n'),
  };
}

export async function estimateTest(projectId: string, input: TestInput): Promise<TestEstimate> {
  const s = await getAiSettings();
  const model = input.kind === 'weekly' ? s.models.testWeekly : s.models.testTriweekly;
  const prompt = await buildTestInput(projectId, input);
  const inputTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user);
  const outputTokens = input.kind === 'weekly' ? 3000 : 8000;
  return {
    inputTokens,
    outputTokens,
    costUsd: costFor(s.prices, model, { input: inputTokens, cached: 0, output: outputTokens }),
    model,
    practiceExams: await practiceExamCount(projectId),
  };
}

/** Creates the test row (generating) after the budget and practice-exam checks; the caller schedules runTestGeneration. */
export async function startTest(projectId: string, input: TestInput): Promise<Test> {
  if (input.kind === 'triweekly') {
    const n = await practiceExamCount(projectId);
    if (n < PRACTICE_EXAMS_REQUIRED)
      throw new Error(
        `A tri-weekly test needs at least ${PRACTICE_EXAMS_REQUIRED} practice exams (${n} so far).`,
      );
  }
  if (input.kind === 'weekly' && input.sessionIds.length === 0)
    throw new Error('Pick at least one lecture or recitation.');
  const est = await estimateTest(projectId, input);
  await assertBudget(est.costUsd);
  const title =
    input.kind === 'weekly'
      ? `Weekly test · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      : `Tri-weekly test · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  const [row] = await db
    .insert(tests)
    .values({
      projectId,
      kind: input.kind,
      title,
      sessionIds: input.sessionIds,
      model: est.model,
      status: 'generating',
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Parses the model's JSON, tolerating a code fence or stray prose around it. */
export function parseJsonObject(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error('The model did not return JSON.');
}

export async function runTestGeneration(projectId: string, testId: string): Promise<void> {
  const s = await getAiSettings();
  const [row] = await db.select().from(tests).where(eq(tests.id, testId)).limit(1);
  if (!row) return;
  const model = row.kind === 'weekly' ? s.models.testWeekly : s.models.testTriweekly;
  const fail = (message: string) =>
    db
      .update(tests)
      .set({ status: 'failed', error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(tests.id, testId));
  try {
    const prompt = await buildTestInput(projectId, { kind: row.kind, sessionIds: row.sessionIds });
    let out: TestOutput | null = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      const res = await chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          model,
          json: true,
          maxTokens: row.kind === 'weekly' ? 6000 : 16_000,
          settings: s,
          timeoutMs: 600_000,
        },
      );
      await recordUsage({
        projectId,
        task: `test-${row.kind}`,
        model: res.model,
        usage: res.usage,
        settings: s,
      });
      const parsed = testOutputSchema.safeParse(parseJsonObject(res.text));
      if (parsed.success) out = parsed.data;
      else lastErr = parsed.error.issues[0]?.message ?? 'bad shape';
    }
    if (!out) throw new Error(`The model's answer was not a valid test (${lastErr}).`);
    const questions = out.questions.map((q, i) => ({ ...q, n: i + 1 }));
    await db.insert(testQuestions).values(
      questions.map((q) => ({
        testId,
        n: q.n,
        body: q.body,
        modelAnswer: q.modelAnswer,
        concept: q.concept,
        points: q.points,
      })),
    );
    const title = out.title?.trim()
      ? `${out.title.trim()} · ${row.title.split(' · ')[1] ?? ''}`.trim()
      : row.title;
    const project = await getProjectById(projectId);
    let pdfPath: string | null = null;
    try {
      pdfPath = await renderTestPdf({ projectId, testId, title, courseName: project?.name ?? '', questions });
    } catch {
      pdfPath = null; // no renderer configured; the print view stands in
    }
    await db
      .update(tests)
      .set({ status: 'ready', title, pdfPath, model, updatedAt: new Date() })
      .where(eq(tests.id, testId));
  } catch (err) {
    const message = err instanceof ProviderError ? `${err.kind}: ${err.message}` : (err as Error).message;
    await recordUsage({
      projectId,
      task: `test-${row.kind}`,
      model,
      usage: { input: 0, cached: 0, output: 0 },
      ok: false,
      error: message,
    }).catch(() => {});
    await fail(message);
  }
}

/** Heading index of a course's notes for the re-read prompt: [{noteId, title, headings:[{text, slug}]}]. */
export async function headingIndex(projectId: string) {
  const rows = await db
    .select({ id: notes.id, title: notes.title, body: notes.body })
    .from(notes)
    .where(and(eq(notes.projectId, projectId), eq(notes.status, 'ready')));
  return rows.map((n) => {
    const slugger = new GithubSlugger();
    const headings = [...n.body.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((m) => {
      const text = (m[2] ?? '').replace(/[*_`]/g, '').trim();
      return { text, slug: slugger.slug(text) };
    });
    return { noteId: n.id, title: n.title, headings };
  });
}

/** After marking: asks the model which note sections and slides to re-read for every failed or partial question. */
export async function runReread(projectId: string, testId: string): Promise<void> {
  const s = await getAiSettings();
  const model = s.models.light;
  const [row] = await db.select().from(tests).where(eq(tests.id, testId)).limit(1);
  if (!row) return;
  const qs = await db
    .select()
    .from(testQuestions)
    .where(eq(testQuestions.testId, testId))
    .orderBy(asc(testQuestions.n));
  const failed = qs.filter((q) => q.result === 'fail' || q.result === 'partial');
  await db.delete(rereadItems).where(eq(rereadItems.testId, testId));
  if (failed.length === 0) return;
  try {
    const index = await headingIndex(projectId);
    const decks = await db
      .select({
        id: documents.id,
        title: documents.title,
        pageCount: documents.pageCount,
        sessionId: documents.sessionId,
      })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), sql`${documents.sessionId} is not null`));
    const deckText = await slideText(projectId, [
      ...new Set(decks.map((d) => d.sessionId).filter((x): x is string => Boolean(x))),
    ]);
    const user = [
      `# Failed questions\n${failed
        .map(
          (q) =>
            `## Q${q.n} (${q.result}; concept: ${q.concept || 'n/a'})\n${q.body}\n\n**Model answer:** ${q.modelAnswer}`,
        )
        .join('\n\n')}`,
      `# Notes index\n${index
        .map(
          (n) =>
            `- note "${n.title}" id=${n.noteId}\n${n.headings.map((h) => `  - ${h.text} (slug: ${h.slug})`).join('\n')}`,
        )
        .join('\n')}`,
      `# Decks\n${decks.map((d) => `- "${d.title}" id=${d.id} slides=${d.pageCount ?? '?'}`).join('\n')}\n\n${deckText
        .map((d) => `## ${d.title}\n${d.text.slice(0, 12_000)}`)
        .join('\n\n')}`,
      'Return only the JSON object.',
    ].join('\n\n---\n\n');
    const res = await chat(
      [
        { role: 'system', content: REREAD_SYSTEM },
        { role: 'user', content: user },
      ],
      { model, json: true, maxTokens: 3000, settings: s, timeoutMs: 300_000 },
    );
    await recordUsage({ projectId, task: 'reread', model: res.model, usage: res.usage, settings: s });
    const parsed = rereadOutputSchema.safeParse(parseJsonObject(res.text));
    if (!parsed.success) return;
    const noteTitles = new Map(index.map((n) => [n.noteId, n]));
    const deckTitles = new Map(decks.map((d) => [d.id, d]));
    const qByN = new Map(failed.map((q) => [q.n, q]));
    type RereadInsert = typeof rereadItems.$inferInsert;
    const values = parsed.data.items.flatMap((it): RereadInsert[] => {
      const q = qByN.get(it.questionN);
      if (!q) return [];
      if (it.kind === 'note' && it.noteId && noteTitles.has(it.noteId)) {
        const n = noteTitles.get(it.noteId);
        const h = n?.headings.find(
          (x) => x.slug === it.heading || x.text.toLowerCase() === it.heading?.toLowerCase(),
        );
        return [
          {
            testId,
            testQuestionId: q.id,
            targetKind: 'note' as const,
            targetId: it.noteId,
            anchor: h?.slug ?? null,
            title: `${n?.title ?? 'Note'}${h ? ` › ${h.text}` : ''}`,
            reason: it.reason,
          },
        ];
      }
      if (it.kind === 'slide' && it.documentId && deckTitles.has(it.documentId)) {
        const d = deckTitles.get(it.documentId);
        return [
          {
            testId,
            testQuestionId: q.id,
            targetKind: 'document' as const,
            targetId: it.documentId,
            anchor: it.page ? String(it.page) : null,
            title: `${d?.title ?? 'Deck'}${it.page ? ` · slide ${it.page}` : ''}`,
            reason: it.reason,
          },
        ];
      }
      return [];
    });
    if (values.length) await db.insert(rereadItems).values(values);
  } catch (err) {
    await recordUsage({
      projectId,
      task: 'reread',
      model,
      usage: { input: 0, cached: 0, output: 0 },
      ok: false,
      error: (err as Error).message,
    }).catch(() => {});
  }
}

export async function failStaleTests(olderThanMinutes = 20): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await db
    .update(tests)
    .set({ status: 'failed', error: 'Interrupted by a restart. Generate the test again.' })
    .where(and(eq(tests.status, 'generating'), lt(tests.updatedAt, cutoff)))
    .returning({ id: tests.id });
  return rows.length;
}
