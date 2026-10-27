-- ADR 0058: a platform skill switched away from its default (no row = on). user_id null = the agency's switch. Additive.
CREATE TABLE "skill_switch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"skill_key" varchar(40) NOT NULL,
	"enabled" boolean NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_switch" ADD CONSTRAINT "skill_switch_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_switch" ADD CONSTRAINT "skill_switch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_switch" ADD CONSTRAINT "skill_switch_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_switch_holder_key_idx" ON "skill_switch" USING btree ("agency_id",coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid),"skill_key");--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "skill_switch" ENABLE ROW LEVEL SECURITY;
