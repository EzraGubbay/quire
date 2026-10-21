// Runs once when the Next.js server boots: apply pending migrations before serving traffic, then mark background
// jobs that died with the previous process as failed so their pages offer Retry instead of spinning forever.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SKIP_MIGRATIONS === '1') return;
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
