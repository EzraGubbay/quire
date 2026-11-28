// @vitest-environment node
// Structural sweep: every exported handler under /api/mobile/v1 must authenticate the device first.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const V1 = __dirname;
const PUSH_API = path.resolve(__dirname, '../../../../lib/mobile/push/api.ts');
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Public on purpose. Each entry says why; keep it short. */
const PUBLIC: Record<string, string[]> = {
  'auth/pair/route.ts': ['POST'], // pairing-code exchange, rate-limited per IP
};
/** Thin wrappers over lib/mobile/push/api.ts (guarded there; checked below). */
const DELEGATED: Record<string, Record<string, string>> = {
  'push/registration/route.ts': {
    PUT: 'putRegistration',
    GET: 'getRegistration',
    DELETE: 'deleteRegistration',
  },
  'push/test/route.ts': { POST: 'sendTest' },
};

type Kind = 'guarded' | 'public' | 'delegated';
type Result = { handlers: { method: string; kind: Kind }[]; problems: string[] };

const parse = (name: string, src: string) =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const hasMod = (n: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);
const isExported = (n: ts.Node) => hasMod(n, ts.SyntaxKind.ExportKeyword);
const isAsync = (n: ts.Node) => hasMod(n, ts.SyntaxKind.AsyncKeyword);

const isIdent = (e: ts.Node | undefined, name?: string): e is ts.Identifier =>
  !!e && ts.isIdentifier(e) && (name === undefined || e.text === name);

/** `await requireDevice(...)` call, or null. */
function awaitedCall(e: ts.Expression | undefined, callee: string): ts.CallExpression | null {
  if (!e || !ts.isAwaitExpression(e)) return null;
  const c = e.expression;
  return ts.isCallExpression(c) && isIdent(c.expression, callee) ? c : null;
}

/** Statement `const N = await requireDevice(<args>)`; returns the call and N. */
function guardDecl(s: ts.Statement | undefined): { call: ts.CallExpression; name: string } | null {
  if (!s || !ts.isVariableStatement(s)) return null;
  const decls = s.declarationList.declarations;
  const d = decls[0];
  if (decls.length !== 1 || !d || !isIdent(d.name)) return null;
  const call = awaitedCall(d.initializer, 'requireDevice');
  return call ? { call, name: d.name.text } : null;
}

/** Statement `if ('response' in N) return N.response;` */
function isResponseReturn(s: ts.Statement | undefined, name: string): boolean {
  if (!s || !ts.isIfStatement(s)) return false;
  const c = s.expression;
  if (
    !ts.isBinaryExpression(c) ||
    c.operatorToken.kind !== ts.SyntaxKind.InKeyword ||
    !ts.isStringLiteral(c.left) ||
    c.left.text !== 'response' ||
    !isIdent(c.right, name)
  )
    return false;
  let t: ts.Statement | undefined = s.thenStatement;
  if (ts.isBlock(t)) t = t.statements.length === 1 ? t.statements[0] : undefined;
  return (
    !!t &&
    ts.isReturnStatement(t) &&
    !!t.expression &&
    ts.isPropertyAccessExpression(t.expression) &&
    isIdent(t.expression.expression, name) &&
    t.expression.name.text === 'response'
  );
}

/** Statements [0] and [1] are the guard; `authArg` is the required 2nd argument shape (push module only). */
function startsWithDeviceGuard(
  stmts: readonly ts.Statement[],
  offset: number,
  reqName: string,
  authArg?: (e: ts.Expression) => boolean,
): boolean {
  const g = guardDecl(stmts[offset]);
  if (!g) return false;
  const args = g.call.arguments;
  if (!isIdent(args[0], reqName)) return false;
  if (authArg) {
    const second = args[1];
    if (args.length !== 2 || !second || !authArg(second)) return false;
  } else if (args.length !== 1) return false;
  return isResponseReturn(stmts[offset + 1], g.name);
}

function containsCall(node: ts.Node, callee: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && isIdent(n.expression, callee)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function checkRoute(rel: string, src: string): Result {
  const sf = parse(rel, src);
  const problems: string[] = [];
  const handlers: { method: string; kind: Kind }[] = [];
  const fns = new Map<string, ts.FunctionDeclaration>();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) fns.set(s.name.text, s);

  // 1. Collect handlers and reject shapes the sweep cannot see through.
  const found: { method: string; fn: ts.FunctionDeclaration }[] = [];
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && isExported(s) && s.name && METHODS.has(s.name.text)) {
      found.push({ method: s.name.text, fn: s });
    } else if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const spec of s.exportClause.elements) {
        const method = spec.name.text;
        if (!METHODS.has(method)) continue;
        if (s.moduleSpecifier) {
          problems.push(`${method}: re-exported from another module`);
          continue;
        }
        const fn = fns.get((spec.propertyName ?? spec.name).text);
        if (fn) found.push({ method, fn });
        else problems.push(`${method}: not a local function declaration`);
      }
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && !s.exportClause) {
      problems.push('export * from another module hides handlers');
    } else if (ts.isVariableStatement(s) && isExported(s)) {
      for (const d of s.declarationList.declarations)
        if (isIdent(d.name) && METHODS.has(d.name.text))
          problems.push(`${d.name.text}: exported as a variable; use a function declaration`);
    } else if (ts.isExportAssignment(s)) {
      problems.push('export default is not allowed in a route file');
    }
  }

  const publicMethods = PUBLIC[rel] ?? [];
  const delegated = DELEGATED[rel] ?? {};
  const importsRequireDevice = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === '@/lib/mobile/device-auth' &&
      s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === 'requireDevice' && !e.propertyName),
  );
  const importsPushRoutes = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === '@/lib/mobile/push/api' &&
      s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === 'pushRoutes' && !e.propertyName),
  );

  for (const { method, fn } of found) {
    const body = fn.body;
    const first = fn.parameters[0];
    if (!isAsync(fn)) problems.push(`${method}: handler is not async`);
    if (!body) {
      problems.push(`${method}: no body`);
      continue;
    }
    const stmts = body.statements;

    if (publicMethods.includes(method)) {
      handlers.push({ method, kind: 'public' });
      if (containsCall(body, 'requireDevice'))
        problems.push(`${method}: allowlisted as public but calls requireDevice; remove it from PUBLIC`);
      const s1 = stmts[1];
      const cond = s1 && ts.isIfStatement(s1) ? s1.expression : undefined;
      const ok =
        !!cond &&
        ts.isCallExpression(cond) &&
        ts.isPropertyAccessExpression(cond.expression) &&
        isIdent(cond.expression.expression, 'pairLimiter') &&
        cond.expression.name.text === 'blocked';
      if (!ok) problems.push(`${method}: public handler must rate-limit with pairLimiter.blocked(...) first`);
      continue;
    }

    if (delegated[method]) {
      handlers.push({ method, kind: 'delegated' });
      const key = delegated[method];
      const only = stmts.length === 1 ? stmts[0] : undefined;
      const e = only && ts.isReturnStatement(only) ? only.expression : undefined;
      const ok =
        !!e &&
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        isIdent(e.expression.expression, 'pushRoutes') &&
        e.expression.name.text === key &&
        e.arguments.length === 1 &&
        isIdent(e.arguments[0], isIdent(first?.name) ? first.name.text : '\0');
      if (!ok) problems.push(`${method}: must be exactly "return pushRoutes.${key}(req)"`);
      if (!importsPushRoutes)
        problems.push(`${method}: pushRoutes must be imported from @/lib/mobile/push/api`);
      continue;
    }

    handlers.push({ method, kind: 'guarded' });
    if (!first || !isIdent(first.name)) {
      problems.push(`${method}: first parameter must be a plain identifier`);
      continue;
    }
    if (!startsWithDeviceGuard(stmts, 0, first.name.text))
      problems.push(
        `${method}: must start with "const a = await requireDevice(${first.name.text}); if ('response' in a) return a.response;"`,
      );
  }

  // 3. The guard import must be the real one, with no shadowing declaration.
  if (handlers.some((h) => h.kind === 'guarded')) {
    if (!importsRequireDevice)
      problems.push("requireDevice must be imported unaliased from '@/lib/mobile/device-auth'");
    const shadow = sf.statements.some(
      (s) =>
        (ts.isFunctionDeclaration(s) && s.name?.text === 'requireDevice') ||
        (ts.isVariableStatement(s) &&
          s.declarationList.declarations.some((d) => isIdent(d.name, 'requireDevice'))),
    );
    if (shadow) problems.push('a local declaration shadows requireDevice');
  }
  return { handlers, problems };
}

function checkPushApi(src: string): string[] {
  const sf = parse('push/api.ts', src);
  const problems: string[] = [];
  const fnNamed = (name: string) =>
    sf.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
    );
  const returnedObject = (fn: ts.FunctionDeclaration | undefined) => {
    const ret = fn?.body?.statements.find(ts.isReturnStatement);
    return ret?.expression && ts.isObjectLiteralExpression(ret.expression) ? ret.expression : undefined;
  };

  const raw = returnedObject(fnNamed('rawHandlers'));
  const expected = ['putRegistration', 'getRegistration', 'deleteRegistration', 'sendTest'];
  const methods = raw?.properties.filter(ts.isMethodDeclaration) ?? [];
  if (
    [...methods.map((m) => (isIdent(m.name) ? m.name.text : '?'))].sort().join() !==
    [...expected].sort().join()
  )
    problems.push('rawHandlers must define exactly the four push handlers');
  for (const m of methods) {
    const name = isIdent(m.name) ? m.name.text : '?';
    const stmts = m.body?.statements ?? [];
    const req = m.parameters[0];
    const d = stmts[0];
    const isDeps =
      !!d &&
      ts.isVariableStatement(d) &&
      d.declarationList.declarations.length === 1 &&
      isIdent(d.declarationList.declarations[0]?.name, 'd') &&
      (() => {
        const init = d.declarationList.declarations[0]?.initializer;
        return (
          !!init &&
          ts.isCallExpression(init) &&
          isIdent(init.expression, 'deps') &&
          init.arguments.length === 0
        );
      })();
    if (!isDeps) problems.push(`${name}: first statement must be "const d = deps();"`);
    const reqName = req && isIdent(req.name) ? req.name.text : '\0';
    const isDAuth = (e: ts.Expression) =>
      ts.isPropertyAccessExpression(e) && isIdent(e.expression, 'd') && e.name.text === 'auth';
    if (!startsWithDeviceGuard(stmts, 1, reqName, isDAuth))
      problems.push(
        `${name}: must call "await requireDevice(req, d.auth)" right after deps() and return its response`,
      );
  }

  const wrapped = returnedObject(fnNamed('pushHandlers'));
  for (const k of expected) {
    const p = wrapped?.properties.find(
      (x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && isIdent(x.name, k),
    );
    const init = p?.initializer;
    const ok =
      !!init &&
      ts.isCallExpression(init) &&
      isIdent(init.expression, 'guarded') &&
      init.arguments.length === 2 &&
      !!init.arguments[1] &&
      ts.isPropertyAccessExpression(init.arguments[1]) &&
      isIdent(init.arguments[1].expression, 'h') &&
      init.arguments[1].name.text === k;
    if (!ok) problems.push(`pushHandlers.${k} must be guarded(<label>, h.${k})`);
  }

  // Production wiring: pushHandlers(() => ({ auth: (req) => authenticate(req), ... }))
  let authOk = false;
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!isIdent(d.name, 'pushRoutes')) continue;
      const call = d.initializer;
      const arrow = call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
      if (!call || !isIdent((call as ts.CallExpression).expression, 'pushHandlers')) continue;
      let obj: ts.Node | undefined = arrow && ts.isArrowFunction(arrow) ? arrow.body : undefined;
      while (obj && ts.isParenthesizedExpression(obj)) obj = obj.expression;
      if (!obj || !ts.isObjectLiteralExpression(obj)) continue;
      const auth = obj.properties.find(
        (x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && isIdent(x.name, 'auth'),
      );
      const fn = auth?.initializer;
      if (fn && ts.isArrowFunction(fn) && fn.parameters.length === 1) {
        const p = fn.parameters[0];
        const b = fn.body;
        authOk =
          !!p &&
          isIdent(p.name) &&
          ts.isCallExpression(b) &&
          isIdent(b.expression, 'authenticate') &&
          b.arguments.length === 1 &&
          isIdent(b.arguments[0], p.name.text);
      }
    }
  }
  if (!authOk) problems.push('pushRoutes must wire auth: (req) => authenticate(req)');
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e === 'route.ts') out.push(p);
  }
  return out;
}

const rel = (f: string) => path.relative(V1, f).split(path.sep).join('/');
const routeFiles = () => walk(V1).map(rel).sort();
const resultFor = (r: string) => checkRoute(r, readFileSync(path.join(V1, r), 'utf8'));

describe('mobile v1 device-auth guard', () => {
  it('scans the real v1 routes (not vacuous)', () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThanOrEqual(20);
    const all = files.flatMap((f) => resultFor(f).handlers);
    expect(all.length).toBeGreaterThanOrEqual(28);
    expect(all.filter((h) => h.kind === 'guarded').length).toBeGreaterThanOrEqual(23);

    const content = resultFor('courses/[course]/files/[fileId]/content/route.ts').handlers;
    expect(content).toEqual([{ method: 'GET', kind: 'guarded' }]);

    const catchAll = resultFor('[...path]/route.ts').handlers;
    expect(catchAll.map((h) => h.method).sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
    expect(catchAll.every((h) => h.kind === 'guarded')).toBe(true);
  });

  it.each(routeFiles())('%s: every exported handler authenticates the device first', (f) => {
    expect(resultFor(f).problems).toEqual([]);
  });

  it('allowlists are not stale', () => {
    const files = new Set(routeFiles());
    const lists: [Record<string, unknown>, Kind][] = [
      [PUBLIC, 'public'],
      [DELEGATED, 'delegated'],
    ];
    for (const [list, kind] of lists) {
      for (const f of Object.keys(list)) {
        expect(files.has(f), `${f} no longer exists`).toBe(true);
        const listed = Array.isArray(list[f]) ? (list[f] as string[]) : Object.keys(list[f] as object);
        const { handlers } = resultFor(f);
        expect(handlers.map((h) => h.method).sort(), f).toEqual([...listed].sort());
        expect(
          handlers.every((h) => h.kind === kind),
          f,
        ).toBe(true);
      }
    }
  });

  it('push handlers call requireDevice first, wired to the real authenticate', () => {
    expect(checkPushApi(readFileSync(PUSH_API, 'utf8'))).toEqual([]);
  });

  const IMPORT = "import { requireDevice } from '@/lib/mobile/device-auth';\n";
  const GUARD = "const a = await requireDevice(req);\n  if ('response' in a) return a.response;\n";
  it.each([
    ['no guard', `${IMPORT}export async function GET(req: Request) { return new Response('x'); }`],
    [
      'guard after another statement',
      `${IMPORT}export async function GET(req: Request) {\n  await req.json();\n  ${GUARD}  return new Response('x');\n}`,
    ],
    [
      'custom authFn argument',
      `${IMPORT}export async function GET(req: Request) {\n  const a = await requireDevice(req, async () => fake);\n  if ('response' in a) return a.response;\n  return new Response('x');\n}`,
    ],
    [
      'guard result never checked',
      `${IMPORT}export async function GET(req: Request) {\n  const a = await requireDevice(req);\n  return new Response('x');\n}`,
    ],
    [
      'exported arrow variable',
      `${IMPORT}export const GET = async (req: Request) => {\n  ${GUARD}  return new Response('x');\n};`,
    ],
    ['re-export from another module', "export { GET } from './other';"],
    [
      'requireDevice imported from elsewhere',
      `import { requireDevice } from './fake';\nexport async function GET(req: Request) {\n  ${GUARD}  return new Response('x');\n}`,
    ],
    [
      'local requireDevice shadow',
      `function requireDevice(_r: Request) { return { principal: {} }; }\nexport async function GET(req: Request) {\n  ${GUARD}  return new Response('x');\n}`,
    ],
    [
      'non-async handler',
      `${IMPORT}export function GET(req: Request) {\n  ${GUARD}  return new Response('x');\n}`,
    ],
    [
      'export specifier of an unguarded function',
      `${IMPORT}async function handle(req: Request) { return new Response('x'); }\nexport { handle as POST };`,
    ],
  ])('the checker rejects unguarded shapes: %s', (_name, src) => {
    expect(checkRoute('x/route.ts', src).problems.length).toBeGreaterThan(0);
  });

  it('the checker accepts the canonical shape', () => {
    const src = `${IMPORT}export async function GET(req: Request) {\n  ${GUARD}  return new Response('x');\n}\nasync function h(req: Request) {\n  ${GUARD}  return new Response('y');\n}\nexport { h as DELETE };`;
    const r = checkRoute('x/route.ts', src);
    expect(r.problems).toEqual([]);
    expect(r.handlers).toEqual([
      { method: 'GET', kind: 'guarded' },
      { method: 'DELETE', kind: 'guarded' },
    ]);
  });
});
