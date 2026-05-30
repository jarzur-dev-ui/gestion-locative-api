import { sql } from 'drizzle-orm';
import { date, index, integer, jsonb, pgEnum, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { documents } from './documents.js';
import { leases } from './leases.js';
import { users } from './users.js';

export const rentPeriodStatusEnum = pgEnum('rent_period_status', ['draft', 'notice_sent', 'paid']);

/**
 * Ajustement sur une période de loyer.
 *
 * Modélisation libre (pas d'enum strict côté DB) pour pouvoir ajouter des types
 * d'ajustements sans migration : TEOM, régularisation de charges, report de
 * solde, divers…
 * `amountCents` peut être négatif (crédit au locataire).
 */
export type Adjustment = {
  type: 'teom' | 'previous_balance' | 'charges_regularization' | 'other';
  labelKey?: string; // i18n key suggéré
  label?: string; // libellé free-form
  amountCents: number; // peut être négatif (crédit au locataire)
};

export const rentPeriods = pgTable(
  'rent_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),

    // 'YYYY-MM-01' — premier jour du mois pour permettre un tri SQL natif sur
    // les périodes. On stocke en `date` (et pas `text`) pour bénéficier des
    // comparaisons d'ordre par PostgreSQL.
    periodMonth: date('period_month').notNull(),

    // Snapshot des montants au moment de la création de la période. Immuable
    // une fois la période passée en `notice_sent` (sinon on régénérerait un
    // avis ne correspondant pas au montant déjà notifié au locataire).
    baseRentCents: integer('base_rent_cents').notNull(),
    baseChargesCents: integer('base_charges_cents').notNull().default(0),
    adjustments: jsonb('adjustments').$type<Adjustment[]>().notNull().default(sql`'[]'::jsonb`),
    totalDueCents: integer('total_due_cents').notNull(),

    dueDate: date('due_date').notNull(),

    statusKey: rentPeriodStatusEnum('status_key').notNull().default('draft'),

    // Avis d'échéance (notice)
    noticeSentAt: timestamp('notice_sent_at', { withTimezone: true }),
    noticeDocumentId: uuid('notice_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),

    // Paiement (toggle Oui/Non — pas de granularité partiel/intégral en V1)
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidByUserId: uuid('paid_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    receiptDocumentId: uuid('receipt_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    leaseIdx: index('rent_periods_lease_id_idx').on(table.leaseId),
    statusIdx: index('rent_periods_status_idx').on(table.statusKey),
    // Garantit l'unicité d'une période (mois × bail) — empêche un double-clic
    // dans le scheduler ou un appel concurrent de générer deux lignes.
    leasePeriodUnique: unique('rent_periods_lease_month_unique').on(
      table.leaseId,
      table.periodMonth,
    ),
  }),
);

export type RentPeriod = typeof rentPeriods.$inferSelect;
export type NewRentPeriod = typeof rentPeriods.$inferInsert;
