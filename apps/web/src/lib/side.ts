import type { ProjectKind } from '@quire/shared';

/** Which side of the app the device last used; read by `/` to pick a home page. */
export const SIDE_COOKIE = 'quire.side';
export type Side = 'courses' | 'research';

export const sideOfKind = (kind: ProjectKind): Side => (kind === 'course' ? 'courses' : 'research');

/** URL prefix for a workspace (client-safe; lib/projects re-exports it for server code). */
export const baseFor = (kind: ProjectKind, slug: string): string =>
  `/${kind === 'course' ? 'c' : 'p'}/${slug}`;

/** The side a path belongs to, or null for shared pages (settings). */
export function sideFromPath(pathname: string): Side | null {
  if (pathname === '/courses' || pathname.startsWith('/courses/') || pathname.startsWith('/c/'))
    return 'courses';
  if (pathname === '/research' || pathname.startsWith('/research/') || pathname.startsWith('/p/'))
    return 'research';
  return null;
}

export const isSide = (v: unknown): v is Side => v === 'courses' || v === 'research';

export const homeOfSide = (side: Side): string => (side === 'courses' ? '/courses' : '/research');
