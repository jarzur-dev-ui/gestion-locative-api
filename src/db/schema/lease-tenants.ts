import { pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { leases } from './leases.js';
import { tenants } from './tenants.js';

export const leaseTenants = pgTable(
  'lease_tenants',
  {
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leaseId, table.tenantId] }),
  }),
);

export type LeaseTenant = typeof leaseTenants.$inferSelect;
