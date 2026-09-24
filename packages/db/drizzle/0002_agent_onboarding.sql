CREATE TYPE "public"."agent_invite_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "licence_number" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "licence_class" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "licence_expiry" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "territory_suburbs" text[];--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "territory_radius_km" numeric(5, 1);--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "commission_tier" varchar(32);--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "commission_split_agent" integer;--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "commission_split_agency" integer;--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "operational_role" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "permission_flags" jsonb;--> statement-breakpoint
CREATE TABLE "agent_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token" varchar(64) NOT NULL,
	"status" "agent_invite_status" DEFAULT 'pending' NOT NULL,
	"draft" jsonb NOT NULL,
	"invited_by" uuid,
	"user_id" uuid,
	"membership_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "agent_invite" ADD CONSTRAINT "agent_invite_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invite" ADD CONSTRAINT "agent_invite_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invite" ADD CONSTRAINT "agent_invite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invite" ADD CONSTRAINT "agent_invite_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE agent_invite ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_invite_select_member ON agent_invite FOR SELECT USING (agency_id IN (SELECT public.user_agency_ids()));
