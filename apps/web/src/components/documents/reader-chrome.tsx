'use client';

import { Icon } from '@ezragubbay/folio';
import { ChevronLeft, MessageSquareText, MoreHorizontal } from 'lucide-react';
import NextLink from 'next/link';
import s from './reader-chrome.module.css';

export interface ReaderChromeProps {
  slug: string;
  title: string;
  /** "3 / 8" for PDFs, "42%" for Markdown. */
  position: string;
  annotationCount: number;
  visible: boolean;
  onAnnotations: () => void;
  onMore: () => void;
  onTitleTap: () => void;
}

/**
 * Phone reader bar: back, title, position, annotations, more. Sits at the bottom edge (one-handed reach),
 * slides away while reading, and comes back on a tap of the page. Stays mounted so it animates and stays
 * reachable by assistive tech.
 */
export function ReaderChrome({
  slug,
  title,
  position,
  annotationCount,
  visible,
  onAnnotations,
  onMore,
  onTitleTap,
}: ReaderChromeProps) {
  return (
    <div className={s.bar} data-visible={visible ? 'true' : 'false'} data-testid="reader-chrome">
      <NextLink href={`/p/${slug}/documents`} className={s.btn} aria-label="Back to documents">
        <Icon icon={ChevronLeft} />
      </NextLink>
      <button type="button" className={s.title} onClick={onTitleTap} title="Scroll to top">
        {title}
      </button>
      <span className={s.pos} data-testid="reader-position">
        {position}
      </span>
      <button
        type="button"
        className={s.btn}
        aria-label={`Annotations, ${annotationCount}`}
        onClick={onAnnotations}
      >
        <Icon icon={MessageSquareText} />
        {annotationCount > 0 && <span className={s.badge}>{annotationCount}</span>}
      </button>
      <button type="button" className={s.btn} aria-label="More" onClick={onMore}>
        <Icon icon={MoreHorizontal} />
      </button>
    </div>
  );
}
