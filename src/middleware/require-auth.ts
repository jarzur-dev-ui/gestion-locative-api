import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types/app-env.js';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Non authentifié' });
  }
  await next();
};

export function requireRole(
  ...allowed: Array<'landlord' | 'tenant' | 'guarantor'>
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Non authentifié' });
    }
    if (!allowed.includes(user.role)) {
      throw new HTTPException(403, { message: 'Accès refusé' });
    }
    await next();
  };
}
