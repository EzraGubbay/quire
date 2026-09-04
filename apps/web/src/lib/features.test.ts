import { featureLevel, featureMatrix } from './features';
import { classifyPlatform, platformFromHeaders } from './platform';

describe('classifyPlatform', () => {
  it('phones by width or UA, tablets by touch points, else desktop', () => {
    expect(classifyPlatform({ width: 390, maxTouchPoints: 5 })).toBe('phone');
    expect(
      classifyPlatform({
        width: 1024,
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605',
      }),
    ).toBe('tablet');
    expect(classifyPlatform({ width: 1440, maxTouchPoints: 0 })).toBe('desktop');
    expect(classifyPlatform({ width: 1440, maxTouchPoints: 0, uaMobile: true })).toBe('phone');
  });
});

describe('platformFromHeaders', () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
  it('prefers the cookie, then client hints, then the user agent', () => {
    expect(platformFromHeaders(h({ cookie: 'a=1; quire.platform=tablet' }))).toBe('tablet');
    expect(platformFromHeaders(h({ 'sec-ch-ua-mobile': '?1' }))).toBe('phone');
    expect(
      platformFromHeaders(h({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })),
    ).toBe('phone');
    expect(platformFromHeaders(h({ 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }))).toBe(
      'tablet',
    );
    expect(platformFromHeaders(h({}))).toBe('desktop');
  });
});

describe('featureLevel', () => {
  it('tablet inherits desktop unless set; env overrides win', () => {
    expect(featureLevel('graph', 'tablet', {})).toBe('on');
    expect(featureLevel('settings.flags', 'tablet', {})).toBe('off');
    expect(featureLevel('graph', 'phone', {})).toBe('off');
    expect(featureLevel('graph', 'desktop', { graph: { desktop: 'off' } })).toBe('off');
    expect(featureLevel('graph', 'tablet', { graph: { desktop: 'lite' } })).toBe('lite');
    expect(featureMatrix({}).chat.phone).toBe('on');
  });
});
