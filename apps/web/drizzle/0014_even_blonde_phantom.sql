ALTER TABLE "mobile_upload_jobs" ADD COLUMN "target" text DEFAULT 'document' NOT NULL;--> statement-breakpoint
ALTER TABLE "mobile_upload_jobs" ADD COLUMN "content_type" text DEFAULT 'application/pdf' NOT NULL;--> statement-breakpoint
ALTER TABLE "mobile_upload_jobs" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "mobile_upload_jobs" ADD COLUMN "note_id" uuid;--> statement-breakpoint
ALTER TABLE "mobile_upload_jobs" ADD CONSTRAINT "mobile_upload_jobs_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;