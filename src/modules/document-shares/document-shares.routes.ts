import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import {
  CreateShareSchema,
  ShareCreatedResponseSchema,
  ShareListQuerySchema,
  ShareListSchema,
  ShareTokenParamSchema,
} from './document-shares.schemas.js';
import {
  createShare,
  listSharesByCreator,
  revokeShare,
  shareUrlFor,
  toPublicShare,
} from './document-shares.service.js';

const TAG = 'document-shares';

const createShareRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Créer un lien de partage public pour un document',
  request: {
    body: {
      content: { 'application/json': { schema: CreateShareSchema } },
    },
  },
  responses: {
    201: {
      description: 'Partage créé',
      content: { 'application/json': { schema: ShareCreatedResponseSchema } },
    },
    400: {
      description: 'Requête invalide',
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
      description: 'Document introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listSharesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les partages créés par le bailleur courant',
  request: {
    query: ShareListQuerySchema,
  },
  responses: {
    200: {
      description: 'Liste des partages',
      content: { 'application/json': { schema: ShareListSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const revokeShareRoute = createRoute({
  method: 'delete',
  path: '/{token}',
  tags: [TAG],
  summary: 'Révoquer un partage existant',
  request: {
    params: ShareTokenParamSchema,
  },
  responses: {
    204: { description: 'Partage révoqué' },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Partage introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const documentSharesRoutes = new OpenAPIHono<AppEnv>();

// Endpoints privés : auth + rôle landlord obligatoires. En V1, seul le
// bailleur peut créer/gérer des partages — un élargissement aux
// tenants/guarantors pourra être ajouté plus tard.
documentSharesRoutes.use('*', requireAuth);
documentSharesRoutes.use('*', requireRole('landlord'));

documentSharesRoutes.openapi(createShareRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    // Défensif : `requireAuth` garantit user != null, mais TS ne le sait
    // pas via le type Variables.
    throw new HTTPException(401, { message: 'Non authentifié' });
  }
  const { documentId, ttlDays } = c.req.valid('json');
  const share = await createShare({
    currentUserId: user.id,
    documentId,
    ttlDays,
  });
  // On audite la création — l'`entityId` est le token tronqué (mêmes raisons
  // de sécurité que pour les invitations : on garde une trace corrélable
  // sans permettre la reconstruction du token complet depuis les logs).
  await recordUserAudit(c, user.id, {
    action: 'document_share.create',
    entityType: 'document_share',
    entityId: share.token.slice(0, 12),
    payload: { documentId, ttlDays },
  });
  return c.json(
    {
      token: share.token,
      expiresAt: share.expiresAt.toISOString(),
      shareUrl: shareUrlFor(share.token),
    },
    201,
  );
});

documentSharesRoutes.openapi(listSharesRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Non authentifié' });
  }
  const { documentId } = c.req.valid('query');
  const rows = await listSharesByCreator(user.id, documentId);
  return c.json(rows.map(toPublicShare), 200);
});

documentSharesRoutes.openapi(revokeShareRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Non authentifié' });
  }
  const { token } = c.req.valid('param');
  await revokeShare(token, user.id);
  await recordUserAudit(c, user.id, {
    action: 'document_share.revoke',
    entityType: 'document_share',
    entityId: token.slice(0, 12),
  });
  return c.body(null, 204);
});
