import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import {
  RentPeriodIdParamSchema,
  RentPeriodListQuerySchema,
  RentPeriodListSchema,
  RentPeriodSchema,
  UpdateRentPeriodSchema,
} from './rent-periods.schemas.js';
import {
  getByIdForOwner,
  listForOwner,
  markPaid,
  markUnpaid,
  sendNotice,
  updateAdjustments,
} from './rent-periods.service.js';

const TAG = 'rent-periods';

// --------------------------------------------------------------------------
// Route definitions
// --------------------------------------------------------------------------

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les périodes de loyer du bailleur courant',
  request: {
    query: RentPeriodListQuerySchema,
  },
  responses: {
    200: {
      description: 'Liste des périodes',
      content: { 'application/json': { schema: RentPeriodListSchema } },
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
  summary: 'Récupérer une période par son identifiant',
  request: {
    params: RentPeriodIdParamSchema,
  },
  responses: {
    200: {
      description: 'Période de loyer',
      content: { 'application/json': { schema: RentPeriodSchema } },
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
      description: 'Période introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: [TAG],
  summary: 'Mettre à jour les ajustements d’une période (statut "draft" uniquement)',
  request: {
    params: RentPeriodIdParamSchema,
    body: {
      content: { 'application/json': { schema: UpdateRentPeriodSchema } },
    },
  },
  responses: {
    200: {
      description: 'Période mise à jour',
      content: { 'application/json': { schema: RentPeriodSchema } },
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
      description: 'Période introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'État incompatible (statut différent de "draft")',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const sendNoticeRoute = createRoute({
  method: 'post',
  path: '/{id}/send-notice',
  tags: [TAG],
  summary: 'Émettre l’avis d’échéance et l’envoyer aux locataires',
  request: {
    params: RentPeriodIdParamSchema,
  },
  responses: {
    200: {
      description: 'Avis émis',
      content: { 'application/json': { schema: RentPeriodSchema } },
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
      description: 'Période introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'État incompatible (statut différent de "draft")',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const markPaidRoute = createRoute({
  method: 'post',
  path: '/{id}/mark-paid',
  tags: [TAG],
  summary: 'Marquer la période comme payée et émettre la quittance',
  request: {
    params: RentPeriodIdParamSchema,
  },
  responses: {
    200: {
      description: 'Période marquée payée',
      content: { 'application/json': { schema: RentPeriodSchema } },
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
      description: 'Période introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Transition invalide',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const markUnpaidRoute = createRoute({
  method: 'post',
  path: '/{id}/mark-unpaid',
  tags: [TAG],
  summary: 'Annuler le paiement (fenêtre 24 h)',
  request: {
    params: RentPeriodIdParamSchema,
  },
  responses: {
    200: {
      description: 'Période revenue à l’état précédent',
      content: { 'application/json': { schema: RentPeriodSchema } },
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
      description: 'Période introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'État incompatible (statut différent de "paid")',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Fenêtre d’annulation dépassée (24 h)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export const rentPeriodsRoutes = new OpenAPIHono<AppEnv>();

rentPeriodsRoutes.use('*', requireAuth);

// Landlord-only V1 — locataires/garants n'accèdent aux infos de paiement que
// via les documents (avis, quittance) déjà servis par le module documents.
rentPeriodsRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  await next();
});

rentPeriodsRoutes.openapi(listRoute, async (c) => {
  const user = c.get('user')!;
  const filters = c.req.valid('query');
  const rows = await listForOwner(user.id, filters);
  return c.json(rows, 200);
});

rentPeriodsRoutes.openapi(getOneRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await getByIdForOwner(id, user.id);
  return c.json(row, 200);
});

rentPeriodsRoutes.openapi(updateRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const row = await updateAdjustments(id, user.id, data);
  return c.json(row, 200);
});

rentPeriodsRoutes.openapi(sendNoticeRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await sendNotice(id, user.id);
  await recordUserAudit(c, user.id, {
    action: 'rent_period.send_notice',
    entityType: 'rent_period',
    entityId: row.id,
    payload: { periodMonth: row.periodMonth, leaseId: row.leaseId },
  });
  return c.json(row, 200);
});

rentPeriodsRoutes.openapi(markPaidRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await markPaid(id, user.id);
  await recordUserAudit(c, user.id, {
    action: 'rent_period.mark_paid',
    entityType: 'rent_period',
    entityId: row.id,
  });
  return c.json(row, 200);
});

rentPeriodsRoutes.openapi(markUnpaidRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const row = await markUnpaid(id, user.id);
  await recordUserAudit(c, user.id, {
    action: 'rent_period.mark_unpaid',
    entityType: 'rent_period',
    entityId: row.id,
  });
  return c.json(row, 200);
});
