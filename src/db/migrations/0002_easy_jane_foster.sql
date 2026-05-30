CREATE TYPE "public"."document_status" AS ENUM('validated', 'pending_validation', 'rejected');--> statement-breakpoint
CREATE TABLE "document_shares" (
	"token" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid,
	"property_id" uuid,
	"document_type_key" text NOT NULL,
	"period_month" text,
	"file_path" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"original_filename" text NOT NULL,
	"status_key" "document_status" NOT NULL,
	"validated_at" timestamp with time zone,
	"validated_by_user_id" uuid,
	"rejection_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancellation_reason" text,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_ownership_check" CHECK (("documents"."lease_id" IS NOT NULL OR "documents"."property_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_validated_by_user_id_users_id_fk" FOREIGN KEY ("validated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_shares_document_id_idx" ON "document_shares" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_shares_expires_at_idx" ON "document_shares" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "documents_lease_id_idx" ON "documents" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "documents_property_id_idx" ON "documents" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status_key");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("document_type_key");