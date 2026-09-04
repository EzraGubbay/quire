CREATE TABLE "client_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"url" text,
	"user_agent" text,
	"platform" text,
	"client_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "client_logs_created_idx" ON "client_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "client_logs_session_idx" ON "client_logs" USING btree ("session","client_ts");