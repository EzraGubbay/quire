import {
  ANNOTATION_TYPES,
  DOCUMENT_KINDS,
  ENTITY_KINDS,
  LINK_KINDS,
  PROJECT_STATUSES,
  READING_STATUSES,
} from '@quire/shared';
import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const projectStatus = pgEnum('project_status', PROJECT_STATUSES);
export const documentKind = pgEnum('document_kind', DOCUMENT_KINDS);
export const readingStatus = pgEnum('reading_status', READING_STATUSES);
export const annotationType = pgEnum('annotation_type', ANNOTATION_TYPES);
export const entityKind = pgEnum('entity_kind', ENTITY_KINDS);
export const linkKind = pgEnum('link_kind', LINK_KINDS);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: projectStatus('status').notNull().default('active'),
  ...timestamps,
});

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('folders_project_idx').on(t.projectId, t.parentId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    kind: documentKind('kind').notNull(),
    title: text('title').notNull(),
    authors: text('authors').array().notNull().default([]),
    year: integer('year'),
    abstract: text('abstract').notNull().default(''),
    sourceUrl: text('source_url'),
    arxivId: text('arxiv_id'),
    doi: text('doi'),
    /** Path relative to FILES_DIR for PDFs. */
    filePath: text('file_path'),
    fileSize: integer('file_size'),
    pageCount: integer('page_count'),
    /** Body for Markdown documents. */
    markdownBody: text('markdown_body'),
    readingStatus: readingStatus('reading_status').notNull().default('unread'),
    lastPage: integer('last_page').notNull().default(1),
    progress: real('progress').notNull().default(0),
    tags: text('tags').array().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    index('documents_project_idx').on(t.projectId, t.folderId),
    index('documents_arxiv_idx').on(t.arxivId),
  ],
);

export const documentPages = pgTable(
  'document_pages',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNo: integer('page_no').notNull(),
    text: text('text').notNull(),
  },
  (t) => [uniqueIndex('document_pages_pk').on(t.documentId, t.pageNo)],
);

export const annotations = pgTable(
  'annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    type: annotationType('type').notNull().default('note'),
    body: text('body').notNull().default(''),
    /** The selected passage; empty for general annotations. */
    quote: text('quote').notNull().default(''),
    /** Anchor JSON (see @quire/shared anchorSchema); null for general annotations. */
    anchor: jsonb('anchor'),
    pageNo: integer('page_no'),
    orphaned: boolean('orphaned').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('annotations_document_idx').on(t.documentId),
    index('annotations_project_idx').on(t.projectId),
  ],
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Unique within the project; what [[wiki links]] resolve against (case-insensitive). */
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    body: text('body').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('notes_project_slug').on(t.projectId, t.slug),
    index('notes_project_idx').on(t.projectId),
  ],
);

/** Every edge in the project graph: wiki links, mentions, containment, AI suggestions. */
export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromKind: entityKind('from_kind').notNull(),
    fromId: uuid('from_id').notNull(),
    toKind: entityKind('to_kind').notNull(),
    toId: uuid('to_id').notNull(),
    kind: linkKind('kind').notNull().default('wiki'),
    /** For wiki links that do not resolve to an entity yet: the raw target name. */
    unresolved: text('unresolved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('links_from_idx').on(t.projectId, t.fromKind, t.fromId),
    index('links_to_idx').on(t.projectId, t.toKind, t.toId),
    uniqueIndex('links_unique').on(t.fromKind, t.fromId, t.toKind, t.toId, t.kind),
  ],
);

/** TeX macros: rows with a null project are global; project rows override by name. */
export const macros = pgTable(
  'macros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Definition body as in \newcommand{\name}[n]{definition}. */
    definition: text('definition').notNull(),
    arity: integer('arity').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('macros_project_idx').on(t.projectId)],
);

/** Single-row app settings. */
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectRelations = relations(projects, ({ many }) => ({
  folders: many(folders),
  documents: many(documents),
}));
export const folderRelations = relations(folders, ({ one, many }) => ({
  project: one(projects, { fields: [folders.projectId], references: [projects.id] }),
  documents: many(documents),
}));
export const documentRelations = relations(documents, ({ one, many }) => ({
  project: one(projects, { fields: [documents.projectId], references: [projects.id] }),
  folder: one(folders, { fields: [documents.folderId], references: [folders.id] }),
  pages: many(documentPages),
  annotations: many(annotations),
}));
export const documentPageRelations = relations(documentPages, ({ one }) => ({
  document: one(documents, { fields: [documentPages.documentId], references: [documents.id] }),
}));
export const annotationRelations = relations(annotations, ({ one }) => ({
  document: one(documents, { fields: [annotations.documentId], references: [documents.id] }),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentPage = typeof documentPages.$inferSelect;
export type Annotation = typeof annotations.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Link = typeof links.$inferSelect;
export type Macro = typeof macros.$inferSelect;
export type NewAnnotation = typeof annotations.$inferInsert;
