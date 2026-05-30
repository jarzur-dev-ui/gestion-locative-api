# Création de la base de données

Ce document décrit comment provisionner la base PostgreSQL utilisée par `gestion-locative-api`.

## Prérequis

- **PostgreSQL ≥ 14** (testé sur 16). La fonction `gen_random_uuid()` est utilisée pour les IDs ; elle est disponible nativement à partir de PG 13.
- Accès admin (rôle `postgres` ou équivalent) pour créer la base et le rôle applicatif.

## 1. Créer le rôle applicatif

Le backend se connecte avec un rôle **dédié** (pas avec `postgres`). Cela limite les droits et permet une rotation de mot de passe sans impacter d'autres services.

```sql
-- Connecté en tant que superuser
CREATE ROLE gestion_locative_app WITH
  LOGIN
  PASSWORD '<MOT_DE_PASSE_FORT>'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE;
```

> Génère un mot de passe fort, par exemple : `openssl rand -base64 32`.

## 2. Créer la base de données

```sql
CREATE DATABASE gestion_locative
  OWNER gestion_locative_app
  ENCODING 'UTF8'
  LC_COLLATE 'fr_FR.UTF-8'
  LC_CTYPE 'fr_FR.UTF-8'
  TEMPLATE template0;
```

> Si `fr_FR.UTF-8` n'est pas disponible sur le serveur, utilise `C.UTF-8` ou `en_US.UTF-8`.

## 3. Droits sur la base

L'`OWNER` fait que `gestion_locative_app` a tous les droits sur la base et peut créer des tables. Aucune commande `GRANT` supplémentaire n'est nécessaire pour démarrer.

Vérification rapide :

```bash
psql -h <host> -p <port> -U gestion_locative_app -d gestion_locative -c "SELECT current_user, current_database();"
```

## 4. Construire la `DATABASE_URL`

Format attendu par le backend (URI Postgres standard) :

```
postgres://gestion_locative_app:<MOT_DE_PASSE>@<HOST>:<PORT>/gestion_locative
```

Caractères spéciaux dans le mot de passe ? Encode-les en URL (`@` → `%40`, `:` → `%3A`, etc.).

Renseigne cette valeur dans le `.env` du backend :

```bash
DATABASE_URL=postgres://gestion_locative_app:xxxxxxxx@db.zeleph.fr:5432/gestion_locative
```

## 5. Appliquer les migrations

Une fois la `DATABASE_URL` configurée :

```bash
cd gestion-locative-api
pnpm db:migrate
```

Cela exécute toutes les migrations présentes dans `src/db/migrations/` dans l'ordre. À la première exécution sur une base vide, ça crée les tables `users`, `sessions` et le type `user_role`.

Vérification :

```bash
psql ... -c "\dt"
```

Tu dois voir : `users`, `sessions`, `__drizzle_migrations` (la table de tracking de Drizzle).

## 6. Sécurité réseau

- **N'expose pas Postgres sur l'internet public.** Le backend et la base doivent partager un réseau privé (Docker network sur le VPS, ou VPC).
- **TLS** côté Postgres : recommandé en prod. Postgres.js supporte SSL via `?sslmode=require` dans l'URL.
- **Pas le même mot de passe en dev et prod.** Le mot de passe de dev peut être faible ; celui de prod doit être fort et stocké dans un secret manager (ou un fichier `.env` hors git, droits `chmod 600`).

## 7. Backup

Stratégie minimale recommandée pour le serveur de prod :

```bash
# Dump quotidien
pg_dump -h db.zeleph.fr -U gestion_locative_app -d gestion_locative -F c -f /backups/gl_$(date +%F).dump

# Restauration
pg_restore -h db.zeleph.fr -U gestion_locative_app -d gestion_locative_restore /backups/gl_2026-05-30.dump
```

À automatiser via un cron sur le VPS + rotation (garder N derniers jours).

## 8. Pour le développement local (optionnel)

Si tu préfères tester contre une base PostgreSQL locale plutôt qu'une dev distante, le snippet docker-compose minimal serait :

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: gestion_locative_app
      POSTGRES_PASSWORD: dev_password
      POSTGRES_DB: gestion_locative
    ports: ['5432:5432']
    volumes: [pgdata:/var/lib/postgresql/data]
volumes: { pgdata: {} }
```

Puis dans `.env` :
```
DATABASE_URL=postgres://gestion_locative_app:dev_password@localhost:5432/gestion_locative
```

## Récap des actions

| # | Action | Où |
|---|---|---|
| 1 | Créer le rôle `gestion_locative_app` | Serveur PG (en superuser) |
| 2 | Créer la base `gestion_locative` (owner = rôle) | Serveur PG (en superuser) |
| 3 | Vérifier la connexion | Ton poste / le serveur backend |
| 4 | Renseigner `DATABASE_URL` dans `.env` | Repo `gestion-locative-api` |
| 5 | `pnpm db:migrate` | Repo `gestion-locative-api` |
| 6 | Configurer le backup | Serveur (cron + script) |
