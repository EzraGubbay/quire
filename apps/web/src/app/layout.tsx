import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@ezragubbay/folio/fonts.css';
import '@ezragubbay/folio/styles.css';
import './globals.css';
import './highlights.css';
import { headers } from 'next/headers';
import { DebugInit } from '@/components/debug-init';
import { PlatformProvider } from '@/components/platform';
import { Providers } from '@/components/providers';
import { MacroDefs } from '@/components/settings/macro-defs';
import { SwRegister } from '@/components/sw-register';
import { getDebugSetting } from '@/lib/debug';
import { featureMatrix } from '@/lib/features';
import { mergedMacros, newcommandBlock } from '@/lib/macros';
import { platformFromHeaders } from '@/lib/platform';
import { getThemeSetting } from '@/lib/theme';

export const metadata: Metadata = {
  title: { default: 'Quire', template: '%s · Quire' },
  description: 'A personal research project manager.',
  applicationName: 'Quire',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Quire' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F1E7' },
    { media: '(prefers-color-scheme: dark)', color: '#1C1915' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [block, themeSetting, platform, debug] = await Promise.all([
    mergedMacros(null)
      .then(newcommandBlock)
      .catch(() => ''),
    getThemeSetting().catch(() => 'system' as const),
    headers().then(platformFromHeaders),
    getDebugSetting().catch(() => false),
  ]);
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <PlatformProvider initial={platform} matrix={featureMatrix()}>
          <Providers themeSetting={themeSetting}>
            <MacroDefs block={block} />
            {children}
            <SwRegister />
            <DebugInit enabled={debug} />
          </Providers>
        </PlatformProvider>
      </body>
    </html>
  );
}
