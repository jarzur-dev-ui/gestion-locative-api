import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Qui est l'auteur de l'action :
//  - 'user'      : action déclenchée par un utilisateur authentifié
//                  → actor_user_id renseigné
//  - 'scheduler' : action automatique du scheduler (cron, jobs)
//                  → actor_user_id null
//  - 'system'    : action système (migration, bootstrap, etc.)
//                  → actor_user_id null
export const auditActorTypeEnum = pgEnum('audit_actor_type', ['user', 'scheduler', 'system']);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Who acted
    actorType: auditActorTypeEnum('actor_type').notNull(),
    // actorUserId est null quand actorType vaut 'scheduler' ou 'system'.
    // `onDelete: 'set null'` permet de conserver la trace d'audit même si
    // l'utilisateur est supprimé (la suppression d'un user ne doit pas
    // effacer l'historique des actions, c'est une exigence d'audit).
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    // What happened
    // `action` est un string libre (pas un pg_enum) pour pouvoir ajouter de
    // nouvelles actions sans migration de schéma. Convention de nommage :
    // 'login', 'lease.create', 'lease.status_change', 'document.upload',
    // 'document.validate', 'document.delete', 'invitation.create',
    // 'invitation.accept', 'rent_period.mark_paid', 'rent_period.mark_unpaid',
    // 'config.update', etc. La liste typée est définie dans `src/lib/audit.ts`.
    action: text('action').notNull(),

    // Référence polymorphique vers l'entité cible. `entityType` est le nom
    // logique ('lease' | 'document' | 'invitation' | ...) et `entityId` est
    // l'UUID stocké en text pour ne pas avoir de FK enforcement (l'entité
    // peut être supprimée sans casser l'audit). Les deux sont nullable pour
    // les actions sans cible (ex. 'login').
    entityType: text('entity_type'),
    entityId: text('entity_id'),

    // Contexte additionnel libre (diff avant/après, valeurs métier, etc.).
    // jsonb permet l'indexation et les requêtes structurées si besoin futur.
    payload: jsonb('payload'),
    // IP et user-agent capturés depuis la requête HTTP lorsque actorType = 'user'.
    // Null pour 'scheduler' / 'system'.
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index pour les recherches par acteur (vue "mes actions").
    actorIdx: index('audit_logs_actor_user_id_idx').on(table.actorUserId),
    // Index pour les recherches par type d'action (filtre côté UI).
    actionIdx: index('audit_logs_action_idx').on(table.action),
    // Index composite pour résoudre "toutes les actions sur l'entité X".
    entityIdx: index('audit_logs_entity_idx').on(table.entityType, table.entityId),
    // Index pour le tri / pagination cursor-based sur la date.
    createdAtIdx: index('audit_logs_created_at_idx').on(table.createdAt),
  }),
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
