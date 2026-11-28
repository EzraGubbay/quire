// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkMigrations, findContractOperations, parseAllowlist } from './migration-policy';

// Expand-only migration policy (docs/adr/0001-unified-backend.md, decision 8).
const DRIZZLE = path.resolve(__dirname, '../../drizzle');
// Migrations up to and including this one predate the policy and are not checked.
const GRANDFATHERED_THROUGH = { idx: 14, tag: '0014_even_blonde_phantom' };

const rules = (sql: string) => findContractOperations(sql).map((o) => o.rule);

describe('findContractOperations: flagged', () => {
  it.each<[string, string, string[]]>([
    ['drop column (acceptance case)', 'ALTER TABLE "documents" DROP COLUMN "abstract";', ['drop']],
    ['drop table', 'DROP TABLE "documents";', ['drop']],
    ['drop index', 'DROP INDEX "documents_idx";', ['drop']],
    ['drop type', 'DROP TYPE "public"."note_status";', ['drop']],
    ['drop constraint', 'ALTER TABLE "t" DROP CONSTRAINT "t_fk";', ['drop']],
    ['drop without COLUMN', 'ALTER TABLE "t" DROP "c";', ['drop']],
    ['drop default', 'ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;', ['drop']],
    ['rename table', 'ALTER TABLE "t" RENAME TO "u";', ['rename']],
    ['rename column', 'ALTER TABLE "t" RENAME COLUMN "a" TO "b";', ['rename']],
    ['rename enum value', 'ALTER TYPE "public"."k" RENAME VALUE \'a\' TO \'b\';', ['rename']],
    ['set not null', 'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;', ['set-not-null']],
    ['column type change', 'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE bigint;', ['alter-column-type']],
    [
      'column type change (short form)',
      'ALTER TABLE "t" ALTER COLUMN "c" TYPE bigint;',
      ['alter-column-type'],
    ],
    [
      'unique index on existing table',
      'CREATE UNIQUE INDEX "s_u" ON "sessions" USING btree ("a","b");',
      ['unique-index-on-existing-table'],
    ],
    [
      'unique index, concurrently, schema-qualified',
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "s_u" ON ONLY "public"."sessions" ("a");',
      ['unique-index-on-existing-table'],
    ],
    [
      'unique constraint on existing table',
      'ALTER TABLE "sessions" ADD CONSTRAINT "s_u" UNIQUE("a","b");',
      ['constraint-on-existing-table'],
    ],
    [
      'check constraint on existing table',
      'ALTER TABLE "sessions" ADD CONSTRAINT "s_c" CHECK (a > 0);',
      ['constraint-on-existing-table'],
    ],
    [
      'foreign key on existing column',
      'ALTER TABLE "sessions" ADD CONSTRAINT "s_fk" FOREIGN KEY ("p") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;',
      ['foreign-key-on-existing-column'],
    ],
    [
      'not null column without default',
      'ALTER TABLE "t" ADD COLUMN "k" text NOT NULL;',
      ['add-not-null-column-without-default'],
    ],
    ['column with unique', 'ALTER TABLE "t" ADD COLUMN "k" text UNIQUE;', ['add-column-with-unique']],
    ['truncate', 'TRUNCATE "t";', ['truncate']],
    ['delete', 'DELETE FROM "t" WHERE a = 1;', ['data-rewrite']],
    ['update', 'UPDATE "documents" SET "a" = 1;', ['data-rewrite']],
    ['cte delete', 'WITH x AS (DELETE FROM "t" RETURNING *) SELECT 1;', ['data-rewrite']],
    ['do block', 'DO $$ BEGIN DROP TABLE x; END $$;', ['procedural-block']],
    [
      'function',
      'CREATE OR REPLACE FUNCTION f() RETURNS int AS $f$ SELECT 1 $f$ LANGUAGE sql;',
      ['procedural-block'],
    ],
    ['lowercase drop', 'alter table "documents" drop column "abstract";', ['drop']],
    [
      'lowercase unique index',
      'create unique index "s_u" on "sessions" ("a");',
      ['unique-index-on-existing-table'],
    ],
    [
      'only the second statement is contract',
      'CREATE INDEX "a" ON "t" ("x");--> statement-breakpoint\nALTER TABLE "t" DROP COLUMN "x";',
      ['drop'],
    ],
  ])('%s', (_name, sql, expected) => {
    expect(rules(sql)).toEqual(expected);
  });
});

describe('findContractOperations: allowed', () => {
  it.each<[string, string]>([
    [
      'new table and its own unique index',
      'CREATE TABLE "jobs" ("id" uuid PRIMARY KEY NOT NULL, "k" text);--> statement-breakpoint\nCREATE UNIQUE INDEX "j" ON "jobs" USING btree ("k");',
    ],
    [
      'new table and its foreign key',
      'CREATE TABLE "jobs" ("id" uuid, "p" uuid);--> statement-breakpoint\nALTER TABLE "jobs" ADD CONSTRAINT "j_fk" FOREIGN KEY ("p") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;',
    ],
    ['non-unique index on an existing table', 'CREATE INDEX "d_idx" ON "documents" USING btree ("a");'],
    ['nullable column', 'ALTER TABLE "t" ADD COLUMN "k" text;'],
    ['not null column with default', 'ALTER TABLE "t" ADD COLUMN "k" text DEFAULT \'x\' NOT NULL;'],
    [
      'new column and a foreign key on it',
      'ALTER TABLE "documents" ADD COLUMN "job_id" uuid;--> statement-breakpoint\nALTER TABLE "documents" ADD CONSTRAINT "d_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE set null ON UPDATE no action;',
    ],
    ['drop not null', 'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;'],
    ['set default', 'ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT \'x\';'],
    ['add enum value', 'ALTER TYPE "public"."k" ADD VALUE \'session\';'],
    ['extension with no breakpoint', 'CREATE EXTENSION IF NOT EXISTS vector;'],
    ['insert', 'INSERT INTO "t" ("a") VALUES (\'x\');'],
    ['literal holding SQL words', 'ALTER TABLE "t" ADD COLUMN "k" text DEFAULT \'drop table; update x\';'],
    ['comment holding SQL words', '-- DROP TABLE x\nCREATE TABLE "a" ("id" uuid);'],
    ['columns named like keywords', 'CREATE TABLE "a" ("drop" text, "update" text, "dropped_at" timestamp);'],
  ])('%s', (_name, sql) => {
    expect(rules(sql)).toEqual([]);
  });
});

const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string }[];
};
const readSql = (tag: string) => {
  const file = path.join(DRIZZLE, `${tag}.sql`);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

describe('calibration on grandfathered history', () => {
  it('flags nothing in migrations 0000 through the baseline', () => {
    const old = journal.entries.filter((e) => e.idx <= GRANDFATHERED_THROUGH.idx);
    expect(old.length).toBe(GRANDFATHERED_THROUGH.idx + 1);
    for (const e of old) {
      expect({ tag: e.tag, ops: findContractOperations(readSql(e.tag) ?? '') }).toEqual({
        tag: e.tag,
        ops: [],
      });
    }
  });
});

describe('parseAllowlist', () => {
  it('reads entries and skips comments and blank lines', () => {
    const m = parseAllowlist('# header\n\n0020_x  Owner approved the repair first.\n');
    expect([...m.keys()]).toEqual(['0020_x']);
  });
  it('rejects a missing reason', () => expect(() => parseAllowlist('0020_x')).toThrow(/line 1/));
  it('rejects a short reason', () => expect(() => parseAllowlist('0020_x ok')).toThrow(/line 1/));
  it('rejects a duplicate tag', () => {
    expect(() => parseAllowlist('0020_x Owner approved this.\n0020_x Owner approved again.')).toThrow(
      /line 2/,
    );
  });
});

describe('checkMigrations on a synthetic journal', () => {
  const entries = [...journal.entries, { idx: 15, tag: '0015_synthetic' }];
  const bad = 'ALTER TABLE "documents" DROP COLUMN "abstract";';
  const read = (tag: string) => (tag === '0015_synthetic' ? bad : readSql(tag));
  const base = { entries, readSql: read, grandfatheredThroughIdx: GRANDFATHERED_THROUGH.idx };

  it('fails a new migration that drops a column', () => {
    const failures = checkMigrations({ ...base, allowlist: new Map() });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/0015_synthetic/);
    expect(failures[0]).toMatch(/drop/);
  });
  it('passes when the tag is allowlisted', () => {
    expect(
      checkMigrations({ ...base, allowlist: new Map([['0015_synthetic', 'owner approved test']]) }),
    ).toEqual([]);
  });
  it('fails when the sql file is missing', () => {
    const failures = checkMigrations({ ...base, readSql: () => undefined, allowlist: new Map() });
    expect(failures.some((f) => /0015_synthetic.*missing/.test(f))).toBe(true);
  });
  it('fails a stale allowlist entry', () => {
    const failures = checkMigrations({
      ...base,
      readSql: readSql,
      entries: journal.entries,
      allowlist: new Map([['0099_nope', 'owner approved test']]),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/stale or misspelt/);
  });
  it('fails an allowlist entry for a grandfathered migration', () => {
    const failures = checkMigrations({
      ...base,
      entries: journal.entries,
      readSql,
      allowlist: new Map([[GRANDFATHERED_THROUGH.tag, 'owner approved test']]),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/grandfathered/);
  });
});

describe('repository migration policy', () => {
  it('pins the baseline to the journal', () => {
    expect(journal.entries[GRANDFATHERED_THROUGH.idx]?.tag).toBe(GRANDFATHERED_THROUGH.tag);
  });
  it('has no contract migration beyond the baseline that is not allowlisted', () => {
    const allowlist = parseAllowlist(readFileSync(path.join(DRIZZLE, 'CONTRACT_ALLOWLIST'), 'utf8'));
    expect(
      checkMigrations({
        entries: journal.entries,
        readSql,
        allowlist,
        grandfatheredThroughIdx: GRANDFATHERED_THROUGH.idx,
      }),
    ).toEqual([]);
  });
});

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; run?: string };
const deployYml = parse(
  readFileSync(path.resolve(__dirname, '../../../../.github/workflows/deploy.yml'), 'utf8'),
) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string }> } };
  jobs: { deploy: { steps: Step[] } };
};

describe('deploy wiring', () => {
  const steps = deployYml.jobs.deploy.steps;
  const dumpIdx = steps.findIndex((s) => /^Pre-deploy database dump/.test(s.name ?? ''));

  it('takes the pre-deploy dump before any .env edit, pull or migration', () => {
    expect(dumpIdx).toBeGreaterThan(-1);
    const firstEnvSync = steps.findIndex((s) => /^Sync .* into \.env/.test(s.name ?? ''));
    const pull = steps.findIndex((s) => s.name === 'Pull, migrate, restart');
    expect(firstEnvSync).toBeGreaterThan(dumpIdx);
    expect(pull).toBeGreaterThan(dumpIdx);
  });
  it('checks out full history for the dump range', () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
  it('exposes force_predeploy_dump as a boolean input', () => {
    expect(deployYml.on.workflow_dispatch.inputs.force_predeploy_dump?.type).toBe('boolean');
  });
  it('runs the script and reads the image with --format only', () => {
    const run = steps[dumpIdx]?.run ?? '';
    expect(run).toContain('predeploy-dump.sh');
    expect(run).toContain("--format '{{.Config.Image}}'");
  });
  it('never runs a bare docker inspect (it prints the container environment, which holds secrets)', () => {
    for (const s of steps) {
      for (const line of (s.run ?? '').split('\n')) {
        if (/docker inspect /.test(line))
          expect(line, `${s.name}: ${line}`).toMatch(/docker inspect --format /);
      }
    }
  });
});
