'use client';

import type { MouseEvent, ReactNode } from 'react';
import s from './segmented.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** Render the segment as a link so it works before hydration (and without JS); onChange still runs on click. */
  href?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T, event: MouseEvent) => void;
  size?: 'sm' | 'md';
  'aria-label': string;
  className?: string;
}

/** A small segmented control (radio group semantics) styled with Folio tokens. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  ...rest
}: SegmentedProps<T>) {
  return (
    <div
      className={[s.root, className].filter(Boolean).join(' ')}
      role="radiogroup"
      data-size={size}
      aria-label={rest['aria-label']}
    >
      {options.map((o) =>
        o.href ? (
          <a
            key={o.value}
            href={o.href}
            role="radio"
            aria-checked={o.value === value}
            aria-disabled={o.disabled || undefined}
            className={s.seg}
            title={o.title}
            onClick={(e) => {
              if (o.disabled) {
                e.preventDefault();
                return;
              }
              if (o.value !== value) onChange(o.value, e);
            }}
          >
            {o.label}
          </a>
        ) : (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={s.seg}
            title={o.title}
            disabled={o.disabled}
            onClick={(e) => o.value !== value && onChange(o.value, e)}
          >
            {o.label}
          </button>
        ),
      )}
    </div>
  );
}
