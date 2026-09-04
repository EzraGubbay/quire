'use client';

import { useEffect } from 'react';
import { initDebug } from '@/lib/debug-client';

/** Starts debug capture when the stored setting (or this device's override) says so. */
export function DebugInit({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    initDebug(enabled);
  }, [enabled]);
  return null;
}
