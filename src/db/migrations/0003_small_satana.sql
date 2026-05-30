CREATE TYPE "public"."rent_period_status" AS ENUM('draft', 'notice_sent', 'paid');--> statement-breakpoint
CREATE TABLE "rent_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"base_rent_cents" integer NOT NULL,
	"base_charges_cents" integer DEFAULT 0 NOT NULL,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_due_cents" integer NOT NULL,
	"due_date" date NOT NULL,
	"status_key" "rent_period_status" DEFAULT 'draft' NOT NULL,
	"notice_sent_at" timestamp with time zone,
	"notice_document_id" uuid,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" uuid,
	"receipt_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_periods_lease_month_unique" UNIQUE("lease_id","period_month")
);
--> statement-breakpoint
ALTER TABLE "rent_periods" ADD CONSTRAINT "rent_periods_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_periods" ADD CONSTRAINT "rent_periods_notice_document_id_documents_id_fk" FOREIGN KEY ("notice_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_periods" ADD CONSTRAINT "rent_periods_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_periods" ADD CONSTRAINT "rent_periods_receipt_document_id_documents_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rent_periods_lease_id_idx" ON "rent_periods" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "rent_periods_status_idx" ON "rent_periods" USING btree ("status_key");