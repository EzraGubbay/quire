// Shared provider-error type and classifiers. Kept in its own module so provider.ts and claude.ts can both use it
// without an import cycle (provider.ts re-exports ProviderError for existing importers).

export class ProviderError extends Error {
  /** Text streamed before the failure, if any (the answer was cut off rather than never started). */
  partial = '';
  constructor(
    message: string,
    public readonly kind: 'quota' | 'rate_limit' | 'auth' | 'other',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  /** Server-side or transient: worth another attempt (or the light model). Never auth or quota. */
  get retryable(): boolean {
    return (
      this.kind === 'rate_limit' ||
      (this.kind === 'other' && (this.status === undefined || this.status >= 500))
    );
  }
}

/** OpenAI / OpenAI-compatible SDK errors. */
export function classifyError(err: unknown): ProviderError {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    error?: { code?: string; message?: string };
  };
  const code = e.code ?? e.error?.code ?? '';
  const msg = e.error?.message ?? e.message ?? 'Unknown provider error';
  if (e.status === 429 && /insufficient_quota|billing|budget/i.test(`${code} ${msg}`))
    return new ProviderError(msg, 'quota', 429);
  if (e.status === 429) return new ProviderError(msg, 'rate_limit', 429);
  if (e.status === 401 || e.status === 403) return new ProviderError(msg, 'auth', e.status);
  return new ProviderError(msg, 'other', e.status);
}

/** Anthropic API (@anthropic-ai/sdk) errors. */
export function classifyAnthropic(err: unknown): ProviderError {
  const e = err as {
    status?: number;
    message?: string;
    error?: { error?: { type?: string; message?: string } };
  };
  const type = e.error?.error?.type ?? '';
  const msg = e.error?.error?.message ?? e.message ?? 'Unknown Claude error';
  // A depleted pay-as-you-go balance is a budget stop, not a transient error.
  if (/credit balance|billing|quota|payment/i.test(msg)) return new ProviderError(msg, 'quota', e.status);
  if (e.status === 429 || type === 'rate_limit_error') return new ProviderError(msg, 'rate_limit', 429);
  if (e.status === 401 || e.status === 403 || type === 'authentication_error' || type === 'permission_error')
    return new ProviderError(msg, 'auth', e.status);
  return new ProviderError(msg, 'other', e.status);
}

/**
 * `claude` CLI (subscription route) failures: a non-zero exit, a spawn error, or an error result event. Auth
 * failures here mean the subscription token is missing or expired — Claude is effectively down until the user
 * re-runs `claude setup-token`, which is exactly a case the failover should cover.
 */
export function classifyClaudeCli(code: number | null, stderr: string): ProviderError {
  const s = (stderr || '').toLowerCase();
  const msg = stderr.trim() || `claude CLI exited with code ${code}`;
  if (s.includes('enoent') || s.includes('command not found') || s.includes('not found on'))
    return new ProviderError('claude CLI not found on PATH', 'other');
  if (
    s.includes('not logged in') ||
    s.includes('unauthorized') ||
    s.includes('authentication') ||
    s.includes('oauth') ||
    s.includes('setup-token') ||
    s.includes('log in')
  )
    return new ProviderError(msg || 'claude subscription not authenticated', 'auth');
  if (s.includes('usage limit') || s.includes('rate limit') || s.includes('overloaded'))
    return new ProviderError(msg, 'rate_limit', 429);
  return new ProviderError(msg, 'other');
}
