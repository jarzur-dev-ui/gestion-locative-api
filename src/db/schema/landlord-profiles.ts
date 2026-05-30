import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const landlordProfiles = pgTable('landlord_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  civility: text('civility'),
  lastName: text('last_name').notNull(),
  firstName: text('first_name').notNull(),
  addressLine: text('address_line').notNull(),
  postalCode: text('postal_code').notNull(),
  city: text('city').notNull(),
  email: text('email'),
  phone: text('phone'),
  iban: text('iban'),
  signatureFilePath: text('signature_file_path'),
  // Quota de stockage des documents (en octets). 1 GiB par défaut.
  // `bigint` (mode number) car la valeur peut dépasser INT32 max (2.1 Go).
  // Ajustable par UPDATE SQL côté ops si besoin de monter un compte donné.
  storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' })
    .notNull()
    .default(1_073_741_824),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LandlordProfile = typeof landlordProfiles.$inferSelect;
export type NewLandlordProfile = typeof landlordProfiles.$inferInsert;
