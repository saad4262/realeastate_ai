CREATE TABLE "mail_customer_read" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_customer_read_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "team_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"sender_id" uuid,
	"channel" varchar(16) DEFAULT 'console' NOT NULL,
	"text" text NOT NULL,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_message_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "team_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"created_by" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_thread_member" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_thread_member_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mail_customer_read" ADD CONSTRAINT "mail_customer_read_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_customer_read" ADD CONSTRAINT "mail_customer_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_message" ADD CONSTRAINT "team_message_thread_id_team_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."team_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_message" ADD CONSTRAINT "team_message_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_message" ADD CONSTRAINT "team_message_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_thread" ADD CONSTRAINT "team_thread_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_thread" ADD CONSTRAINT "team_thread_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_thread_member" ADD CONSTRAINT "team_thread_member_thread_id_team_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."team_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_thread_member" ADD CONSTRAINT "team_thread_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_message_thread_idx" ON "team_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "team_thread_agency_idx" ON "team_thread" USING btree ("agency_id","last_message_at" desc);--> statement-breakpoint
CREATE INDEX "team_thread_member_user_idx" ON "team_thread_member" USING btree ("user_id");--> statement-breakpoint
-- Hand-written tail (ADR 0035). Server-only (ADR 0017): no grants, RLS on.
ALTER TABLE "mail_customer_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_thread" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_thread_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The whole set: every tool allowed by 0040 plus send_email and message_colleagues.
-- No row changes: every existing value stays allowed.
ALTER TABLE "proposed_action" DROP CONSTRAINT "proposed_action_tool_check";--> statement-breakpoint
ALTER TABLE "proposed_action" ADD CONSTRAINT "proposed_action_tool_check" CHECK (tool IN ('add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email', 'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived', 'update_agent', 'remove_agent', 'send_email', 'message_colleagues'));
