// Runs once when the Next.js server boots: apply pending migrations before serving traffic.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SKIP_MIGRATIONS === '1') return;
  const { runMigrations } = await import('./db/migrate');
  await runMigrations();
  console.log('[db] schema up to date');
}
