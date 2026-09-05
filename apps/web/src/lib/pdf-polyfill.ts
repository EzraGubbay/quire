// pdf.js 5.x uses Map/WeakMap.prototype.getOrInsert(Computed) (TC39 "upsert"), which iOS 18 Safari lacks.
// The legacy build polyfills them, but this runs first regardless so a build change cannot reintroduce the crash.
export const PDF_POLYFILL_SOURCE = `(function(){
  for (const C of [Map, WeakMap]) {
    const P = C.prototype;
    if (typeof P.getOrInsert !== 'function') Object.defineProperty(P, 'getOrInsert', { configurable: true, writable: true, value: function(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); } });
    if (typeof P.getOrInsertComputed !== 'function') Object.defineProperty(P, 'getOrInsertComputed', { configurable: true, writable: true, value: function(k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); } });
  }
})();`;

export function installPdfPolyfills(): void {
  // biome-ignore lint/security/noGlobalEval: deliberate, tiny, static source shared with the worker file.
  (0, eval)(PDF_POLYFILL_SOURCE);
}
