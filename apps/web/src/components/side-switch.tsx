'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { homeOfSide, SIDE_COOKIE, type Side, sideFromPath } from '@/lib/side';

function writeSide(side: Side) {
  try {
    document.cookie = `${SIDE_COOKIE}=${side}; path=/; max-age=31536000; samesite=lax`;
  } catch {}
}

/** Remembers the side of the current page so `/` opens it next time. */
export function useRememberSide() {
  const pathname = usePathname();
  useEffect(() => {
    const side = sideFromPath(pathname);
    if (side) writeSide(side);
  }, [pathname]);
}

const OPTIONS = [
  { value: 'courses', label: 'Courses', href: homeOfSide('courses') },
  { value: 'research', label: 'Research', href: homeOfSide('research') },
] as const;

/**
 * Courses | Research. Sits in the app bar next to the mark (and at the top of the phone More sheet). The segments
 * are links, so the switch works before hydration; once hydrated, clicks go through the client router.
 */
export function SideSwitch({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const current = sideFromPath(pathname);
  return (
    <Segmented<Side>
      aria-label="Switch between courses and research"
      size={size}
      className={className}
      value={current ?? 'research'}
      options={OPTIONS}
      onChange={(side, e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open a new tab
        e.preventDefault();
        writeSide(side);
        router.push(homeOfSide(side));
      }}
    />
  );
}
