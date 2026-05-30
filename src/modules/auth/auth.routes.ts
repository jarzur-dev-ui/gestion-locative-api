import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { recordUserAudit } from '../../lib/audit.js';
import type { AppEnv } from '../../types/app-env.js';
import { authenticateByEmailAndPassword, toPublicUser } from './auth.service.js';
import {
  ErrorResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  UserPublicSchema,
} from './auth.schemas.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  readSessionCookie,
  setSessionCookie,
} from './session.service.js';

const TAG = 'auth';

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: [TAG],
  summary: 'Authentification par email + mot de passe',
  request: {
    body: {
      content: { 'application/json': { schema: LoginRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Session ouverte',
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    401: {
      description: 'Identifiants invalides',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: [TAG],
  summary: 'Fermer la session courante',
  responses: {
    204: { description: 'Session fermée' },
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: [TAG],
  summary: 'Profil utilisateur courant',
  responses: {
    200: {
      description: 'Utilisateur courant',
      content: { 'application/json': { schema: UserPublicSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const authRoutes = new OpenAPIHono<AppEnv>();

authRoutes.openapi(loginRoute, async (c) => {
  const { email, password } = c.req.valid('json');
  const user = await authenticateByEmailAndPassword(email, password);
  const session = await createSession({
    userId: user.id,
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });
  setSessionCookie(c, session.id);
  await recordUserAudit(c, user.id, { action: 'login' });
  return c.json({ user: toPublicUser(user) }, 200);
});

authRoutes.openapi(logoutRoute, async (c) => {
  const token = readSessionCookie(c);
  // On capture l'identité user AVANT de supprimer la session — sinon
  // l'audit ne saurait pas qui s'est déconnecté (le middleware `requireAuth`
  // n'est pas appliqué sur /logout pour rester idempotent côté front).
  const currentUser = c.get('user');
  if (token) {
    await deleteSession(token);
  }
  clearSessionCookie(c);
  if (currentUser) {
    await recordUserAudit(c, currentUser.id, { action: 'logout' });
  }
  return c.body(null, 204);
});

authRoutes.openapi(meRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Non authentifié' }, 401);
  }
  return c.json(toPublicUser(user), 200);
});
