'use client';

import { FolioProvider } from '@ezragubbay/folio';
import { MathJaxContext } from 'better-react-mathjax';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ThemeSetting } from '@/lib/theme';

type Theme = 'light' | 'dark';
interface ThemeCtx {
  theme: Theme;
  /** The stored default from Settings. */
  setting: ThemeSetting;
  /** Header toggle: a per-device override kept in localStorage. */
  toggle: () => void;
  /** Settings radio: applies everywhere and clears the device override. */
  applySetting: (s: ThemeSetting) => void;
}
const ThemeContext = createContext<ThemeCtx>({
  theme: 'light',
  setting: 'system',
  toggle: () => {},
  applySetting: () => {},
});
export const useTheme = () => useContext(ThemeContext);

// Same setup as folio's MathProvider, but served from this origin: the CDN copy failed to load on the iPad.
const MATHJAX = {
  loader: { load: ['[tex]/ams'] },
  tex: {
    packages: { '[+]': ['ams'] },
    inlineMath: [
      ['$', '$'],
      ['\\(', '\\)'],
    ],
    displayMath: [
      ['$$', '$$'],
      ['\\[', '\\]'],
    ],
  },
};

const STORAGE_KEY = 'quire.theme';

const systemTheme = (): Theme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

function resolve(setting: ThemeSetting): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return setting === 'system' ? systemTheme() : setting;
}

export function Providers({ children, themeSetting }: { children: ReactNode; themeSetting: ThemeSetting }) {
  const [setting, setSetting] = useState<ThemeSetting>(themeSetting);
  const [theme, setTheme] = useState<Theme>(themeSetting === 'system' ? 'light' : themeSetting);
  useEffect(() => {
    setTheme(resolve(setting));
    if (setting !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      try {
        if (!window.localStorage.getItem(STORAGE_KEY)) setTheme(mq.matches ? 'dark' : 'light');
      } catch {}
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setting]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {}
      return next;
    });
  }, []);
  const applySetting = useCallback((s: ThemeSetting) => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setSetting(s);
    setTheme(s === 'system' ? systemTheme() : s);
  }, []);
  const value = useMemo(
    () => ({ theme, setting, toggle, applySetting }),
    [theme, setting, toggle, applySetting],
  );
  return (
    <ThemeContext.Provider value={value}>
      <FolioProvider theme={theme}>
        <MathJaxContext version={3} src="/mathjax/tex-mml-chtml.js" config={MATHJAX}>
          {children}
        </MathJaxContext>
      </FolioProvider>
    </ThemeContext.Provider>
  );
}
