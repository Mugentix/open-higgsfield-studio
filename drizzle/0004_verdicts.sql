ALTER TABLE "results" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "verdict_by" text;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "verdict_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "note" text;--> statement-breakpoint
CREATE INDEX "results_team_verdict" ON "results" USING btree ("team_id","verdict");