CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"text" text NOT NULL,
	"searches" jsonb,
	"results_frame" jsonb,
	"deep_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_thread_id_chat_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_message_thread_idx" ON "chat_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_thread_user_idx" ON "chat_thread" USING btree ("user_id","last_message_at");--> statement-breakpoint

--
-- Hand-written below. drizzle-kit does not model policies; do not lose this
-- on the next `generate`. Same arrangement as 0001, 0002, 0006 and 0009.
--

ALTER TABLE "chat_thread" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "chat_thread_select_own" ON "chat_thread"
  FOR SELECT USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "chat_thread_delete_own" ON "chat_thread"
  FOR DELETE USING (user_id = auth.uid());--> statement-breakpoint

-- SELECT and DELETE only, and no INSERT or UPDATE policy anywhere.
--
-- A message is written by the server after it has run the turn. Nothing a
-- person holds credentials for should be able to author a transcript line —
-- an assistant turn that somebody wrote themselves is the one thing that
-- could put a price into the record without a tool result behind it (#4).
CREATE POLICY "chat_message_select_own" ON "chat_message"
  FOR SELECT USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "chat_message_delete_own" ON "chat_message"
  FOR DELETE USING (user_id = auth.uid());
