'use client';

import type { ReactNode } from 'react';
import s from './segmented.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
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
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={s.seg}
          title={o.title}
          disabled={o.disabled}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
