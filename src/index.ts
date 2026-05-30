import { serve } from '@hono/node-server';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';

const app = new OpenAPIHono();

app.use('*', cors({ origin: env.CORS_ORIGIN, credentials: true }));
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
});
