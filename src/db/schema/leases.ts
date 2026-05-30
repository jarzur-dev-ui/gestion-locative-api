import { boolean, date, index, integer, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { properties } from './properties.js';

export const leaseTypeEnum = pgEnum('lease_type', ['empty', 'furnished']);
export const chargesTypeEnum = pgEnum('charges_type', ['package', 'real']);
export const leaseStatusEnum = pgEnum('lease_status', ['draft', 'active', 'ended']);
export const signatureMethodEnum = pgEnum('signature_method', ['handwritten_scanned']);

export const leases = pgTable(
  'leases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),

    leaseTypeKey: leaseTypeEnum('lease_type_key').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'), // nullable: bail ouvert / tacite reconduction

    monthlyRentCents: integer('monthly_rent_cents').notNull(),
    monthlyChargesCents: integer('monthly_charges_cents').notNull().default(0),
    chargesTypeKey: chargesTypeEnum('charges_type_key').notNull(),
    depositCents: integer('deposit_cents').notNull().default(0),

    paymentDay: integer('payment_day').notNull(), // 1-31
    solidarity: boolean('solidarity').notNull().default(false), // clause de solidarité entre colocataires

    statusKey: leaseStatusEnum('status_key').notNull().default('draft'),
    signedAt: timestamp('signed_at', { withTimezone: true }),

    // Signature workflow V1 — voir docs/roadmap.md
    signatureMethodKey: signatureMethodEnum('signature_method_key')
      .notNull()
      .default('handwritten_scanned'),
    originalPaperArchived: boolean('original_paper_archived').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    propertyIdx: index('leases_property_id_idx').on(table.propertyId),
    statusIdx: index('leases_status_idx').on(table.statusKey),
  }),
);

export type Lease = typeof leases.$inferSelect;
export type NewLease = typeof leases.$inferInsert;
