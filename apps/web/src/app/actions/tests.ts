'use server';

import type { TestResult } from '@quire/shared';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { db } from '@/db/client';
import { rereadItems, testQuestions, tests } from '@/db/schema';
import { BudgetError } from '@/lib/ai/ledger';
import { estimateTest, runReread, runTestGeneration, startTest, type TestEstimate } from '@/lib/ai/tests';
import { removeStoredFile } from '@/lib/files';
import { getProjectBySlug, projectBase } from '@/lib/projects';
import { getTest } from '@/lib/tests';

export interface ActionState {
  error?: string;
  ok?: boolean;
}

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

export async function estimateTestAction(
  slug: string,
  kind: 'weekly' | 'triweekly',
  sessionIds: string[],
): Promise<TestEstimate> {
  const project = await projectOr404(slug);
  return estimateTest(project.id, { kind, sessionIds });
}

export async function startTestAction(
  slug: string,
  kind: 'weekly' | 'triweekly',
  sessionIds: string[],
): Promise<ActionState & { testId?: string }> {
  const project = await projectOr404(slug);
  try {
    const row = await startTest(project.id, { kind, sessionIds });
    after(() => runTestGeneration(project.id, row.id));
    revalidatePath(`${projectBase(project)}/tests`);
    return { ok: true, testId: row.id };
  } catch (err) {
    return { error: err instanceof BudgetError ? err.message : (err as Error).message };
  }
}

export async function markQuestionAction(
  slug: string,
  testId: string,
  questionId: string,
  result: TestResult | null,
) {
  const project = await projectOr404(slug);
  const t = await getTest(project.id, testId);
  if (!t) return;
  await db
    .update(testQuestions)
    .set({ result })
    .where(and(eq(testQuestions.testId, testId), eq(testQuestions.id, questionId)));
  revalidatePath(`${projectBase(project)}/tests/${testId}`);
}

/** Every question marked: close the test and pick what to re-read in the background. */
export async function finishMarkingAction(slug: string, testId: string): Promise<ActionState> {
  const project = await projectOr404(slug);
  const t = await getTest(project.id, testId);
  if (!t) return { error: 'Not found' };
  if (t.questions.some((q) => !q.result)) return { error: 'Mark every question first.' };
  await db
    .update(tests)
    .set({ status: 'marked', markedAt: new Date(), updatedAt: new Date() })
    .where(eq(tests.id, testId));
  after(() => runReread(project.id, testId));
  revalidatePath(`${projectBase(project)}/tests/${testId}`);
  revalidatePath(`${projectBase(project)}/tests`);
  revalidatePath(`${projectBase(project)}/overview`);
  return { ok: true };
}

export async function toggleRereadAction(slug: string, itemId: string, done: boolean): Promise<void> {
  const project = await projectOr404(slug);
  await db.update(rereadItems).set({ done }).where(eq(rereadItems.id, itemId));
  revalidatePath(`${projectBase(project)}/overview`);
  revalidatePath(`${projectBase(project)}/tests`, 'layout');
}

export async function deleteTestAction(slug: string, testId: string): Promise<void> {
  const project = await projectOr404(slug);
  const t = await getTest(project.id, testId);
  if (!t) return;
  await db.delete(tests).where(eq(tests.id, testId));
  await removeStoredFile(t.pdfPath);
  revalidatePath(`${projectBase(project)}/tests`);
  redirect(`${projectBase(project)}/tests`);
}
