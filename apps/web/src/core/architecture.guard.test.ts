// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

// The core fence (docs/adr/0001-unified-backend.md, src/core/README.md): core holds business rules
// with no web-framework code. Inject Next-only effects (revalidate, defer) as deps instead.
const CORE = __dirname;
const SRC = path.resolve(CORE, '..');

const FORBIDDEN_MODULES: RegExp[] = [
  /^next(\/.*)?$/,
  /^next-auth(\/.*)?$/,
  /^react(-dom)?(\/.*)?$/,
  /^@\/app(\/.*)?$/,
  /^@\/components(\/.*)?$/,
  /^@\/auth(\.tsx?|\/.*)?$/,
];

const FORBIDDEN_CALLS = new Set([
  'revalidatePath',
  'after',
  'headers',
  // Other Next request/response functions, in case one is re-exported through @/lib.
  'revalidateTag',
  'updateTag',
  'cookies',
  'notFound',
  'redirect',
  'permanentRedirect',
]);

/** Map a relative specifier to its `@/…` form so `../app/x` is fenced like `@/app/x`. */
function normalize(spec: string, fileName: string): string {
  if (!spec.startsWith('.')) return spec;
  const rel = path.relative(SRC, path.resolve(path.dirname(fileName), spec));
  return rel.startsWith('..') ? spec : `@/${rel.split(path.sep).join('/')}`;
}

/** Pure checker: every fence violation in one source file, as `line N: …`. */
function violations(source: string, fileName = path.join(CORE, 'synthetic.ts')): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const at = (n: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const checkSpec = (n: ts.Node, spec: string) => {
    const s = normalize(spec, fileName);
    if (FORBIDDEN_MODULES.some((re) => re.test(s))) out.push(`${at(n)}: imports '${spec}'`);
  };
  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      checkSpec(n, n.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      checkSpec(n, n.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteral(n.argument.literal)
    ) {
      checkSpec(n, n.argument.literal.text);
    } else if (ts.isCallExpression(n)) {
      const [arg] = n.arguments;
      const isLoader =
        n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require');
      if (isLoader && arg && ts.isStringLiteralLike(arg)) checkSpec(n, arg.text);
      else if (ts.isIdentifier(n.expression) && FORBIDDEN_CALLS.has(n.expression.text))
        out.push(`${at(n)}: calls ${n.expression.text}()`);
    } else if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      out.push(`${at(n)}: JSX (implies react/jsx-runtime)`);
    } else if (
      ts.isExpressionStatement(n) &&
      ts.isStringLiteral(n.expression) &&
      /^use (client|server)$/.test(n.expression.text)
    ) {
      out.push(`${at(n)}: '${n.expression.text}' directive`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/** Every violation under `root`, tests and .d.ts included, as `relative/path: line N: …`. */
function scan(root: string): string[] {
  return walk(root).flatMap((f) =>
    violations(readFileSync(f, 'utf8'), f).map((v) => `${path.relative(root, f)}: ${v}`),
  );
}

const MUST_FLAG: [string, string, string?][] = [
  ['next/headers import', "import { headers } from 'next/headers';"],
  ['type-only next/server import', "import type { NextRequest } from 'next/server';"],
  ['next/link import', "import Link from 'next/link';"],
  ['next-auth import', "import NextAuth from 'next-auth';"],
  ['next-auth subpath', "import { getServerSession } from 'next-auth/next';"],
  ['react import', "import { useState } from 'react';"],
  ['react-dom subpath', "import { createRoot } from 'react-dom/client';"],
  ['@/app import', "import { x } from '@/app/actions/documents';"],
  ['@/components import', "import { Button } from '@/components/ui/button';"],
  ['@/auth import', "import { auth } from '@/auth';"],
  ['export * from next', "export * from 'next/cache';"],
  ['named re-export from next', "export { after } from 'next/server';"],
  ['dynamic import', "const m = await import('next/headers');"],
  ['require', "const r = require('react');"],
  ['import = require', "import x = require('next/server');"],
  ['typeof import', "type R = typeof import('react');"],
  ['relative @/app', "import { x } from '../app/actions/documents';", path.join(CORE, 'a.ts')],
  ['relative @/auth', "import { auth } from '../auth';", path.join(CORE, 'a.ts')],
  ['revalidatePath call', "revalidatePath('/projects');"],
  ['after call', 'after(() => work());'],
  ['headers call', 'const h = await headers();'],
  ['notFound call', 'notFound();'],
  ['JSX', 'export const X = () => <div />;', path.join(CORE, 'x.tsx')],
  ['use client directive', "'use client';\nexport const a = 1;"],
  ['inline use server directive', "export async function f() { 'use server'; }"],
];

const MUST_PASS: [string, string, string?][] = [
  ['@/db import', "import { db } from '@/db';"],
  ['node builtin', "import path from 'node:path';"],
  ['zod', "import { z } from 'zod';"],
  ['nextra is not next', "import x from 'nextra';"],
  ['@/authz is not @/auth', "import { a } from '@/authz';"],
  ['@/application is not @/app', "import { a } from '@/application/x';"],
  ['react-markdown is not react', "import Md from 'react-markdown';"],
  ['@/lib/next-page', "import { nextPage } from '@/lib/next-page';"],
  ['relative sibling', "import { x } from './sibling';"],
  ['forbidden text in a string', 'const s = "import { headers } from \'next/headers\'";'],
  ['forbidden call in a comment', "// revalidatePath('/x')"],
  ['injected deps', "deps.revalidate('document'); deps.defer(() => 1);"],
  ['web-standard Headers', "const h = new Headers({ a: 'b' }); res.headers.get('etag');"],
  ['headers as a property name', 'export type T = { headers: Record<string, string> };'],
  ['tsx without JSX', 'export const n: number = 1;', path.join(CORE, 'n.tsx')],
];

describe('core architecture fence', () => {
  it.each(MUST_FLAG)('flags: %s', (_label, source, fileName) => {
    expect(violations(source, fileName).length).toBeGreaterThanOrEqual(1);
  });

  it('reports the exact line and specifier', () => {
    expect(violations("import { headers } from 'next/headers';")).toEqual(["line 1: imports 'next/headers'"]);
  });

  it.each(MUST_PASS)('allows: %s', (_label, source, fileName) => {
    expect(violations(source, fileName)).toEqual([]);
  });

  describe('scan', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'core-fence-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it('walks nested dirs and only .ts/.tsx', () => {
      writeFileSync(path.join(tmp, 'ok.ts'), "import path from 'node:path';\nexport const p = path;\n");
      mkdirSync(path.join(tmp, 'deep', 'nested'), { recursive: true });
      writeFileSync(path.join(tmp, 'deep', 'nested', 'bad.tsx'), "import { useState } from 'react';\n");
      writeFileSync(path.join(tmp, 'notes.md'), "import 'next/headers'\n");
      expect(scan(tmp)).toEqual([`${path.join('deep', 'nested', 'bad.tsx')}: line 1: imports 'react'`]);
    });
  });

  it('sweep sees src/core (not miswired)', () => {
    expect(walk(CORE)).toContain(path.join(CORE, 'architecture.guard.test.ts'));
  });

  it('nothing in src/core breaks the fence', () => {
    expect(scan(CORE)).toEqual([]);
  });
});
