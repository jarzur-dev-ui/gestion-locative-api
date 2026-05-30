import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { documents } from './documents.js';
import { users } from './users.js';

/**
 * Partage public d'un document via un lien à durée limitée.
 *
 * - `token` : 32 bytes aléatoires encodés en base64url (cf. service.ts).
 *   Sert de clé primaire ET de secret porteur — opaque, non énumérable.
 * - `expiresAt` : TTL côté serveur (par défaut 7 jours, max 30).
 * - `revokedAt` : révocation manuelle par le bailleur ; un partage révoqué
 *   est rejeté (410) sans purge immédiate de la ligne (audit/historique).
 * - `accessCount` / `lastAccessedAt` : compteurs best-effort mis à jour à
 *   chaque téléchargement réussi via `/share/:token`.
 *
 * ON DELETE CASCADE sur `document_id` : si le document sous-jacent est
 * supprimé, tous ses partages le sont aussi (cohérence forte).
 * ON DELETE RESTRICT sur `created_by_user_id` : un utilisateur ayant créé
 * des partages ne peut pas être supprimé tant qu'ils existent.
 */
export const documentShares = pgTable(
  'document_shares',
  {
    token: text('token').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    accessCount: integer('access_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('document_shares_document_id_idx').on(table.documentId),
    expiresIdx: index('document_shares_expires_at_idx').on(table.expiresAt),
  }),
);

export type DocumentShare = typeof documentShares.$inferSelect;
export type NewDocumentShare = typeof documentShares.$inferInsert;
