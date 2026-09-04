'use client';

import { usePlatform } from '@/components/platform';
import { FEATURE_KEYS, FEATURE_LABEL } from '@/lib/features';
import { PLATFORMS } from '@/lib/platform';
import s from './settings.module.css';

/** Read-only view of the feature matrix; flags themselves live in code (src/lib/features.ts). */
export function FeaturesPanel() {
  const { platform, matrix } = usePlatform();
  return (
    <section className={s.section}>
      <h2 className={s.h2}>Feature flags</h2>
      <p className={s.help}>
        What each device class gets. Rule: phones are for capture and lookup; anything needing a wide canvas,
        precise selection, or long typing stays on tablet and laptop. Flags are set in code (
        <code>features.ts</code>); this table shows what is live. Your class is highlighted.
      </p>
      <table className={s.table} data-testid="feature-flags">
        <thead>
          <tr>
            <th>Feature</th>
            {PLATFORMS.map((p) => (
              <th key={p} style={p === platform ? { color: 'var(--eg-accent-text)' } : undefined}>
                {p}
                {p === platform ? ' (you)' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATURE_KEYS.map((k) => (
            <tr key={k}>
              <td>
                {FEATURE_LABEL[k]} <code className={s.help}>{k}</code>
              </td>
              {PLATFORMS.map((p) => (
                <td key={p} className={s.level} data-level={matrix[k][p]}>
                  {matrix[k][p]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
