CREATE TYPE "public"."lemida_command_kind" AS ENUM('open_login', 'probe', 'sync');--> statement-breakpoint
CREATE TYPE "public"."lemida_command_status" AS ENUM('pending', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."lemida_file_status" AS ENUM('imported', 'needs_review', 'duplicate', 'error');--> statement-breakpoint
CREATE TYPE "public"."lemida_kind" AS ENUM('lecture', 'recitation', 'homework', 'exam', 'book', 'other', 'unknown');--> statement-breakpoint
CREATE TABLE "lemida_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "lemida_command_kind" NOT NULL,
	"status" "lemida_command_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lemida_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lemida_url" text NOT NULL,
	"lemida_course_id" text,
	"label" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lemida_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lemida_course_id" uuid,
	"source_url" text DEFAULT '' NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"section_title" text DEFAULT '' NOT NULL,
	"module_type" text DEFAULT '' NOT NULL,
	"detected_kind" "lemida_kind" DEFAULT 'unknown' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"rule" text DEFAULT '' NOT NULL,
	"placement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "lemida_file_status" DEFAULT 'needs_review' NOT NULL,
	"corrected_kind" "lemida_kind",
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "lemida_courses" ADD CONSTRAINT "lemida_courses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lemida_files" ADD CONSTRAINT "lemida_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lemida_files" ADD CONSTRAINT "lemida_files_lemida_course_id_lemida_courses_id_fk" FOREIGN KEY ("lemida_course_id") REFERENCES "public"."lemida_courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lemida_commands_status_idx" ON "lemida_commands" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "lemida_courses_project_idx" ON "lemida_courses" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lemida_courses_project_url_idx" ON "lemida_courses" USING btree ("project_id","lemida_url");--> statement-breakpoint
CREATE INDEX "lemida_files_project_idx" ON "lemida_files" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "lemida_files_project_sha_idx" ON "lemida_files" USING btree ("project_id","sha256");