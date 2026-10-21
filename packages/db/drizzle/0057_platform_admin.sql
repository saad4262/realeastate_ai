-- ADR 0049: the platform admin console — who is a platform admin, and every page they opened.
CREATE TABLE "platform_admin" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_view_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"agency_id" uuid,
	"subject_user_id" uuid,
	"area" varchar(32) NOT NULL,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_admin" ADD CONSTRAINT "platform_admin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_view_log" ADD CONSTRAINT "platform_view_log_admin_user_id_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_view_log" ADD CONSTRAINT "platform_view_log_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_view_log" ADD CONSTRAINT "platform_view_log_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_view_log_agency_idx" ON "platform_view_log" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "platform_view_log_admin_idx" ON "platform_view_log" USING btree ("admin_user_id","created_at" desc);--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants (default privileges revoked in 0019), RLS on, no policy.
ALTER TABLE "platform_admin" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_view_log" ENABLE ROW LEVEL SECURITY;
