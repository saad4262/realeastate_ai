-- ADR 0052: presence (last seen), blocking a site user, and emails sent by platform admins.
CREATE TABLE "platform_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"audience" varchar(24) NOT NULL,
	"agency_id" uuid,
	"subject_user_id" uuid,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_email_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"name" text,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"error" text,
	"provider_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "platform_email" ADD CONSTRAINT "platform_email_admin_user_id_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_email" ADD CONSTRAINT "platform_email_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_email" ADD CONSTRAINT "platform_email_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_email_recipient" ADD CONSTRAINT "platform_email_recipient_email_id_platform_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."platform_email"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_email_recipient" ADD CONSTRAINT "platform_email_recipient_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_email_created_idx" ON "platform_email" USING btree ("created_at" desc);--> statement-breakpoint
CREATE INDEX "platform_email_recipient_email_idx" ON "platform_email_recipient" USING btree ("email_id","status");--> statement-breakpoint
CREATE INDEX "platform_email_recipient_queued_idx" ON "platform_email_recipient" USING btree ("status","created_at");--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "platform_email" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_email_recipient" ENABLE ROW LEVEL SECURITY;
