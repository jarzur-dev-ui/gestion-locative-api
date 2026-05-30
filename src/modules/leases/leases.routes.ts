import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import {
  CreateLeaseSchema,
  LeaseIdParamSchema,
  LeaseListQuerySchema,
  LeaseListSchema,
  LeaseSchema,
  PatchLeaseSchema,
  UpdateLeaseStatusSchema,
} from './leases.schemas.js';
import {
  create,
  getByIdForOwner,
  listByOwner,
  patch,
  remove,
  updateStatus,
} from './leases.service.js';

const TAG = 'leases';

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les baux du bailleur courant',
  request: {
    query: LeaseListQuerySchema,
  },
  responses: {
    200: {
      description: 'Liste des baux',
      content: { 'application/json': { schema: LeaseListSchema } },
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

const createRouteDef = createRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Créer un bail',
  request: {
    body: {
      content: { 'application/json': { schema: CreateLeaseSchema } },
    },
  },
  responses: {
    201: {
      description: 'Bail créé',
      content: { 'application/json': { schema: LeaseSchema } },
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
      description: 'Ressource liée introuvable (propriété)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getOneRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Récupérer un bail par son identifiant',
  request: {
    params: LeaseIdParamSchema,
  },
  responses: {
    200: {
      description: 'Bail',
      content: { 'application/json': { schema: LeaseSchema } },
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
      description: 'Bail introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: [TAG],
  summary: 'Mettre à jour partiellement un bail (JSON Merge Patch, propriété immuable)',
  description:
    'Mise à jour partielle (RFC 7396). Champ absent = inchangé, champ à `null` = effacé (colonnes nullables), champ avec valeur = mis à jour. `propertyId` est immuable. `statusKey` se gère via `PATCH /:id/status`. `tenantIds`/`guarantorIds` absents = inchangés ; présents = remplacement intégral de la M2M.',
  request: {
    params: LeaseIdParamSchema,
    body: {
      content: { 'application/json': { schema: PatchLeaseSchema } },
    },
  },
  responses: {
    200: {
      description: 'Bail mis à jour',
      content: { 'application/json': { schema: LeaseSchema } },
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
      description: 'Bail introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateStatusRoute = createRoute({
  method: 'patch',
  path: '/{id}/status',
  tags: [TAG],
  summary: 'Transitionner le statut d’un bail (draft → active → ended)',
  request: {
    params: LeaseIdParamSchema,
    body: {
      content: { 'application/json': { schema: UpdateLeaseStatusSchema } },
    },
  },
  responses: {
    200: {
      description: 'Bail mis à jour',
      content: { 'application/json': { schema: LeaseSchema } },
    },
    400: {
      description: 'Transition de statut invalide',
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
      description: 'Bail introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Supprimer un bail (uniquement à l’état draft)',
  request: {
    params: LeaseIdParamSchema,
  },
  responses: {
    204: { description: 'Bail supprimé' },
    400: {
      description: 'Bail non supprimable (statut différent de "draft")',
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
      description: 'Bail introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const leasesRoutes = new OpenAPIHono<AppEnv>();

leasesRoutes.use('*', requireAuth);

leasesRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  await next();
});

leasesRoutes.openapi(listRoute, async (c) => {
  const user = c.get('user')!;
  const { status } = c.req.valid('query');
  const rows = await listByOwner(user.id, status);
  return c.json(rows, 200);
});

leasesRoutes.openapi(createRouteDef, async (c) => {
  const user = c.get('user')!;
  const data = c.req.valid('json');
  const row = await create(user.id, data);
  await recordUserAudit(c, user.id, {
    action: 'lease.create',
    entityType: 'lease',
    entityId: row.id,
  });
  return c.json(row, 201);
});

leasesRoutes.openapi(getOneRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await getByIdForOwner(id, user.id);
  return c.json(row, 200);
});

leasesRoutes.openapi(updateRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const row = await patch(id, user.id, data);
  await recordUserAudit(c, user.id, {
    action: 'lease.update',
    entityType: 'lease',
    entityId: row.id,
    payload: { fields: Object.keys(data) },
  });
  return c.json(row, 200);
});

leasesRoutes.openapi(updateStatusRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const { statusKey } = c.req.valid('json');
  // Capture du statut courant AVANT la transition : c'est indispensable pour
  // pouvoir auditer la transition `from → to`. On accepte l'aller-retour DB
  // supplémentaire car ces appels restent rares (changement de statut métier).
  const before = await getByIdForOwner(id, user.id);
  const row = await updateStatus(id, user.id, statusKey);
  await recordUserAudit(c, user.id, {
    action: 'lease.status_change',
    entityType: 'lease',
    entityId: row.id,
    payload: { from: before.statusKey, to: row.statusKey },
  });
  return c.json(row, 200);
});

leasesRoutes.openapi(deleteRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  await remove(id, user.id);
  await recordUserAudit(c, user.id, {
    action: 'lease.delete',
    entityType: 'lease',
    entityId: id,
  });
  return c.body(null, 204);
});
