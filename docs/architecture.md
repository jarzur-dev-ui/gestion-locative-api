# Architecture

API Hono mono-processus, ESM (Node ≥ 22). Bootstrap et montage des routes : `src/index.ts`.
Spec OpenAPI auto-générée exposée sur `GET /openapi.json` (le front génère ses types à partir de là).

## Pattern vertical-slice

Chaque domaine vit sous `src/modules/<name>/` avec trois fichiers :

- `<name>.routes.ts` — handlers **fins** : déclarent les routes OpenAPI (`createRoute`), valident
  l'entrée via Zod, appellent le service, enregistrent l'audit, mappent vers la réponse publique.
  Le middleware d'auth/role du module est appliqué ici (`.use('*', requireAuth)`, etc.).
- `<name>.service.ts` — **logique métier + tout l'accès DB** (Drizzle). Fonctions pures côté mapping
  (`toPublicX`) ; lèvent `HTTPException` pour les erreurs métier (404/403/400).
- `<name>.schemas.ts` — schémas Zod request/response + types inférés (`XPublic`, `CreateXInput`…),
  constantes de bornes (TTL, limites de page).

Certains modules ajoutent des fichiers dédiés : `document-types.ts` (whitelist), `period-generation.ts`
(logique pure testable), `config.defaults.ts` / `config.validators.ts`, `password.ts` /
`session.service.ts` / `password-reset.service.ts` (auth).

## Liste des modules

Montés dans `src/index.ts` sous `/api/*` (sauf `share`). Détail par module → `docs/modules.md`.

| Module | Préfixe | Rôle |
|---|---|---|
| auth | `/api/auth` | login/logout, me, mot de passe oublié/reset |
| landlord-profiles | `/api/landlord-profile` | profil bailleur (singleton par user) + quota stockage |
| properties | `/api/properties` | biens immobiliers |
| tenants | `/api/tenants` | locataires |
| guarantors | `/api/guarantors` | garants (personne ou organisation) |
| leases | `/api/leases` | baux + transitions de statut |
| invitations | `/api/invitations` | magic links locataire/garant |
| documents | `/api/documents` | upload/download/validation/soft-delete |
| document-types | `/api/document-types` | whitelist par rôle |
| document-shares | `/api/document-shares` | liens de partage public |
| share-public | `/share` | téléchargement public (non authentifié) |
| rent-periods | `/api/rent-periods` | quittances / avis d'échéance |
| config | `/api/config` | clés de configuration |
| audit-logs | `/api/audit-logs` | journal d'audit (landlord) |
| me | `/api/me` | vues centrées sur l'utilisateur courant |
| migration | `/api/migration` | import one-shot legacy |

## Ownership / multi-tenant

Pas de table « organisation ». L'isolation se fait **par utilisateur**, filtrée dans la requête SQL :

- Biens : colonne `ownerUserId`. Locataires/garants/documents/partages : `createdByUserId` /
  `uploadedByUserId`. Voir `docs/data-model.md`.
- Idiome de lecture : `getByIdForOwner(id, userId)` / `getByIdForCreator(...)` — charge la ligne puis
  lève `404` si absente, `403` si l'owner ≠ user (ressource existe mais accès interdit). Réf :
  `src/modules/properties/properties.service.ts:getByIdForOwner`.
- Idiome d'écriture : pré-check d'ownership **puis** double filtre `and(eq(id), eq(ownerUserId))` sur
  l'UPDATE/DELETE (anti-race). Réf : `properties.service.ts:patch` / `:remove`.
- L'`ownerUserId` provient **toujours** de `c.get('user').id`, jamais du body.
- Documents/partages : ownership **indirecte** via property/lease (le doc n'a pas de colonne owner) —
  voir `src/modules/document-shares/document-shares.service.ts:assertLandlordOwnsDocument` et l'ACL
  dans `src/modules/documents/documents.service.ts`.

## Auth & sessions

- Sessions = **tokens opaques** (32 bytes / 256 bits base64url) stockés en table `sessions`, servis en
  cookie `gl_session` (HttpOnly, SameSite=Lax, Secure en prod). TTL 30 j, sliding-window
  (`lastSeenAt` bumpé à chaque requête). Réf : `src/modules/auth/session.service.ts`.
- Mots de passe : argon2id via `src/modules/auth/password.ts`. Détails sécurité → `docs/security.md`.

## Middleware (`src/middleware/`)

- `session.ts` — **passif** : lit le cookie, charge `user`+`session` dans le contexte
  (`c.get('user')`/`c.get('session')`), ne refuse jamais. Monté globalement.
- `require-auth.ts` — `requireAuth` (401 si pas de user) et `requireRole(...roles)` (403 si rôle non
  autorisé). Appliqués par module.
- `error-handler.ts` — `app.onError` : mappe `HTTPException` (status+message), `ZodError` (400 +
  `issues`), reste → 500 loggé. Réf : `src/middleware/error-handler.ts`.

Le type du contexte Hono (`Variables: { user, session }`) est dans `src/types/app-env.ts`.

## Scheduler (`src/scheduler/`)

`startScheduler()` (appelé après `serve`) enregistre 3 tâches node-cron, timezone `Europe/Paris` :

- **08:00** — `rent-periods.task.ts` : crée les `rent_periods` du mois prochain pour chaque bail actif
  (idempotent via l'unique `(lease, period_month)`) + envoie les avis d'échéance dont `due_date ≤ J+10`.
- **03:00** — `documents-purge.task.ts` : purge définitive des documents soft-deleted dépassant le TTL
  (`config_entries['document.soft_delete_ttl_days']`, défaut 90 j), par batch de 100.
- **04:00** — `documents-orphan-cleanup.task.ts` : supprime les fichiers du volume sans ligne DB et
  plus vieux que 7 j (marge anti-race upload→insert).

`stopScheduler()` (sur SIGTERM/SIGINT) arrête les crons et ferme le browser puppeteer + le mailer.

## `lib/` — helpers transverses

- `logger.ts` — pino (pretty hors prod), niveau via `LOG_LEVEL`.
- `mailer.ts` — nodemailer, transporter singleton lazy. **En prod, SMTP_HOST manquant = throw** (pas
  de fallback silencieux). `sendEmail` ne propage jamais une erreur SMTP (log + `{ delivered: false }`).
- `email-templates.ts` — rendu HTML des emails transactionnels (invitation, reset, quittance/avis…).
- `storage.ts` — stockage fichiers sur volume sous `<year>/<month>/<uuid>.<ext>`. Garde-fou
  path-traversal (`resolveSafePath`), validation taille (`MAX_UPLOAD_BYTES`) + MIME par magic bytes
  (`assertContentMatchesDeclaredMime`, allowlist `ALLOWED_MIME_TYPES`).
- `pdf-renderer.ts` — puppeteer (Chromium singleton partagé), templates HTML→PDF des quittances et
  avis ; helpers de formatage FR (`formatEur`, `formatDate`, `formatMonth`).
- `audit.ts` — insertion best-effort dans `audit_logs` (`recordUserAudit` / `recordSchedulerAudit` /
  `recordSystemAudit`). Liste typée des actions : `AuditAction`.
- `rate-limit.ts` — limiteurs global + sensible, résolution IP derrière proxy de confiance
  (`resolveClientIp`). Détails → `docs/security.md`.

## DB client

`src/db/client.ts` : pool `postgres.js` (`max` 20 en prod / 5 sinon), SSL auto si l'hôte n'est pas
local (`shouldUseSsl`), instance Drizzle avec le schéma agrégé. Migrations via drizzle-kit
(`drizzle.config.ts`, sortie `src/db/migrations`). Voir `docs/data-model.md`.
