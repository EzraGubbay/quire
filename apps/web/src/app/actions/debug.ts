'use server';

import { revalidatePath } from 'next/cache';
import { clearClientLogs, saveDebugSetting } from '@/lib/debug';
import { requireSession } from '@/lib/require-session';

export async function setDebugAction(on: boolean): Promise<void> {
  await requireSession();
  await saveDebugSetting(on);
  revalidatePath('/', 'layout');
}

export async function clearLogsAction(): Promise<void> {
  await requireSession();
  await clearClientLogs();
  revalidatePath('/settings');
}
