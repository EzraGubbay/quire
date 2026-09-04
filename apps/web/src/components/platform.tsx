'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { type FeatureKey, featureLevel, type Level } from '@/lib/features';
import {
  classifyPlatform,
  isPlatform,
  PLATFORM_COOKIE,
  PLATFORM_OVERRIDE_KEY,
  type Platform,
} from '@/lib/platform';

interface Ctx {
  platform: Platform;
  /** The device's real class, ignoring any preview override. */
  detected: Platform;
  override: Platform | null;
  setOverride: (p: Platform | null) => void;
  feature: (key: FeatureKey) => Level;
  matrix: Record<FeatureKey, Record<Platform, Level>>;
}

const PlatformContext = createContext<Ctx | null>(null);

function detect(): Platform {
  return classifyPlatform({
    width: window.innerWidth,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    userAgent: navigator.userAgent,
    ...((navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile !== undefined
      ? { uaMobile: (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile }
      : {}),
  });
}

function writeCookie(p: Platform) {
  try {
    document.cookie = `${PLATFORM_COOKIE}=${p}; path=/; max-age=31536000; samesite=lax`;
  } catch {}
}

/** Provides the device class and feature levels. `initial` comes from the server (cookie or UA) so SSR matches. */
export function PlatformProvider({
  initial,
  matrix,
  children,
}: {
  initial: Platform;
  matrix: Ctx['matrix'];
  children: ReactNode;
}) {
  const [detected, setDetected] = useState<Platform>(initial);
  const [override, setOverrideState] = useState<Platform | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(PLATFORM_OVERRIDE_KEY);
    } catch {}
    if (isPlatform(stored)) setOverrideState(stored);
    const update = () => {
      const p = detect();
      setDetected(p);
      writeCookie(isPlatform(stored) ? stored : p);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const setOverride = (p: Platform | null) => {
    setOverrideState(p);
    try {
      if (p) window.localStorage.setItem(PLATFORM_OVERRIDE_KEY, p);
      else window.localStorage.removeItem(PLATFORM_OVERRIDE_KEY);
    } catch {}
    writeCookie(p ?? detected);
  };

  const platform = override ?? detected;
  const value = useMemo<Ctx>(
    () => ({
      platform,
      detected,
      override,
      setOverride,
      feature: (key) => matrix[key]?.[platform] ?? featureLevel(key, platform),
      matrix,
    }),
    // setOverride is stable enough for our use; recreating it is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [platform, detected, override, matrix],
  );
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Ctx {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error('usePlatform outside PlatformProvider');
  return ctx;
}

export function useFeature(key: FeatureKey): Level {
  return usePlatform().feature(key);
}
