import { pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { guarantors } from './guarantors.js';
import { leases } from './leases.js';

export const leaseGuarantors = pgTable(
  'lease_guarantors',
  {
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    guarantorId: uuid('guarantor_id')
      .notNull()
      .references(() => guarantors.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leaseId, table.guarantorId] }),
  }),
);

export type LeaseGuarantor = typeof leaseGuarantors.$inferSelect;
