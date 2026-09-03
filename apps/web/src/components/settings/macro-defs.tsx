'use client';

import { MathJax } from 'better-react-mathjax';

/** Defines TeX macros for the page. Mounted at the top of a layout so MathJax processes it before any content. */
export function MacroDefs({ block }: { block: string }) {
  if (!block) return null;
  return (
    <MathJax key={block} hideUntilTypeset="first">
      <span
        aria-hidden="true"
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      >{`\\(${block}\\)`}</span>
    </MathJax>
  );
}
