import { z } from 'zod';
import { answer, BudgetError, ProviderError } from '@/lib/ai/answer';
import { aiConfigured } from '@/lib/ai/provider';
import { apiError, projectFromSlug, readJson } from '@/lib/api';
import { addMessage, getThread, listMessages, renameThread, touchThread } from '@/lib/chat';

export const dynamic = 'force-dynamic';

const schema = z.object({ question: z.string().trim().min(1).max(8000) });

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
  const question = body.data.question;
  const history = (await listMessages(threadId))
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  const userMsg = await addMessage(threadId, { role: 'user', content: question });
  if (history.length === 0) await renameThread(threadId, question.slice(0, 80));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      send({ type: 'user', message: userMsg });
      try {
        const res = await answer({
          projectId: project.id,
          slug,
          projectName: project.name,
          question,
          history,
          documentId: thread.documentId,
          onDelta: (text) => send({ type: 'delta', text }),
          signal: req.signal,
        });
        const saved = await addMessage(threadId, {
          role: 'assistant',
          content: res.text,
          citations: res.citations,
          model: res.model,
          inputTokens: res.usage.input,
          outputTokens: res.usage.output,
          costUsd: res.costUsd,
        });
        await touchThread(threadId);
        send({ type: 'done', message: saved });
      } catch (err) {
        const kind =
          err instanceof BudgetError ? 'budget' : err instanceof ProviderError ? err.kind : 'other';
        const message = (err as Error).message;
        const saved = await addMessage(threadId, { role: 'assistant', content: '', error: message });
        send({ type: 'error', message, kind, saved });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
