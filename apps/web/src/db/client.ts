import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

// The pool is created on first use, not at import: `next build` imports this module while collecting
// page data in an environment without DATABASE_URL. One pool per process; Next's dev server
// re-evaluates modules, so it is cached on globalThis.
const g = globalThis as unknown as { __quireSql?: Sql; __quireDb?: Db };

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return postgres(url, { max: 10, prepare: false, onnotice: () => {} });
}

export function getSql(): Sql {
  if (!g.__quireSql) g.__quireSql = connect();
  return g.__quireSql;
}

export function getDb(): Db {
  if (!g.__quireDb) g.__quireDb = drizzle(getSql(), { schema });
  return g.__quireDb;
}

/** Lazily-connected Drizzle instance. Property access triggers the connection. */
export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});
export type { Db };
