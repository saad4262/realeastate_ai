-- ADR 0088: which kind of console chat a conversation is, and the same on each model request, with its cached tokens.
-- Additive and idempotent. Apply BEFORE deploying this code: every ai_run insert names these columns.
ALTER TABLE "ai_run" ADD COLUMN IF NOT EXISTS "chat_scope" varchar(32);
--> statement-breakpoint
ALTER TABLE "ai_run" ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer;
--> statement-breakpoint
ALTER TABLE "ai_run" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN IF NOT EXISTS "chat_scope" varchar(32);
