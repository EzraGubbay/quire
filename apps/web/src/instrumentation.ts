// Runs once when the Next.js server boots: apply pending migrations before serving traffic, then mark background
// jobs that died with the previous process as failed so their pages offer Retry instead of spinning forever. The
// push loop starts on every nodejs boot, after migrations when they run, including under SKIP_MIGRATIONS=1.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SKIP_MIGRATIONS !== '1') await migrateAndCleanUp();
  try {
    const { startPushLoop } = await import('./lib/mobile/push/scheduler');
    startPushLoop();
  } catch (err) {
    console.warn('[push] loop failed to start', (err as Error)?.name ?? 'Error');
  }
}

async function migrateAndCleanUp() {
  const { runMigrations } = await import('./db/migrate');
  await runMigrations();
  console.log('[db] schema up to date');
  try {
    const { failStaleGenerating } = await import('./lib/ai/synthesis');
    const { failStaleTests } = await import('./lib/ai/tests');
    const [n, t] = await Promise.all([failStaleGenerating(20), failStaleTests(20)]);
    if (n || t) console.log(`[jobs] marked ${n} note(s) and ${t} test(s) as interrupted`);
  } catch (err) {
    console.warn('[jobs] stale cleanup failed', err);
  }
}
