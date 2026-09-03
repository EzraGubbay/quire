import { AppShell } from '@/components/app-shell';
import { MacrosPanel } from '@/components/settings/macros-panel';
import s from '@/components/settings/settings.module.css';
import { listMacros } from '@/lib/macros';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const macros = await listMacros(null);
  return (
    <AppShell>
      <div className={s.wrap}>
        <h1 className={s.title}>Settings</h1>
        <MacrosPanel scope="global" macros={macros} />
      </div>
    </AppShell>
  );
}
