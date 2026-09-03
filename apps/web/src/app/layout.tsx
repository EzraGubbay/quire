import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@ezragubbay/folio/fonts.css';
import '@ezragubbay/folio/styles.css';
import './globals.css';
import './highlights.css';
import { Providers } from '@/components/providers';
import { MacroDefs } from '@/components/settings/macro-defs';
import { SwRegister } from '@/components/sw-register';
import { mergedMacros, newcommandBlock } from '@/lib/macros';

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
  const block = newcommandBlock(await mergedMacros(null).catch(() => []));
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <MacroDefs block={block} />
          {children}
          <SwRegister />
        </Providers>
      </body>
    </html>
  );
}
