import NextLink from 'next/link';
import { AppShell } from '@/components/app-shell';
import { AiPanel } from '@/components/settings/ai-panel';
import { MacrosPanel } from '@/components/settings/macros-panel';
import s from '@/components/settings/settings.module.css';
import { spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { getAiSettings } from '@/lib/ai/settings';
import { listMacros } from '@/lib/macros';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [macros, ai, summary] = await Promise.all([listMacros(null), getAiSettings(), spendSummary()]);
  return (
    <AppShell>
      <div className={s.wrap}>
        <NextLink href="/" className={s.crumb}>
          ← Projects
        </NextLink>
        <h1 className={s.title}>Settings</h1>
        <AiPanel settings={ai} summary={summary} configured={aiConfigured()} />
        <MacrosPanel scope="global" macros={macros} />
      </div>
    </AppShell>
  );
}
