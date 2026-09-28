ALTER TABLE "ai_run" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Hand-written below: the index the spend budget actually reads through.
-- checkAiBudget sums cost_usd for one user over a trailing 24 hours on every
-- tick, and ai_run only gained its first indexes in 0009.
CREATE INDEX IF NOT EXISTS "ai_run_user_created_idx"
  ON "ai_run" USING btree ("user_id", "created_at" DESC);
