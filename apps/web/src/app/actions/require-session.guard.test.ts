// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const ACTIONS = __dirname;

function isRequireSessionCall(e: ts.Expression): boolean {
  const inner = ts.isAwaitExpression(e) ? e.expression : null;
  return (
    !!inner &&
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === 'requireSession'
  );
}

/** First statement must be `await requireSession();` or `const x = await requireSession();`. */
function startsWithGuard(body: ts.Block): boolean {
  const first = body.statements[0];
  if (!first) return false;
  if (ts.isExpressionStatement(first)) return isRequireSessionCall(first.expression);
  if (ts.isVariableStatement(first)) {
    const d = first.declarationList.declarations[0];
    return !!d?.initializer && isRequireSessionCall(d.initializer);
  }
  return false;
}

const hasExport = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

// Every non-test module under app/actions, nested ones included.
function actionFiles() {
  return walk(ACTIONS).filter((f) => !/\.test\.tsx?$/.test(f));
}

describe('Server Action session guard', () => {
  const files = actionFiles();

  it('scans the real action modules (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
    const names: string[] = [];
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const s of sf.statements)
        if (ts.isFunctionDeclaration(s) && hasExport(s) && s.name) names.push(s.name.text);
    }
    expect(names).toContain('deleteDocumentAction');
    expect(names.length).toBeGreaterThanOrEqual(100);
  });

  it.each(files.map((f) => [path.basename(f), f]))(
    '%s: every exported action starts with requireSession()',
    (_n, f) => {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const first = sf.statements[0];
      expect(
        first &&
          ts.isExpressionStatement(first) &&
          ts.isStringLiteral(first.expression) &&
          first.expression.text,
      ).toBe('use server');
      const problems: string[] = [];
      for (const s of sf.statements) {
        if (ts.isVariableStatement(s) && hasExport(s))
          problems.push('exported variable (use an async function declaration)');
        if (ts.isExportAssignment(s)) problems.push('export default');
        if (ts.isExportDeclaration(s) && !s.isTypeOnly) problems.push('re-export of values');
        if (ts.isFunctionDeclaration(s) && hasExport(s)) {
          const name = s.name?.text ?? 'default';
          const isAsync = !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
          if (!isAsync) problems.push(`${name} is not async`);
          else if (!s.body || !startsWithGuard(s.body))
            problems.push(`${name} does not start with await requireSession()`);
        }
      }
      expect(problems).toEqual([]);
    },
  );

  it("no 'use server' outside app/actions (inline actions would be unguarded)", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (f.startsWith(ACTIONS + path.sep) || /\.test\.tsx?$/.test(f)) continue;
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (
          ts.isExpressionStatement(n) &&
          ts.isStringLiteral(n.expression) &&
          n.expression.text === 'use server'
        ) {
          offenders.push(path.relative(SRC, f));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });
});
