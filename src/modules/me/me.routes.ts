import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { LeaseListSchema } from '../leases/leases.schemas.js';
import { listForParty } from '../leases/leases.service.js';

const TAG = 'me';

const myLeasesRoute = createRoute({
  method: 'get',
  path: '/leases',
  tags: [TAG],
  summary: 'Liste des baux où l\'utilisateur courant est partie (locataire ou garant)',
  responses: {
    200: {
      description: 'Baux accessibles à l\'utilisateur courant',
      content: { 'application/json': { schema: LeaseListSchema } },
    },
    401: { description: 'Non authentifié' },
  },
});

export const meRoutes = new OpenAPIHono<AppEnv>();
meRoutes.use('*', requireAuth);

meRoutes.openapi(myLeasesRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Non authentifié' });
  }
  // Pour un landlord, on ne renvoie rien depuis ici (il a déjà GET /api/leases qui couvre ses biens).
  // Pour un tenant ou guarantor, on renvoie les baux où il est dans les junctions.
  if (user.role === 'landlord') {
    return c.json([], 200);
  }
  const list = await listForParty(user.id);
  return c.json(list, 200);
});
