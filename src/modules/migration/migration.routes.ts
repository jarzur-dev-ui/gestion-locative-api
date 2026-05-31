import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import { requireRole } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';

import { ImportReportSchema, ImportRequestSchema } from './migration.schemas.js';
import { importLegacy } from './migration.service.js';

const TAG = 'migration';

const importRoute = createRoute({
  method: 'post',
  path: '/import',
  tags: [TAG],
  summary: 'Import one-shot d\'un export legacy localStorage (bailleur + baux)',
  request: {
    body: { content: { 'application/json': { schema: ImportRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Rapport d\'import (counts + warnings)',
      content: { 'application/json': { schema: ImportReportSchema } },
    },
    401: { description: 'Non authentifié' },
    403: { description: 'Accès refusé (landlord uniquement)' },
  },
});

export const migrationRoutes = new OpenAPIHono<AppEnv>();
migrationRoutes.use('*', requireRole('landlord'));

migrationRoutes.openapi(importRoute, async (c) => {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Non authentifié' });

  const body = c.req.valid('json');
  const report = await importLegacy(user.id, body);
  return c.json(report, 200);
});
