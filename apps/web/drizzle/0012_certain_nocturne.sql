CREATE TABLE "mobile_push_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"group_key" text,
	"batch_id" uuid,
	"data" jsonb NOT NULL,
	"priority" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "mobile_push_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"fcm_token" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "mobile_push_registrations_token_id_unique" UNIQUE("token_id"),
	CONSTRAINT "mobile_push_registrations_fcm_token_unique" UNIQUE("fcm_token")
);
--> statement-breakpoint
ALTER TABLE "mobile_push_outbox" ADD CONSTRAINT "mobile_push_outbox_registration_id_mobile_push_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."mobile_push_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_push_registrations" ADD CONSTRAINT "mobile_push_registrations_token_id_mobile_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mobile_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_push_outbox_registration_dedupe_uq" ON "mobile_push_outbox" USING btree ("registration_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "mobile_push_outbox_due_idx" ON "mobile_push_outbox" USING btree ("not_before") WHERE "mobile_push_outbox"."sent_at" IS NULL AND "mobile_push_outbox"."dead_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mobile_push_outbox_batch_idx" ON "mobile_push_outbox" USING btree ("batch_id");