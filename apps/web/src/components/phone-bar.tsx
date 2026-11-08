'use client';

import { Icon, Mark } from '@ezragubbay/folio';
import { Moon, Settings, Sun } from 'lucide-react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { AskLauncher } from '@/components/chat/ask-launcher';
import { LemidaStatusDot } from '@/components/lemida/status-dot';
import { baseFor } from '@/lib/side';
import type { ShellProject } from './app-shell';
import s from './phone-bar.module.css';
import { useTheme } from './providers';

/** One-row phone header: mark (home), project name, Ask, theme, settings. Tabs live in the bottom TabBar. */
export function PhoneBar({ project }: { project?: ShellProject }) {
  const { theme, toggle } = useTheme();
  const pathname = usePathname();
  const inCourses = pathname.startsWith('/courses') || pathname.startsWith('/c/');
  return (
    <header className={s.bar} data-testid="phone-bar">
      <NextLink href="/" className={s.mark} aria-label="Home">
        <Mark variant="monogram" size={18} />
      </NextLink>
      {project ? (
        <NextLink href={`${baseFor(project.kind, project.slug)}/overview`} className={s.project}>
          {project.name}
        </NextLink>
      ) : (
        <span className={s.project}>Quire</span>
      )}
      <div className={s.actions}>
        {inCourses && <LemidaStatusDot />}
        {project && <AskLauncher slug={project.slug} />}
        <button
          type="button"
          className={s.iconBtn}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggle}
        >
          <Icon icon={theme === 'dark' ? Sun : Moon} />
        </button>
        <NextLink href="/settings" aria-label="Settings" className={s.iconBtn}>
          <Icon icon={Settings} />
        </NextLink>
      </div>
    </header>
  );
}
