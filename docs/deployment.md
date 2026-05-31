# Déploiement prod

Cible : VPS `zeleph.fr` (Ubuntu 22.04, Docker + nginx + certbot + Postgres déjà en place dans `/root/persistent/`).

## Architecture cible

```
Internet
  │
  ▼
nginx (host) — gère HTTPS via certbot
  │
  ├── gestion-locative.zeleph.fr  → static (front, hébergement OVH)
  └── api.gestion-locative.zeleph.fr → reverse_proxy → 127.0.0.1:3000
                                                          │
                                                          ▼
                                                  container gestion-locative-api
                                                          │
                                                          ├─→ host.docker.internal:5432
                                                          │   (Postgres host)
                                                          ├─→ volume gestion-locative-files
                                                          │   (uploads PDFs/justifs)
                                                          └─→ ssl0.ovh.net:587 (SMTP)
```

## Prérequis (à valider une fois)

### 1. DNS

Sous-domaine OVH `api.gestion-locative.zeleph.fr` → A → `178.32.75.195` (IP du VPS).

Vérification :
```bash
dig +short api.gestion-locative.zeleph.fr A
# doit renvoyer 178.32.75.195
```

### 2. Postgres : créer la base de prod

Sur le VPS :
```bash
sudo -u postgres psql <<SQL
CREATE ROLE gestionlocative_prod WITH LOGIN PASSWORD '<mot-de-passe-fort-prod>';
CREATE DATABASE gestionlocative_prod OWNER gestionlocative_prod ENCODING 'UTF8';
SQL
```

> Garde le dev (`gestionlocative_dev`) séparé.

### 3. SMTP `noreply@zeleph.fr`

Déjà créé côté OVH (visible dans le manager > Emails). Récupère/reset le mot de passe.

## Procédure de premier déploiement

### Sur le VPS (en root)

```bash
mkdir -p /root/persistent/gestion-locative-api
cd /root/persistent/gestion-locative-api
```

Cloner le repo (ou git pull si déjà cloné) :
```bash
git clone git@gitlab.exanders.fr:infrajo/gestion-locative-api.git .
```

Créer le `.env` à partir de `.env.prod.example` :
```bash
cp .env.prod.example .env
# Éditer .env et renseigner :
#   - DATABASE_URL (utilise gestionlocative_prod, pas dev)
#   - COOKIE_SECRET (openssl rand -base64 48)
#   - SMTP_PASSWORD (mot de passe noreply@zeleph.fr)
chmod 600 .env
```

Build + start :
```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Vérif healthcheck :
```bash
docker compose -f docker-compose.prod.yml ps
# STATUS doit afficher "healthy" après ~15s
curl -i http://127.0.0.1:3000/api/health
# HTTP 200 + JSON {"status":"ok",...}
```

Appliquer les migrations Drizzle (1ère fois uniquement) :
```bash
docker compose -f docker-compose.prod.yml exec api pnpm db:migrate
```

Bootstrap du landlord :
```bash
docker compose -f docker-compose.prod.yml exec api pnpm create-user jonathan@zeleph.fr <mdp> landlord
```

### Config nginx

Ajouter le server block sur le VPS :

```nginx
# /root/persistent/nginx/conf.d/api.gestion-locative.zeleph.fr.conf
server {
    listen 80;
    server_name api.gestion-locative.zeleph.fr;
    # certbot redirigera vers HTTPS après installation du certif
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.gestion-locative.zeleph.fr;

    ssl_certificate     /etc/letsencrypt/live/api.gestion-locative.zeleph.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.gestion-locative.zeleph.fr/privkey.pem;

    # Limites taille upload (uploads documents PDF/images, max 20 Mo côté back)
    client_max_body_size 25M;

    # Headers de sécurité
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
```

Obtenir le certif Let's Encrypt :
```bash
certbot certonly --webroot -w /var/www/letsencrypt -d api.gestion-locative.zeleph.fr
# OU si nginx est dockerisé : certbot --nginx -d api.gestion-locative.zeleph.fr
```

Reload nginx :
```bash
nginx -t && nginx -s reload  # ou systemctl reload nginx
```

### Vérification end-to-end

```bash
curl -i https://api.gestion-locative.zeleph.fr/api/health
# HTTP 200 + JSON ok
```

## Procédure de mise à jour

```bash
cd /root/persistent/gestion-locative-api
git pull origin main
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
# Si nouvelle migration :
docker compose -f docker-compose.prod.yml exec api pnpm db:migrate
```

## Backups

### Postgres (cron quotidien)

```bash
# /etc/cron.daily/gl-pg-backup
#!/bin/bash
TS=$(date +%F)
DUMP=/root/persistent/postgresql/backups/gestionlocative_prod_${TS}.dump
mkdir -p /root/persistent/postgresql/backups
sudo -u postgres pg_dump -F c -f $DUMP gestionlocative_prod
# Garde 30 derniers
find /root/persistent/postgresql/backups -name 'gestionlocative_prod_*.dump' -mtime +30 -delete
```

### Volume documents (cron hebdo)

```bash
# /etc/cron.weekly/gl-files-backup
#!/bin/bash
TS=$(date +%F)
tar czf /root/persistent/backups/gl-files-${TS}.tar.gz \
    $(docker volume inspect gestion-locative-files --format '{{ .Mountpoint }}')
find /root/persistent/backups -name 'gl-files-*.tar.gz' -mtime +90 -delete
```

## Rollback

Si une mise à jour casse :
```bash
cd /root/persistent/gestion-locative-api
git log --oneline | head -5  # repère le dernier commit qui marchait
git checkout <sha-précédent>
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
# Si la migration est rétro-incompatible, restaurer un dump :
pg_restore -d gestionlocative_prod /root/persistent/postgresql/backups/<dump>.dump
```

## Monitoring

- **Logs** : `docker compose -f docker-compose.prod.yml logs -f api`
- **Healthcheck** : `docker inspect gestion-locative-api --format '{{json .State.Health}}' | jq`
- **Espace disque volume** : `du -sh /var/lib/docker/volumes/gestion-locative-files`
