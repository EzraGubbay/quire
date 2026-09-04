import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { settings } from '@/db/schema';

export type ThemeSetting = 'light' | 'dark' | 'system';
export const THEME_KEY = 'quire.theme';

export async function getThemeSetting(): Promise<ThemeSetting> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const t = (row?.data as { theme?: unknown } | undefined)?.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

export async function saveThemeSetting(theme: ThemeSetting): Promise<void> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const data = { ...((row?.data as Record<string, unknown>) ?? {}), theme };
  if (row) await db.update(settings).set({ data, updatedAt: new Date() }).where(eq(settings.id, 1));
  else await db.insert(settings).values({ id: 1, data });
}
