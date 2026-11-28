import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The render smoke's `prod` variant (scripts/render-smoke/render-one.mjs) re-implements how lib/slides.ts renders a
// page. This tripwire fails when slides.ts stops using the options the smoke mirrors, so the two get updated together.
const slides = readFileSync(path.join(process.cwd(), 'src/lib/slides.ts'), 'utf8');

describe('render smoke mirrors lib/slides.ts', () => {
  const MIRRORED = [
    'getDocument({ data: new Uint8Array(data), useSystemFonts: true })',
    "import('@napi-rs/canvas')",
    'canvasContext: ctx as unknown as CanvasRenderingContext2D',
    '[quality, quality - 10, quality - 20]',
  ];
  it.each(MIRRORED)('slides.ts still contains %s', (snippet) => {
    expect(
      slides,
      `lib/slides.ts changed how it renders (${snippet}): update the prod variant in scripts/render-smoke/render-one.mjs`,
    ).toContain(snippet);
  });
});
