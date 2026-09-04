'use client';

import { useTransition } from 'react';
import { saveThemeAction } from '@/app/actions/theme';
import { usePlatform } from '@/components/platform';
import { useTheme } from '@/components/providers';
import { PLATFORMS } from '@/lib/platform';
import type { ThemeSetting } from '@/lib/theme';
import s from './settings.module.css';

const OPTIONS: { value: ThemeSetting; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Warm paper' },
  { value: 'dark', label: 'Dark', hint: 'Warm charcoal' },
  { value: 'system', label: 'System', hint: 'Follow the device' },
];

/** Default theme for every device, plus a "preview as" selector for checking the phone/tablet layouts. */
export function ThemePanel() {
  const { setting, applySetting } = useTheme();
  const { detected, override, setOverride } = usePlatform();
  const [pending, start] = useTransition();
  return (
    <section className={s.section}>
      <h2 className={s.h2}>Appearance</h2>
      <p className={s.help}>
        The default on every device. The moon/sun button in the app bar overrides it on this device only,
        until you pick here again.
      </p>
      <div className={s.radios} role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => (
          <label key={o.value} className={s.radio} data-active={setting === o.value}>
            <input
              type="radio"
              name="theme"
              value={o.value}
              checked={setting === o.value}
              disabled={pending}
              onChange={() => {
                applySetting(o.value);
                start(() => saveThemeAction(o.value));
              }}
            />
            <span>
              <strong>{o.label}</strong>
              <span className={s.help}>{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <h3 className={s.h3}>Device class</h3>
      <p className={s.help}>
        Detected: <strong>{detected}</strong>. Features are switched per class; preview another class here to
        check its layout on this screen.
      </p>
      <select
        className={s.select}
        aria-label="Preview as"
        value={override ?? 'auto'}
        onChange={(e) =>
          setOverride(e.target.value === 'auto' ? null : (e.target.value as (typeof PLATFORMS)[number]))
        }
      >
        <option value="auto">Auto (detected)</option>
        {PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </section>
  );
}
