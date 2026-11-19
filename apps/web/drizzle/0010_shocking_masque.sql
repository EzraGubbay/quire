CREATE TABLE "mobile_pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"owner_login" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mobile_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_login" text NOT NULL,
	"device_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mobile_tokens_token_hash_unique" UNIQUE("token_hash")
);
