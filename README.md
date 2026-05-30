# gestion-locative-api

API REST du projet [gestion-locative](https://github.com/jarzur-dev-ui/gestion-locative) (frontend React) : authentification, persistance des biens / baux / locataires / garants, génération automatique des quittances, stockage des documents.

## Stack

- **Node.js 22** + **TypeScript** (ESM, `NodeNext`)
- **Hono** (web framework) + **@hono/zod-openapi** (spec OpenAPI auto-générée)
- **Drizzle ORM** + **PostgreSQL**
- **Zod** (validation des payloads, types partagés)
- **@node-rs/argon2** (hash mots de passe)
- **pino** (logs structurés)
- **node-cron** (scheduler quittances/avis)
- **nodemailer** (envoi emails)
- **Biome** (lint + format)
- **Vitest** (tests)

## Architecture

```
Frontend  ──REST + OpenAPI──►  API Hono  ──Drizzle──►  PostgreSQL
                                  │
                                  └──Volume Docker──►  Fichiers (PDF, justifs…)
```

## Démarrer en local

Prérequis : Node 22+, pnpm, accès à une base PostgreSQL de dev.

> 📘 Pour provisionner la base de données (rôle, base, droits, `DATABASE_URL`, backup) : voir [`docs/database-setup.md`](./docs/database-setup.md).
> 🗺️ État du projet et reste à faire (front + back) : voir [`docs/roadmap.md`](./docs/roadmap.md).

```bash
cp .env.example .env
# Renseigner DATABASE_URL, COOKIE_SECRET, SMTP_*, etc.

pnpm install
pnpm db:migrate      # applique les migrations sur la base pointée par DATABASE_URL
pnpm dev             # serveur sur http://localhost:3000
```

## Scripts

| Commande | Description |
|---|---|
| `pnpm dev` | Hot-reload via `tsx watch` |
| `pnpm build` | Compile TS → `dist/` |
| `pnpm start` | Lance le build de prod |
| `pnpm db:generate` | Génère une nouvelle migration à partir du schéma Drizzle |
| `pnpm db:migrate` | Applique les migrations en attente |
| `pnpm db:studio` | Ouvre Drizzle Studio (GUI de la BDD) |
| `pnpm lint` | Linter (Biome) |
| `pnpm format` | Formatter (Biome) |
| `pnpm typecheck` | Vérification de types sans build |
| `pnpm test` | Tests Vitest |

## Structure

```
src/
├── index.ts              # bootstrap Hono + montage des routes
├── config/env.ts         # parse process.env via Zod
├── db/
│   ├── client.ts         # pool postgres + instance Drizzle
│   ├── schema/           # une table par fichier
│   └── migrations/       # SQL généré par drizzle-kit
├── modules/              # vertical slices (auth, tenants, leases, documents…)
│   └── auth/
│       ├── auth.routes.ts
│       ├── auth.service.ts
│       └── auth.schemas.ts
├── middleware/           # session, auth, error-handler, cors
├── lib/                  # logger, mailer, crypto
└── scheduler/            # tâches cron (avis d'échéance, rappels)
```

## Spec OpenAPI

L'API expose sa spec à `GET /openapi.json` une fois en route. Le frontend peut générer ses types TS à partir de là (via `openapi-typescript` côté front).
