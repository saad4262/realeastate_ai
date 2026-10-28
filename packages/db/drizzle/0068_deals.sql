-- ADR 0063 + 0064: the deal pipeline — one open deal per property, its conditions, what happened to it, and the agency-set commission. Additive.
CREATE TYPE "public"."deal_stage" AS ENUM('appraisal', 'listing', 'marketing', 'offers', 'negotiation', 'contract', 'settlement');--> statement-breakpoint
CREATE TABLE "deal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"listing_id" uuid,
	"stage" "deal_stage" NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"agent_id" uuid,
	"vendor_contact_id" uuid,
	"buyer_contact_id" uuid,
	"sale_price" numeric(14, 2),
	"contract_date" date,
	"deposit_amount" numeric(14, 2),
	"deposit_paid_on" date,
	"settlement_date" date,
	"buyer_solicitor" text,
	"settled_at" timestamp with time zone,
	"commission_basis" varchar(8),
	"commission_rate" numeric(6, 3),
	"commission_fixed" numeric(14, 2),
	"agent_split" numeric(5, 2),
	"commission_paid_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_condition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"label" varchar(80) NOT NULL,
	"due_on" date,
	"done_at" timestamp with time zone,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"from_stage" "deal_stage",
	"to_stage" "deal_stage",
	"auto" boolean DEFAULT false NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_agent_id_user_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_vendor_contact_id_contact_id_fk" FOREIGN KEY ("vendor_contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_buyer_contact_id_contact_id_fk" FOREIGN KEY ("buyer_contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_condition" ADD CONSTRAINT "deal_condition_deal_id_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_condition" ADD CONSTRAINT "deal_condition_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_event" ADD CONSTRAINT "deal_event_deal_id_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_event" ADD CONSTRAINT "deal_event_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_event" ADD CONSTRAINT "deal_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deal_open_property_idx" ON "deal" USING btree ("property_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "deal_agency_status_stage_idx" ON "deal" USING btree ("agency_id","status","stage");--> statement-breakpoint
CREATE INDEX "deal_listing_idx" ON "deal" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "deal_condition_deal_idx" ON "deal_condition" USING btree ("deal_id","sort");--> statement-breakpoint
CREATE INDEX "deal_event_deal_idx" ON "deal_event" USING btree ("deal_id","created_at");--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "deal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deal_condition" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deal_event" ENABLE ROW LEVEL SECURITY;
