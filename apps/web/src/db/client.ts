import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// One pool per process; Next's dev server re-evaluates modules, so cache on globalThis.
const g = globalThis as unknown as { __quireSql?: ReturnType<typeof postgres> };
if (!g.__quireSql) g.__quireSql = postgres(url, { max: 10, prepare: false, onnotice: () => {} });
export const sqlClient = g.__quireSql;

export const db = drizzle(sqlClient, { schema });
export type Db = typeof db;
