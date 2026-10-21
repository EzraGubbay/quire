'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Refreshes the route every `ms` while `active` (a row is generating in the background). */
export function PollWhile({ active, ms = 3000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => router.refresh(), ms);
    return () => window.clearInterval(id);
  }, [active, ms, router]);
  return null;
}
