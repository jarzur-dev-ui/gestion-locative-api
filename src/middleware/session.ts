import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/app-env.js';
import { getSessionWithUser, readSessionCookie } from '../modules/auth/session.service.js';

/**
 * Middleware passif : charge la session + l'utilisateur depuis le cookie
 * et les expose via c.get('user') / c.get('session'). Ne refuse jamais.
 * À combiner avec `require-auth` sur les routes protégées.
 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  c.set('session', null);

  const token = readSessionCookie(c);
  if (token) {
    const data = await getSessionWithUser(token);
    if (data) {
      c.set('user', data.user);
      c.set('session', data.session);
    }
  }

  await next();
};
