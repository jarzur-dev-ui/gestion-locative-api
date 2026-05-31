# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────────────────────────
# gestion-locative-api — Dockerfile multi-stage
#
# Particularité : Puppeteer (génération PDF des quittances) nécessite Chromium.
# On utilise l'image officielle puppeteer qui embarque déjà Chromium + libs.
# Alternative envisagée et rejetée pour V1 : installer Chromium séparément sur
# une base node:22-bookworm-slim — économie ~150 Mo mais plus fragile à maintenir.
# ──────────────────────────────────────────────────────────────────────────────

# ─── Stage 1 — deps : install des dépendances avec pnpm + Chromium auto-DL ───
FROM node:22-bookworm-slim AS deps

# Installer Chromium + dépendances système requises par Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libnss3 \
    libxss1 \
    libxshmfence1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Empêche Puppeteer de re-télécharger Chromium (on utilise celui du système)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Active corepack pour avoir pnpm à la bonne version (depuis packageManager du package.json)
RUN corepack enable

# Copie les manifests d'abord pour bénéficier du cache Docker
COPY package.json pnpm-lock.yaml ./

# Install avec lockfile strict (pas de mise à jour silencieuse en CI)
RUN pnpm install --frozen-lockfile

# ─── Stage 2 — build : compile TypeScript en JS via tsc ───
FROM deps AS build
COPY . .
RUN pnpm build

# ─── Stage 3 — runtime : image finale minimale, prod-only deps ───
FROM node:22-bookworm-slim AS runtime

# Mêmes dépendances système Chromium que la stage deps (pour Puppeteer en runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libnss3 \
    libxss1 \
    libxshmfence1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=3000

WORKDIR /app

# Crée un utilisateur non-root pour le runtime (sécurité)
# Le UID 1001 évite les conflits avec node:* qui utilise 1000.
RUN groupadd --system --gid 1001 nodeapp && \
    useradd --system --uid 1001 --gid nodeapp --shell /bin/false --create-home nodeapp

# Active corepack pour pnpm
RUN corepack enable

# Copie les manifests et installe SEULEMENT les prod deps
COPY --chown=nodeapp:nodeapp package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copie le build TypeScript compilé + les migrations Drizzle (consommées au runtime)
COPY --from=build --chown=nodeapp:nodeapp /app/dist ./dist
COPY --from=build --chown=nodeapp:nodeapp /app/src/db/migrations ./src/db/migrations
COPY --from=build --chown=nodeapp:nodeapp /app/drizzle.config.ts ./drizzle.config.ts

# Le volume pour les documents uploadés (mounté côté docker-compose)
RUN mkdir -p /var/lib/gestion-locative/files && \
    chown -R nodeapp:nodeapp /var/lib/gestion-locative

USER nodeapp

EXPOSE 3000

# Healthcheck Docker — Docker se base dessus pour les restart policies et l'orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
