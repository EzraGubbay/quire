import { z } from 'zod';

/** The five annotation types. Order is the display order of the filter buttons. */
export const ANNOTATION_TYPES = ['note', 'insight', 'idea', 'question', 'todo'] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export const annotationTypeSchema = z.enum(ANNOTATION_TYPES);

export const ANNOTATION_TYPE_LABEL: Record<AnnotationType, string> = {
  note: 'Note',
  insight: 'Insight',
  idea: 'Idea',
  question: 'Question',
  todo: 'Todo',
};

/** Anchor of an annotation inside a PDF page's text layer. */
export const pdfAnchorSchema = z.object({
  kind: z.literal('pdf'),
  page: z.number().int().min(1),
  /** The selected text, exact. */
  quote: z.string().min(1),
  /** A few characters before and after the quote, to disambiguate repeats. */
  prefix: z.string().default(''),
  suffix: z.string().default(''),
  /** Character offsets into the page's concatenated text-layer string. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /** Highlight rectangles in PDF user space, per line. */
  rects: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).default([]),
});

/** Anchor of an annotation inside rendered Markdown (a W3C-style text quote selector). */
export const markdownAnchorSchema = z.object({
  kind: z.literal('markdown'),
  quote: z.string().min(1),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
  /** Character offsets into the rendered plain text at the time of creation. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

export const anchorSchema = z.discriminatedUnion('kind', [pdfAnchorSchema, markdownAnchorSchema]);
export type PdfAnchor = z.infer<typeof pdfAnchorSchema>;
export type MarkdownAnchor = z.infer<typeof markdownAnchorSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
