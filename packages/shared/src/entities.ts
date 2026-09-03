import { z } from 'zod';

export const DOCUMENT_KINDS = ['pdf', 'markdown'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const READING_STATUSES = ['unread', 'reading', 'done'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SOURCE_TYPES = ['web', 'book', 'video', 'dataset', 'repo', 'post', 'other'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Graph node entity kinds. */
export const ENTITY_KINDS = ['document', 'note', 'source', 'annotation', 'run'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Edge kinds in the single links table. */
export const LINK_KINDS = ['wiki', 'mention', 'belongs', 'suggested'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
