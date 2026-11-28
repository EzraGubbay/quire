// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfAssetUrls } from '@/core/pdf/open';
import { buildSmokeCases } from '../../scripts/render-smoke/smoke-pdfs.mjs';

// Host regression test for the one-canvas policy and the bundled fonts: renders each synthetic smoke page through
// renderPages (the MCP page-image path) and checks the JPEG actually has the page's ink in it. Rendering stays
// in-process on purpose: a native crash from two canvas copies kills the worker and fails the test loudly.
const tmp = mkdtempSync(path.join(tmpdir(), 'slides-render-'));
process.env.FILES_DIR = tmp;

type Region = { name: string; x: number; y: number; w: number; h: number; min: number };
type SmokeCase = {
  id: string;
  page: { width?: number; height?: number };
  regions: Region[];
  bytes: Uint8Array;
};

const PAGE_W = 720;
const PAGE_H = 405;
const WHITE_BELOW = 235;

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('renderPages renders every smoke page', () => {
  let cases: SmokeCase[] = [];
  let renderPages: typeof import('./slides').renderPages;
  let writeFile: typeof import('node:fs/promises').writeFile;
  let mkdir: typeof import('node:fs/promises').mkdir;
  let readFile: typeof import('node:fs/promises').readFile;

  beforeAll(async () => {
    ({ renderPages } = await import('./slides'));
    ({ writeFile, mkdir, readFile } = await import('node:fs/promises'));
    cases = buildSmokeCases({ fontDir: pdfAssetUrls().standardFontDataUrl }).cases as SmokeCase[];
  });

  it('has all eleven cases', () => {
    expect(cases).toHaveLength(11);
  });

  it.each([
    'text-type3',
    'text-helvetica',
    'text-embedded-truetype',
    'vector-shapes',
    'shading-axial',
    'image-raw-gray',
    'image-jpeg',
    'image-smask',
    'image-stencil-mask',
    'transparency-group',
    'slide-combo',
  ])(
    '%s is not blank and has ink in its regions',
    async (id) => {
      const spec = cases.find((c) => c.id === id);
      if (!spec) throw new Error(`no smoke case ${id}`);
      const projectId = `p-${id}`;
      await mkdir(path.join(tmp, projectId), { recursive: true });
      await writeFile(path.join(tmp, projectId, `${id}.pdf`), spec.bytes);
      const doc = { projectId, id, filePath: path.join(projectId, `${id}.pdf`) };
      const [img] = await renderPages(doc, [1], {
        cacheName: 'smoke',
        maxWidth: 1024,
        maxHeight: 1568,
        quality: 60,
        maxBytes: 72_000,
      });
      expect(img).toBeDefined();
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const image = await loadImage(await readFile(path.join(tmp, img?.path ?? '')));
      const c = createCanvas(image.width, image.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height);
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < data.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          lo = Math.min(lo, data[i + k] ?? 0);
          hi = Math.max(hi, data[i + k] ?? 0);
        }
      }
      expect(hi - lo, 'the render is a flat colour').toBeGreaterThan(6);

      const s = width / PAGE_W;
      for (const r of spec.regions) {
        const x0 = Math.max(0, Math.floor(r.x * s));
        const x1 = Math.min(width, Math.ceil((r.x + r.w) * s));
        const y0 = Math.max(0, Math.floor((PAGE_H - r.y - r.h) * s));
        const y1 = Math.min(height, Math.ceil((PAGE_H - r.y) * s));
        let non = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4;
            if (Math.min(data[i] ?? 255, data[i + 1] ?? 255, data[i + 2] ?? 255) < WHITE_BELOW) non++;
            n++;
          }
        }
        expect(n ? non / n : 0, `region ${r.name}`).toBeGreaterThanOrEqual(r.min);
      }
      void height;
    },
    60_000,
  );
});
