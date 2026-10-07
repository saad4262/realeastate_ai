CREATE TABLE "lead_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid,
	"by_user_id" uuid,
	"contact_moved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_handover" ADD CONSTRAINT "lead_handover_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_handover" ADD CONSTRAINT "lead_handover_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_handover" ADD CONSTRAINT "lead_handover_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_handover" ADD CONSTRAINT "lead_handover_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_handover" ADD CONSTRAINT "lead_handover_by_user_id_user_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_handover_from_idx" ON "lead_handover" USING btree ("agency_id","from_user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "lead_handover_lead_idx" ON "lead_handover" USING btree ("lead_id");--> statement-breakpoint
-- Hand-written. RLS on, no grants (ADR 0017).
ALTER TABLE "lead_handover" ENABLE ROW LEVEL SECURITY;
