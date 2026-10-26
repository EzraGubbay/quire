import {
  ANNOTATION_TYPES,
  ASSIGNMENT_STATUSES,
  DOCUMENT_KINDS,
  ENTITY_KINDS,
  FOLDER_SCOPES,
  LEMIDA_COMMAND_KINDS,
  LEMIDA_COMMAND_STATUSES,
  LEMIDA_FILE_STATUSES,
  LEMIDA_KINDS,
  LINK_KINDS,
  NOTE_STATUSES,
  PROJECT_KINDS,
  PROJECT_STATUSES,
  type ProjectMeta,
  QUESTION_STATUSES,
  READING_STATUSES,
  RUN_STATUSES,
  SESSION_KINDS,
  SOURCE_TYPES,
  TEST_KINDS,
  TEST_RESULTS,
  TEST_STATUSES,
} from '@quire/shared';
import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
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
  vector,
} from 'drizzle-orm/pg-core';

export const projectStatus = pgEnum('project_status', PROJECT_STATUSES);
export const projectKind = pgEnum('project_kind', PROJECT_KINDS);
export const documentKind = pgEnum('document_kind', DOCUMENT_KINDS);
export const readingStatus = pgEnum('reading_status', READING_STATUSES);
export const annotationType = pgEnum('annotation_type', ANNOTATION_TYPES);
export const entityKind = pgEnum('entity_kind', ENTITY_KINDS);
export const linkKind = pgEnum('link_kind', LINK_KINDS);
export const sourceType = pgEnum('source_type', SOURCE_TYPES);
export const runStatus = pgEnum('run_status', RUN_STATUSES);
export const folderScope = pgEnum('folder_scope', FOLDER_SCOPES);
export const noteStatus = pgEnum('note_status', NOTE_STATUSES);
export const sessionKind = pgEnum('session_kind', SESSION_KINDS);
export const assignmentStatus = pgEnum('assignment_status', ASSIGNMENT_STATUSES);
export const questionStatus = pgEnum('question_status', QUESTION_STATUSES);
export const testKind = pgEnum('test_kind', TEST_KINDS);
export const testStatus = pgEnum('test_status', TEST_STATUSES);
export const testResult = pgEnum('test_result', TEST_RESULTS);
export const lemidaKind = pgEnum('lemida_kind', LEMIDA_KINDS);
export const lemidaFileStatus = pgEnum('lemida_file_status', LEMIDA_FILE_STATUSES);
export const lemidaCommandKind = pgEnum('lemida_command_kind', LEMIDA_COMMAND_KINDS);
export const lemidaCommandStatus = pgEnum('lemida_command_status', LEMIDA_COMMAND_STATUSES);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** A workspace: a research project (kind research) or a university course (kind course). */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: projectStatus('status').notNull().default('active'),
  kind: projectKind('kind').notNull().default('research'),
  /** Course details (type, code, semester, links); {} for research projects. */
  meta: jsonb('meta').$type<Partial<ProjectMeta>>().notNull().default({}),
  ...timestamps,
});

/** Folders for documents or notes (scope). Builtin rows (raw, synthesized, practice_exams) cannot be deleted. */
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
    scope: folderScope('scope').notNull().default('documents'),
    builtin: text('builtin'),
    ...timestamps,
  },
  (t) => [index('folders_project_idx').on(t.projectId, t.parentId)],
);

/** A lecture or recitation: an ordered session with attached decks and a raw note. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: sessionKind('kind').notNull(),
    number: integer('number').notNull().default(1),
    title: text('title').notNull(),
    date: date('date', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [index('sessions_project_idx').on(t.projectId, t.kind, t.number)],
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
    /** Lecture or recitation this deck belongs to. */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    /** The uploaded .pptx (relative to FILES_DIR) when file_path is its PDF rendering. */
    originalPath: text('original_path'),
    originalName: text('original_name'),
    /** sha256 of the source bytes (original file for decks, PDF otherwise); lazily backfilled, used to dedupe Lemida pulls. */
    contentHash: text('content_hash'),
    /** Why the deck has no PDF yet (conversion unavailable or failed). */
    conversionError: text('conversion_error'),
    /** For documents in the Practice Exams folder: { term?, solutionDocumentId? }. */
    examMeta: jsonb('exam_meta').$type<{ term?: string; solutionDocumentId?: string | null }>(),
    ...timestamps,
  },
  (t) => [
    index('documents_project_idx').on(t.projectId, t.folderId),
    index('documents_arxiv_idx').on(t.arxivId),
    index('documents_session_idx').on(t.sessionId),
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
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    /** The lecture or recitation a raw note was taken in. */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    /** generating while the model writes a synthesized note; failed keeps the error for Retry. */
    status: noteStatus('status').notNull().default('ready'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('notes_project_slug').on(t.projectId, t.slug),
    index('notes_project_idx').on(t.projectId),
    index('notes_folder_idx').on(t.folderId),
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

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: sourceType('type').notNull().default('web'),
    url: text('url'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    /** Page text captured at add time, for search and AI retrieval. */
    snapshotText: text('snapshot_text'),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('sources_project_idx').on(t.projectId)],
);

export const experiments = pgTable(
  'experiments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    ...timestamps,
  },
  (t) => [uniqueIndex('experiments_project_name').on(t.projectId, t.name)],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: runStatus('status').notNull().default('queued'),
    params: jsonb('params').notNull().default({}),
    /** Latest value per metric key, kept in sync with run_metrics for cheap listing. */
    summary: jsonb('summary').notNull().default({}),
    notes: text('notes').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('runs_experiment_idx').on(t.experimentId)],
);

export const runMetrics = pgTable(
  'run_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    step: integer('step').notNull().default(0),
    value: real('value').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_metrics_run_key_idx').on(t.runId, t.key, t.step)],
);

export const runLogs = pgTable(
  'run_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_logs_run_idx').on(t.runId, t.ts)],
);

export const runArtifacts = pgTable(
  'run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    filePath: text('file_path').notNull(),
    size: integer('size').notNull().default(0),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_artifacts_run_idx').on(t.runId)],
);

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    ...timestamps,
  },
  (t) => [index('observations_run_idx').on(t.runId)],
);

/** Text chunks with embeddings for retrieval. owner_kind/owner_id point at the document, note, annotation, or source. */
export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerKind: entityKind('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    chunkNo: integer('chunk_no').notNull().default(0),
    /** Page number for document chunks, when known. */
    pageNo: integer('page_no'),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('embeddings_owner_idx').on(t.projectId, t.ownerKind, t.ownerId),
    index('embeddings_vec_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New chat'),
    /** Optional scope: restrict retrieval to one document. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    /** default | tutor-hint | tutor-full (homework question chats). */
    mode: text('mode').notNull().default('default'),
    assignmentQuestionId: uuid('assignment_question_id'),
    ...timestamps,
  },
  (t) => [index('chat_threads_project_idx').on(t.projectId, t.updatedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** [{n, kind, id, title, href, pageNo}] for the [n] markers in content. */
    citations: jsonb('citations').notNull().default([]),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_messages_thread_idx').on(t.threadId, t.createdAt)],
);

/** Every model call, for the monthly cap and the spend view. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    task: text('task').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    ok: boolean('ok').notNull().default(true),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);

/** Client-side debug log (debug mode only): errors, console warnings, viewer events, heartbeats. */
export const clientLogs = pgTable(
  'client_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One id per page load, so a crash can be traced to its last entries. */
    session: text('session').notNull(),
    level: text('level').notNull().default('info'),
    source: text('source').notNull().default('app'),
    message: text('message').notNull(),
    data: jsonb('data'),
    url: text('url'),
    userAgent: text('user_agent'),
    platform: text('platform'),
    /** Client clock, so ordering survives batching. */
    clientTs: timestamp('client_ts', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('client_logs_created_idx').on(t.createdAt),
    index('client_logs_session_idx').on(t.session, t.clientTs),
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

/** Homework: tracked and stored here, solved elsewhere. */
export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull().default(1),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: assignmentStatus('status').notNull().default('not_started'),
    /** The problem sheet (annotatable) and the returned, graded PDF. */
    sheetDocumentId: uuid('sheet_document_id').references(() => documents.id, { onDelete: 'set null' }),
    returnedDocumentId: uuid('returned_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    repoUrl: text('repo_url'),
    score: real('score'),
    maxScore: real('max_score'),
    /** "What I lost points on": feeds test generation. */
    lostPoints: text('lost_points').notNull().default(''),
    notes: text('notes').notNull().default(''),
    ...timestamps,
  },
  (t) => [index('assignments_project_idx').on(t.projectId, t.dueAt)],
);

export const assignmentQuestions = pgTable(
  'assignment_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    status: questionStatus('status').notNull().default('todo'),
    /** Working notes (Markdown + math). */
    notes: text('notes').notNull().default(''),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('assignment_questions_idx').on(t.assignmentId, t.position)],
);

/** Submitted files, stored under FILES_DIR/<project>/assignments/<assignment>/. */
export const assignmentFiles = pgTable(
  'assignment_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    filePath: text('file_path').notNull(),
    size: integer('size').notNull().default(0),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assignment_files_idx').on(t.assignmentId)],
);

/** Generated self-tests: weekly (recall, chosen sessions) and tri-weekly (exam style, everything so far). */
export const tests = pgTable(
  'tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: testKind('kind').notNull(),
    status: testStatus('status').notNull().default('generating'),
    title: text('title').notNull(),
    /** Sessions a weekly test covers; empty for tri-weekly. */
    sessionIds: uuid('session_ids').array().notNull().default([]),
    /** Relative to FILES_DIR; null when no PDF renderer was available (print view instead). */
    pdfPath: text('pdf_path'),
    model: text('model'),
    error: text('error'),
    markedAt: timestamp('marked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('tests_project_idx').on(t.projectId, t.createdAt)],
);

export const testQuestions = pgTable(
  'test_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testId: uuid('test_id')
      .notNull()
      .references(() => tests.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    body: text('body').notNull(),
    modelAnswer: text('model_answer').notNull().default(''),
    /** The concept the question checks; failed concepts feed the next weekly test. */
    concept: text('concept').notNull().default(''),
    points: real('points').notNull().default(1),
    result: testResult('result'),
  },
  (t) => [index('test_questions_idx').on(t.testId, t.n)],
);

/** AI-picked note sections and slides to revisit after a failed or partial question. */
export const rereadItems = pgTable(
  'reread_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testId: uuid('test_id')
      .notNull()
      .references(() => tests.id, { onDelete: 'cascade' }),
    testQuestionId: uuid('test_question_id').references(() => testQuestions.id, { onDelete: 'cascade' }),
    targetKind: entityKind('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    /** Heading slug for notes, page number for documents. */
    anchor: text('anchor'),
    title: text('title').notNull().default(''),
    reason: text('reason').notNull().default(''),
    done: boolean('done').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reread_items_idx').on(t.testId)],
);

/** A Quire course linked to one Lemida (Moodle) course, with its per-course sync state. */
export const lemidaCourses = pgTable(
  'lemida_courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The Lemida course-view URL the user mapped. */
    lemidaUrl: text('lemida_url').notNull(),
    /** Parsed `id=` from the course URL, when present. */
    lemidaCourseId: text('lemida_course_id'),
    label: text('label').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('lemida_courses_project_idx').on(t.projectId),
    uniqueIndex('lemida_courses_project_url_idx').on(t.projectId, t.lemidaUrl),
  ],
);

/**
 * Every file the agent handed to Quire: provenance for dedupe, the review queue (needs_review rows),
 * and the Phase-2 training log (the deterministic rule + confidence, and any manual correction).
 */
export const lemidaFiles = pgTable(
  'lemida_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    lemidaCourseId: uuid('lemida_course_id').references(() => lemidaCourses.id, { onDelete: 'set null' }),
    sourceUrl: text('source_url').notNull().default(''),
    fileName: text('file_name').notNull(),
    sha256: text('sha256').notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    /** Moodle section heading the resource sat under, when known. */
    sectionTitle: text('section_title').notNull().default(''),
    /** Moodle module type the resource came from (mod_resource, mod_folder, mod_assign, …). */
    moduleType: text('module_type').notNull().default(''),
    detectedKind: lemidaKind('detected_kind').notNull().default('unknown'),
    confidence: real('confidence').notNull().default(0),
    /** Which deterministic rule fired (for Phase-2 analysis). */
    rule: text('rule').notNull().default(''),
    placement: jsonb('placement')
      .$type<{ documentId?: string; sessionId?: string; assignmentId?: string }>()
      .notNull()
      .default({}),
    status: lemidaFileStatus('status').notNull().default('needs_review'),
    /** Set when the user re-files a row from the review queue; the Phase-2 label. */
    correctedKind: lemidaKind('corrected_kind'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    index('lemida_files_project_idx').on(t.projectId, t.status),
    uniqueIndex('lemida_files_project_sha_idx').on(t.projectId, t.sha256),
  ],
);

/** The command/status channel the Quire panel and the Mac agent talk over (agent polls for pending). */
export const lemidaCommands = pgTable(
  'lemida_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: lemidaCommandKind('kind').notNull(),
    status: lemidaCommandStatus('status').notNull().default('pending'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index('lemida_commands_status_idx').on(t.status, t.createdAt)],
);

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
export type Source = typeof sources.$inferSelect;
export type Experiment = typeof experiments.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunMetric = typeof runMetrics.$inferSelect;
export type RunLog = typeof runLogs.$inferSelect;
export type RunArtifact = typeof runArtifacts.$inferSelect;
export type Observation = typeof observations.$inferSelect;
export type Embedding = typeof embeddings.$inferSelect;
export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
export type ClientLog = typeof clientLogs.$inferSelect;
export type NewAnnotation = typeof annotations.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type AssignmentQuestion = typeof assignmentQuestions.$inferSelect;
export type AssignmentFile = typeof assignmentFiles.$inferSelect;
export type Test = typeof tests.$inferSelect;
export type TestQuestion = typeof testQuestions.$inferSelect;
export type RereadItem = typeof rereadItems.$inferSelect;
export type LemidaCourse = typeof lemidaCourses.$inferSelect;
export type NewLemidaCourse = typeof lemidaCourses.$inferInsert;
export type LemidaFile = typeof lemidaFiles.$inferSelect;
export type NewLemidaFile = typeof lemidaFiles.$inferInsert;
export type LemidaCommand = typeof lemidaCommands.$inferSelect;
export type NewLemidaCommand = typeof lemidaCommands.$inferInsert;
