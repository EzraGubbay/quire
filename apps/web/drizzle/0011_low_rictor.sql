CREATE TABLE "mobile_upload_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_login" text NOT NULL,
	"course_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"data" "bytea",
	"file_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mobile_upload_jobs" ADD CONSTRAINT "mobile_upload_jobs_course_id_projects_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_upload_jobs" ADD CONSTRAINT "mobile_upload_jobs_file_id_documents_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_upload_jobs_owner_course_key_uq" ON "mobile_upload_jobs" USING btree ("owner_login","course_id","idempotency_key");