CREATE TYPE "public"."annotation_type" AS ENUM('note', 'insight', 'idea', 'question', 'todo');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('pdf', 'markdown');--> statement-breakpoint
CREATE TYPE "public"."reading_status" AS ENUM('unread', 'reading', 'done');--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid,
	"type" "annotation_type" DEFAULT 'note' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"anchor" jsonb,
	"page_no" integer,
	"orphaned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"folder_id" uuid,
	"kind" "document_kind" NOT NULL,
	"title" text NOT NULL,
	"authors" text[] DEFAULT '{}' NOT NULL,
	"year" integer,
	"abstract" text DEFAULT '' NOT NULL,
	"source_url" text,
	"arxiv_id" text,
	"doi" text,
	"file_path" text,
	"file_size" integer,
	"page_count" integer,
	"markdown_body" text,
	"reading_status" "reading_status" DEFAULT 'unread' NOT NULL,
	"last_page" integer DEFAULT 1 NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotations_document_idx" ON "annotations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "annotations_project_idx" ON "annotations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_pages_pk" ON "document_pages" USING btree ("document_id","page_no");--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id","folder_id");--> statement-breakpoint
CREATE INDEX "documents_arxiv_idx" ON "documents" USING btree ("arxiv_id");--> statement-breakpoint
CREATE INDEX "folders_project_idx" ON "folders" USING btree ("project_id","parent_id");