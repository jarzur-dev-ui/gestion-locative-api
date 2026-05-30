import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { recordUserAudit } from '../../lib/audit.js';
import type { AppEnv } from '../../types/app-env.js';
import {
  ConfigEntrySchema,
  ConfigKeyParamSchema,
  ConfigMapResponseSchema,
  UpsertConfigSchema,
} from './config.schemas.js';
import { getByKey, listAll, toPublicEntry, upsertByKey } from './config.service.js';
import { validateConfigValue } from './config.validators.js';

const TAG = 'config';

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Récupérer toute la configuration applicative (defaults, listes d\'options i18n…)',
  responses: {
    200: {
      description: 'Map clé/valeur de toute la config (wrapped sous "config")',
      content: { 'application/json': { schema: ConfigMapResponseSchema } },
    },
  },
});

const getOneRoute = createRoute({
  method: 'get',
  path: '/{key}',
  tags: [TAG],
  request: { params: ConfigKeyParamSchema },
  responses: {
    200: {
      description: 'Entrée de config',
      content: { 'application/json': { schema: ConfigEntrySchema } },
    },
    404: { description: 'Clé inconnue' },
  },
});

const upsertRoute = createRoute({
  method: 'put',
  path: '/{key}',
  tags: [TAG],
  request: {
    params: ConfigKeyParamSchema,
    body: { content: { 'application/json': { schema: UpsertConfigSchema } } },
  },
  responses: {
    200: {
      description: 'Entrée upsertée',
      content: { 'application/json': { schema: ConfigEntrySchema } },
    },
    401: { description: 'Non authentifié' },
    403: { description: 'Accès refusé (landlord uniquement)' },
  },
});

export const configRoutes = new OpenAPIHono<AppEnv>();

// GET public : la config sert à rendre les formulaires côté front,
// elle ne contient aucune donnée sensible. Pas d'auth requise.
configRoutes.openapi(listRoute, async (c) => {
  const map = await listAll();
  return c.json({ config: map }, 200);
});

configRoutes.openapi(getOneRoute, async (c) => {
  const { key } = c.req.valid('param');
  const entry = await getByKey(key);
  if (!entry) {
    throw new HTTPException(404, { message: 'Clé inconnue' });
  }
  return c.json(toPublicEntry(entry), 200);
});

// PUT landlord-only : seul un bailleur connecté peut modifier la config
// (utile pour mettre à jour l'IRL ou ajouter des types de biens).
configRoutes.openapi(upsertRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Non authentifié' });
  }
  if (user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  const { key } = c.req.valid('param');
  const body = c.req.valid('json');
  const validation = validateConfigValue(key, body.value);
  if (!validation.ok) {
    throw new HTTPException(400, { message: validation.error, cause: validation.issues });
  }
  // Use validation.value (potentially transformed by Zod) instead of body.value
  const entry = await upsertByKey(key, validation.value, body.description);
  // On évite de logger la valeur brute : certaines clés peuvent contenir
  // des secrets futurs et la valeur précise est de toute façon récupérable
  // par GET /api/config/:key au moment de l'investigation. On garde
  // uniquement la description si elle est présente.
  await recordUserAudit(c, user.id, {
    action: 'config.update',
    entityType: 'config_entry',
    entityId: key,
    payload: { description: body.description },
  });
  return c.json(toPublicEntry(entry), 200);
});
