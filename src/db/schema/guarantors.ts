import { sql } from 'drizzle-orm';
import { check, date, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const guarantorTypeEnum = pgEnum('guarantor_type', ['person', 'organization']);

export const guarantors = pgTable(
  'guarantors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // userId nullable : un garant peut être créé par le bailleur AVANT d'avoir
    // un compte (cas garant personne physique), puis lié lors de l'acceptation
    // de l'invitation. Pour un garant organisation (Visale, Action Logement…),
    // il reste null indéfiniment.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    guarantorTypeKey: guarantorTypeEnum('guarantor_type_key').notNull(),

    // Champs si person (nullable si organization) :
    civility: text('civility'),
    lastName: text('last_name'),
    firstName: text('first_name'),
    email: text('email'),
    phone: text('phone'),
    birthDate: date('birth_date'),
    birthPlace: text('birth_place'),
    addressLine: text('address_line'),
    postalCode: text('postal_code'),
    city: text('city'),

    // Champs si organization (nullable si person) :
    organizationName: text('organization_name'),
    organizationReference: text('organization_reference'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('guarantors_created_by_user_id_idx').on(table.createdByUserId),
    typeIdx: index('guarantors_type_idx').on(table.guarantorTypeKey),
    // CHECK : cohérence du polymorphisme.
    // - 'person'       → last_name + first_name requis
    // - 'organization' → organization_name requis
    typeCoherence: check(
      'guarantors_type_coherence',
      sql`(
        (${table.guarantorTypeKey} = 'person' AND ${table.lastName} IS NOT NULL AND ${table.firstName} IS NOT NULL)
        OR
        (${table.guarantorTypeKey} = 'organization' AND ${table.organizationName} IS NOT NULL)
      )`,
    ),
  }),
);

export type Guarantor = typeof guarantors.$inferSelect;
export type NewGuarantor = typeof guarantors.$inferInsert;
