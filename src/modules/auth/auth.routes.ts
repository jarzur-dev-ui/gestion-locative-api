import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { recordUserAudit } from '../../lib/audit.js';
import type { AppEnv } from '../../types/app-env.js';
import {
  ErrorResponseSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  ResetPasswordRequestSchema,
  ResetPasswordResponseSchema,
  UserPublicSchema,
} from './auth.schemas.js';
import { authenticateByEmailAndPassword, toPublicUser } from './auth.service.js';
import { requestPasswordReset, resetPassword } from './password-reset.service.js';
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

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/forgot-password',
  tags: [TAG],
  summary: 'Demander un lien de réinitialisation de mot de passe',
  request: {
    body: {
      content: { 'application/json': { schema: ForgotPasswordRequestSchema } },
    },
  },
  responses: {
    // Toujours 204, quelle que soit l'existence du compte : anti-énumération.
    204: { description: 'Demande prise en compte (réponse uniforme anti-énumération)' },
  },
});

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/reset-password',
  tags: [TAG],
  summary: "Réinitialiser le mot de passe à partir d'un token",
  request: {
    body: {
      content: { 'application/json': { schema: ResetPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Mot de passe réinitialisé — l'utilisateur doit se reconnecter",
      content: { 'application/json': { schema: ResetPasswordResponseSchema } },
    },
    404: {
      description: 'Lien introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Lien expiré ou déjà utilisé',
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

authRoutes.openapi(forgotPasswordRoute, async (c) => {
  const { email } = c.req.valid('json');
  // Anti-énumération : pas d'audit côté requête. Enregistrer `password.reset_request`
  // ici nécessiterait de résoudre un userId, ce qui révélerait (par sa présence ou
  // son absence) si l'email correspond à un compte. On se limite donc à l'audit
  // `password.reset` côté /reset-password, où le userId est connu sans fuite.
  await requestPasswordReset(email);
  return c.body(null, 204);
});

authRoutes.openapi(resetPasswordRoute, async (c) => {
  const { token, password } = c.req.valid('json');
  const { userId } = await resetPassword({ token, password });
  // On n'ouvre PAS de session : l'utilisateur doit se reconnecter avec son
  // nouveau mot de passe (toutes ses sessions ont été révoquées par le reset).
  await recordUserAudit(c, userId, { action: 'password.reset' });
  return c.json({ ok: true as const }, 200);
});

authRoutes.openapi(meRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Non authentifié' }, 401);
  }
  return c.json(toPublicUser(user), 200);
});
