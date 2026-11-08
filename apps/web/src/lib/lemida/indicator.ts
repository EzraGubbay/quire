// Pure, client-safe derivation of the global Lemida sign-in dot's colour. Deliberately kept out of ./state
// (which imports the DB client) so a client component can import it without dragging server-only modules —
// postgres/`fs` — into the browser bundle.

/** The global sign-in dot's colour. */
export type LemidaIndicator = 'green' | 'orange' | 'red';

/**
 * The colour of the global Lemida sign-in dot, *derived* from the stored state rather than persisted — so
 * it can be recomputed on the client and flip to orange on its own once the viewer's local midnight passes,
 * without any server write. `now` is a parameter so the midnight boundary is testable.
 *
 *  - red    — a probe was sent and the session was confirmed signed out (`expired`).
 *  - green  — confirmed signed in, and that confirmation happened on the current local day.
 *  - orange — was valid but local 12AM of the next day has passed since the last check (re-verify), or the
 *             session has never been checked (`unknown` / no `checkedAt`).
 */
export function lemidaIndicator(
  state: { sessionStatus: 'unknown' | 'valid' | 'expired'; checkedAt: string | null },
  now: Date,
): LemidaIndicator {
  if (state.sessionStatus === 'expired') return 'red';
  if (state.sessionStatus === 'valid' && state.checkedAt) {
    const checked = Date.parse(state.checkedAt);
    if (!Number.isFinite(checked)) return 'orange';
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return checked >= midnight.getTime() ? 'green' : 'orange';
  }
  return 'orange';
}
