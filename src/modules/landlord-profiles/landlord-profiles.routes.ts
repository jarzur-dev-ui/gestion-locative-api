import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import { LandlordProfileSchema, UpsertLandlordProfileSchema } from './landlord-profiles.schemas.js';
import {
  getByUserId,
  toPublicLandlordProfile,
  upsertByUserId,
} from './landlord-profiles.service.js';

const TAG = 'landlord-profiles';

const getProfileRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Récupérer le profil bailleur courant',
  responses: {
    200: {
      description: 'Profil bailleur',
      content: { 'application/json': { schema: LandlordProfileSchema } },
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
      description: 'Profil bailleur non trouvé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const upsertProfileRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [TAG],
  summary: 'Créer ou mettre à jour le profil bailleur courant',
  request: {
    body: {
      content: { 'application/json': { schema: UpsertLandlordProfileSchema } },
    },
  },
  responses: {
    200: {
      description: 'Profil bailleur mis à jour',
      content: { 'application/json': { schema: LandlordProfileSchema } },
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

export const landlordProfilesRoutes = new OpenAPIHono<AppEnv>();

landlordProfilesRoutes.use('*', requireAuth);

landlordProfilesRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  await next();
});

landlordProfilesRoutes.openapi(getProfileRoute, async (c) => {
  const user = c.get('user')!;
  const profile = await getByUserId(user.id);
  if (!profile) {
    return c.json({ error: 'Profil bailleur non trouvé' }, 404);
  }
  return c.json(toPublicLandlordProfile(profile), 200);
});

landlordProfilesRoutes.openapi(upsertProfileRoute, async (c) => {
  const user = c.get('user')!;
  const data = c.req.valid('json');
  const profile = await upsertByUserId(user.id, data);
  await recordUserAudit(c, user.id, {
    action: 'landlord_profile.update',
    entityType: 'landlord_profile',
    entityId: user.id,
  });
  return c.json(toPublicLandlordProfile(profile), 200);
});
