// Applies pending drizzle migrations. Used by `pnpm db:migrate` (CI, local) and by instrumentation.ts at server start.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client';

/** The drizzle folder lives next to the app source in dev/CI and under apps/web in the standalone image. */
export function migrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.join(process.cwd(), 'drizzle'),
    path.join(process.cwd(), 'apps/web/drizzle'),
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error(`migrations folder not found; tried ${candidates.filter(Boolean).join(', ')}`);
  return found;
}

export async function runMigrations() {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations()
    .then(() => {
      console.log('[db] migrations applied');
      return sqlClient.end();
    })
    .catch((err) => {
      console.error('[db] migration failed', err);
      process.exit(1);
    });
}
