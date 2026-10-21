CREATE TYPE "public"."assignment_status" AS ENUM('not_started', 'in_progress', 'submitted', 'graded');--> statement-breakpoint
CREATE TYPE "public"."folder_scope" AS ENUM('documents', 'notes');--> statement-breakpoint
CREATE TYPE "public"."note_status" AS ENUM('ready', 'generating', 'failed');--> statement-breakpoint
CREATE TYPE "public"."project_kind" AS ENUM('research', 'course');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('todo', 'working', 'done', 'stuck');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('lecture', 'recitation');--> statement-breakpoint
CREATE TYPE "public"."test_kind" AS ENUM('weekly', 'triweekly');--> statement-breakpoint
CREATE TYPE "public"."test_result" AS ENUM('pass', 'partial', 'fail');--> statement-breakpoint
CREATE TYPE "public"."test_status" AS ENUM('generating', 'ready', 'marked', 'failed');--> statement-breakpoint
ALTER TYPE "public"."entity_kind" ADD VALUE 'session';--> statement-breakpoint
ALTER TYPE "public"."entity_kind" ADD VALUE 'assignment';--> statement-breakpoint
ALTER TYPE "public"."entity_kind" ADD VALUE 'test';--> statement-breakpoint
ALTER TYPE "public"."link_kind" ADD VALUE 'synthesized';--> statement-breakpoint
CREATE TABLE "assignment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" "question_status" DEFAULT 'todo' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" "assignment_status" DEFAULT 'not_started' NOT NULL,
	"sheet_document_id" uuid,
	"returned_document_id" uuid,
	"repo_url" text,
	"score" real,
	"max_score" real,
	"lost_points" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reread_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_id" uuid NOT NULL,
	"test_question_id" uuid,
	"target_kind" "entity_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"anchor" text,
	"title" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "session_kind" NOT NULL,
	"number" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"body" text NOT NULL,
	"model_answer" text DEFAULT '' NOT NULL,
	"concept" text DEFAULT '' NOT NULL,
	"points" real DEFAULT 1 NOT NULL,
	"result" "test_result"
);
--> statement-breakpoint
CREATE TABLE "tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "test_kind" NOT NULL,
	"status" "test_status" DEFAULT 'generating' NOT NULL,
	"title" text NOT NULL,
	"session_ids" uuid[] DEFAULT '{}' NOT NULL,
	"pdf_path" text,
	"model" text,
	"error" text,
	"marked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "assignment_question_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "original_path" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "original_name" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "conversion_error" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "exam_meta" jsonb;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "scope" "folder_scope" DEFAULT 'documents' NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "builtin" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "status" "note_status" DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" "project_kind" DEFAULT 'research' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_files" ADD CONSTRAINT "assignment_files_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_questions" ADD CONSTRAINT "assignment_questions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_sheet_document_id_documents_id_fk" FOREIGN KEY ("sheet_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_returned_document_id_documents_id_fk" FOREIGN KEY ("returned_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reread_items" ADD CONSTRAINT "reread_items_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reread_items" ADD CONSTRAINT "reread_items_test_question_id_test_questions_id_fk" FOREIGN KEY ("test_question_id") REFERENCES "public"."test_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_questions" ADD CONSTRAINT "test_questions_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_files_idx" ON "assignment_files" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_questions_idx" ON "assignment_questions" USING btree ("assignment_id","position");--> statement-breakpoint
CREATE INDEX "assignments_project_idx" ON "assignments" USING btree ("project_id","due_at");--> statement-breakpoint
CREATE INDEX "reread_items_idx" ON "reread_items" USING btree ("test_id");--> statement-breakpoint
CREATE INDEX "sessions_project_idx" ON "sessions" USING btree ("project_id","kind","number");--> statement-breakpoint
CREATE INDEX "test_questions_idx" ON "test_questions" USING btree ("test_id","n");--> statement-breakpoint
CREATE INDEX "tests_project_idx" ON "tests" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_session_idx" ON "documents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "notes_folder_idx" ON "notes" USING btree ("folder_id");