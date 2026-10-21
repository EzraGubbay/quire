'use client';

/**
 * Cross-tab "this note changed" signal, so a note open in read mode re-renders the moment it is saved from
 * another tab (the lecture page's note pane, the editor). Same browser only; other devices rely on polling.
 */
const CHANNEL = 'quire:notes';

export interface NoteChange {
  id: string;
  at: number;
}

export function announceNoteChange(id: string): void {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ id, at: Date.now() } satisfies NoteChange);
    ch.close();
  } catch {}
}

/** Subscribes; returns the unsubscribe function. */
export function onNoteChange(handler: (change: NoteChange) => void): () => void {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (e: MessageEvent<NoteChange>) => {
      if (e.data && typeof e.data.id === 'string') handler(e.data);
    };
    return () => ch.close();
  } catch {
    return () => {};
  }
}
