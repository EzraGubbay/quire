CREATE TYPE "public"."entity_kind" AS ENUM('document', 'note', 'source', 'annotation', 'run');--> statement-breakpoint
CREATE TYPE "public"."link_kind" AS ENUM('wiki', 'mention', 'belongs', 'suggested');--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_kind" "entity_kind" NOT NULL,
	"from_id" uuid NOT NULL,
	"to_kind" "entity_kind" NOT NULL,
	"to_id" uuid NOT NULL,
	"kind" "link_kind" DEFAULT 'wiki' NOT NULL,
	"unresolved" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "macros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"definition" text NOT NULL,
	"arity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "macros" ADD CONSTRAINT "macros_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "links_from_idx" ON "links" USING btree ("project_id","from_kind","from_id");--> statement-breakpoint
CREATE INDEX "links_to_idx" ON "links" USING btree ("project_id","to_kind","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "links_unique" ON "links" USING btree ("from_kind","from_id","to_kind","to_id","kind");--> statement-breakpoint
CREATE INDEX "macros_project_idx" ON "macros" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_project_slug" ON "notes" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "notes_project_idx" ON "notes" USING btree ("project_id");