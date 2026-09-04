import NextLink from 'next/link';
import type { Platform } from '@/lib/platform';
import s from './ui.module.css';

const NAME: Record<Platform, string> = { phone: 'phones', tablet: 'tablets', desktop: 'this device' };

/** Shown in place of a feature that is off for the current device class. */
export function Unavailable({
  feature,
  platform,
  backHref,
  backLabel,
}: {
  feature: string;
  platform: Platform;
  backHref: string;
  backLabel: string;
}) {
  return (
    <div className={s.empty} data-testid="unavailable">
      <h2 className={s.emptyTitle}>
        {feature} is not available on {NAME[platform]}
      </h2>
      <p className={s.emptyBody}>
        Open Quire on your iPad or laptop for this. Everything you add there is here too.
      </p>
      <div className={s.emptyActions}>
        <NextLink href={backHref}>{backLabel}</NextLink>
      </div>
    </div>
  );
}
