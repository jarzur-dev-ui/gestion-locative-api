# Plan de remédiation — Audit gestion-locative

Suivi de la remédiation issue d'un audit externe (sécurité, fiabilité, qualité, produit).
Couvre **gestion-locative-api** (back) et **gestion-locative** (front), plus les opérations VPS.

**Légende :** ✅ fait · 🔲 à faire · 🟡 partiel · ⛔ hors périmètre (volontairement laissé)

Dernière mise à jour : 2026-06-22.

---

## 0. Contexte projet (lire d'abord si tu débarques sans historique)

### Repos (machine de dev = Mac)
| Repo | Chemin | Stack |
|---|---|---|
| Backend | `/Users/jonathan/private-project/gestion-locative-api` | Hono + `@hono/zod-openapi`, Drizzle ORM (driver `postgres.js`), argon2 (`@node-rs/argon2`), nodemailer, puppeteer (PDF), node-cron, pino, vitest, biome. **ESM** (imports en `.js`). pnpm. |
| Frontend | `/Users/jonathan/private-project/gestion-locative` | React 19 + react-router-dom v7 + `@tanstack/react-query` + `openapi-fetch` (types générés dans `src/api/schema.gen.ts` via `pnpm gen:api` qui tape l'OpenAPI de l'API). SCSS modules, Vite 7. pnpm. **Indentation = TABS**. |
| Legacy | `private-project/quittance-generator`, `private-project/bail-generator` | Scripts Python (PDF). Prédécesseurs, subsumés par l'app. Ne pas y toucher. |

### Git
- Chaque repo a **2 remotes de push** : GitLab `git@gitlab.exanders.fr:infrajo/<repo>.git` (= fetch d'`origin`) **et** GitHub `git@github.com:jarzur-dev-ui/<repo>.git`. Un `git push origin main` pousse **aux deux**.
- Branche par défaut : `main`. Compte GitLab : `@jarzur` (clé du Mac `~/.ssh/id_rsa`).
- ⚠️ Pas d'accès API GitLab/glab/token en local → impossible de créer MR / deploy keys par CLI (à faire en UI).

### VPS
- Accès : `ssh root@zeleph.fr` (clé). Hôte = `ubuntu`, Ubuntu 22.04.
- Conteneurs Docker utiles : `gestion-locative-api` (port hôte **3002**→3000), `postgresql` (postgres:18.4-alpine), `nginx` (reverse proxy HTTPS, monte les certs depuis `/root/persistent/certbot/certs`), `gitlab-runner` (`zeleph-1`, executor docker). Autres conteneurs = **autres projets** (`ergodocker-*`, `adguard`…), ne pas toucher.
- Repo prod déployé : `/root/persistent/gestion-locative-api` (cloné depuis GitLab, branche `main`, deploy key read-only `root@ubuntu`).
- Front : déployé via sa **CI GitLab** (push `main` → pipeline runner → build image → ssh deploy). L'API, elle, **n'a pas de CI** → déploiement manuel.

### Base de données
- **Une** instance Postgres (conteneur `postgresql`), 3 bases : `postgres`, `gestionlocative_dev`, `gestionlocative_prod`.
- L'app prod joint via `DATABASE_URL = postgres://gestionlocative_prod:<pwd>@host.docker.internal:5432/gestionlocative_prod`.
- Depuis l'hôte VPS : `localhost:5432`. Depuis le Mac : `zeleph.fr:5432` (⚠️ **public**, c'est le sujet 0.1).
- Pour requêter prod depuis l'hôte : `docker exec -i postgresql psql "<DATABASE_URL avec host.docker.internal→localhost>"`.

### Secrets (SOPS/age)
- Secrets prod chiffrés dans le repo : `secrets/prod.env` (règle dans `.sops.yaml`). Sûr à committer (chiffré).
- Clé **privée** age : `~/.config/sops/age/keys.txt` (chmod 600), présente sur le **Mac et le VPS**, jamais commitée.
- ⚠️ Ce build de sops ne trouve pas la clé tout seul → `SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt` est exporté dans le `~/.zshrc` du Mac ; sur le VPS le passer explicitement.
- Éditer un secret : `sops secrets/prod.env` (s'ouvre déchiffré, re-chiffre à la sauvegarde).

### ⚠️ Gotchas (sinon tu perds du temps)
- **pnpm dans le repo back** avorte en shell non-TTY (`ERR_PNPM_*`). → préfixer `CI=true pnpm <cmd>` et **lancer les binaires directement** : `node_modules/.bin/{tsc,vitest,biome,drizzle-kit}`. (Le front, lui, accepte `pnpm build`/`pnpm lint` directement.)
- pnpm peut régénérer un `pnpm-workspace.yaml` parasite (placeholder) → le supprimer s'il apparaît.

### Commandes de vérification
- **Back** : `node_modules/.bin/tsc --noEmit` · `node_modules/.bin/vitest run` · `node_modules/.bin/biome check src`
- **Front** : `pnpm build` (= `tsc -b && vite build`) · `node_modules/.bin/eslint .`

### Déploiement
- **Backend** (manuel, sur le VPS) :
  ```bash
  cd /root/persistent/gestion-locative-api
  git pull --ff-only origin main
  SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops -d secrets/prod.env > .env && chmod 600 .env
  docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d
  curl -s http://127.0.0.1:3002/api/health   # doit renvoyer {"status":"ok",...}
  ```
- **Migrations prod** : pas de `drizzle-kit` dans le conteneur runtime. Appliquer le SQL d'une migration :
  `docker exec -i postgresql psql "<DATABASE_URL host=localhost>" -v ON_ERROR_STOP=1 -f - < src/db/migrations/XXXX.sql`.
  Le tracking `drizzle.__drizzle_migrations` prod est **peuplé et cohérent** (cf. ✅) → `drizzle-kit migrate` est un no-op pour l'existant ; tu peux aussi le lancer depuis le Mac avec `DATABASE_URL` pointant `zeleph.fr:5432/gestionlocative_prod`.

---

## ✅ Fait (session 2026-06-21 → 22)

### Fonctionnel
- ✅ **Forgot / reset password** (back + front) : développé, testé (unit + E2E), mergé, **déployé en prod et vérifié**. Back : `src/modules/auth/password-reset.{service,service.test}.ts`, endpoints publics dans `auth.routes.ts` (`POST /api/auth/forgot-password` → 204, `POST /api/auth/reset-password` → 200/404/410), table `password_reset_tokens` (migration `0006`). Front : pages `ForgotPasswordPage`, `ResetPasswordPage`, lien sur `LoginPage`, hooks dans `src/api/auth.ts`.
- ✅ **Bug magic-link d'invitation** corrigé (`/accept-invitation/:token` en param de chemin ; `WEB_APP_BASE_URL` extrait dans `src/config/app.ts`).

### Sécurité backend (commit `46f85a7`, **déployé en prod**)
- ✅ **H1** Rate limiting (`hono-rate-limiter`, `src/lib/rate-limit.ts` + `src/index.ts`) : global + buckets stricts sur login / forgot / reset / accept-invitation / share. **Vérifié live** (401×10 → 429). + Hash Argon2 déplacé **après** validation du token (`invitations.service.ts`, `password-reset.service.ts`).
- ✅ **H2** Upload validé par magic bytes (`file-type`) dans `src/lib/storage.ts` + `documents.service.ts`.
- ✅ **H3** `X-Content-Type-Options: nosniff` sur `documents.routes.ts` + `share-public.routes.ts`.
- ✅ **M2** Share public ne sert plus les docs soft-deleted (`document-shares.service.ts` → `isNull(documents.deletedAt)`).
- ✅ **M1** Écriture config : clés inconnues rejetées + cap taille (`config.validators.ts`).
- ✅ **L6** TLS DB pour connexions non-loopback (`src/db/client.ts`).
- ✅ **5.2** Garde « total négatif » → 409 propre (`rent-periods.service.ts`).
- ✅ **0.5** `COOKIE_SECRET` (dead config) retiré de `env.ts` + `.env*.example`.
- ✅ **0.4** `biome --write` sur tout `src`.

### Qualité frontend (commit `21818d4`)
- ✅ **0.4** 10 erreurs ESLint → 0 (Toast store extrait dans `toast-store.ts`, `Date.now()` impur, set-state-in-effect, regex).
- ✅ **5.1** Flash login corrigé · `mutateAsync` protégé (unhandled rejection) · N+1 Quittances 2N→2 requêtes.

### Secrets, déploiement, migrations
- ✅ **SOPS/age** opérationnel (cf. §0). SMTP configuré (mdp récupéré depuis le projet `ergojs` sur le VPS) + **envoi réel validé en prod** depuis `noreply@zeleph.fr`.
- ✅ **Accès git VPS réparé** (deploy key read-only `root@ubuntu` sur GitLab).
- ✅ **Tracking `__drizzle_migrations` prod normalisé** (7 lignes hash+timestamp exacts) ; `drizzle-kit migrate` prod = no-op vérifié.

### Ops VPS
- ✅ **2.1 Backups Postgres** : `pg_dumpall` quotidien 3h30 (`/root/persistent/backup_postgres.sh`), cron installé, rotation 14 j, dump validé. ⚠️ **local-only** (cf. reste : offsite).
- ✅ **2.2 Renouvellement cert auto** pour `zeleph.fr` + `api.gestion-locative.zeleph.fr` : cron certbot dns-ovh 2×/jour + reload nginx ; **dry-run validé** (creds OVH + DNS-01 OK).

---

## 🔲 Reste à faire

### Sécurité / Ops — Élevé
- 🔲 **0.1 Fermer Postgres au public** — `zeleph.fr:5432` exposé sur internet. ⚠️ **Piège** : Docker contourne ufw (DNAT) ; l'app prod joint via `host.docker.internal` → ne PAS binder sur `127.0.0.1` (casse la prod). Fix propre : republier Postgres sur l'IP du bridge Docker, **ou** mettre app+postgres sur un réseau Docker partagé (nom de service). Tester la connectivité prod (`/api/health`) à chaque étape.
- 🔲 **0.2 Rotater le mot de passe `gestionlocative_dev`** (le seul exposé, en clair dans le `.env` dev du Mac) + MAJ `.env` dev. *(Le mdp `gestionlocative_prod` n'a jamais été exposé.)*
- 🔲 **Bloqueur 0.1/0.2 : dev local.** Le Mac n'a **ni Docker ni Postgres**. **Reco** : tunnel SSH (`ssh -L 5433:localhost:5432 root@zeleph.fr`, `.env` dev → `localhost:5433`) pour fermer le port sans rien installer ; base locale Homebrew Postgres plus tard (avec Lot 4).
- 🔲 **Backups offsite** : les dumps restent sur le VPS (perte VPS = perte backups). Pousser vers OVH Object Storage / S3 (credentials requis).

### Lot 3 — CI/CD
- 🔲 **CI API** (inexistante) : `.gitlab-ci.yml` → gate `node_modules/.bin/biome check src && tsc --noEmit && vitest run` → build image → deploy (cf. §0 Déploiement).
- 🔲 **Gate lint front** : ajouter `eslint . && tsc --noEmit` au pipeline front (aujourd'hui seul `pnpm build`).
- 🔲 **Déploiement health-gated** + rollback si `/api/health` KO.
- 🔲 **Confirmer le déploiement front** (la CI front est censée s'être déclenchée au push `main` — non vérifié, pas d'accès API GitLab).

### Lot 4 — Tests (nécessite une base de test)
- 🔲 **Base de test** : Testcontainers-Postgres (besoin Docker) **ou** Homebrew Postgres dédiée.
- 🔲 **Tests d'autorisation / IDOR** : 1 test par module (`properties`, `tenants`, `guarantors`, `leases`, `documents`, `document-shares`, `rent-periods`) — landlord A ne doit pas accéder aux données de B. C'est le squelette sécu multi-tenant, **non testé**.
- 🔲 **Tests purs** (pas de DB) : `src/modules/rent-periods/period-generation.ts` → `computeDueDate` (clamp février, bissextile), sommes en centimes avec avoirs négatifs ; machines à états (mark-paid, fenêtre 24h).
- 🔲 Quelques tests RTL front (toggle Quittances, routing gardé par `RequireAuth`).

### Lot 5 — Produit / finitions
- 🔲 **5.3 Signature du bailleur** (N12) : `POST /api/landlord-profile/signature` — upload **unique** de la signature du bailleur (les locataires/garants **ne signent pas** dans l'app), embarquée dans les PDF. Corriger **L1** au passage : `signatureFilePath` est aujourd'hui un chemin FS brut accepté du client (`landlord-profiles.schemas.ts`) → passer par le pipeline d'upload à id opaque (comme `documents`). Front : `SignaturePad` + `ReglagesPage` (TODO N12 déjà en place).
- 🔲 **Suivi back (noté par l'agent front)** : l'endpoint rent-periods ne renvoie pas de summaries dénormalisés (lease/property) ni de flag serveur `canUndo` (fenêtre 24h) → calcul côté client. Dénormaliser permettrait de supprimer 2 fetchs + le calcul d'horloge client dans `QuittancesPage`.

### Moyen / Bas
- 🔲 **M3** énumération via accept-invitation (409 vs 200) — portée limitée (email figé au snapshot).
- 🔲 Nettoyage : `COOKIE_SECRET` encore présent dans `secrets/prod.env` + le `.env` du VPS (inoffensif, ignoré ; à retirer au prochain `sops secrets/prod.env`).

---

## ⛔ Hors périmètre (volontairement laissé)
- ⛔ **4 certs cassés d'autres projets** (`dev.exanders.fr`, `exanders.fr`, `rianne.fr`, `xdrs.eu`) : structure certbot cassée (live = copies au lieu de symlinks), dont **2 expirés** (`dev.exanders.fr` 27/04, `xdrs.eu` 08/06). Décision : non traités (projets distincts). Fix éventuel : reconstruire symlinks live→archive, ou réémettre via `certbot certonly`.

---

## Ordre recommandé
1. **Tunnel SSH dev** → **0.1 fermer Postgres** (proprement, testé) → **0.2 rotation**. *(Rouge sécu concret restant.)*
2. **Backups offsite**.
3. **Lot 3 CI**.
4. **Lot 4 tests**.
5. **Lot 5** (signature bailleur + finitions).

## Références
- Déploiement & infra : `docs/deployment.md` · Base : `docs/database-setup.md` · Roadmap produit : `docs/roadmap.md`.
- Clé SOPS : `~/.config/sops/age/keys.txt` (Mac + VPS, hors repo).
