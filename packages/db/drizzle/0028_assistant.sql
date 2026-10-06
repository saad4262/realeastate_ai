CREATE TABLE "assistant_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"surface" varchar(16) NOT NULL,
	"title" text NOT NULL,
	"handles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"turn_started_at" timestamp with time zone,
	"last_turn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"user_text" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"frames" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"api_messages" jsonb,
	"error" text,
	"model" text,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_run" ADD COLUMN "agency_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turn" ADD CONSTRAINT "assistant_turn_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_conversation_user_idx" ON "assistant_conversation" USING btree ("user_id","last_turn_at" desc);--> statement-breakpoint
CREATE INDEX "assistant_conversation_last_turn_idx" ON "assistant_conversation" USING btree ("last_turn_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turn_seq_idx" ON "assistant_turn" USING btree ("conversation_id","seq");--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-written. RLS on, no grants: the server is the only door (ADR 0017).
ALTER TABLE "assistant_conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_turn" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Closed lists (packages/core/src/assistant).
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_surface_check" CHECK (surface IN ('agent', 'agency'));--> statement-breakpoint
ALTER TABLE "assistant_turn" ADD CONSTRAINT "assistant_turn_status_check" CHECK (status IN ('done', 'failed'));--> statement-breakpoint
-- The assistant's per-agency daily cap (ADR 0025 §10) sums today's cost by agency.
CREATE INDEX IF NOT EXISTS "ai_run_agency_created_idx" ON "ai_run" USING btree ("agency_id", "created_at") WHERE agency_id IS NOT NULL;
