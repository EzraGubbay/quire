// Resolves @napi-rs/canvas and pdfjs-dist the way the built app does. `next build` rewrites externalized packages
// to hashed names (e.g. `pdfjs-dist-<hash>`, `@napi-rs/canvas-<hash>`) that are symlinked under `.next/node_modules`;
// the server chunks resolve those, not the plain names. On a checkout without a build the plain names are used.
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function resolveAppModules(appRoot) {
  const nextModules = path.join(appRoot, '.next', 'node_modules');
  const hashed = (dir, prefix) => {
    try {
      return readdirSync(dir).find((n) => n.startsWith(prefix) && /-[0-9a-f]{8,}$/.test(n)) ?? null;
    } catch {
      return null;
    }
  };
  const pdfHash = hashed(nextModules, 'pdfjs-dist-');
  const canvasHash = hashed(path.join(nextModules, '@napi-rs'), 'canvas-');
  const chunkRequire = createRequire(path.join(appRoot, '.next', 'server', 'chunks', 'x.js'));
  const plainRequire = createRequire(path.join(appRoot, 'server.js'));
  const useNext = existsSync(nextModules) && pdfHash && canvasHash;
  const req = useNext ? chunkRequire : plainRequire;
  const canvasSpecifier = useNext ? `@napi-rs/${canvasHash}` : '@napi-rs/canvas';
  const pdfSpecifier = useNext ? `${pdfHash}/legacy/build/pdf.mjs` : 'pdfjs-dist/legacy/build/pdf.mjs';
  return {
    how: useNext ? 'next externals (.next/node_modules)' : 'plain package names',
    canvasSpecifier,
    pdfSpecifier,
    canvasEntry: req.resolve(canvasSpecifier),
    pdfPath: req.resolve(pdfSpecifier),
    appRequire: req,
  };
}
