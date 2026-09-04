'use server';

import { revalidatePath } from 'next/cache';
import { saveThemeSetting, type ThemeSetting } from '@/lib/theme';

export async function saveThemeAction(theme: ThemeSetting): Promise<void> {
  await saveThemeSetting(theme);
  revalidatePath('/', 'layout');
}
