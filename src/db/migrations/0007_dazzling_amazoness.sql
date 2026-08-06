ALTER TABLE "rent_periods" ADD COLUMN "receipt_delivered_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill : sous l'ancien flux, mark-paid envoyait la quittance immédiatement,
-- donc toute période déjà `paid` a de fait été délivrée. On l'antidate à `paid_at`
-- pour que le nouveau document de cycle ne re-délivre pas ces quittances.
UPDATE "rent_periods" SET "receipt_delivered_at" = "paid_at" WHERE "status_key" = 'paid' AND "paid_at" IS NOT NULL;