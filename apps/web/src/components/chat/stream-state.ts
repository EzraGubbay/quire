// The waiting indicator is driven by the real NDJSON stream, not a timer: this maps a streamed
// assistant message's live state (the `delta` / `done` / `error` events the chat route emits) onto
// the four phases the UI renders, so "still coming" always reads differently from "it failed".

/** thinking: pending, no token yet · streaming: tokens arriving · done: settled ok · error: stream failed. */
export type StreamPhase = 'thinking' | 'streaming' | 'done' | 'error';

/** The slice of a streamed assistant message the phase depends on. */
export interface StreamStateInput {
  /** True between send and the terminal `done`/`error` event. */
  pending?: boolean;
  content: string;
  /** Set by an `error` event or a transport failure; wins over everything. */
  error: string | null;
}

/**
 * A failed stream reads as stopped, never as still working — even when some text streamed before the
 * provider died (`ProviderError.partial`) or the budget tripped — so `error` takes priority. While
 * pending the phase is `thinking` before the first token and `streaming` once text is arriving;
 * anything settled without an error is `done`.
 */
export function streamPhase(m: StreamStateInput): StreamPhase {
  if (m.error) return 'error';
  if (m.pending) return m.content.trim() ? 'streaming' : 'thinking';
  return 'done';
}

/** Whether the indicator should animate: the answer is still on its way. */
export function isWorking(phase: StreamPhase): boolean {
  return phase === 'thinking' || phase === 'streaming';
}
