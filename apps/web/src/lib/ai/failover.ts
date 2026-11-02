// Circuit breaker for the Claude routes. When a Claude route (claude-api or claude-sub) fails this many times
// in a row, generation falls over to OpenAI for a cooldown window; a single Claude success clears it. Both knobs
// are env-overridable so they can be tuned on the Pi without a redeploy.
import { type AiSettings, getAiSettings, saveAiSettings } from './settings';

export const CLAUDE_FAILOVER_STRIKES = Math.max(
  1,
  Math.round(Number(process.env.CLAUDE_FAILOVER_STRIKES)) || 3,
);
export const CLAUDE_FAILOVER_HOURS =
  Number(process.env.CLAUDE_FAILOVER_HOURS) > 0 ? Number(process.env.CLAUDE_FAILOVER_HOURS) : 6;

export const isClaudeProvider = (p: AiSettings['provider']): boolean =>
  p === 'claude-api' || p === 'claude-sub';

/** True while an open failover window still lies in the future. */
export function failoverActive(s: AiSettings, now = Date.now()): boolean {
  const until = s.claudeFailover.until;
  return until != null && new Date(until).getTime() > now;
}

/**
 * The backend that should serve generation right now. A Claude route degrades to 'openai' while the failover
 * window is open; every other setting is served as configured. (Embeddings never consult this — always OpenAI.)
 */
export function effectiveProvider(s: AiSettings, now = Date.now()): AiSettings['provider'] {
  if (isClaudeProvider(s.provider) && failoverActive(s, now)) return 'openai';
  return s.provider;
}

/** When a window is open, the time it lifts (for the settings banner); null otherwise. */
export function failoverUntil(s: AiSettings, now = Date.now()): string | null {
  return failoverActive(s, now) ? s.claudeFailover.until : null;
}

/**
 * The state after one more Claude failure. A Claude route is only tried when no window is open, so on entry any
 * stored `until` is already spent and is cleared; reaching the strike limit opens a fresh cooldown window and
 * resets the counter. Pure (testable); `noteClaudeFailure` persists it.
 */
export function nextFailoverState(
  cur: AiSettings['claudeFailover'],
  now = Date.now(),
): AiSettings['claudeFailover'] {
  const fails = cur.consecutiveFails + 1;
  const open = fails >= CLAUDE_FAILOVER_STRIKES;
  return {
    consecutiveFails: open ? 0 : fails,
    until: open ? new Date(now + CLAUDE_FAILOVER_HOURS * 3_600_000).toISOString() : null,
  };
}

/** Record one Claude failure; opens the cooldown window once the strike limit is hit. Returns the new state. */
export async function noteClaudeFailure(s?: AiSettings): Promise<AiSettings['claudeFailover']> {
  const cur = (s ?? (await getAiSettings())).claudeFailover;
  const next = nextFailoverState(cur);
  await saveAiSettings({ claudeFailover: next });
  return next;
}

/** Clear the strike counter after a Claude success; no write unless something was actually set. */
export async function noteClaudeSuccess(s?: AiSettings): Promise<void> {
  const cur = (s ?? (await getAiSettings())).claudeFailover;
  if (cur.consecutiveFails === 0 && cur.until == null) return;
  await saveAiSettings({ claudeFailover: { consecutiveFails: 0, until: null } });
}
