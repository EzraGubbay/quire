// One chat turn on top of chat.ts + answer(): shared by the web and mobile chat routes.

import type { ChatMessage, ChatThread, Project } from '@/db/schema';
import { answer } from '@/lib/ai/answer';
import {
  addMessage,
  dropFailedAfter,
  lastUserMessage,
  listMessages,
  renameThread,
  touchThread,
} from '@/lib/chat';
import { type ChatStreamShape, chatEventStream } from '@/lib/chat-stream';
import { projectBase } from '@/lib/projects';

export type TurnInput = { question: string } | { retry: true };

/** Returns the NDJSON stream, or `null` when asked to retry a thread with no question. */
export async function startChatTurn(args: {
  project: Project;
  thread: ChatThread;
  input: TurnInput;
  signal?: AbortSignal;
  shape?: ChatStreamShape<ChatMessage>;
}): Promise<ReadableStream<Uint8Array> | null> {
  const { project, thread, input, signal, shape } = args;
  const threadId = thread.id;
  const retry = 'retry' in input;
  let question: string;
  let userMsg: ChatMessage | undefined;
  if ('retry' in input) {
    const last = await lastUserMessage(threadId);
    if (!last) return null;
    await dropFailedAfter(threadId, last.createdAt);
    question = last.content;
    userMsg = last;
  } else question = input.question;
  const history = (await listMessages(threadId))
    .filter((m) => !m.error && m.id !== userMsg?.id)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  if (!retry) {
    userMsg = await addMessage(threadId, { role: 'user', content: question });
    if (history.length === 0) await renameThread(threadId, question.slice(0, 80));
  }
  if (!userMsg) return null;

  return chatEventStream<ChatMessage>({
    userMessage: userMsg,
    shape,
    run: (onDelta) =>
      answer({
        projectId: project.id,
        base: projectBase(project),
        projectName: project.name,
        question,
        history,
        documentId: thread.documentId,
        mode: thread.mode,
        course: project.kind === 'course',
        onDelta,
        signal,
      }),
    saveAnswer: async (res) => {
      const saved = await addMessage(threadId, {
        role: 'assistant',
        content: res.text,
        citations: res.citations,
        model: res.model,
        fallback: res.fallback ?? false,
        inputTokens: res.usage.input,
        outputTokens: res.usage.output,
        costUsd: res.costUsd,
      });
      await touchThread(threadId);
      return saved;
    },
    saveFailure: (message, partial) =>
      addMessage(threadId, {
        role: 'assistant',
        content: partial,
        error: message,
      }),
  });
}
