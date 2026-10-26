-- ADR 0055: a buyer's (or tenant's) brief on a contact — typed bounds a listing is matched against in SQL. Additive.
CREATE TABLE "buyer_requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" "listing_channel" DEFAULT 'sale' NOT NULL,
	"price_min" numeric(14, 2),
	"price_max" numeric(14, 2),
	"min_bedrooms" integer,
	"min_bathrooms" numeric(3, 1),
	"suburbs" text[] DEFAULT '{}'::text[] NOT NULL,
	"property_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buyer_requirement" ADD CONSTRAINT "buyer_requirement_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_requirement" ADD CONSTRAINT "buyer_requirement_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_requirement" ADD CONSTRAINT "buyer_requirement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buyer_requirement_contact_idx" ON "buyer_requirement" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "buyer_requirement_agency_status_idx" ON "buyer_requirement" USING btree ("agency_id","status");--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "buyer_requirement" ENABLE ROW LEVEL SECURITY;
