import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Macro, macros } from '@/db/schema';

/** Global macros plus this project's; a project macro with the same name wins. */
export async function mergedMacros(projectId: string | null): Promise<Macro[]> {
  const rows = await db
    .select()
    .from(macros)
    .where(
      projectId ? or(isNull(macros.projectId), eq(macros.projectId, projectId)) : isNull(macros.projectId),
    )
    .orderBy(asc(macros.name));
  const byName = new Map<string, Macro>();
  for (const r of rows) {
    const existing = byName.get(r.name);
    if (!existing || (existing.projectId === null && r.projectId !== null)) byName.set(r.name, r);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMacros(projectId: string | null): Promise<Macro[]> {
  return db
    .select()
    .from(macros)
    .where(projectId ? eq(macros.projectId, projectId) : isNull(macros.projectId))
    .orderBy(asc(macros.name));
}

export async function upsertMacro(
  projectId: string | null,
  name: string,
  definition: string,
  arity: number,
): Promise<Macro> {
  const clean = name.replace(/^\\/, '').trim();
  const [existing] = await db
    .select()
    .from(macros)
    .where(
      and(projectId ? eq(macros.projectId, projectId) : isNull(macros.projectId), eq(macros.name, clean)),
    )
    .limit(1);
  if (existing) {
    const [row] = await db
      .update(macros)
      .set({ definition, arity, updatedAt: new Date() })
      .where(eq(macros.id, existing.id))
      .returning();
    return row ?? existing;
  }
  const [row] = await db.insert(macros).values({ projectId, name: clean, definition, arity }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function deleteMacro(id: string): Promise<void> {
  await db.delete(macros).where(eq(macros.id, id));
}

/** One `\newcommand` per macro, for MathJax to process ahead of any content. */
export function newcommandBlock(list: Pick<Macro, 'name' | 'definition' | 'arity'>[]): string {
  return list
    .map((m) =>
      m.arity > 0
        ? `\\newcommand{\\${m.name}}[${m.arity}]{${m.definition}}`
        : `\\newcommand{\\${m.name}}{${m.definition}}`,
    )
    .join('');
}

/** Parses lines like `\newcommand{\E}{\mathbb{E}}` or `\E: \mathbb{E}` or `\norm[1]: \left\lVert #1 \right\rVert`. */
export function parseMacroLine(line: string): { name: string; definition: string; arity: number } | null {
  const l = line.trim();
  if (!l) return null;
  const nc = l.match(/^\\(?:re)?newcommand\{?\\([A-Za-z]+)\}?(?:\[(\d)\])?\{(.*)\}$/);
  if (nc?.[1] && nc[3] !== undefined) return { name: nc[1], definition: nc[3], arity: Number(nc[2] ?? 0) };
  const colon = l.match(/^\\?([A-Za-z]+)(?:\[(\d)\])?\s*:\s*(.+)$/);
  if (colon?.[1] && colon[3])
    return { name: colon[1], definition: colon[3].trim(), arity: Number(colon[2] ?? 0) };
  return null;
}
