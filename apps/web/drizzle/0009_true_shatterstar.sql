CREATE TABLE "mind_map_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"x" real,
	"y" real,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mind_map_nodes" ADD CONSTRAINT "mind_map_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mind_map_nodes" ADD CONSTRAINT "mind_map_nodes_parent_id_mind_map_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."mind_map_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mind_map_nodes_project_idx" ON "mind_map_nodes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mind_map_nodes_parent_idx" ON "mind_map_nodes" USING btree ("parent_id");