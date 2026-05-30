import { boolean, index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addressLine: text('address_line').notNull(),
    postalCode: text('postal_code').notNull(),
    city: text('city').notNull(),
    propertyTypeKey: text('property_type_key').notNull(), // i18n key: 'apartment' | 'house' | 'studio' | 'parking' | ...
    surfaceM2: numeric('surface_m2', { precision: 7, scale: 2 }), // ex 75.50
    roomCount: integer('room_count'),
    builtYear: integer('built_year'),
    dpeGrade: text('dpe_grade'), // 'A'..'G'
    gesGrade: text('ges_grade'), // 'A'..'G'
    furnished: boolean('furnished').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index('properties_owner_user_id_idx').on(table.ownerUserId),
  }),
);

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
