import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import {
  CreatePropertySchema,
  PropertyIdParamSchema,
  PropertyListSchema,
  PropertySchema,
  UpdatePropertySchema,
} from './properties.schemas.js';
import {
  create,
  getByIdForOwner,
  listByOwner,
  remove,
  toPublicProperty,
  update,
} from './properties.service.js';

const TAG = 'properties';

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les biens immobiliers du bailleur courant',
  responses: {
    200: {
      description: 'Liste des biens immobiliers',
      content: { 'application/json': { schema: PropertyListSchema } },
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
  summary: 'Créer un bien immobilier',
  request: {
    body: {
      content: { 'application/json': { schema: CreatePropertySchema } },
    },
  },
  responses: {
    201: {
      description: 'Bien immobilier créé',
      content: { 'application/json': { schema: PropertySchema } },
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
  },
});

const getOneRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Récupérer un bien immobilier par son id',
  request: {
    params: PropertyIdParamSchema,
  },
  responses: {
    200: {
      description: 'Bien immobilier',
      content: { 'application/json': { schema: PropertySchema } },
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
      description: 'Bien immobilier non trouvé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: [TAG],
  summary: 'Mettre à jour un bien immobilier (remplacement complet)',
  request: {
    params: PropertyIdParamSchema,
    body: {
      content: { 'application/json': { schema: UpdatePropertySchema } },
    },
  },
  responses: {
    200: {
      description: 'Bien immobilier mis à jour',
      content: { 'application/json': { schema: PropertySchema } },
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
      description: 'Bien immobilier non trouvé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Supprimer un bien immobilier',
  request: {
    params: PropertyIdParamSchema,
  },
  responses: {
    204: {
      description: 'Bien immobilier supprimé',
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
      description: 'Bien immobilier non trouvé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const propertiesRoutes = new OpenAPIHono<AppEnv>();

propertiesRoutes.use('*', requireAuth);

propertiesRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  await next();
});

propertiesRoutes.openapi(listRoute, async (c) => {
  const user = c.get('user')!;
  const rows = await listByOwner(user.id);
  return c.json(rows.map(toPublicProperty), 200);
});

propertiesRoutes.openapi(createRouteDef, async (c) => {
  const user = c.get('user')!;
  const data = c.req.valid('json');
  const row = await create(user.id, data);
  return c.json(toPublicProperty(row), 201);
});

propertiesRoutes.openapi(getOneRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await getByIdForOwner(id, user.id);
  return c.json(toPublicProperty(row), 200);
});

propertiesRoutes.openapi(updateRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const row = await update(id, user.id, data);
  return c.json(toPublicProperty(row), 200);
});

propertiesRoutes.openapi(deleteRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  await remove(id, user.id);
  return c.body(null, 204);
});
