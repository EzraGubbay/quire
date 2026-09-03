import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@ezragubbay/core', '@ezragubbay/folio', '@quire/shared'],
  experimental: { serverActions: { bodySizeLimit: '100mb' } },
};

export default nextConfig;
