import { z } from 'zod';

export const DOCUMENT_KINDS = ['pdf', 'markdown'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const READING_STATUSES = ['unread', 'reading', 'done'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A workspace is a research project or a university course; both live in the projects table. */
export const PROJECT_KINDS = ['research', 'course'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/** Course type only sets defaults (synthesis prompt addendum, note templates); it gates nothing. */
export const COURSE_TYPES = ['practical', 'theoretical', 'mixed'] as const;
export type CourseType = (typeof COURSE_TYPES)[number];

export const FOLDER_SCOPES = ['documents', 'notes'] as const;
export type FolderScope = (typeof FOLDER_SCOPES)[number];

/** Non-deletable folders every course starts with. */
export const BUILTIN_FOLDERS = ['raw', 'synthesized', 'practice_exams'] as const;
export type BuiltinFolder = (typeof BUILTIN_FOLDERS)[number];

export const NOTE_STATUSES = ['ready', 'generating', 'failed'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const SESSION_KINDS = ['lecture', 'recitation'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const ASSIGNMENT_STATUSES = ['not_started', 'in_progress', 'submitted', 'graded'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const QUESTION_STATUSES = ['todo', 'working', 'done', 'stuck'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const TEST_KINDS = ['weekly', 'triweekly'] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const TEST_STATUSES = ['generating', 'ready', 'marked', 'failed'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const TEST_RESULTS = ['pass', 'partial', 'fail'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

/** Chat thread modes: tutor modes are used by homework question chats. */
export const THREAD_MODES = ['default', 'tutor-hint', 'tutor-full'] as const;
export type ThreadMode = (typeof THREAD_MODES)[number];

/** Practice exams need at least this many documents in the folder before a tri-weekly test can be generated. */
export const PRACTICE_EXAMS_REQUIRED = 5;

export const SOURCE_TYPES = ['web', 'book', 'video', 'dataset', 'repo', 'post', 'other'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Graph node entity kinds. */
export const ENTITY_KINDS = [
  'document',
  'note',
  'source',
  'annotation',
  'run',
  'session',
  'assignment',
  'test',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Edge kinds in the single links table. `synthesized` points from a synthesized note to its raw note. */
export const LINK_KINDS = ['wiki', 'mention', 'belongs', 'suggested', 'synthesized'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const courseLinkSchema = z.object({
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().url(),
});
export type CourseLink = z.infer<typeof courseLinkSchema>;

/** Course details stored in projects.meta; absent for research projects. */
export const projectMetaSchema = z.object({
  type: z.enum(COURSE_TYPES).default('mixed'),
  code: z.string().trim().max(40).default(''),
  semester: z.string().trim().max(40).default(''),
  links: z.array(courseLinkSchema).default([]),
});
export type ProjectMeta = z.infer<typeof projectMetaSchema>;

export const courseCreateSchema = projectCreateSchema.extend({
  type: z.enum(COURSE_TYPES).default('mixed'),
  code: z.string().trim().max(40).default(''),
  semester: z.string().trim().max(40).default(''),
  links: z.array(courseLinkSchema).default([]),
});
export type CourseCreate = z.infer<typeof courseCreateSchema>;

/**
 * Parses one "Label | https://url" line per entry (a bare URL gets its host as label).
 * Invalid lines are dropped rather than failing the whole form.
 */
export function parseCourseLinks(text: string): CourseLink[] {
  const out: CourseLink[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bar = line.indexOf('|');
    let label = bar >= 0 ? line.slice(0, bar).trim() : '';
    const url = (bar >= 0 ? line.slice(bar + 1) : line).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!label) {
      try {
        label = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
    }
    const parsed = courseLinkSchema.safeParse({ label, url });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
