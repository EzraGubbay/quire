'use server';

import { revalidatePath } from 'next/cache';
import { clearClientLogs, saveDebugSetting } from '@/lib/debug';

export async function setDebugAction(on: boolean): Promise<void> {
  await saveDebugSetting(on);
  revalidatePath('/', 'layout');
}

export async function clearLogsAction(): Promise<void> {
  await clearClientLogs();
  revalidatePath('/settings');
}
