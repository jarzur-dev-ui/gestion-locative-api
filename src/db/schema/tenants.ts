import { date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // userId nullable : le locataire existe en DB AVANT d'avoir un compte
    // (saisi par le bailleur), puis lié quand il accepte l'invitation.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    civility: text('civility'),
    lastName: text('last_name').notNull(),
    firstName: text('first_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    birthDate: date('birth_date'),
    birthPlace: text('birth_place'),

    currentAddressLine: text('current_address_line'),
    currentPostalCode: text('current_postal_code'),
    currentCity: text('current_city'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('tenants_created_by_user_id_idx').on(table.createdByUserId),
    userIdIdx: index('tenants_user_id_idx').on(table.userId),
    emailIdx: index('tenants_email_idx').on(table.email),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
