// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadPdfCanvas } from './pdf-canvas';

describe('loadPdfCanvas', () => {
  it("installs the app's own Path2D, DOMMatrix and ImageData as globals", async () => {
    await loadPdfCanvas();
    const canvas = await import('@napi-rs/canvas');
    expect(globalThis.Path2D).toBe(canvas.Path2D);
    expect(globalThis.DOMMatrix).toBe(canvas.DOMMatrix);
    expect(globalThis.ImageData).toBe(canvas.ImageData);
  });

  it('creates canvases of the requested size with a 2d context', async () => {
    const { CanvasFactory } = await loadPdfCanvas();
    const entry = new CanvasFactory().create(3, 4);
    expect(entry.canvas.width).toBe(3);
    expect(entry.canvas.height).toBe(4);
    expect(typeof entry.context.fillRect).toBe('function');
  });

  it('resizes on reset and releases the bitmap on destroy', async () => {
    const { CanvasFactory } = await loadPdfCanvas();
    const factory = new CanvasFactory();
    const entry = factory.create(3, 4);
    factory.reset(entry, 7, 8);
    expect([entry.canvas.width, entry.canvas.height]).toEqual([7, 8]);
    factory.destroy(entry);
    expect([entry.canvas.width, entry.canvas.height]).not.toEqual([7, 8]);
  });
});
