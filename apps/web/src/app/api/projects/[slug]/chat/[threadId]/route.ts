import { z } from 'zod';
import { aiConfigured } from '@/lib/ai/provider';
import { apiError, projectFromSlug, readJson } from '@/lib/api';
import { getThread } from '@/lib/chat';
import { NDJSON_HEADERS } from '@/lib/chat-stream';
import { startChatTurn } from '@/lib/chat-turn';

export const dynamic = 'force-dynamic';

const schema = z.union([
  z.object({ question: z.string().trim().min(1).max(8000) }),
  /** Ask the thread's last question again (after a failed answer); no new user row is written. */
  z.object({ retry: z.literal(true) }),
]);

/**
 * POST a question; the response streams newline-delimited JSON events:
 * {type:'delta', text} … {type:'done', message} or {type:'error', message, kind}.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; threadId: string }> }) {
  const { slug, threadId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  const thread = await getThread(project.id, threadId);
  if (!thread) return apiError('thread not found', 404);
  if (!aiConfigured()) return apiError('AI is not configured: set OPENAI_API_KEY on the server.', 503);
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  const stream = await startChatTurn({
    project,
    thread,
    input: body.data,
    signal: req.signal,
  });
  if (!stream) return apiError('nothing to retry', 400);
  return new Response(stream, { headers: NDJSON_HEADERS });
}
