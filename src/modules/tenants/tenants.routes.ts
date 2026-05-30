import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import {
  CreateTenantSchema,
  PatchTenantSchema,
  TenantIdParamsSchema,
  TenantListSchema,
  TenantSchema,
} from './tenants.schemas.js';
import {
  create,
  deleteTenant,
  getByIdForCreator,
  listByCreator,
  patch,
  toPublicTenant,
} from './tenants.service.js';

const TAG = 'tenants';

const listTenantsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les locataires créés par l’utilisateur courant',
  responses: {
    200: {
      description: 'Liste des locataires',
      content: { 'application/json': { schema: TenantListSchema } },
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

const createTenantRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Créer un locataire',
  request: {
    body: {
      content: { 'application/json': { schema: CreateTenantSchema } },
    },
  },
  responses: {
    201: {
      description: 'Locataire créé',
      content: { 'application/json': { schema: TenantSchema } },
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

const getTenantRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Récupérer un locataire par son identifiant',
  request: {
    params: TenantIdParamsSchema,
  },
  responses: {
    200: {
      description: 'Locataire',
      content: { 'application/json': { schema: TenantSchema } },
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
      description: 'Locataire introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateTenantRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: [TAG],
  summary: 'Mettre à jour partiellement un locataire (JSON Merge Patch)',
  description:
    'Mise à jour partielle (RFC 7396). Champ absent = inchangé, champ à `null` = effacé (colonnes nullables seulement), champ avec valeur = mis à jour.',
  request: {
    params: TenantIdParamsSchema,
    body: {
      content: { 'application/json': { schema: PatchTenantSchema } },
    },
  },
  responses: {
    200: {
      description: 'Locataire mis à jour',
      content: { 'application/json': { schema: TenantSchema } },
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
      description: 'Locataire introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteTenantRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Supprimer un locataire',
  request: {
    params: TenantIdParamsSchema,
  },
  responses: {
    204: { description: 'Locataire supprimé' },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Locataire introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const tenantsRoutes = new OpenAPIHono<AppEnv>();

tenantsRoutes.use('*', requireAuth);

tenantsRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  await next();
});

tenantsRoutes.openapi(listTenantsRoute, async (c) => {
  const user = c.get('user')!;
  const rows = await listByCreator(user.id);
  return c.json(rows.map(toPublicTenant), 200);
});

tenantsRoutes.openapi(createTenantRoute, async (c) => {
  const user = c.get('user')!;
  const data = c.req.valid('json');
  const tenant = await create(user.id, data);
  await recordUserAudit(c, user.id, {
    action: 'tenant.create',
    entityType: 'tenant',
    entityId: tenant.id,
  });
  return c.json(toPublicTenant(tenant), 201);
});

tenantsRoutes.openapi(getTenantRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const tenant = await getByIdForCreator(id, user.id);
  return c.json(toPublicTenant(tenant), 200);
});

tenantsRoutes.openapi(updateTenantRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const tenant = await patch(id, user.id, data);
  await recordUserAudit(c, user.id, {
    action: 'tenant.update',
    entityType: 'tenant',
    entityId: tenant.id,
    payload: { fields: Object.keys(data) },
  });
  return c.json(toPublicTenant(tenant), 200);
});

tenantsRoutes.openapi(deleteTenantRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  await deleteTenant(id, user.id);
  await recordUserAudit(c, user.id, {
    action: 'tenant.delete',
    entityType: 'tenant',
    entityId: id,
  });
  return c.body(null, 204);
});
