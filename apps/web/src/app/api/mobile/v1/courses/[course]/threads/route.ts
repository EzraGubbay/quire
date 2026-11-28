import { z } from 'zod';
import { createThread, listThreads } from '@/lib/chat';
import { resolveCourse } from '@/lib/mcp/courses';
import { toThread } from '@/lib/mobile/chat';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';
import { CreateThreadRequest } from '@/lib/mobile/schema';

export const dynamic = 'force-dynamic';

const createSchema = CreateThreadRequest.extend({
  mode: z.string().min(1).max(40).optional(),
});

async function courseOf(slug: string) {
  const p = await resolveCourse(slug);
  return p && p.kind === 'course' ? p : null;
}

export async function GET(req: Request, ctx: { params: Promise<{ course: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course } = await ctx.params;
  const project = await courseOf(course);
  if (!project) return fail('not_found', 'Course not found');
  const documentId = new URL(req.url).searchParams.get('documentId');
  const rows = await listThreads(project.id, documentId);
  return ok(rows.map((t) => toThread(t, project.slug)));
}

export async function POST(req: Request, ctx: { params: Promise<{ course: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course } = await ctx.params;
  const project = await courseOf(course);
  if (!project) return fail('not_found', 'Course not found');
  let body: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return fail('invalid_request', 'Body must be JSON');
    }
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success)
    return fail(
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  const thread = await createThread(project.id, parsed.data);
  return ok(toThread(thread, project.slug), 201);
}
