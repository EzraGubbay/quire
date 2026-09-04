import NextLink from 'next/link';
import { AppShell } from '@/components/app-shell';
import { AiPanel } from '@/components/settings/ai-panel';
import { FeaturesPanel } from '@/components/settings/features-panel';
import { MacrosPanel } from '@/components/settings/macros-panel';
import s from '@/components/settings/settings.module.css';
import { SpendPanel } from '@/components/settings/spend-panel';
import { ThemePanel } from '@/components/settings/theme-panel';
import { spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { getAiSettings } from '@/lib/ai/settings';
import { listMacros } from '@/lib/macros';
import { currentFeature } from '@/lib/platform-server';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [macros, ai, summary, full, flags] = await Promise.all([
    listMacros(null),
    getAiSettings(),
    spendSummary(),
    currentFeature('settings.full'),
    currentFeature('settings.flags'),
  ]);
  const lite = full.level === 'lite';
  return (
    <AppShell>
      <div className={s.wrap}>
        <NextLink href="/" className={s.crumb}>
          ← Projects
        </NextLink>
        <h1 className={s.title}>Settings</h1>
        <ThemePanel />
        {lite ? (
          <SpendPanel summary={summary} configured={aiConfigured()} />
        ) : (
          <AiPanel settings={ai} summary={summary} configured={aiConfigured()} />
        )}
        {!lite && <MacrosPanel scope="global" macros={macros} />}
        {flags.level === 'on' && <FeaturesPanel />}
        {lite && (
          <p className={s.help}>AI models, prices, and math macros are edited on an iPad or laptop.</p>
        )}
      </div>
    </AppShell>
  );
}
