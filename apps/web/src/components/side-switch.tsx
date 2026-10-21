'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { SIDE_COOKIE, type Side, sideFromPath } from '@/lib/side';

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
  { value: 'courses', label: 'Courses' },
  { value: 'research', label: 'Research' },
] as const;

/** Courses | Research. Sits in the app bar next to the mark (and at the top of the phone More sheet). */
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
      onChange={(side) => {
        writeSide(side);
        router.push(side === 'courses' ? '/courses' : '/research');
      }}
    />
  );
}
