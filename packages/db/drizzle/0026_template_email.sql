CREATE TYPE "public"."email_batch_status" AS ENUM('prepared', 'approved_sending', 'sent', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_recipient_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."email_template_status" AS ENUM('draft', 'pending_approval', 'approved', 'retired');--> statement-breakpoint
ALTER TYPE "public"."skill_handler" ADD VALUE 'template_email';--> statement-breakpoint
CREATE TABLE "contact_filter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"filter_id" uuid,
	"template_snapshot" jsonb NOT NULL,
	"filter_snapshot" jsonb NOT NULL,
	"status" "email_batch_status" DEFAULT 'prepared' NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_batch_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"status" "email_recipient_status" NOT NULL,
	"skip_reason" varchar(32),
	"skipped_at_send" boolean DEFAULT false NOT NULL,
	"thread_id" uuid,
	"mail_message_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" "email_template_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_filter" ADD CONSTRAINT "contact_filter_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_filter" ADD CONSTRAINT "contact_filter_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch" ADD CONSTRAINT "email_batch_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch" ADD CONSTRAINT "email_batch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch" ADD CONSTRAINT "email_batch_template_id_email_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch" ADD CONSTRAINT "email_batch_filter_id_contact_filter_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."contact_filter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch_recipient" ADD CONSTRAINT "email_batch_recipient_batch_id_email_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."email_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch_recipient" ADD CONSTRAINT "email_batch_recipient_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch_recipient" ADD CONSTRAINT "email_batch_recipient_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_batch_recipient" ADD CONSTRAINT "email_batch_recipient_mail_message_id_mail_message_id_fk" FOREIGN KEY ("mail_message_id") REFERENCES "public"."mail_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_filter_user_idx" ON "contact_filter" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "email_batch_agency_idx" ON "email_batch" USING btree ("agency_id","prepared_at" desc);--> statement-breakpoint
CREATE INDEX "email_batch_user_idx" ON "email_batch" USING btree ("user_id","prepared_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "email_batch_recipient_unique_idx" ON "email_batch_recipient" USING btree ("batch_id","contact_id");--> statement-breakpoint
CREATE INDEX "email_batch_recipient_status_idx" ON "email_batch_recipient" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "email_template_agency_idx" ON "email_template" USING btree ("agency_id","status");--> statement-breakpoint
-- Hand-written (ADR 0022). Server-only, like everything since ADR 0017. The
-- built-in "template email" library skill is NOT seeded here: a new enum value
-- cannot be used in the same migration transaction that adds it, so core
-- creates that one row on first read (ensureBuiltInSkills).
ALTER TABLE "contact_filter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_batch_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_batch" ADD CONSTRAINT "email_batch_expiry_ok" CHECK (expires_at > prepared_at);
