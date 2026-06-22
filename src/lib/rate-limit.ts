import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import type { AppEnv } from '../types/app-env.js';

/**
 * Rate limiting applicatif (anti brute-force / anti DoS sur les routes
 * sensibles).
 *
 * ─── Résolution de l'IP cliente ──────────────────────────────────────────
 * L'API tourne derrière UN reverse-proxy (nginx/traefik sur le VPS) qui ajoute
 * l'IP cliente réelle en fin de chaîne `X-Forwarded-For`. On NE prend donc PAS
 * aveuglément l'entrée la plus à gauche (trivialement spoofable par le client :
 * il suffit d'envoyer son propre header `X-Forwarded-For` pour usurper une IP
 * et contourner le bucket). On prend l'entrée la plus à DROITE — celle que
 * notre proxy de confiance a effectivement observée et ajoutée.
 *
 * Si `X-Forwarded-For` est absent (appel direct, dev local), on retombe sur
 * l'adresse de la connexion TCP via `getConnInfo`.
 *
 * Hypothèse : exactement un hop de proxy de confiance. Si l'on ajoutait un CDN
 * ou un second proxy devant, il faudrait remonter de N entrées (TRUSTED_HOPS).
 */
const TRUSTED_HOPS = 1;

export function resolveClientIp(c: Context<AppEnv>): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length > 0) {
      // On remonte de `TRUSTED_HOPS` depuis la fin : l'entrée ajoutée par notre
      // proxy de confiance (non falsifiable par le client).
      const idx = Math.max(0, parts.length - TRUSTED_HOPS);
      const ip = parts[idx];
      if (ip) {
        return ip;
      }
    }
  }

  // Fallback : adresse de la socket TCP (pas de proxy devant).
  const info = getConnInfo(c);
  return info.remote.address ?? 'unknown';
}

function keyByIp(c: Context<AppEnv>): string {
  return resolveClientIp(c);
}

const MINUTE_MS = 60 * 1000;

/**
 * Limiteur global : garde-fou large contre l'abus généralisé. 100 req/min/IP
 * — confortable pour un usage normal (un seul bailleur + ses locataires), mais
 * coupe un scan/scrape agressif.
 */
export const globalRateLimiter = rateLimiter<AppEnv>({
  windowMs: MINUTE_MS,
  limit: 100,
  standardHeaders: 'draft-6',
  keyGenerator: keyByIp,
  message: { error: 'Trop de requêtes, réessayez dans une minute.' },
});

/**
 * Limiteur strict pour les routes non authentifiées et sensibles (login,
 * mot de passe oublié/reset, acceptation d'invitation, téléchargement de
 * partage public). 10 req/min/IP : un humain légitime ne dépasse jamais ce
 * volume, mais ça étrangle un brute-force de credentials ou de tokens.
 */
export const sensitiveRateLimiter = rateLimiter<AppEnv>({
  windowMs: MINUTE_MS,
  limit: 10,
  standardHeaders: 'draft-6',
  keyGenerator: keyByIp,
  message: { error: 'Trop de tentatives, réessayez dans une minute.' },
});
