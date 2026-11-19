// In-memory failed-attempt limiter for the public pair endpoint (single-process deploy; resets on restart).
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const live = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (live.length) this.hits.set(key, live);
    else this.hits.delete(key);
    return live;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.hits.set(key, [...this.recent(key, now), now]);
  }
}

/** 5 failed pairing attempts per client IP per 10 minutes. */
export const pairLimiter = new FailureLimiter(5, 10 * 60 * 1000);

/** Client IP behind cloudflared: cf-connecting-ip, else first x-forwarded-for hop. */
export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
