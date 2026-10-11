CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"product_id" text,
	"project_id" text,
	"user_id" text,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"sha256" text,
	"key" text NOT NULL,
	"url" text NOT NULL,
	"kie_url" text,
	"kie_url_expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"pin" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"product_id" text NOT NULL,
	"user_id" text,
	"credits" numeric(12, 4) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"offer_url" text,
	"brand_notes" text,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"brief" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" numeric(8, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"product_id" text NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"model_id" text NOT NULL,
	"model_label" text NOT NULL,
	"prompt" text NOT NULL,
	"ratio" text NOT NULL,
	"meta" text NOT NULL,
	"badge" text,
	"settings" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"source_url" text,
	"key" text,
	"url" text,
	"last_frame_key" text,
	"kie_url" text,
	"kie_url_expires_at" timestamp with time zone,
	"mirror_status" text DEFAULT 'none' NOT NULL,
	"mirror_attempts" integer DEFAULT 0 NOT NULL,
	"mirror_error" text,
	"bytes" bigint,
	"mime" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"favorite" boolean DEFAULT false NOT NULL,
	"favorited_by" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"team_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"product_id" text NOT NULL,
	"user_id" text,
	"batch_id" text,
	"parent_result_id" text,
	"idempotency_key" text NOT NULL,
	"surface" text NOT NULL,
	"model_id" text NOT NULL,
	"model_label" text NOT NULL,
	"kie_model" text NOT NULL,
	"prompt" text NOT NULL,
	"settings" jsonb NOT NULL,
	"media" jsonb NOT NULL,
	"kie_input" jsonb NOT NULL,
	"expected_count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"kie_task_id" text,
	"kie_state" text,
	"fail_code" text,
	"fail_msg" text,
	"credits_consumed" numeric(12, 4),
	"cost_time_raw" bigint,
	"callback_token" text NOT NULL,
	"submit_attempts" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"poll_attempts" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"kie_task_id" text NOT NULL,
	"run_id" text,
	"ts_header" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"token_valid" boolean NOT NULL,
	"body" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_key" ON "assets" USING btree ("key");--> statement-breakpoint
CREATE INDEX "assets_team_kind" ON "assets" USING btree ("team_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "assets_team_sha" ON "assets" USING btree ("team_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_run" ON "credit_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ledger_team_user" ON "credit_ledger" USING btree ("team_id","user_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_type_dedupe" ON "jobs" USING btree ("type","dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_queue" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "products_team_slug" ON "products" USING btree ("team_id","slug");--> statement-breakpoint
CREATE INDEX "products_team" ON "products" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_product_slug" ON "projects" USING btree ("product_id","slug");--> statement-breakpoint
CREATE INDEX "projects_team_recent" ON "projects" USING btree ("team_id","last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "results_run_index" ON "results" USING btree ("run_id","index");--> statement-breakpoint
CREATE INDEX "results_team_created" ON "results" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "results_team_project_created" ON "results" USING btree ("team_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "results_team_product_created" ON "results" USING btree ("team_id","product_id","created_at");--> statement-breakpoint
CREATE INDEX "results_team_user_created" ON "results" USING btree ("team_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "results_team_updated" ON "results" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "results_mirror" ON "results" USING btree ("mirror_status");--> statement-breakpoint
CREATE INDEX "run_events_run" ON "run_events" USING btree ("run_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_team_idem" ON "runs" USING btree ("team_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_kie_task" ON "runs" USING btree ("kie_task_id");--> statement-breakpoint
CREATE INDEX "runs_team_project_created" ON "runs" USING btree ("team_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_open" ON "runs" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_task_ts" ON "webhook_receipts" USING btree ("kie_task_id","ts_header");