# Roadmap — État d'avancement & reste à faire

Vue d'ensemble du projet `gestion-locative` (front) + `gestion-locative-api` (back).
Mise à jour : 2026-05-30.

---

## 🎯 Décisions d'architecture verrouillées

- **2 repos séparés** : `gestion-locative` (front React Vite) + `gestion-locative-api` (back Hono)
- **Contrat front ↔ back** : REST + OpenAPI (spec auto-générée par `@hono/zod-openapi`)
- **Auth** : cookies HTTP-only + sessions DB-backed, magic link pour les invitations
- **BDD** : PostgreSQL + Drizzle ORM (schéma versionné, migrations SQL)
- **Stockage fichiers** : volume Docker monté sur le container backend (jamais exposé directement)
- **PDF** : générés par le backend via Puppeteer (templates HTML/CSS partagés avec le front)
- **Scheduler** : `node-cron` dans le process backend (avis d'échéance J-10, génération quittances)
- **i18n** : structure des formulaires + clés de traduction servies par l'API, libellés FR dans le bundle front
- **Déploiement** : Docker containers derrière le nginx existant du VPS
- **Auto-hébergé** sur ton VPS, dual-push GitLab (origin) + GitHub (mirror)

---

## ✅ Ce qui est fait

### Frontend (`gestion-locative`)
- App React 19 + Vite + TypeScript fonctionnelle (localStorage uniquement, pas de back encore)
- Pages : Réglages, Biens & baux, Quittances, Aperçu PDF imprimable
- Génération PDF via impression navigateur
- Dual-push GitLab + GitHub configuré

### Backend (`gestion-locative-api`)
- Squelette du repo : Hono + Drizzle + Zod + Biome + Vitest
- Bootstrap serveur : `/api/health` répond, spec OpenAPI exposée sur `/openapi.json`
- Schéma DB initial : `users` (id, email, password_hash, role) + `sessions`
- Migration SQL initiale générée
- `.env.example`, logger pino, error handler, config Zod
- Doc `docs/database-setup.md` pour provisionner la BDD

---

## 🚧 Reste à faire

### Milestone 1 — Auth bout-en-bout

**Backend**
- [ ] Créer la base de données de dev + appliquer la migration `0000`
- [ ] Module `auth` : routes `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/accept-invitation`
- [ ] Service de session : création/lecture/expiration/refresh
- [ ] Hash mot de passe avec `@node-rs/argon2`
- [ ] Middleware `session` (lit le cookie, charge l'user)
- [ ] Middleware `require-auth` et `require-role`
- [ ] Tests vitest sur le service auth

**Frontend**
- [ ] Page `/login` (email + password)
- [ ] Page `/accept-invitation/:token` (création du mot de passe)
- [ ] Provider `AuthContext` (fetch `/api/auth/me` au boot)
- [ ] Routes protégées (`<RequireAuth>` wrapper)
- [ ] Logout

---

### Milestone 2 — Entités domain (CRUD)

**Backend** — un module par entité, pattern vertical slice
- [ ] `landlord-profiles` : `GET`, `PUT`
- [ ] `tenants` : CRUD + endpoint `POST /:id/invite`
- [ ] `guarantors` : CRUD + endpoint `POST /:id/invite` + champ `guarantor_type_key` (person/organization)
- [ ] `properties` : CRUD
- [ ] `leases` : CRUD + `PATCH /:id/status` (draft → active → ended)
- [ ] Tables d'association : `lease_tenants`, `lease_guarantors` (colocation, multi-garants)
- [ ] Table `invitations` polymorphique (target_type : tenant ou guarantor) + envoi email magic link
- [ ] Middleware `access-control` (le bailleur ne voit que ses ressources)
- [ ] Tests d'intégration sur chaque module

**Frontend**
- [ ] Refactor : sortir du localStorage, consommer l'API REST
- [ ] Générer le client TS depuis la spec OpenAPI (`openapi-typescript` ou équivalent)
- [ ] Page Réglages : `landlord-profile` via API
- [ ] Page Biens : liste + formulaire CRUD
- [ ] Page Locataires : liste + formulaire CRUD + bouton "Inviter"
- [ ] Page Garants : liste + formulaire CRUD (person/organization) + bouton "Inviter"
- [ ] Page Baux : wizard 4 étapes (bien → locataires → garants → conditions) avec sauvegarde draft à chaque étape

---

### Milestone 3 — Documents + upload + partage

**Backend**
- [ ] Schéma `documents` (lease_id nullable, property_id nullable, status_key, validated_at, cancelled_at…)
- [ ] Schéma `document_shares` (token, expires_at, revoked_at, access_count)
- [ ] Module `documents` :
  - [ ] `GET /api/documents` (filtres lease, property, type, status)
  - [ ] `POST /api/documents` (multipart upload)
  - [ ] `GET /api/documents/:id/download` (stream, ACL)
  - [ ] `PATCH /api/documents/:id/status` (validate / reject, bailleur uniquement)
  - [ ] `DELETE /api/documents/:id`
- [ ] Module `document-shares` :
  - [ ] `POST /api/document-shares` (TTL 7j)
  - [ ] `DELETE /api/document-shares/:id` (révocation)
  - [ ] `GET /share/:token` (public, vérif TTL + révocation + log accès)
- [ ] Service `storage` : write/read/stream sur le volume Docker, structure `<year>/<month>/<uuid>.<ext>`
- [ ] Endpoint `GET /api/document-types?role=` (whitelist servie par l'API)
- [ ] Envoi email à la création d'un share (optionnel)

**Frontend**
- [ ] Page "Mon dossier" côté locataire : grille de cartes par catégorie, drop multi-fichiers
- [ ] Page "Documents en attente" côté bailleur : preview + validation/rejet
- [ ] Action "Partager" sur chaque document (génère le lien copiable)
- [ ] Page publique `/share/:token` qui télécharge le doc (pas d'auth)
- [ ] Whitelist par rôle consommée depuis `GET /api/document-types`

---

### Milestone 4 — Rent periods + génération quittances + scheduler

**Backend**
- [ ] Schéma `rent_periods` (lease_id, period_month, montants, status_key, paid_at, notice_document_id, receipt_document_id…)
- [ ] Module `rent-periods` :
  - [ ] `GET /api/rent-periods` (filtres lease, status, mois)
  - [ ] `PATCH /api/rent-periods/:id` (ajouter régul. avant J-10)
  - [ ] `POST /api/rent-periods/:id/send-notice` (envoi manuel de l'avis)
  - [ ] `POST /api/rent-periods/:id/mark-paid` (toggle Oui → génère quittance + email)
  - [ ] `POST /api/rent-periods/:id/mark-unpaid` (undo dans la fenêtre 24h)
- [ ] Service de génération PDF avec Puppeteer (avis d'échéance + quittance)
- [ ] Templates HTML/CSS partagés avec le front (package `gestion-locative-templates` ou duplication V1)
- [ ] Module `scheduler` :
  - [ ] Tâche quotidienne 8h Paris : créer les `rent_periods` du mois suivant, envoyer les avis à J-10
  - [ ] (V2) Rappel J-3 si non payé
- [ ] Module `mailer` : nodemailer + templates HTML pour avis, quittance, annulation, invitation, partage
- [ ] Schéma `documents.cancelled_at`, `cancelled_by_user_id`, `cancellation_reason`

**Frontend**
- [ ] Page mensuelle bailleur : liste de cartes `rent_periods` avec toggle Oui/Non
- [ ] Bouton "↩ Annuler" visible pendant 24h après validation
- [ ] Édition des régul. ponctuelles (TEOM, solde, régul. charges) avant J-10
- [ ] Vue locataire : ses quittances et avis groupés par mois

---

### Milestone 5 — Config dynamique + i18n

**Backend**
- [ ] Schéma `config_entries` (key/value JSON)
- [ ] Schéma `form_schemas` (name, schema JSON, version)
- [ ] `GET /api/config` (valeurs par défaut, listes)
- [ ] `GET /api/form-schemas/:name` (structure du formulaire avec clés i18n)
- [ ] Seed initial : `lease_form`, `tenant_form`, `property_form`, `guarantor_form`

**Frontend**
- [ ] Setup i18n (`react-i18next` ou équivalent) avec bundles `fr.json` versionnés
- [ ] Renderer de formulaire dynamique à partir du `form_schemas` (champ → composant via type)
- [ ] Migration des formulaires hardcodés vers le renderer dynamique

---

### Milestone 6 — Migration localStorage → DB

**Frontend**
- [ ] Page `/migration` (one-shot)
- [ ] Lecture des clés `gl.bailleur`, `gl.baux`
- [ ] Envoi vers `POST /api/migration/import` (endpoint dédié côté back)

**Backend**
- [ ] Endpoint `POST /api/migration/import` : parse + crée landlord_profile + properties + tenants + leases en `active`
- [ ] Idempotence (peut être relancé sans dupliquer)

---

### Milestone 7 — Déploiement prod

> ⚠ **Statut : rien n'est en place.** Tout ce qui est listé ici est à construire.

#### Décisions à trancher avant de démarrer ce milestone

1. **Stratégie de déploiement**
   - **(A) Déployer tôt et souvent** — setup complet immédiatement avec juste `/api/health` en prod, puis chaque feature suivante se déploie auto. ~2-3h d'investissement initial.
   - **(B) Attendre Milestone 1+** — faire l'auth en local d'abord, puis setup prod ensuite.
2. **Registry d'image Docker**
   - GitHub Container Registry (`ghcr.io/jarzur-dev-ui/gestion-locative-api`)
   - GitLab Container Registry (`registry.gitlab.exanders.fr/infrajo/gestion-locative-api`)
   - Docker Hub
3. **Domaine API**
   - Sous-domaine séparé : `api.zeleph.fr` → backend, `gestion.zeleph.fr` → front
   - Path : `gestion.zeleph.fr/api/*` → backend (plus simple côté cookies/CORS, recommandé)
4. **CI primaire** (lint + typecheck + build + push image)
   - GitHub Actions
   - GitLab CI
   - Les deux en parallèle (déclenchés par le dual-push)
5. **Méthode de déploiement sur le VPS**
   - SSH + `docker compose pull && up -d` manuel
   - Webhook auto déclenché par CI (Watchtower, Portainer, ou script custom)
   - Repo "infra" central avec `docker-compose.yml` versionné

#### Backend — à construire

- [ ] `Dockerfile` multi-stage (Node 22 slim)
  - V1 : sans Puppeteer
  - V2 (Milestone 4) : ajout de Chromium pour génération PDF (~+300 Mo)
- [ ] Snippet `docker-compose` à intégrer côté infra (image registry, env vars, secrets, volume `gestion-locative-files`)
- [ ] Workflow CI : `lint` → `typecheck` → `test` → `build image` → `push registry`
- [ ] Stratégie de secrets : Docker secrets, ou fichier `.env` hors git avec `chmod 600`, ou Vault/Doppler
- [ ] Doc `docs/deployment.md` : checklist du premier déploiement, génération du `COOKIE_SECRET`, procédure de rollback

#### Frontend — à construire

- [ ] Build statique pour prod, déployable sur le nginx existant ou via un container nginx-alpine
- [ ] Variables d'env build-time (`VITE_API_URL`)
- [ ] Workflow CI : `lint` → `typecheck` → `build` → upload artefact

#### Infra (VPS) — à configurer

- [ ] Provisionner la BDD prod (rôle `gestion_locative_app_prod`, base `gestion_locative_prod`, cf. `docs/database-setup.md`)
- [ ] Configurer nginx :
  - Reverse proxy `/api/*` → backend container (port 3000)
  - Statique `/*` → frontend (container nginx ou dossier `dist/` direct)
  - Trust proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto`)
  - Limites taille upload (multipart pour documents : 20 Mo conseillé)
- [ ] Volume Docker `gestion-locative-files` créé sur l'hôte
- [ ] HTTPS via Let's Encrypt (probablement déjà géré par ton nginx existant)
- [ ] CORS : `CORS_ORIGIN=https://gestion.zeleph.fr` côté backend
- [ ] Cookie domain : aligner avec le domaine front (`.zeleph.fr` si sous-domaines, sinon laisser implicite)

#### SMTP

- [ ] Choisir le provider : OVH SMTP (inclus avec ton hébergement), Brevo, Resend, Mailgun…
- [ ] Configurer les variables : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- [ ] Configurer SPF / DKIM / DMARC sur le domaine `zeleph.fr` pour la délivrabilité
- [ ] Tester l'envoi (template invitation magic link)

#### Backups & Observabilité

- [ ] Cron quotidien `pg_dump` → fichier daté → upload distant (S3-compatible, Backblaze, autre VPS)
- [ ] Cron hebdo `tar` du volume `gestion-locative-files`
- [ ] Rotation (garder N derniers jours)
- [ ] Procédure de restauration testée au moins 1 fois
- [ ] Logs structurés (`pino` JSON) → fichier ou stdout, scrapés par un agent (Loki, Vector, journald…)
- [ ] Healthcheck Docker pointant sur `/api/health` (auto-restart si KO)

#### Migration depuis le localStorage (Milestone 6) — checklist prod

- [ ] Exporter le `localStorage` du navigateur depuis ton app actuelle
- [ ] Importer via `POST /api/migration/import`
- [ ] Vérifier que tous les baux apparaissent
- [ ] Envoyer les invitations aux locataires actuels

---

### Idées V2 (post-MVP)

- [ ] Génération automatisée de la quittance par lecture des virements bancaires (PSD2 / Bridge / Powens) → plus de toggle manuel
- [ ] Workflow de validation d'identité (vérification automatique des pièces d'identité)
- [ ] Dashboard analytics bailleur (revenus annuels, retards, taux d'occupation)
- [ ] Multi-bailleur (passer d'un seul utilisateur à une vraie plateforme SaaS, si besoin)
- [ ] Notifications push / mobile
- [ ] Génération d'attestations fiscales annuelles pour les locataires
- [ ] Génération avenants au bail (changement de loyer, sortie de coloc…)

---

## 📌 Prochaine action immédiate

➡ **Provisionner la base de données de dev** (voir [`database-setup.md`](./database-setup.md)) puis fournir la `DATABASE_URL` pour que je lance la première migration et démarre le **Milestone 1 (Auth)**.
