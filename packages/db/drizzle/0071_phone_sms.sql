-- ADR 0070: Phone & SMS (bring-your-own Twilio). Additive: six new tables, nothing existing changes.
CREATE TABLE "phone_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"account_sid" varchar(64) NOT NULL,
	"api_key_sid" varchar(64) NOT NULL,
	"api_key_secret" text NOT NULL,
	"friendly_name" text,
	"kyc_status" varchar(16) DEFAULT 'unknown' NOT NULL,
	"bundle_sid" varchar(64),
	"kyc_note" text,
	"kyc_checked_at" timestamp with time zone,
	"status" varchar(12) DEFAULT 'connected' NOT NULL,
	"error" text,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_account_agency_id_unique" UNIQUE("agency_id")
);
--> statement-breakpoint
CREATE TABLE "phone_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"phone_number_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"call_sid" varchar(64),
	"from_e164" varchar(20),
	"contact_id" uuid,
	"status" varchar(12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_call_call_sid_unique" UNIQUE("call_sid")
);
--> statement-breakpoint
CREATE TABLE "phone_number" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"e164" varchar(20) NOT NULL,
	"number_sid" varchar(64) NOT NULL,
	"caller_id_e164" varchar(20),
	"caller_id_status" varchar(12) DEFAULT 'none' NOT NULL,
	"caller_id_checked_at" timestamp with time zone,
	"forwarding_tested_at" timestamp with time zone,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_number_number_sid_unique" UNIQUE("number_sid")
);
--> statement-breakpoint
CREATE TABLE "sms_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"phone_number_id" uuid NOT NULL,
	"counterpart" varchar(20) NOT NULL,
	"contact_id" uuid,
	"direction" "mail_direction" NOT NULL,
	"body" text NOT NULL,
	"status" varchar(12) NOT NULL,
	"provider_sid" varchar(64),
	"error" text,
	"sent_by" uuid,
	"kind" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_message_provider_sid_unique" UNIQUE("provider_sid")
);
--> statement-breakpoint
CREATE TABLE "sms_opt_out" (
	"agency_id" uuid NOT NULL,
	"e164" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_opt_out_agency_id_e164_pk" PRIMARY KEY("agency_id","e164")
);
--> statement-breakpoint
CREATE TABLE "sms_read" (
	"phone_number_id" uuid NOT NULL,
	"counterpart" varchar(20) NOT NULL,
	"user_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_read_phone_number_id_counterpart_user_id_pk" PRIMARY KEY("phone_number_id","counterpart","user_id")
);
--> statement-breakpoint
ALTER TABLE "phone_account" ADD CONSTRAINT "phone_account_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_account" ADD CONSTRAINT "phone_account_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_sent_by_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_opt_out" ADD CONSTRAINT "sms_opt_out_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_read" ADD CONSTRAINT "sms_read_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_read" ADD CONSTRAINT "sms_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_read" ADD CONSTRAINT "sms_read_agency_id_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agency"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_call_number_idx" ON "phone_call" USING btree ("phone_number_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "phone_number_agent_idx" ON "phone_number" USING btree ("agency_id","user_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "phone_number_e164_idx" ON "phone_number" USING btree ("e164");--> statement-breakpoint
CREATE INDEX "sms_message_conv_idx" ON "sms_message" USING btree ("phone_number_id","counterpart","created_at");--> statement-breakpoint
CREATE INDEX "sms_message_agency_idx" ON "sms_message" USING btree ("agency_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "sms_message_contact_idx" ON "sms_message" USING btree ("contact_id");
--> statement-breakpoint
-- Hand-written tail. Server-only (ADR 0017): no grants, RLS on, no policy.
ALTER TABLE "phone_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phone_number" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_opt_out" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phone_call" ENABLE ROW LEVEL SECURITY;
