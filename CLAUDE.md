# CLAUDE.md — gestion-locative-api

API REST de gestion locative (bailleur particulier) : auth, biens, baux, locataires, garants,
quittances/avis d'échéance (PDF), documents et partages publics.
**Stack** : Hono + `@hono/zod-openapi`, Drizzle ORM (driver `postgres.js`), argon2 (`@node-rs/argon2`),
nodemailer, puppeteer (PDF), node-cron, pino, vitest, biome. **ESM** (imports en `.js`). pnpm. Node ≥ 22.

## Quick start

```bash
CI=true pnpm install
pnpm dev            # tsx watch src/index.ts → http://localhost:3000 (+ /openapi.json)
pnpm db:migrate     # applique les migrations Drizzle sur DATABASE_URL
```

### ⚠️ GOTCHA — pnpm en shell non-TTY
Dans cet environnement, `pnpm <cmd>` **avorte en shell non interactif** (non-TTY).
Préfixer par `CI=true` **et** appeler les binaires directement :

```bash
CI=true pnpm install
node_modules/.bin/tsc --noEmit          # typecheck (verif)
node_modules/.bin/vitest run            # tests (verif)
node_modules/.bin/biome check src       # lint (verif)
node_modules/.bin/drizzle-kit generate  # nouvelle migration depuis le schéma
```

## Architecture (résumé)

**Vertical slices** sous `src/modules/<name>/` : `<name>.routes.ts` (handlers fins OpenAPI),
`<name>.service.ts` (logique métier + accès DB), `<name>.schemas.ts` (Zod request/response).
Montage des routes dans `src/index.ts`. Détails → `docs/architecture.md`.

**Multi-tenant par propriété (ownership)** : pas de table « organisation ». Chaque ressource porte
`ownerUserId` (biens) ou `createdByUserId` (locataires, garants, …). Le service filtre **dans la
requête SQL** par l'id de session (`getByIdForOwner` / `getByIdForCreator`, double filtre `id + owner`
sur UPDATE/DELETE). Voir `src/modules/properties/properties.service.ts` comme référence.

## Conventions clés

- **ESM** : tous les imports relatifs finissent en `.js` (même pour du `.ts`).
- **Argent = entiers en centimes** (`*_cents`, `integer`), jamais de float. Formatage € uniquement à
  l'affichage (`formatEur` dans `src/lib/pdf-renderer.ts`).
- **Dates** : colonnes `timestamptz` (`withTimezone: true`) ; `period_month` = `date` au 1er du mois.
- **Ownership vient de la session, jamais du body** : `c.get('user').id` alimente `ownerUserId` /
  `createdByUserId`. Ne jamais accepter ces colonnes depuis le payload.
- **Auth** : middleware passif `session` (charge user/session depuis cookie, ne refuse jamais) +
  `require-auth` / `requireRole(...)` sur les routes protégées. Erreurs via `HTTPException`.
- **Audit best-effort** : `recordUserAudit` / `recordSchedulerAudit` ne doivent jamais faire échouer
  la requête métier.

## ⚠️ GOTCHAS opérationnels (introuvables dans le code)

- **Secrets = SOPS/age** : chiffrés dans `secrets/prod.env` (règle dans `.sops.yaml`). Clé **privée**
  hors repo : `~/.config/sops/age/keys.txt`, et `SOPS_AGE_KEY_FILE` exporté dans le `~/.zshrc` du Mac.
  Éditer avec `sops secrets/prod.env`. Le fichier chiffré est safe à committer.
- **Git — deux remotes de push** : GitLab `gitlab.exanders.fr:infrajo/gestion-locative-api` +
  GitHub `jarzur-dev-ui/gestion-locative-api`. `git push origin main` pousse **aux deux**.
  Branche par défaut : `main`.
- **Déploiement manuel (pas de CI pour l'API)** : VPS, topologie DB, procédure deploy/migration →
  `docs/deployment.md` et `docs/audit-plan.md` §0 (contexte projet complet).

## Knowledge map

| Besoin de savoir sur… | Fiche |
|---|---|
| Pattern vertical-slice, middleware, scheduler, lib/ | `docs/architecture.md` |
| Un module précis (endpoints, règles métier) | `docs/modules.md` |
| Schéma DB, money/dates, relations, migrations | `docs/data-model.md` |
| Auth, sessions, rate limit, uploads, secrets, audit | `docs/security.md` |
| Provisionner la base (rôle, droits, backup) | `docs/database-setup.md` |
| Déploiement VPS, Docker, nginx, certbot | `docs/deployment.md` |
| Contexte projet, infra, reste de l'audit | `docs/audit-plan.md` |
| État du projet / reste à faire (front+back) | `docs/roadmap.md` |

## Maintenance de la doc

Après un commit avec un changement **structurel** (endpoint public ajouté/retiré, nouveau module ou
type public, signature d'API modifiée, nouvelle règle métier/invariant, changement d'architecture),
**suggérer `/dev:doc-sync`** (skill du marketplace perso `claude-skills`) pour mettre à jour CLAUDE.md + `docs/`.
**Ne PAS** mettre à jour la doc pour : CSS/libellés/i18n, bugfix préservant le comportement, refacto
interne, bump de dépendances, ajout de tests, lint/format.
