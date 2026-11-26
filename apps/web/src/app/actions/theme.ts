'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/require-session';
import { saveThemeSetting, type ThemeSetting } from '@/lib/theme';

export async function saveThemeAction(theme: ThemeSetting): Promise<void> {
  await requireSession();
  await saveThemeSetting(theme);
  revalidatePath('/', 'layout');
}
