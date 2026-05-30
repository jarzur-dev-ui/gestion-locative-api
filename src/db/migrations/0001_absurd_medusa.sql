CREATE TYPE "public"."guarantor_type" AS ENUM('person', 'organization');--> statement-breakpoint
CREATE TYPE "public"."invitation_target_type" AS ENUM('tenant', 'guarantor');--> statement-breakpoint
CREATE TYPE "public"."charges_type" AS ENUM('package', 'real');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('draft', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."lease_type" AS ENUM('empty', 'furnished');--> statement-breakpoint
CREATE TYPE "public"."signature_method" AS ENUM('handwritten_scanned');--> statement-breakpoint
CREATE TABLE "guarantors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"guarantor_type_key" "guarantor_type" NOT NULL,
	"civility" text,
	"last_name" text,
	"first_name" text,
	"email" text,
	"phone" text,
	"birth_date" date,
	"birth_place" text,
	"address_line" text,
	"postal_code" text,
	"city" text,
	"organization_name" text,
	"organization_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guarantors_type_coherence" CHECK ((
        ("guarantors"."guarantor_type_key" = 'person' AND "guarantors"."last_name" IS NOT NULL AND "guarantors"."first_name" IS NOT NULL)
        OR
        ("guarantors"."guarantor_type_key" = 'organization' AND "guarantors"."organization_name" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"token" text PRIMARY KEY NOT NULL,
	"target_type_key" "invitation_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"email_snapshot" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landlord_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"civility" text,
	"last_name" text NOT NULL,
	"first_name" text NOT NULL,
	"address_line" text NOT NULL,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"email" text,
	"phone" text,
	"iban" text,
	"signature_file_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lease_guarantors" (
	"lease_id" uuid NOT NULL,
	"guarantor_id" uuid NOT NULL,
	CONSTRAINT "lease_guarantors_lease_id_guarantor_id_pk" PRIMARY KEY("lease_id","guarantor_id")
);
--> statement-breakpoint
CREATE TABLE "lease_tenants" (
	"lease_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "lease_tenants_lease_id_tenant_id_pk" PRIMARY KEY("lease_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"lease_type_key" "lease_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"monthly_rent_cents" integer NOT NULL,
	"monthly_charges_cents" integer DEFAULT 0 NOT NULL,
	"charges_type_key" charges_type NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"payment_day" integer NOT NULL,
	"solidarity" boolean DEFAULT false NOT NULL,
	"status_key" "lease_status" DEFAULT 'draft' NOT NULL,
	"signed_at" timestamp with time zone,
	"signature_method_key" "signature_method" DEFAULT 'handwritten_scanned' NOT NULL,
	"original_paper_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"address_line" text NOT NULL,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"property_type_key" text NOT NULL,
	"surface_m2" numeric(7, 2),
	"room_count" integer,
	"built_year" integer,
	"dpe_grade" text,
	"ges_grade" text,
	"furnished" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"civility" text,
	"last_name" text NOT NULL,
	"first_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"birth_date" date,
	"birth_place" text,
	"current_address_line" text,
	"current_postal_code" text,
	"current_city" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guarantors" ADD CONSTRAINT "guarantors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantors" ADD CONSTRAINT "guarantors_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landlord_profiles" ADD CONSTRAINT "landlord_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_guarantors" ADD CONSTRAINT "lease_guarantors_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_guarantors" ADD CONSTRAINT "lease_guarantors_guarantor_id_guarantors_id_fk" FOREIGN KEY ("guarantor_id") REFERENCES "public"."guarantors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guarantors_created_by_user_id_idx" ON "guarantors" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "guarantors_type_idx" ON "guarantors" USING btree ("guarantor_type_key");--> statement-breakpoint
CREATE INDEX "invitations_target_idx" ON "invitations" USING btree ("target_type_key","target_id");--> statement-breakpoint
CREATE INDEX "invitations_created_by_user_id_idx" ON "invitations" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "leases_property_id_idx" ON "leases" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "leases_status_idx" ON "leases" USING btree ("status_key");--> statement-breakpoint
CREATE INDEX "properties_owner_user_id_idx" ON "properties" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "tenants_created_by_user_id_idx" ON "tenants" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "tenants_user_id_idx" ON "tenants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tenants_email_idx" ON "tenants" USING btree ("email");