import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@ezragubbay/core', '@ezragubbay/folio', '@quire/shared'],
  // pdf.js resolves its worker relative to its own file and needs @napi-rs/canvas at runtime; keep both unbundled.
  serverExternalPackages: ['pdfjs-dist', '@napi-rs/canvas'],
  // The standalone tracer misses pdf.js's dynamically imported worker and canvas's native binary.
  outputFileTracingIncludes: {
    '/**': [
      '../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/**',
      '../../node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/*.js',
      '../../node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/package.json',
      '../../node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/*.node',
      '../../node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/package.json',
    ],
  },
  experimental: { serverActions: { bodySizeLimit: '100mb' } },
};

export default nextConfig;
