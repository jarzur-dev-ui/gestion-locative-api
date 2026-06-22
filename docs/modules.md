# Modules

Une section par vertical-slice (`src/modules/<name>/`). Chemins d'endpoint relatifs au préfixe monté
dans `src/index.ts`. Sauf mention contraire, les routes `/api/*` exigent une session (`requireAuth`)
et la plupart sont réservées au rôle `landlord`.

## auth — `/api/auth`
Authentification, session, mot de passe.
- `POST /login` — email + mot de passe → ouvre une session (cookie `gl_session`).
- `POST /logout` — ferme la session courante (204).
- `GET /me` — profil de l'utilisateur courant (`UserPublic`).
- `POST /forgot-password` — démarre un reset (toujours 204, anti-énumération).
- `POST /reset-password` — consomme le token, change le mot de passe, **invalide les sessions**.
- Clés : `auth.service.ts` (login, `toPublicUser`), `password.ts` (argon2), `session.service.ts`
  (tokens opaques, cookie), `password-reset.service.ts`.
- Invariants : message uniforme `401 Identifiants invalides` (n'expose pas si l'email existe) ;
  reset uniquement si le user a déjà un `passwordHash` (un invité non activé utilise son invitation).

## landlord-profiles — `/api/landlord-profile`
Profil bailleur (singleton : PK = `userId`). Réservé `landlord`.
- `GET /` — profil courant (404 si absent).
- `PUT /` — upsert du profil.
- Clés : `landlord-profiles.service.ts` — `upsertByUserId`, `getStorageQuotaBytes`,
  `getStorageUsedBytes` (quota stockage documents, défaut 1 GiB via `storageQuotaBytes`).

## properties — `/api/properties`
Biens immobiliers. Réservé `landlord`. **Module de référence pour l'ownership.**
- `GET /` · `POST /` · `GET /{id}` · `PATCH /{id}` (JSON Merge Patch) · `DELETE /{id}`.
- Clés : `properties.service.ts` — `listByOwner`, `getByIdForOwner`, `patch`, `remove`.
- Invariants : `ownerUserId` vient de la session ; double filtre `id + ownerUserId` sur UPDATE/DELETE ;
  404 si inconnu, 403 si non propriétaire.

## tenants — `/api/tenants`
Locataires (saisis par le bailleur, compte créé plus tard via invitation). Réservé `landlord`.
- `GET /` · `POST /` · `GET /{id}` · `PATCH /{id}` · `DELETE /{id}`.
- Clés : `tenants.service.ts` (`listByCreator`, `getByIdForCreator`…).
- Invariants : `createdByUserId` = session ; `userId` nullable jusqu'à l'acceptation d'invitation.

## guarantors — `/api/guarantors`
Garants, polymorphes `person` | `organization`. Réservé `landlord`.
- `GET /` (filtrable `?type=`) · `POST /` · `GET /{id}` · `PATCH /{id}` · `DELETE /{id}`.
- Clés : `guarantors.service.ts`.
- Invariants : CHECK DB de cohérence (person → nom+prénom ; organization → raison sociale) ; `userId`
  nullable (toujours null pour une organisation).

## leases — `/api/leases`
Baux et leur cycle de vie. Réservé `landlord`.
- `GET /` (query de filtre) · `POST /` · `GET /{id}` · `PATCH /{id}` · `PATCH /{id}/status` · `DELETE /{id}`.
- Clés : `leases.service.ts` — `create` (lie tenants/guarantors via tables de jonction),
  `updateStatus`, `listForParty` (utilisé par `/api/me`).
- Invariants : transitions de statut restreintes (`ALLOWED_TRANSITIONS` : draft→active/ended,
  active→ended, ended→∅) ; montants en centimes ; ownership via la propriété du bail.

## invitations — `/api/invitations`
Magic links pour rattacher un compte à un locataire/garant existant.
- `POST /` — créer une invitation (réservé `landlord`, `requireRole`).
- `POST /accept` — **public** (rate-limité) : crée/active le compte, définit le mot de passe, ouvre la
  session.
- Clés : `invitations.service.ts` — token opaque 256 bits, TTL **7 j**, `emailSnapshot` figé à l'envoi.
- Invariants : cible doit exister, appartenir au bailleur, ne pas être déjà liée à un compte, avoir un
  email ; token consommé (`usedAt`) à l'acceptation.

## documents + document-types — `/api/documents`, `/api/document-types`
Pièces et documents générés, sur volume disque (binaire) + métadonnées en DB.
- `GET /document-types` — whitelist des types autorisés, filtrable par rôle.
- `GET /api/documents` — documents accessibles (ACL par rôle/ownership).
- `POST /api/documents` — upload `multipart/form-data` (valide MIME magic bytes + taille + quota).
- `GET /{id}` — métadonnées · `GET /{id}/download` — stream binaire.
- `PATCH /{id}/status` — valider/rejeter (landlord) · `DELETE /{id}` — soft delete (landlord) ·
  `POST /{id}/restore` — restaurer (landlord).
- Clés : `documents.service.ts` (ACL, soft-delete), `document-types.ts` (`DOCUMENT_TYPES_BY_ROLE`,
  `isAllowedTypeForRole`), `storage.ts`.
- Invariants : `filePath` jamais exposé (le client passe par `downloadUrl`) ; au moins un de
  `leaseId`/`propertyId` (CHECK SQL) ; type validé contre la whitelist du rôle uploadeur ; soft-delete
  (`deletedAt`) masque la ligne, purge par cron après TTL.

## document-shares + share-public — `/api/document-shares`, `/share`
Liens de partage public d'un document.
- `POST /api/document-shares` (landlord) — crée un lien (token opaque, TTL défaut 7 j, max 30).
- `GET /api/document-shares` — liste · `DELETE /api/document-shares/{token}` — révoque.
- `GET /share/{token}` — **public, non authentifié** (rate-limité) : stream le binaire ; **410** si
  expiré/révoqué/inconnu.
- Clés : `document-shares.service.ts` (`assertLandlordOwnsDocument`, `resolveShareForDownload`,
  `recordShareAccess`, `maskToken`), `share-public.routes.ts` (sanitization `Content-Disposition`).
- Invariants : token = secret porteur opaque ; `revokedAt` → rejet sans purge (historique) ;
  compteurs d'accès best-effort.

## rent-periods — `/api/rent-periods`
Périodes de loyer = quittances / avis d'échéance. Réservé `landlord`.
- `GET /` · `GET /{id}` · `PATCH /{id}` · `POST /{id}/send-notice` · `POST /{id}/mark-paid` ·
  `POST /{id}/mark-unpaid`.
- Clés : `rent-periods.service.ts` (génère PDF via `pdf-renderer`, envoie l'email, crée le document),
  `period-generation.ts` (logique pure : `computeDueDate`, `computeTotalDueCents`,
  `firstDayToPeriodMonth` — réutilisée par le scheduler).
- Invariants : montants snapshot immuables une fois `notice_sent` ; `total_due = loyer + charges +
  Σ ajustements` (ajustements possiblement négatifs) ; unique `(lease, period_month)`.

## config — `/api/config`
Clés de configuration (defaults + overrides en `config_entries`).
- `GET /` — map clé→valeur · `GET /{key}` · `PUT /{key}` (landlord, valeur validée).
- Clés : `config.defaults.ts` (`CONFIG_DEFAULTS`), `config.validators.ts` (`CONFIG_VALUE_SCHEMAS` —
  un schéma Zod par clé), `config.service.ts` (`upsertByKey`).
- Invariants : la valeur d'une clé connue est validée contre son schéma avant upsert ; le back ne
  traduit pas (expose `labelKey` i18n consommés par le front).

## audit-logs — `/api/audit-logs`
Journal d'audit. Réservé `landlord`.
- `GET /` — liste paginée cursor-based, filtrable (`action`, `actorType`, `entityType`).
- Clés : `audit-logs.service.ts` — `listAuditLogsForUser` (V1 : seulement `actor_user_id = user`).
- Invariants : pagination bornée (`AUDIT_LOG_MAX_LIMIT`).

## me — `/api/me`
Vues centrées sur l'utilisateur courant (tout rôle).
- `GET /leases` — baux où le user est partie (locataire/garant) ; `[]` pour un landlord (il a
  `/api/leases`). Clé : `leases.service.ts:listForParty`.

## migration — `/api/migration`
Import one-shot d'un export legacy (localStorage front). Réservé `landlord`.
- `POST /import` — crée/met à jour profil + biens + locataires + garants + baux ; renvoie un rapport
  (counts + warnings). Clé : `migration.service.ts:importLegacy`.
- Invariants : idempotent best-effort (skip des doublons), parsing tolérant des champs legacy.
