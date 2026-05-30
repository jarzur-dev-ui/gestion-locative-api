import { serve } from '@hono/node-server';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { sessionMiddleware } from './middleware/session.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { documentSharesRoutes } from './modules/document-shares/document-shares.routes.js';
import { sharePublicRoutes } from './modules/document-shares/share-public.routes.js';
import { documentTypesRoutes, documentsRoutes } from './modules/documents/documents.routes.js';
import { guarantorsRoutes } from './modules/guarantors/guarantors.routes.js';
import { invitationsRoutes } from './modules/invitations/invitations.routes.js';
import { landlordProfilesRoutes } from './modules/landlord-profiles/landlord-profiles.routes.js';
import { leasesRoutes } from './modules/leases/leases.routes.js';
import { propertiesRoutes } from './modules/properties/properties.routes.js';
import { rentPeriodsRoutes } from './modules/rent-periods/rent-periods.routes.js';
import { tenantsRoutes } from './modules/tenants/tenants.routes.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';
import type { AppEnv } from './types/app-env.js';

const app = new OpenAPIHono<AppEnv>();

app.use('*', cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use('*', sessionMiddleware);
app.onError(errorHandler);

const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    timestamp: z.string().datetime(),
    uptime: z.number(),
  })
  .openapi('HealthResponse');

const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['system'],
  summary: 'Healthcheck',
  responses: {
    200: {
      description: 'Le service est en route',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
});

app.openapi(healthRoute, (c) =>
  c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }),
);

app.route('/api/auth', authRoutes);
app.route('/api/landlord-profile', landlordProfilesRoutes);
app.route('/api/properties', propertiesRoutes);
app.route('/api/tenants', tenantsRoutes);
app.route('/api/guarantors', guarantorsRoutes);
app.route('/api/leases', leasesRoutes);
app.route('/api/invitations', invitationsRoutes);
app.route('/api/documents', documentsRoutes);
app.route('/api/document-types', documentTypesRoutes);
app.route('/api/document-shares', documentSharesRoutes);
app.route('/api/rent-periods', rentPeriodsRoutes);
app.route('/share', sharePublicRoutes);

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'gestion-locative API',
    version: '0.0.0',
    description: 'API de gestion locative — baux, locataires, garants, quittances, documents',
  },
  servers: [{ url: `http://localhost:${env.PORT}`, description: 'Local' }],
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(`🚀 API démarrée sur http://localhost:${info.port}`);
  logger.info(`📘 Spec OpenAPI : http://localhost:${info.port}/openapi.json`);
  startScheduler();
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutdown initié');
  await stopScheduler();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
