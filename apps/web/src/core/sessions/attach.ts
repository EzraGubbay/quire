/**
 * Attach check: does a file name agree with the session it is attached to?
 *
 * Pure on purpose: it lives in core, so it imports nothing but the name parser and a shared type.
 */
import type { SessionKind } from '@quire/shared';
import { parseSessionName } from './naming';

export type AttachCheck =
  | { ok: true }
  | {
      ok: false;
      mismatch: true;
      fileNumber: number;
      sessionNumber: number;
      fileKind?: SessionKind;
      sessionKind: SessionKind;
    };

/** A file with no number bound to a kind word never mismatches; a different number or kind does. */
export function checkAttach(session: { kind: SessionKind; number: number }, fileName: string): AttachCheck {
  const parsed = parseSessionName(fileName);
  if (parsed?.number === undefined) return { ok: true };
  if (parsed.number === session.number && parsed.kind === session.kind) return { ok: true };
  return {
    ok: false,
    mismatch: true,
    fileNumber: parsed.number,
    sessionNumber: session.number,
    fileKind: parsed.kind,
    sessionKind: session.kind,
  };
}
