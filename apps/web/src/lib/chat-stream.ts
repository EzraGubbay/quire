// Shared NDJSON streaming for chat answers: used by the web route and the mobile v1 route.
import { type AnswerResult, BudgetError, ProviderError } from '@/lib/ai/answer';

export interface ChatErrorInfo<M> {
  message: string;
  kind: string;
  /** The persisted failed-assistant stub row. */
  saved: M;
}

/** How each stream event is serialised; web and mobile differ only in message and error shapes. */
export interface ChatStreamShape<M> {
  user(message: M): unknown;
  done(message: M, fallback: boolean): unknown;
  error(info: ChatErrorInfo<M>): unknown;
}

export function webStreamShape<M>(): ChatStreamShape<M> {
  return {
    user: (message) => ({ type: 'user', message }),
    done: (message, fallback) => ({ type: 'done', message, fallback }),
    error: ({ message, kind, saved }) => ({
      type: 'error',
      message,
      kind,
      saved,
    }),
  };
}

export interface ChatStreamDeps<M> {
  userMessage: M;
  /** Runs the model; call `onDelta` for each streamed chunk. Wire the request's AbortSignal in here. */
  run(onDelta: (text: string) => void): Promise<AnswerResult>;
  saveAnswer(res: AnswerResult): Promise<M>;
  saveFailure(message: string, partial: string): Promise<M>;
  shape?: ChatStreamShape<M>;
}

export function errorKind(err: unknown): string {
  return err instanceof BudgetError ? 'budget' : err instanceof ProviderError ? err.kind : 'other';
}

/** Event order: `user`, `delta`*, then exactly one of `done` / `error`. */
export function chatEventStream<M>(deps: ChatStreamDeps<M>): ReadableStream<Uint8Array> {
  const shape = deps.shape ?? webStreamShape<M>();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          open = false; // client went away
        }
      };
      send(shape.user(deps.userMessage));
      try {
        const res = await deps.run((text) => send({ type: 'delta', text }));
        const saved = await deps.saveAnswer(res);
        send(shape.done(saved, res.fallback ?? false));
      } catch (err) {
        const message = (err as Error).message;
        const partial = err instanceof ProviderError ? err.partial : '';
        const saved = await deps.saveFailure(message, partial);
        send(shape.error({ message, kind: errorKind(err), saved }));
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
}

export const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
} as const;
