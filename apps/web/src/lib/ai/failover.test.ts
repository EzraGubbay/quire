import { describe, expect, it } from 'vitest';
import { hasImages, stripImages } from './claude';
import {
  CLAUDE_FAILOVER_STRIKES,
  effectiveProvider,
  failoverActive,
  isClaudeProvider,
  nextFailoverState,
} from './failover';
import { type AiSettings, aiSettingsSchema } from './settings';

const base = (patch: Partial<AiSettings> = {}): AiSettings => aiSettingsSchema.parse(patch);
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const future = new Date(NOW + 60 * 60_000).toISOString();
const past = new Date(NOW - 60 * 60_000).toISOString();

describe('isClaudeProvider', () => {
  it('matches only the two Claude routes', () => {
    expect(isClaudeProvider('claude-api')).toBe(true);
    expect(isClaudeProvider('claude-sub')).toBe(true);
    expect(isClaudeProvider('openai')).toBe(false);
    expect(isClaudeProvider('openai-compatible')).toBe(false);
  });
});

describe('effectiveProvider', () => {
  it('serves non-Claude providers as configured', () => {
    expect(effectiveProvider(base({ provider: 'openai' }), NOW)).toBe('openai');
    expect(effectiveProvider(base({ provider: 'openai-compatible' }), NOW)).toBe('openai-compatible');
  });

  it('serves a Claude route when no window is open', () => {
    expect(effectiveProvider(base({ provider: 'claude-sub' }), NOW)).toBe('claude-sub');
    const expired = base({ provider: 'claude-sub', claudeFailover: { consecutiveFails: 0, until: past } });
    expect(effectiveProvider(expired, NOW)).toBe('claude-sub');
  });

  it('degrades a Claude route to OpenAI while a window is open', () => {
    const open = base({ provider: 'claude-api', claudeFailover: { consecutiveFails: 0, until: future } });
    expect(failoverActive(open, NOW)).toBe(true);
    expect(effectiveProvider(open, NOW)).toBe('openai');
  });
});

describe('nextFailoverState', () => {
  it('counts strikes and opens a window at the limit, then resets the counter', () => {
    let st: AiSettings['claudeFailover'] = { consecutiveFails: 0, until: null };
    for (let i = 1; i < CLAUDE_FAILOVER_STRIKES; i++) {
      st = nextFailoverState(st, NOW);
      expect(st.consecutiveFails).toBe(i);
      expect(st.until).toBeNull();
    }
    st = nextFailoverState(st, NOW);
    expect(st.consecutiveFails).toBe(0);
    expect(st.until).not.toBeNull();
    expect(new Date(st.until as string).getTime()).toBeGreaterThan(NOW);
  });

  it('clears a stale past window when a fresh strike does not yet open one', () => {
    const next = nextFailoverState({ consecutiveFails: 0, until: past }, NOW);
    expect(next.until).toBeNull();
    expect(next.consecutiveFails).toBe(1);
  });
});

describe('image helpers', () => {
  it('detects and strips image parts for the text-only sub route', () => {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'look' },
          { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ];
    expect(hasImages(msgs)).toBe(true);
    const stripped = stripImages(msgs);
    expect(hasImages(stripped)).toBe(false);
    expect(stripped[1]!.content).toBe('look');
    expect(stripped[0]!.content).toBe('sys');
  });
});
