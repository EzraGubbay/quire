// Render smoke harness (#122). Renders synthetic one-feature PDF pages the way lib/slides.ts does, each page and
// variant in its own child process, and reports the canvas/pdfjs environment plus a case x variant table.
// Run inside the runtime image (see run-in-image.sh) or on a checkout after `pnpm install`.
// Usage: node run.mjs --app-root <dir> --out <dir> [--variants a,b] [--cases a,b] [--timeout-ms 60000]
//
// Variants (only `prod` counts for the exit code):
//   prod               mirrors lib/slides.ts exactly
//   assets             prod + standardFontDataUrl / cMapUrl / wasmUrl from the first existing directory
//   assets-nosys       assets with useSystemFonts: false (pdf.js skips its standard font data when it is true)
//   one-canvas         app canvas for Path2D/DOMMatrix/ImageData and for pdfjs's CanvasFactory
//   one-canvas+assets  both of the above
//   one-canvas+assets-nosys  one-canvas + assets-nosys
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppModules } from './resolve-app.mjs';
import { buildSmokeCases } from './smoke-pdfs.mjs';

const VARIANTS = [
  'prod',
  'assets',
  'assets-nosys',
  'one-canvas',
  'one-canvas+assets',
  'one-canvas+assets-nosys',
];
const here = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const appRoot = path.resolve(args['app-root'] ?? '.');
const repoRoot = path.resolve(appRoot, '..', '..');
const out = path.resolve(args.out ?? 'render-smoke-out');
const timeoutMs = Number(args['timeout-ms'] ?? 60000);
const variants = args.variants ? args.variants.split(',') : VARIANTS;
const only = args.cases ? args.cases.split(',') : null;

/** Keeps local absolute paths out of anything that gets printed or uploaded. */
const scrub = (s) =>
  String(s).split(appRoot).join('<app>').split(repoRoot).join('<root>').split(out).join('<out>');
const relNm = (p) => {
  if (!p) return null;
  const i = p.indexOf('node_modules/');
  if (i >= 0) return p.slice(i);
  return scrub(p);
};
const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

function packageDirOf(entry, name) {
  let dir = path.dirname(entry);
  for (;;) {
    const pj = safe(() => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')));
    if (pj?.name === name) return { dir, version: pj.version };
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
const countFiles = (dir) => {
  let n = 0;
  for (const e of safe(() => readdirSync(dir, { withFileTypes: true }), [])) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
};

function describeEnv() {
  const resolved = safe(() => resolveAppModules(appRoot));
  const appCanvasEntry = resolved?.canvasEntry;
  const appCanvas = appCanvasEntry && packageDirOf(appCanvasEntry, '@napi-rs/canvas');
  const pdfPath = resolved?.pdfPath;
  const pdfjs = pdfPath && packageDirOf(pdfPath, 'pdfjs-dist');
  const pdfCanvasEntry = pdfPath && safe(() => createRequire(pdfPath).resolve('@napi-rs/canvas'));
  const pdfCanvas = pdfCanvasEntry && packageDirOf(pdfCanvasEntry, '@napi-rs/canvas');
  const real = (d) => (d ? safe(() => realpathSync(d.dir)) : null);
  const bindings = (d) =>
    d
      ? safe(
          () =>
            readdirSync(path.dirname(real(d)))
              .filter((n) => n.startsWith('canvas-'))
              .map(
                (n) =>
                  `${n}@${safe(() => JSON.parse(readFileSync(path.join(path.dirname(real(d)), n, 'package.json'), 'utf8')).version)}`,
              ),
          [],
        )
      : [];
  const link = (p) =>
    safe(
      () =>
        lstatSync(p).isSymbolicLink()
          ? relNm(path.resolve(path.dirname(p), readlinkSync(p)))
          : 'not a symlink',
      'absent',
    );
  const specifier = safe(() => {
    const pj = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    return pj.dependencies?.['@napi-rs/canvas'] ?? pj.devDependencies?.['@napi-rs/canvas'] ?? 'absent';
  }, 'no package.json');
  const exists = (p) => existsSync(p);
  return {
    node: process.version,
    arch: process.arch,
    uid: process.getuid?.() ?? null,
    resolution: resolved
      ? `${resolved.how}: ${resolved.canvasSpecifier}, ${resolved.pdfSpecifier}`
      : 'unresolved',
    appCanvas: {
      specifier,
      version: appCanvas?.version ?? null,
      realpath: relNm(real(appCanvas)),
      bindings: bindings(appCanvas),
    },
    pdfjsDist: { version: pdfjs?.version ?? null, realpath: relNm(real(pdfjs)) },
    pdfjsCanvas: {
      version: pdfCanvas?.version ?? null,
      realpath: relNm(real(pdfCanvas)),
      bindings: bindings(pdfCanvas),
    },
    sameCanvasInstance: Boolean(appCanvas && pdfCanvas && real(appCanvas) === real(pdfCanvas)),
    rootCanvasSymlink: link(path.join(repoRoot, 'node_modules', '@napi-rs', 'canvas')),
    appCanvasSymlink: link(path.join(appRoot, 'node_modules', '@napi-rs', 'canvas')),
    canvasPnpmDirs: safe(
      () =>
        readdirSync(path.join(repoRoot, 'node_modules', '.pnpm')).filter((n) =>
          n.startsWith('@napi-rs+canvas'),
        ),
      [],
    ),
    workerNextToPdf: Boolean(pdfPath && exists(path.join(path.dirname(pdfPath), 'pdf.worker.mjs'))),
    pdfjsAssets: Object.fromEntries(
      ['standard_fonts', 'cmaps', 'wasm'].map((d) => [
        d,
        Boolean(pdfPath && exists(path.join(path.dirname(pdfPath), '..', '..', d))),
      ]),
    ),
    publicPdfjsAssets: Object.fromEntries(
      ['standard_fonts', 'cmaps', 'wasm'].map((d) => [d, exists(path.join(appRoot, 'public', 'pdfjs', d))]),
    ),
    systemFontFiles: countFiles('/usr/share/fonts'),
    _pdfPath: pdfPath,
  };
}

function runChild(caseId, variant, manifestPath) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(here, 'render-one.mjs'),
        '--app-root',
        appRoot,
        '--manifest',
        manifestPath,
        '--case',
        caseId,
        '--variant',
        variant,
        '--out',
        out,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      const result = line ? safe(() => JSON.parse(line.slice(7))) : null;
      resolve({
        code,
        signal,
        timedOut,
        result,
        stderrTail: stderr.split('\n').filter(Boolean).slice(-15).map(scrub),
      });
    });
  });
}

function classify(run, spec) {
  if (run.timedOut) return { status: 'TIMEOUT' };
  const crashed = run.signal || (run.code !== null && run.code >= 128) || !run.result;
  if (crashed) return { status: `CRASH(${run.signal ?? run.code ?? 'no result'})`, tail: run.stderrTail };
  const r = run.result;
  if (r.status === 'error') return { status: 'ERROR', message: scrub(r.message), logs: r.logs };
  const low = r.regions
    .filter((g) => g.ratio < (spec.regions.find((x) => x.name === g.name)?.min ?? 0.02))
    .map((g) => g.name);
  const base = {
    ratio: r.ratio,
    regions: r.regions,
    logs: r.logs,
    jpegBytes: r.jpegBytes,
    size: `${r.width}x${r.height}`,
    scale: r.scale,
  };
  if (r.uniform || low.length === r.regions.length) return { status: 'BLANK', ...base };
  if (low.length) return { status: `PARTIAL(${low.join(',')})`, ...base };
  return { status: 'OK', ...base };
}

const env = describeEnv();
const pdfDir = path.join(out, 'pdfs');
mkdirSync(pdfDir, { recursive: true });
const fontDir = [
  path.join(appRoot, 'public', 'pdfjs', 'standard_fonts'),
  env._pdfPath && path.join(path.dirname(env._pdfPath), '..', '..', 'standard_fonts'),
]
  .filter(Boolean)
  .find((d) => existsSync(d));
const { cases: built, skipped } = buildSmokeCases({ fontDir });
const cases = built.filter((c) => !only || only.includes(c.id));
const manifest = { cases: [], skipped };
for (const c of cases) {
  writeFileSync(path.join(pdfDir, `${c.id}.pdf`), c.bytes);
  const { bytes, ...meta } = c;
  manifest.cases.push({ ...meta, file: `${c.id}.pdf` });
}
const manifestPath = path.join(pdfDir, 'manifest.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
delete env._pdfPath;

const results = [];
for (const spec of manifest.cases) {
  for (const variant of variants) {
    const run = await runChild(spec.id, variant, manifestPath);
    results.push({ case: spec.id, variant, ...classify(run, spec) });
  }
}
writeFileSync(path.join(out, 'results.json'), `${JSON.stringify({ env, skipped, results }, null, 2)}\n`);

const cell = (r) => (r ? `${r.status}${r.ratio !== undefined ? ` ${r.ratio.toFixed(3)}` : ''}` : '-');
const lines = [
  '## Render smoke',
  '',
  '### Environment',
  '',
  `- node ${env.node}, ${env.arch}, uid ${env.uid}`,
  `- app resolution: ${env.resolution.replace(/-[0-9a-f]{16}/g, '-<hash>')}`,
  `- app canvas: spec \`${env.appCanvas.specifier}\` -> **${env.appCanvas.version}** at \`${env.appCanvas.realpath}\` (bindings: ${env.appCanvas.bindings.join(', ') || 'none'})`,
  `- pdfjs-dist: **${env.pdfjsDist.version}** at \`${env.pdfjsDist.realpath}\``,
  `- pdfjs's canvas: **${env.pdfjsCanvas.version}** at \`${env.pdfjsCanvas.realpath}\` (bindings: ${env.pdfjsCanvas.bindings.join(', ') || 'none'})`,
  `- same canvas instance: **${env.sameCanvasInstance ? 'yes' : 'no'}**`,
  `- root node_modules/@napi-rs/canvas -> \`${env.rootCanvasSymlink}\`; app node_modules/@napi-rs/canvas -> \`${env.appCanvasSymlink}\``,
  `- canvas pnpm dirs: ${env.canvasPnpmDirs.map((d) => `\`${d}\``).join(', ') || 'none'}`,
  `- pdf.worker.mjs next to pdf.mjs: ${env.workerNextToPdf ? 'yes' : 'no'}`,
  `- pdfjs-dist asset dirs (standard_fonts/cmaps/wasm): ${Object.values(env.pdfjsAssets)
    .map((v) => (v ? 'yes' : 'no'))
    .join('/')}`,
  `- public/pdfjs asset dirs (standard_fonts/cmaps/wasm): ${Object.values(env.publicPdfjsAssets)
    .map((v) => (v ? 'yes' : 'no'))
    .join('/')}`,
  `- files under /usr/share/fonts: ${env.systemFontFiles}`,
  skipped.length ? `- skipped cases: ${skipped.map((s) => `${s.id} (${s.reason})`).join('; ')}` : '',
  '',
  '### Cases x variants (`STATUS non-white-ratio`)',
  '',
  `| case | ${variants.join(' | ')} |`,
  `|---|${variants.map(() => '---').join('|')}|`,
  ...manifest.cases.map(
    (c) =>
      `| ${c.id} | ${variants.map((v) => cell(results.find((r) => r.case === c.id && r.variant === v))).join(' | ')} |`,
  ),
  '',
  '### Per-region ratios',
  '',
  ...results
    .filter((r) => r.regions)
    .map(
      (r) =>
        `- ${r.case} / ${r.variant}: ${r.regions.map((g) => `${g.name}=${g.ratio.toFixed(3)}`).join(', ')} (${r.size}, ${r.jpegBytes} B, scale ${r.scale})`,
    ),
  '',
  '### Notes',
  '',
];
const notes = new Set();
for (const r of results) {
  if (r.message) notes.add(`- ${r.case} / ${r.variant}: ERROR ${r.message}`);
  if (r.tail?.length)
    notes.add(`- ${r.case} / ${r.variant}: ${r.status}\n${r.tail.map((t) => `    ${t}`).join('\n')}`);
  for (const l of r.logs ?? []) notes.add(`- ${r.case} / ${r.variant}: log: ${scrub(l)}`);
}
lines.push(...(notes.size ? [...notes] : ['none']), '');
const summary = lines.join('\n');
writeFileSync(path.join(out, 'summary.md'), summary);
process.stdout.write(`${summary}\n`);

let failed = false;
for (const r of results.filter((x) => x.variant === 'prod' && x.status !== 'OK')) {
  failed = true;
  if (process.env.GITHUB_ACTIONS)
    process.stdout.write(`::warning title=render-smoke::${r.case} ${r.status}\n`);
}
process.exit(failed ? 1 : 0);
