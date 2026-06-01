# Roadmap — État d'avancement & reste à faire

Vue d'ensemble du projet `gestion-locative` (front) + `gestion-locative-api` (back).
Mise à jour : 2026-06-01.

**Statut global** : Milestones **M1 → M7 ✅ terminées**. App live en prod sur `https://gestion-locative.zeleph.fr`. Reste à faire : **M7.5 — Hardening prod** (backups, certbot renew, SMTP, fix migrations Drizzle). Voir section dédiée plus bas.

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

#### Workflow de signature retenu pour V1 — signature physique scannée

**Décision** : pas d'e-signature qualifiée (Yousign / DocuSign / etc.) en V1. Trop coûteux en effort et complexité pour le volume actuel. À reconsidérer en V2 si volume ≥ 5 baux/an.

**Workflow** :
1. Bailleur génère le PDF du bail **sans signatures** depuis l'app
2. Bail imprimé → signé physiquement par toutes les parties sur un **papier blanc séparé**
3. Bailleur scanne les signatures
4. Upload des images de signatures dans l'app → backend compose visuellement le PDF final du bail
5. Le PDF composé est stocké dans `documents` avec un watermark explicite

**Schéma `leases` — champs liés à la signature** :
```
+ signature_method_key       -- 'handwritten_scanned' (V1, valeur fixe)
+ original_paper_archived    -- bool, default true (reminder/audit, le bailleur confirme l'archivage papier)
```

**4 règles non-négociables** (à respecter au niveau process et code) :
1. **Conserver les originaux papier** ≥ 5 ans après la fin du bail (prescription quinquennale)
2. **Ne JAMAIS persister les images isolées** des signatures locataire/garant côté serveur. Workflow strict côté backend : upload → composition PDF → suppression immédiate des images source. Seule la signature du **bailleur** est persistée (`landlord_profiles.signature_file_path`), parce qu'il consent à sa conservation
3. **Watermark obligatoire** sur le PDF composé : *"Reproduction numérique d'un bail signé sur support papier le JJ/MM/AAAA — original conservé par le bailleur"*. Désamorce toute confusion juridique avec une vraie e-signature
4. **Audit trail dans `documents`** : `uploaded_by_user_id`, `created_at`, IP (déjà prévu sur `sessions`)

---

### Milestone 2.5 — Hardening backend (à faire **avant** Milestone 7 / déploiement prod)

> Liste issue de la revue critique post-M2 (2026-05-30). Items techniques et sécurité à corriger ou consciemment accepter avant toute mise en production.

#### 🔴 Risques à corriger absolument avant prod

- [ ] **R1 — Race condition `accept-invitation`** : ajouter `isNull(invitations.usedAt)` dans le WHERE de l'UPDATE et vérifier `rowcount === 1` ; sinon deux requêtes simultanées avec le même token peuvent toutes les deux créer un compte. (REPEATABLE READ ou SELECT FOR UPDATE en alternative.)
- [ ] **R2 — Email duplicate → 409 propre** : try/catch sur l'INSERT user dans `accept-invitation`, détecter le code Postgres `23505` (unique_violation) et renvoyer 409 typé au lieu d'un 500 cryptique.
- [ ] **R3 — FK polymorphique `invitations.target_id`** : refactor en `target_tenant_id` + `target_guarantor_id` avec CHECK XOR + ON DELETE CASCADE, ou consciemment laisser et nettoyer les orphelines via un cron.
- [ ] **R4 — Migration PUT → PATCH** (5 modules : landlord-profiles, properties, tenants, guarantors, leases) :
  - Sémantique : **JSON Merge Patch (RFC 7396)**
  - Champ absent → pas touché ; champ présent à `null` → set NULL ; champ présent non-null → update
  - Tous les champs `.optional()` dans les schemas Zod d'update
  - Drizzle `.set(dataObj)` ne met à jour que les colonnes présentes
  - À documenter clairement dans la spec OpenAPI
- [ ] **R5 — Lease status : rollback contrôlé** : ajouter une transition `active → draft` autorisée pendant N heures après le passage en active (typo, erreur de saisie). Au-delà, verrouillé. Ou alternativement : autoriser un PATCH partiel sur lease même en `active` pour les champs non-structurants (loyer, charges) avec audit log.

#### 🟡 Améliorations sécurité / robustesse prod

- [ ] **P3 — Mailer prod-safe** : `if (env.NODE_ENV === 'production' && !env.SMTP_HOST) throw` au boot. Sinon une invitation envoyée en prod = silence, le bailleur ne sait pas que rien n'est parti.
- [ ] **P4 — Token d'invitation non-exposé en prod** : `POST /api/invitations` retourne `{ expiresAt }` uniquement en production, jamais `token`. Le token ne doit transiter que par email.
- [ ] **P5 — Audit log** : table `audit_logs(id, user_id, action, entity_type, entity_id, payload jsonb, ip, user_agent, created_at)`. Middleware qui enregistre les actions sensibles (login, lease.create, lease.status.change, document.validate, invitation.accept, payment.confirm).
- [ ] **P6 — Rate limiting** : middleware sur `/api/auth/login` (5 tentatives / 15min par IP), `/api/invitations/accept` (10 tentatives / heure par IP), `/api/invitations` (50 / jour par bailleur). Lib type `hono-rate-limiter` ou implémentation maison Redis-less.
- [ ] **Helmet-like headers** : `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`.
- [ ] **Validation taille body** : middleware qui rejette `Content-Length > 20 Mo` au niveau Hono (en plus de nginx).

#### 🟢 Améliorations non bloquantes (à programmer post-MVP)

- [ ] **P1 — N+1 sur `GET /api/leases`** : passer à un INNER JOIN global + map en mémoire quand on dépassera 50 baux/bailleur.
- [ ] **P2 — Consistency pass sur les middlewares de rôle** : harmoniser entre les 6 modules (certains utilisent `requireRole`, d'autres inlinent le check). Lance un agent dédié pour normaliser.
- [ ] **Junction update diff** : dans `leases.update`, diffuser les sets tenant/guarantor au lieu de delete-then-insert systématique (économise des writes inutiles).

#### Items ajoutés post-revue Milestone 5 (config_entries)

🔴 **Bloquants multi-user** :

- [ ] **R14 — Validation Zod par-clé sur PUT `/api/config/:key`** : actuellement `value` accepte n'importe quel JSON. Un bailleur peut écraser `lease.types` avec une chaîne et casser le rendu front. **Fix** : table de mapping `key → schema` (ex. `lease.default_payment_day` → `z.number().int().min(1).max(31)`), refuser 400 si non-conforme.
- [ ] **R15 — Scoping multi-bailleur de `config_entries`** : actuellement N'IMPORTE QUEL landlord écrase la config GLOBALE. **Fix multi-user** : `landlord_user_id` FK + PRIMARY KEY composite `(landlord_user_id, key)` ; OU séparer un rôle `admin` distinct (seul autorisé à update).

🟡 **Améliorations** :

- [ ] **P19 — Wrapping `{ config: ... }` sur GET /api/config** : workaround zod-openapi pour le typage `z.record`. Documenter dans la spec OpenAPI ou trouver mieux (passthrough manuel ?).
- [ ] **P21 — Versioning des entrées** : pas de trace des updates précédentes. Couvert par `audit_logs` (P5).

---

#### Items ajoutés post-revue Milestone 4 (rent_periods + scheduler + PDF + mailer)

🔴 **Bloquants avant multi-user / SaaS** :

- [ ] **R10 — Idempotence stricte sur `mark-paid`** : un double-clic peut générer 2 PDFs (le 2e échoue à l'UPDATE mais le fichier reste sur le volume). Fix attaché à R6 (cron cleanup orphelins) OU passer la génération PDF dans la transaction au prix d'une transaction longue.
- [ ] **R11 — Email best-effort sans retry sur quittance/avis** : si SMTP est down au moment de `mark-paid`, la quittance est en BDD mais le locataire n'est pas notifié. **Fix** : queue durable (BullMQ + Redis) avec retry exponentiel + alerte UI "X emails non délivrés".
- [ ] **R12 — Scheduler agit comme le bailleur sans audit** : `sendNotice(periodId, ownerUserId)` est appelé en interne par le cron en se faisant passer pour le landlord. Pas exploitable actuellement mais opaque. **Fix** : table `audit_logs` (P5) avec `actor_type='scheduler'`, `triggered_by='cron'`, et un endpoint `GET /api/audit-logs` côté UI bailleur.
- [ ] **R13 — PDF generation bloque le throughput multi-user** : Browser Puppeteer singleton + 5.4s cold start = 1 quittance/process à la fois. **Fix multi-user** : pool de pages (4-8), ou worker process dédié avec queue, ou service séparé.

🟡 **Améliorations à programmer en MVP** :

- [ ] **P13 — Cache mémoire de la signature bailleur** : LRU cache (key = signaturePath, value = base64), invalidation sur PUT landlord-profile. Évite N reads disque pour N quittances.
- [ ] **P16 — Endpoint admin `POST /api/internal/scheduler/run-now`** (protégé landlord) pour déclencher la tâche cron manuellement. Utile pour dev, ops et tests. Sinon `pnpm tsx scripts/scheduler-run-once.ts`.
- [ ] **P17 — Retry PDF generation sur crash Chromium** : try/catch + recréation browser + 1 retry, sinon erreur 500 propre.
- [ ] **P18 — Test explicite `paymentDay > daysInMonth`** : vérifier que `computeDueDate('2026-02', 31)` renvoie bien `2026-02-28`. Test unitaire à ajouter dans `scripts/test-period-generation.ts`.

🟢 **Trade-offs assumés** :

- **P14 — `period-generation` en UTC** : ok V1, peut diverger sur les bords de mois pour le bailleur à 23h Paris. À surveiller.
- **PDF lifecycle hors transaction** : pragma pour éviter de tenir une tx pendant 5s pendant Chromium. Risque orphelin couvert par R6.
- **Browser singleton** : 1 instance/process. Suffisant V1, à scaler en M2.5 R13.

---

#### Items ajoutés post-revue Milestone 3 (documents + storage + shares)

🔴 **Bloquants avant multi-user / SaaS** :

- [ ] **R6 — Pas de transaction sur l'upload de document** : entre `storeFile` (volume) et l'INSERT (BDD), un crash process laisse un fichier orphelin. Cleanup best-effort sur erreur DB existe mais ne couvre pas le crash. **Fix** : cron quotidien qui scanne le volume et supprime les fichiers sans référence dans `documents.file_path`. Ou pattern staging dir + move atomique.
- [ ] **R7 — Hard delete documents → perte irrécupérable** : `DELETE /api/documents/:id` efface fichier ET row DB. Aucune récupération en cas de litige tardif. **Fix** : soft delete via colonnes `deleted_at` / `deleted_by_user_id` + purge physique différée (90j) via cron. Les colonnes `cancelledAt/cancelledByUserId/cancellationReason` existent déjà — à réutiliser ou ajouter des colonnes spécifiques `deletedAt`.
- [ ] **R8 — Pas de quota par bailleur** : 1000 fichiers × 20 Mo = 20 Go sans plafond. Bloquant en SaaS. **Fix** : colonne `total_storage_bytes` sur `landlord_profiles` mise à jour atomiquement à chaque upload/delete, refus 413 au-delà d'un quota configurable (ex. 1 Go).
- [ ] **R9 — Pas de scan antivirus** : un upload locataire/garant malicieux pourrait être téléchargé puis ouvert côté client → exposition. **Fix** : container ClamAV dédié, scan via lib `clamscan` en post-upload async, marquage `quarantined` si infecté. Acceptable solo, **non négociable multi-user**.

🟡 **Améliorations sécurité/perf à programmer en MVP** :

- [ ] **P7 — Pagination sur `GET /api/documents`** : actuellement retourne tout. À 5 ans × baux × quittances = 6000+ documents en une réponse. Cursor-based pagination (`?limit=50&cursor=<uuid>`), pattern Drizzle-friendly via `where(gt(id, cursor)).limit(limit + 1)`.
- [ ] **P9 — Contrainte d'unicité `(lease_id, document_type_key, period_month)`** : prévient les doublons accidentels de quittance pour le même mois. Sera implicitement enforcée par M4 via `rent_periods.receipt_document_id` UNIQUE — sinon ajouter `UNIQUE INDEX ... WHERE period_month IS NOT NULL`.
- [ ] **P12 — Mime type sniffing** : actuellement on fait confiance au `Content-Type` du client. Ajouter `file-type` (lib qui détecte via magic bytes) pour rejeter les binaires déguisés en PDF. Pas d'exécution côté serveur donc impact contenu, pas systèmique — mais hygiène propre.

🟢 **Trade-offs conscients à documenter** :

- **P10 — `recordShareAccess` fire-and-forget** : si l'incrément du `access_count` échoue, le download passe quand même. Trade-off audit-vs-UX assumé. À noter dans le manuel d'exploitation que ce compteur n'est **pas** une source de vérité absolue.
- **P11 — Pas d'historique des transitions de statut documents** : si un doc fait `pending → validated → rejected → validated`, seul le dernier état est en BDD. Sera couvert par la table `audit_logs` de P5.

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

### Milestone 6 — Migration localStorage → DB + intégration API front

#### Stack frontend validé (2026-05-31)

- **`openapi-typescript`** (dev) — génère `src/api/schema.gen.ts` depuis `/openapi.json`
  - Script : `pnpm gen:api`
- **`openapi-fetch`** — client fetch typé, zéro divergence avec le contrat back
- **`@tanstack/react-query`** v5 — cache, refetch, invalidation, optimistic updates
- **`@tanstack/react-query-devtools`** (dev) — debugging

#### Frontend
- [ ] Setup deps + QueryClientProvider + devtools dans App.tsx
- [ ] Variable d'env `VITE_API_URL` (dev: localhost:3000, prod: api.gestion-locative.zeleph.fr)
- [ ] Génération initiale du schema via `pnpm gen:api`
- [ ] Pages auth (login, accept-invitation) consommant `/api/auth/*`
- [ ] AuthContext basé sur `useQuery(['me'], () => api.GET('/api/auth/me'))`
- [ ] Routes protégées (`<RequireAuth>` wrapper)
- [ ] Page Réglages : `landlord-profile` via API (PUT)
- [ ] Page Biens : liste + CRUD via API
- [ ] Page Locataires + Garants : CRUD + bouton "Inviter"
- [ ] Page Baux : wizard 4 étapes
- [ ] Page Quittances : liste mensuelle + toggle Oui/Non (mark-paid) avec optimistic update + undo 24h
- [ ] Page "Mon dossier" côté locataire : drop multi-fichiers par catégorie (whitelist `/api/document-types?role=tenant`)
- [ ] Page `/migration` (one-shot) — lecture localStorage + POST `/api/migration/import`

#### Backend (complément M6)
- [ ] Endpoint `POST /api/migration/import` : parse + crée landlord_profile + properties + tenants + leases en `active`
- [ ] Idempotence (peut être relancé sans dupliquer)

---

### Milestone 7 — Déploiement prod ✅ TERMINÉ (2026-06-01)

> Front et back live sur `https://gestion-locative.zeleph.fr` et `https://api.gestion-locative.zeleph.fr`. Login bailleur fonctionnel en prod.

#### Décisions arrêtées

1. **Stratégie de déploiement** : (A) déploiement complet en une fois après M6
2. **Registry d'image Docker** : `registry.exanders.fr/infrajo/gestion-locative*` (GitLab Container Registry)
3. **Domaine** :
   - Front : `https://gestion-locative.zeleph.fr`
   - API : `https://api.gestion-locative.zeleph.fr`
   - Cookie domain : implicite (single-host par sous-domaine)
   - CORS_ORIGIN : `https://gestion-locative.zeleph.fr`
4. **CI primaire** : GitLab CI (front auto via `.gitlab-ci.yml`, back manuel pour V1)
5. **Méthode de déploiement** :
   - Front : auto via GitLab CI (compile → buildx multi-arch → ssh deploy)
   - Back : manuel (`scp` + `docker compose up -d` sur le VPS)

#### Backend — fait

- [x] `Dockerfile` multi-stage (Node 22 slim + Chromium pour Puppeteer)
- [x] `docker-compose.prod.yml` (port `127.0.0.1:3002:3000`, `host.docker.internal`, volume `gestion-locative-files`)
- [x] Doc `docs/deployment.md` (procédure complète + rollback)
- [x] Secrets : `.env` hors git avec `chmod 600` sur `/root/persistent/gestion-locative-api/`

#### Frontend — fait

- [x] Build statique servi par container `nginx:stable-alpine`
- [x] `VITE_API_URL` injecté au build via variable CI/CD GitLab
- [x] CI : compile → docker-build multi-arch → deploy auto sur push `main`

#### Infra (VPS) — fait

- [x] BDD prod `gestionlocative_prod` provisionnée (rôle dédié, password URL-encoded)
- [x] nginx reverse proxy `api.gestion-locative.zeleph.fr` → `127.0.0.1:3002`
- [x] Volume Docker `gestion-locative-files` créé
- [x] HTTPS Let's Encrypt (webroot challenge, certs `/etc/letsencrypt/live/api.gestion-locative.zeleph.fr/`)
- [x] CORS configuré
- [x] Headers sécurité (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
- [x] `client_max_body_size 25M`

#### Migration localStorage — fait

- [x] Bailleur prod créé (`bailleur@zeleph.fr`)
- [x] 15 tables + 18 entrées de config seedées
- [x] Données legacy migrées via `POST /api/migration/import`

---

### Milestone 7.5 — Hardening prod (post-déploiement)

> Liste issue de la revue critique de fin de M7 (2026-06-01). À traiter avant d'inviter de vrais locataires en prod.

#### 🔴 Bloquants — à corriger avant usage réel

- [ ] **H1 — Backup Postgres quotidien** : cron `pg_dump gestionlocative_prod | gzip > /backup/db-$(date +%F).sql.gz` + upload distant + rotation 30 jours. Sans ça, un crash VPS = perte totale.
- [ ] **H2 — Backup volume documents** : cron hebdo `tar -czf /backup/files-$(date +%F).tar.gz /var/lib/docker/volumes/gestion-locative-files`. Contenu RGPD-sensible (RIB, pièces d'identité).
- [ ] **H3 — Auto-renewal Let's Encrypt** : cron `certbot renew --webroot --webroot-path /root/persistent/nginx/www` (hebdo). Le cert actuel expire ~août 2026. Sans renewal, le site cassera silencieusement.
- [ ] **H4 — SMTP configuré** : sans SMTP, le flux complet d'invitation locataire/garant (magic link mail) ne fonctionne pas. Choisir OVH/Brevo/Resend, configurer SPF/DKIM/DMARC sur `zeleph.fr`, remplir `SMTP_*` dans le `.env` prod.
- [ ] **H5 — Fix `__drizzle_migrations`** : les 6 migrations ont été appliquées via `psql` direct, sans table de tracking peuplée. Prochaine `drizzle-kit migrate` voudra re-jouer → erreur "relation already exists". Action : insérer manuellement les 6 entrées avec les hashes de chaque fichier dans `__drizzle_migrations`.

#### 🟡 Important — à planifier

- [ ] **H6 — CI/CD pour l'API** : actuellement build manuel + scp. Symétriser sur le modèle front : `.gitlab-ci.yml` côté API avec `compile → docker-build → deploy` automatique sur push `main`.
- [ ] **H7 — Monitoring/alerting** : healthcheck Docker en place mais aucune alerte. Brancher Uptime Kuma ou ping externe (Better Uptime gratuit, Healthchecks.io) sur `/api/health`.
- [ ] **H8 — Logs centralisés** : `pino` JSON déjà émis sur stdout. Brancher un agent (Loki, Vector, journald → fichier).
- [ ] **N12 — Endpoint upload signature bailleur** : TODO marqué dans `src/utils/bail-adapter.ts:86`. Permet au bailleur d'uploader sa signature scannée une fois pour qu'elle soit injectée auto dans le PDF du bail à l'impression.
- [ ] **N13 — Tests E2E Playwright** : couvre les parcours bailleur (CRUD bail, mark-paid, génération quittance) et tenant (accept invitation, upload document, share document).
- [ ] **M2.5 Wave 3** :
  - R3 — FK polymorphique `invitations.target_id` (refactor en `target_tenant_id` + `target_guarantor_id`)
  - R9 — Antivirus ClamAV sur les uploads documents
  - R11 — Email retry queue (actuellement fire-and-forget, échec silencieux)
  - R13 — Pool de browsers Puppeteer (actuellement 1 instance/process)

#### 🟢 Dette acceptée pour V1

- Pas de rate-limiting login (argon2id + HttpOnly cookie limite l'impact brute force)
- `VITE_API_URL` hardcodé au build (rebuild si change d'URL — acceptable, ne change jamais)
- Pas de Sentry (`docker logs` suffit pour V1)
- Bundle 103 KB gzip avec code splitting

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

➡ **Hardening prod (Milestone 7.5)** — l'app est live, mais il manque les backups (H1, H2), le renewal Let's Encrypt (H3), et le SMTP (H4) avant de pouvoir vraiment inviter des locataires. À attaquer dans cet ordre : H1 → H2 → H3 → H4 → H5 (fix `__drizzle_migrations`).
