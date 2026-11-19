import { z } from 'zod';
import { aiConfigured } from '@/lib/ai/provider';
import { getThread, listMessages } from '@/lib/chat';
import { NDJSON_HEADERS } from '@/lib/chat-stream';
import { startChatTurn } from '@/lib/chat-turn';
import { mobileStreamShape, toMessage } from '@/lib/mobile/chat';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ course: string; threadId: string }> };

const bodySchema = z.union([
  z.object({ question: z.string().trim().min(1).max(8000) }),
  z.object({ retry: z.literal(true) }),
]);

async function lookup(ctx: Ctx) {
  const { course, threadId } = await ctx.params;
  const project = await getProjectBySlug(course);
  if (project?.kind !== 'course') return { response: fail('not_found', 'Course not found') };
  const thread = await getThread(project.id, threadId);
  if (!thread) return { response: fail('not_found', 'Thread not found') };
  return { project, thread };
}

export async function GET(req: Request, ctx: Ctx) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const found = await lookup(ctx);
  if ('response' in found) return found.response;
  return ok((await listMessages(found.thread.id)).map(toMessage));
}

export async function POST(req: Request, ctx: Ctx) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const found = await lookup(ctx);
  if ('response' in found) return found.response;
  if (!aiConfigured()) return fail('ai_unavailable', 'AI is not configured on the server');
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail('invalid_request', 'Body must be JSON');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail('invalid_request', 'Body must be { question } or { retry: true }');
  const stream = await startChatTurn({
    project: found.project,
    thread: found.thread,
    input: parsed.data,
    signal: req.signal,
    shape: mobileStreamShape(),
  });
  if (!stream) return fail('invalid_request', 'Nothing to retry');
  return new Response(stream, { headers: NDJSON_HEADERS });
}
