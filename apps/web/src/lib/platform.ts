export type Platform = 'phone' | 'tablet' | 'desktop';
export const PLATFORMS: Platform[] = ['phone', 'tablet', 'desktop'];
export const PLATFORM_COOKIE = 'quire.platform';
export const PLATFORM_OVERRIDE_KEY = 'quire.platform.override';
export const PHONE_MAX_WIDTH = 700;

export interface ClientSignals {
  width: number;
  maxTouchPoints: number;
  /** navigator.userAgentData?.mobile when available. */
  uaMobile?: boolean;
  userAgent?: string;
}

/** Client-side classification. iPadOS reports a Mac user agent, so touch points decide tablet vs desktop. */
export function classifyPlatform(s: ClientSignals): Platform {
  if (s.uaMobile || s.width <= PHONE_MAX_WIDTH || /iPhone|Android.*Mobile/i.test(s.userAgent ?? ''))
    return 'phone';
  if (s.maxTouchPoints > 1) return 'tablet';
  return 'desktop';
}

/** Server-side guess before the client has set the cookie. */
export function platformFromHeaders(h: { get(name: string): string | null }): Platform {
  const cookie = h.get('cookie') ?? '';
  const m = cookie.match(
    new RegExp(`(?:^|;\\s*)${PLATFORM_COOKIE.replace('.', '\\.')}=(phone|tablet|desktop)`),
  );
  if (m?.[1]) return m[1] as Platform;
  if (h.get('sec-ch-ua-mobile') === '?1') return 'phone';
  const ua = h.get('user-agent') ?? '';
  if (/iPhone|Android.*Mobile/i.test(ua)) return 'phone';
  if (/iPad|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  return 'desktop';
}

export function isPlatform(v: unknown): v is Platform {
  return v === 'phone' || v === 'tablet' || v === 'desktop';
}
