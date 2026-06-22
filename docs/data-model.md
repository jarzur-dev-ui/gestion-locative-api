# Modèle de données

Schéma Drizzle : un fichier par table sous `src/db/schema/*.ts` (agrégé dans `src/db/client.ts`).
PostgreSQL ≥ 14 (IDs via `gen_random_uuid()`). Provisionnement : `docs/database-setup.md`.

## Tables (vue d'ensemble)

| Table | Fichier | Rôle |
|---|---|---|
| `users` | `users.ts` | comptes ; rôle `landlord`/`tenant`/`guarantor` ; `passwordHash` nullable (invité) |
| `sessions` | `sessions.ts` | sessions opaques (PK = token) ; `expiresAt`, `lastSeenAt` |
| `password_reset_tokens` | `password-reset-tokens.ts` | tokens reset (TTL 1 h) |
| `landlord_profiles` | `landlord-profiles.ts` | profil bailleur (PK = `userId`) ; `storageQuotaBytes` (bigint, défaut 1 GiB) |
| `properties` | `properties.ts` | biens ; owner = `ownerUserId` ; `surfaceM2` numeric |
| `tenants` | `tenants.ts` | locataires ; `createdByUserId`, `userId` nullable |
| `guarantors` | `guarantors.ts` | garants person/organization ; CHECK de cohérence |
| `leases` | `leases.ts` | baux ; montants `*_cents` ; statut + transitions |
| `lease_tenants` / `lease_guarantors` | `lease-tenants.ts` / `lease-guarantors.ts` | jonctions N-N (PK composite) |
| `invitations` | `invitations.ts` | magic links (PK = token) ; cible polymorphe ; `emailSnapshot` |
| `documents` | `documents.ts` | métadonnées fichiers ; soft-delete ; workflow de validation |
| `document_shares` | `document-shares.ts` | liens publics (PK = token) ; TTL, révocation, compteurs |
| `rent_periods` | `rent-periods.ts` | périodes de loyer ; snapshot montants ; `adjustments` jsonb |
| `config_entries` | `config-entries.ts` | config clé→valeur (jsonb) |
| `audit_logs` | `audit-logs.ts` | journal d'audit polymorphe |

## Argent = entiers en centimes (RÈGLE)

Tous les montants sont des `integer` en **centimes** nommés `*_cents`
(`monthly_rent_cents`, `deposit_cents`, `base_rent_cents`, `total_due_cents`, `amountCents`…).
**Jamais de float.** Les ajustements (`rent_periods.adjustments`) peuvent être négatifs (crédit).
La conversion en € (avec espace insécable, format FR) se fait uniquement à l'affichage —
`formatEur` dans `src/lib/pdf-renderer.ts`. Le quota stockage (`storageQuotaBytes`) est en octets
(`bigint`, peut dépasser INT32).

## Dates & fuseau

- Tous les horodatages sont `timestamp with time zone` (`withTimezone: true`) ; `createdAt`/`updatedAt`
  par défaut `defaultNow()`. Mappés en ISO string côté API (`toPublicX`).
- Dates « calendaires » sans heure : type `date` (`leases.startDate/endDate`, `birthDate`,
  `rent_periods.dueDate`).
- **`period_month`** : stocké en `date` au **1er du mois** (`'YYYY-MM-01'`) dans `rent_periods` pour
  permettre le tri SQL natif ; converti en `'YYYY-MM'` côté API (`firstDayToPeriodMonth`). Sur
  `documents` c'est un `text` `'YYYY-MM'` nullable (docs mensuels). Conversions :
  `src/modules/rent-periods/period-generation.ts`.
- Scheduler en `Europe/Paris` ; les PDF affichent les dates en FR (`DD/MM/YYYY`, mois en toutes lettres).

## Relations clés

- `properties.ownerUserId → users` ; `leases.propertyId → properties` ; `rent_periods.leaseId → leases`.
- Baux ↔ locataires/garants via `lease_tenants` / `lease_guarantors` (N-N, PK composite).
- `documents` : ownership **polymorphe** via `leaseId` OU `propertyId` (CHECK
  `documents_ownership_check` garantit qu'au moins un est non null) ; pas de colonne owner directe —
  l'ACL remonte à la propriété (`document-shares.service.ts:assertLandlordOwnsDocument`).
- `rent_periods` référence `noticeDocumentId` / `receiptDocumentId` (les PDF générés).
- Références polymorphes sans FK (vérifiées côté service) : `invitations.targetId`,
  `audit_logs.entityType/entityId`.

## Soft-delete (documents)

`documents.deletedAt` / `deletedByUserId` : un document supprimé est **masqué** des lectures mais
conservé. Un cron (`documents-purge.task.ts`, 03:00) le purge définitivement (ligne + fichier) après
`config_entries['document.soft_delete_ttl_days']` (défaut 90 j). Restaurable via
`POST /api/documents/{id}/restore` tant que pas purgé. Colonnes `cancelledAt`/… prêtes pour un usage
futur (quittances annulées), inutilisées en V1.

## Politiques ON DELETE

- `cascade` : suppression d'un user → ses sessions, reset tokens, profil bailleur ;
  d'une propriété/d'un bail → ses documents ; d'un bail → ses jonctions et `rent_periods` ;
  d'un document → ses `document_shares`.
- `restrict` : empêche de supprimer une entité encore référencée — `properties.ownerUserId`,
  `leases.propertyId`, jonctions vers tenants/guarantors, `documents.uploadedByUserId`,
  `document_shares.createdByUserId`.
- `set null` : préserve l'historique — `tenants.userId`/`guarantors.userId`,
  `audit_logs.actorUserId`, `documents.validatedByUserId`/`deletedByUserId`,
  `rent_periods.notice/receiptDocumentId`/`paidByUserId`.

## Migrations

- Générer : `node_modules/.bin/drizzle-kit generate` (depuis le schéma → SQL dans `src/db/migrations`).
- Appliquer : `pnpm db:migrate` / `node_modules/.bin/drizzle-kit migrate`. Studio : `pnpm db:studio`.
- Config : `drizzle.config.ts` (dialect postgresql, `DATABASE_URL` requis).
- drizzle-kit suit l'état appliqué dans la table `__drizzle_migrations`.
- Provisionnement base/rôle/droits + procédure de migration en prod : `docs/database-setup.md` et
  `docs/audit-plan.md` §0.
