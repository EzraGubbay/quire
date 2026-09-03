import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@ezragubbay/core', '@ezragubbay/folio', '@quire/shared'],
  // pdf.js resolves its worker relative to its own file and needs @napi-rs/canvas at runtime; keep both unbundled.
  serverExternalPackages: ['pdfjs-dist', '@napi-rs/canvas'],
  // The standalone tracer misses pdf.js's dynamically imported worker (canvas is added in the Dockerfile).
  outputFileTracingIncludes: {
    '/**': ['../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/**'],
  },
  experimental: {
    serverActions: { bodySizeLimit: '100mb' },
    // Keep visited dynamic pages in the client router cache briefly: tab switching back is instant.
    // Mutations call revalidatePath/router.refresh, which invalidate it.
    staleTimes: { dynamic: 30, static: 180 },
  },
};

export default nextConfig;
