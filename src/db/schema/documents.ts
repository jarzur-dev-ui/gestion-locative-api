import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { leases } from './leases.js';
import { properties } from './properties.js';
import { users } from './users.js';

export const documentStatusEnum = pgEnum('document_status', [
  'validated',
  'pending_validation',
  'rejected',
]);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Polymorphic ownership : au moins un de lease_id / property_id doit être
    // renseigné (contrainte CHECK ci-dessous). On laisse les deux possibles
    // pour permettre par ex. de rattacher un DPE à la fois au bien et au bail
    // — la majorité des documents ne porte que sur l'un des deux.
    leaseId: uuid('lease_id').references(() => leases.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),

    // Type métier du document. On garde un `text` libre (et pas un pg_enum)
    // pour pouvoir ajouter de nouveaux types sans migration de schéma. La
    // validation se fait au niveau de l'API via la whitelist `document-types.ts`.
    documentTypeKey: text('document_type_key').notNull(),

    // 'YYYY-MM' pour les documents mensuels (quittances, avis d'échéance).
    // Nullable pour les documents non-périodiques (bail, DPE, état des lieux…).
    periodMonth: text('period_month'),

    // Métadonnées de fichier. Le binaire vit dans le volume, ici on ne stocke
    // que la référence (chemin relatif au storage root) et les méta utiles à
    // la diffusion (taille, mime, nom d'origine pour Content-Disposition).
    filePath: text('file_path').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    mimeType: text('mime_type').notNull(),
    originalFilename: text('original_filename').notNull(),

    // Workflow de validation (utile pour les pièces justificatives uploadées
    // par locataire/garant : le bailleur valide ou rejette).
    statusKey: documentStatusEnum('status_key').notNull(),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    validatedByUserId: uuid('validated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    rejectionReason: text('rejection_reason'),

    // Annulation (utilisée en M4 pour les quittances annulées dans la fenêtre
    // 24h — V1 inutilisé mais colonnes prêtes pour éviter une migration).
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancellationReason: text('cancellation_reason'),

    // Soft delete : la ligne est masquée des lectures (cf. `documents.service`)
    // mais conservée le temps du TTL configurable (`document.soft_delete_ttl_days`,
    // 90 jours par défaut). Un cron purge ensuite la ligne + le fichier.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    leaseIdx: index('documents_lease_id_idx').on(table.leaseId),
    propertyIdx: index('documents_property_id_idx').on(table.propertyId),
    statusIdx: index('documents_status_idx').on(table.statusKey),
    typeIdx: index('documents_type_idx').on(table.documentTypeKey),
    deletedAtIdx: index('documents_deleted_at_idx').on(table.deletedAt),
    ownershipCheck: check(
      'documents_ownership_check',
      sql`(${table.leaseId} IS NOT NULL OR ${table.propertyId} IS NOT NULL)`,
    ),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
