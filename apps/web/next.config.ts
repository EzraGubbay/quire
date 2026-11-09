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
    // The proxy (this fork's middleware) buffers the request body with a 10 MB default cap, so a deck over
    // 10 MB was truncated before the upload server action saw it — the multipart form arrived cut off and
    // threw "Unexpected end of form" (a 500, surfaced to the client as React #441). Lift it to match the
    // server-action limit so real decks (and the 100 MB client guard) pass through intact.
    proxyClientMaxBodySize: '100mb',
    // Keep visited dynamic pages in the client router cache briefly: tab switching back is instant.
    // Mutations call revalidatePath/router.refresh, which invalidate it.
    staleTimes: { dynamic: 30, static: 180 },
  },
};

export default nextConfig;
