// Expand-only migration policy (docs/adr/0001-unified-backend.md, decision 8).
//
// Pure module: no imports, no fs, no Next. A migration may only add things the previous release ignores
// (tables, nullable or defaulted columns, non-unique indexes, enum values). Anything that removes or tightens
// something the running code relies on is a "contract" operation: it ships alone in an owner-gated PR and is
// listed in apps/web/drizzle/CONTRACT_ALLOWLIST. This is regex-based, not a SQL parser, and it fails closed:
// opaque bodies (DO blocks, functions) are flagged so a human reviews them.

export type ContractRule =
  | 'drop'
  | 'rename'
  | 'set-not-null'
  | 'alter-column-type'
  | 'unique-index-on-existing-table'
  | 'constraint-on-existing-table'
  | 'foreign-key-on-existing-column'
  | 'add-not-null-column-without-default'
  | 'add-column-with-unique'
  | 'truncate'
  | 'data-rewrite'
  | 'procedural-block';

export interface ContractOperation {
  rule: ContractRule;
  statement: string;
}

const RULE_ORDER: ContractRule[] = [
  'drop',
  'rename',
  'set-not-null',
  'alter-column-type',
  'unique-index-on-existing-table',
  'constraint-on-existing-table',
  'foreign-key-on-existing-column',
  'add-not-null-column-without-default',
  'add-column-with-unique',
  'truncate',
  'data-rewrite',
  'procedural-block',
];

/**
 * Split a migration file into statements. Removes `--` line comments (this also drops drizzle's
 * `--> statement-breakpoint`) and block comments, replaces string literals by `''` and dollar-quoted bodies by
 * `$$`, then splits on `;`. It splits on `;` rather than on breakpoints because hand-written statements (for
 * example `CREATE EXTENSION`) carry no breakpoint.
 */
export function splitStatements(sql: string): string[] {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? sql.length : close + m[0].length;
        out += '$$';
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normIdent(raw: string): string {
  return raw
    .replace(/"/g, '')
    .toLowerCase()
    .replace(/^public\./, '');
}

const IDENT = '(?:"[^"]+"|\\w+)';
const TABLE = `(${IDENT}(?:\\.${IDENT})?)`;

/** Split on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const mask = (s: string) => s.replace(/"[^"]*"/g, '"_"');
const ALTER_TABLE = new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${TABLE}\\s+(.*)$`, 'i');
const ADD_COLUMN = new RegExp(`^ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, 'i');
const CREATE_TABLE = new RegExp(
  `^CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE}`,
  'i',
);
const CREATE_UNIQUE_INDEX = new RegExp(
  `^CREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:\\S+\\s+)?ON\\s+(?:ONLY\\s+)?${TABLE}`,
  'i',
);

/**
 * Find contract operations in one migration file. A "new table" is a table created by CREATE TABLE in the
 * same file: its own unique indexes, constraints and foreign keys are expand, because nothing old can write
 * to it. A unique index added in a later file to a table created earlier is contract, even if the table is
 * young; allowlist it when the table is known to be empty.
 *
 * Known false negatives (owner review of migration PRs is the backstop): dynamic SQL, `ALTER ... SET SCHEMA`,
 * `ALTER TABLE ... SET LOGGED`, `CREATE TABLE ... AS SELECT`, and column-level CHECK on an added column.
 */
export function findContractOperations(sql: string): ContractOperation[] {
  const statements = splitStatements(sql);
  const newTables = new Set<string>();
  const addedColumns = new Map<string, Set<string>>();

  // Pass 1: tables created and columns added in this file.
  for (const stmt of statements) {
    const ct = CREATE_TABLE.exec(stmt);
    if (ct) newTables.add(normIdent(ct[1] ?? ''));
    const at = ALTER_TABLE.exec(stmt);
    if (at) {
      const table = normIdent(at[1] ?? '');
      for (const action of splitTopLevel(at[2] ?? '')) {
        const ac = ADD_COLUMN.exec(action);
        if (!ac) continue;
        const cols = addedColumns.get(table) ?? new Set<string>();
        addedColumns.set(table, cols);
        cols.add(normIdent(ac[1] ?? ''));
      }
    }
  }

  // Pass 2: rules. Keyword rules run on an identifier-masked copy so a column called "drop" is not flagged.
  const ops: ContractOperation[] = [];
  for (const stmt of statements) {
    const masked = mask(stmt);
    const hit = new Set<ContractRule>();

    if (/\bDROP\b/i.test(masked.replace(/\bDROP\s+NOT\s+NULL\b/gi, ''))) hit.add('drop');
    if (/\bRENAME\b/i.test(masked)) hit.add('rename');
    if (/\bSET\s+NOT\s+NULL\b/i.test(masked)) hit.add('set-not-null');
    if (/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(masked)) hit.add('alter-column-type');
    if (/^TRUNCATE\b/i.test(masked)) hit.add('truncate');
    if (
      /^(?:DELETE|UPDATE|MERGE)\b/i.test(masked) ||
      (/^WITH\b/i.test(masked) && /\b(?:DELETE|UPDATE)\b/i.test(masked))
    ) {
      hit.add('data-rewrite');
    }
    if (
      /^DO\b/i.test(masked) ||
      /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(masked) ||
      masked.includes('$$')
    ) {
      hit.add('procedural-block');
    }

    const ui = CREATE_UNIQUE_INDEX.exec(stmt);
    if (ui ? !newTables.has(normIdent(ui[1] ?? '')) : /^CREATE\s+UNIQUE\s+INDEX\b/i.test(stmt)) {
      // Fail closed: a unique index whose table the regex could not capture (for example a quoted index name
      // holding a space or a semicolon) is flagged for review.
      hit.add('unique-index-on-existing-table');
    }

    const at = ALTER_TABLE.exec(stmt);
    if (at) {
      const table = normIdent(at[1] ?? '');
      const isNew = newTables.has(table);
      for (const action of splitTopLevel(at[2] ?? '')) {
        const m = mask(action);
        if (!isNew && /^ADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:UNIQUE|PRIMARY\s+KEY|CHECK|EXCLUDE)\b/i.test(m)) {
          hit.add('constraint-on-existing-table');
        }
        const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(action);
        if (fk && !isNew) {
          const added = addedColumns.get(table) ?? new Set<string>();
          const cols = (fk[1] ?? '').split(',').map(normIdent);
          if (cols.some((c) => !added.has(c))) hit.add('foreign-key-on-existing-column');
        }
        if (!isNew && ADD_COLUMN.test(action)) {
          if (/\bNOT\s+NULL\b/i.test(m) && !/\b(?:DEFAULT|GENERATED)\b/i.test(m)) {
            hit.add('add-not-null-column-without-default');
          }
          if (/\b(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(m)) hit.add('add-column-with-unique');
        }
      }
    }

    for (const rule of RULE_ORDER) {
      if (hit.has(rule)) ops.push({ rule, statement: stmt.length > 160 ? `${stmt.slice(0, 157)}...` : stmt });
    }
  }
  return ops;
}

/** Parse CONTRACT_ALLOWLIST: `<tag> <reason of at least 10 characters>` per line; `#` comments and blanks skipped. */
export function parseAllowlist(text: string): Map<string, string> {
  const out = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(\d{4}_[a-z0-9_]+)\s+(\S.{9,})$/.exec(line);
    const tag = m?.[1];
    const reason = m?.[2];
    if (tag === undefined || reason === undefined) {
      throw new Error(
        `CONTRACT_ALLOWLIST line ${i + 1}: expected "<migration tag> <reason, at least 10 characters>"`,
      );
    }
    if (out.has(tag)) throw new Error(`CONTRACT_ALLOWLIST line ${i + 1}: duplicate tag ${tag}`);
    out.set(tag, reason);
  });
  return out;
}

export interface CheckOptions {
  entries: { idx: number; tag: string }[];
  readSql: (tag: string) => string | undefined;
  allowlist: Map<string, string>;
  grandfatheredThroughIdx: number;
}

/** Returns readable failures; an empty array means the migration history satisfies the policy. */
export function checkMigrations(opts: CheckOptions): string[] {
  const failures: string[] = [];
  const byTag = new Map(opts.entries.map((e) => [e.tag, e.idx]));
  for (const { idx, tag } of opts.entries) {
    if (idx <= opts.grandfatheredThroughIdx) continue;
    const sql = opts.readSql(tag);
    if (sql === undefined) {
      failures.push(`${tag}: listed in the journal but ${tag}.sql is missing`);
      continue;
    }
    if (opts.allowlist.has(tag)) continue;
    const ops = findContractOperations(sql);
    if (ops.length === 0) continue;
    const rules = [...new Set(ops.map((o) => o.rule))].join(', ');
    failures.push(
      `${tag}: contract operation(s) ${rules}: ${ops.map((o) => o.statement).join(' | ')} ` +
        `Make it expand-only, or ship it alone in an owner-gated PR and add '${tag} <reason>' to ` +
        `apps/web/drizzle/CONTRACT_ALLOWLIST (ADR 0001, decision 8).`,
    );
  }
  for (const tag of opts.allowlist.keys()) {
    const idx = byTag.get(tag);
    if (idx === undefined)
      failures.push(`${tag}: stale or misspelt allowlist entry (no such migration in the journal)`);
    else if (idx <= opts.grandfatheredThroughIdx)
      failures.push(`${tag}: grandfathered by the policy baseline, remove it from the allowlist`);
  }
  return failures;
}
