import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LandlordProfile = typeof landlordProfiles.$inferSelect;
export type NewLandlordProfile = typeof landlordProfiles.$inferInsert;
