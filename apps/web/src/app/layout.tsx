import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@ezragubbay/folio/fonts.css';
import '@ezragubbay/folio/styles.css';
import './globals.css';
import './highlights.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'Quire', template: '%s · Quire' },
  description: 'A personal research project manager.',
  applicationName: 'Quire',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F1E7' },
    { media: '(prefers-color-scheme: dark)', color: '#1C1915' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
