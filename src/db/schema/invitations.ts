import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const invitationTargetTypeEnum = pgEnum('invitation_target_type', ['tenant', 'guarantor']);

export const invitations = pgTable(
  'invitations',
  {
    // Token = clé primaire, opaque, 32 bytes base64url.
    token: text('token').primaryKey(),

    targetTypeKey: invitationTargetTypeEnum('target_type_key').notNull(),
    // FK logique vers tenants.id OU guarantors.id selon `targetTypeKey`.
    // Pas de FK SQL : la cible dépend du type (polymorphisme), on vérifie côté service.
    targetId: uuid('target_id').notNull(),

    // Email destinataire snapshot au moment de l'envoi : si la fiche locataire/garant
    // est ensuite modifiée, l'invitation reste valable pour l'email initial.
    emailSnapshot: text('email_snapshot').notNull(),

    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Nullable : set au moment de l'acceptation, sinon l'invitation est encore active.
    usedAt: timestamp('used_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetIdx: index('invitations_target_idx').on(table.targetTypeKey, table.targetId),
    creatorIdx: index('invitations_created_by_user_id_idx').on(table.createdByUserId),
  }),
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
