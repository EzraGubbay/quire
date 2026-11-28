// pdf.js polyfills Path2D/DOMMatrix/ImageData and creates its scratch canvases from whichever @napi-rs/canvas it
// resolves itself. When that is a different copy from the app's (two versions installed), a Path2D or canvas
// from one copy reaches a context of the other: errors ("Value is none of these types String, Path") or a native
// crash on raster pages. Use the app's copy for everything.
export async function loadPdfCanvas() {
  const canvas = await import('@napi-rs/canvas');
  Object.assign(globalThis, {
    Path2D: canvas.Path2D,
    DOMMatrix: canvas.DOMMatrix,
    ImageData: canvas.ImageData,
  });
  class CanvasFactory {
    create(width: number, height: number) {
      const c = canvas.createCanvas(width, height);
      return { canvas: c, context: c.getContext('2d') };
    }
    reset(entry: { canvas: { width: number; height: number } }, width: number, height: number) {
      entry.canvas.width = width;
      entry.canvas.height = height;
    }
    destroy(entry: { canvas: { width: number; height: number } }) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
  }
  return { createCanvas: canvas.createCanvas, CanvasFactory };
}
