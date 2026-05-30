import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import { toPublicUser } from '../auth/auth.service.js';
import { createSession, setSessionCookie } from '../auth/session.service.js';
import {
  AcceptInvitationSchema,
  AcceptedInvitationResponseSchema,
  CreateInvitationSchema,
  InvitationCreatedResponseSchema,
} from './invitations.schemas.js';
import { acceptInvitation, createInvitation } from './invitations.service.js';

const TAG = 'invitations';

const createInvitationRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Créer une invitation pour un locataire ou un garant',
  request: {
    body: {
      content: { 'application/json': { schema: CreateInvitationSchema } },
    },
  },
  responses: {
    201: {
      description: 'Invitation créée — email envoyé (stub en V1)',
      content: { 'application/json': { schema: InvitationCreatedResponseSchema } },
    },
    400: {
      description: 'Données invalides (ex: email absent sur la cible)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Cible introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Compte déjà créé pour cette cible',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const acceptInvitationRoute = createRoute({
  method: 'post',
  path: '/accept',
  tags: [TAG],
  summary: "Accepter une invitation : crée le compte et ouvre la session",
  request: {
    body: {
      content: { 'application/json': { schema: AcceptInvitationSchema } },
    },
  },
  responses: {
    200: {
      description: 'Compte créé, session ouverte',
      content: { 'application/json': { schema: AcceptedInvitationResponseSchema } },
    },
    404: {
      description: 'Invitation introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Un compte avec cet email existe déjà',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Invitation expirée ou déjà utilisée',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const invitationsRoutes = new OpenAPIHono<AppEnv>();

// Endpoint public d'acceptation : on l'enregistre AVANT les middlewares d'auth.
// `c.get('user')` y reste null car aucun cookie de session n'est attendu.
invitationsRoutes.openapi(acceptInvitationRoute, async (c) => {
  const { token, password } = c.req.valid('json');
  const { user, targetType, targetId } = await acceptInvitation({ token, password });

  // La session est créée APRÈS la transaction d'acceptation : on évite ainsi
  // qu'un échec d'insertion de session ne rollback la création de compte
  // (l'utilisateur pourrait simplement se logger ensuite).
  const session = await createSession({
    userId: user.id,
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });
  setSessionCookie(c, session.id);

  // Audit : l'acteur est le user fraîchement créé (pas le bailleur qui a
  // invité). On enregistre la cible métier dans le payload pour pouvoir
  // remonter le lien invitation → entité côté investigation.
  await recordUserAudit(c, user.id, {
    action: 'invitation.accept',
    entityType: 'user',
    entityId: user.id,
    payload: { targetType, targetId },
  });

  return c.json({ user: toPublicUser(user) }, 200);
});

// Endpoint protégé : seul un `landlord` peut créer une invitation.
invitationsRoutes.use('/', requireAuth);
invitationsRoutes.use('/', requireRole('landlord'));

invitationsRoutes.openapi(createInvitationRoute, async (c) => {
  const user = c.get('user');
  // `requireAuth` garantit user != null, mais TS ne le sait pas via Variables.
  if (!user) {
    return c.json({ error: 'Non authentifié' }, 401);
  }
  const { targetType, targetId } = c.req.valid('json');

  const invitation = await createInvitation({
    currentUserId: user.id,
    targetType,
    targetId,
  });

  // On audite la création — l'`entityId` est volontairement tronqué aux 12
  // premiers caractères du token : suffisant pour corréler côté investigation
  // sans permettre d'usurper l'invitation depuis les logs.
  await recordUserAudit(c, user.id, {
    action: 'invitation.create',
    entityType: 'invitation',
    entityId: invitation.token.slice(0, 12),
    payload: { targetType, targetId },
  });

  return c.json(
    {
      token: invitation.token,
      expiresAt: invitation.expiresAt.toISOString(),
    },
    201,
  );
});
