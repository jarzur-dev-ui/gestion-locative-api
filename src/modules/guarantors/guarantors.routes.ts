import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import {
  CreateGuarantorSchema,
  GuarantorIdParamsSchema,
  GuarantorListQuerySchema,
  GuarantorListSchema,
  GuarantorSchema,
  UpdateGuarantorSchema,
} from './guarantors.schemas.js';
import {
  create,
  getByIdForCreator,
  listByCreator,
  remove,
  toPublicGuarantor,
  update,
} from './guarantors.service.js';

const TAG = 'guarantors';

const listGuarantorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les garants créés par l’utilisateur courant',
  request: {
    query: GuarantorListQuerySchema,
  },
  responses: {
    200: {
      description: 'Liste des garants',
      content: { 'application/json': { schema: GuarantorListSchema } },
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

const createGuarantorRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Créer un garant (personne physique ou organisation)',
  request: {
    body: {
      content: { 'application/json': { schema: CreateGuarantorSchema } },
    },
  },
  responses: {
    201: {
      description: 'Garant créé',
      content: { 'application/json': { schema: GuarantorSchema } },
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

const getGuarantorRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Récupérer un garant par son identifiant',
  request: {
    params: GuarantorIdParamsSchema,
  },
  responses: {
    200: {
      description: 'Garant',
      content: { 'application/json': { schema: GuarantorSchema } },
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
      description: 'Garant introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateGuarantorRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: [TAG],
  summary: 'Mettre à jour un garant (remplacement complet, type immuable)',
  request: {
    params: GuarantorIdParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateGuarantorSchema } },
    },
  },
  responses: {
    200: {
      description: 'Garant mis à jour',
      content: { 'application/json': { schema: GuarantorSchema } },
    },
    400: {
      description: 'Requête invalide (ex. tentative de changer le type)',
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
      description: 'Garant introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteGuarantorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Supprimer un garant',
  request: {
    params: GuarantorIdParamsSchema,
  },
  responses: {
    204: { description: 'Garant supprimé' },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Garant introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const guarantorsRoutes = new OpenAPIHono<AppEnv>();

guarantorsRoutes.use('*', requireAuth);

guarantorsRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  await next();
});

guarantorsRoutes.openapi(listGuarantorsRoute, async (c) => {
  const user = c.get('user')!;
  const { type } = c.req.valid('query');
  const rows = await listByCreator(user.id, type);
  return c.json(rows.map(toPublicGuarantor), 200);
});

guarantorsRoutes.openapi(createGuarantorRoute, async (c) => {
  const user = c.get('user')!;
  const data = c.req.valid('json');
  const row = await create(user.id, data);
  return c.json(toPublicGuarantor(row), 201);
});

guarantorsRoutes.openapi(getGuarantorRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await getByIdForCreator(id, user.id);
  return c.json(toPublicGuarantor(row), 200);
});

guarantorsRoutes.openapi(updateGuarantorRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const row = await update(id, user.id, data);
  return c.json(toPublicGuarantor(row), 200);
});

guarantorsRoutes.openapi(deleteGuarantorRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  await remove(id, user.id);
  return c.body(null, 204);
});
