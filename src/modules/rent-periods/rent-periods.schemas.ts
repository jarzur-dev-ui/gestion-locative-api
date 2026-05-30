import { z } from '@hono/zod-openapi';

export const RENT_PERIOD_STATUSES = ['draft', 'notice_sent', 'paid'] as const;

export const ADJUSTMENT_TYPES = [
  'teom',
  'previous_balance',
  'charges_regularization',
  'other',
] as const;

/**
 * Format 'YYYY-MM' — utilisé en query param `?periodMonth=` et exposé dans la
 * réponse (alors que la DB stocke un `date` au 'YYYY-MM-01').
 */
const PERIOD_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export const PeriodMonthQuerySchema = z
  .string()
  .regex(PERIOD_MONTH_REGEX, 'Format attendu : YYYY-MM');

/**
 * Représentation d'un ajustement (TEOM, régularisation de charges, etc.) côté
 * API. Strictement aligné avec le type Drizzle `Adjustment` côté schema, mais
 * exprimé en Zod pour validation des entrées.
 */
export const AdjustmentSchema = z
  .object({
    type: z.enum(ADJUSTMENT_TYPES),
    labelKey: z.string().min(1).max(120).optional(),
    label: z.string().min(1).max(240).optional(),
    amountCents: z.number().int(),
  })
  .openapi('Adjustment');

/**
 * Résumé d'un locataire embarqué dans la représentation publique d'une
 * période. On reste minimaliste — l'UI a juste besoin d'afficher qui doit
 * payer.
 */
export const RentPeriodTenantSummarySchema = z
  .object({
    id: z.string().uuid(),
    lastName: z.string(),
    firstName: z.string(),
    email: z.string().email(),
  })
  .openapi('RentPeriodTenantSummary');

export const RentPeriodSchema = z
  .object({
    id: z.string().uuid(),
    leaseId: z.string().uuid(),

    // Toujours retourné au format 'YYYY-MM' côté API même si la DB stocke un
    // `date` ('YYYY-MM-01') — l'UI manipule des mois, pas des jours.
    periodMonth: z.string().regex(PERIOD_MONTH_REGEX),

    baseRentCents: z.number().int().nonnegative(),
    baseChargesCents: z.number().int().nonnegative(),
    adjustments: z.array(AdjustmentSchema),
    totalDueCents: z.number().int(),

    dueDate: z.string().date(),

    statusKey: z.enum(RENT_PERIOD_STATUSES),

    noticeSentAt: z.string().datetime().nullable(),
    noticeDocumentId: z.string().uuid().nullable(),

    paidAt: z.string().datetime().nullable(),
    paidByUserId: z.string().uuid().nullable(),
    receiptDocumentId: z.string().uuid().nullable(),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),

    tenants: z.array(RentPeriodTenantSummarySchema),
  })
  .openapi('RentPeriod');

export const RentPeriodListSchema = z.array(RentPeriodSchema).openapi('RentPeriodList');

export const RentPeriodIdParamSchema = z
  .object({
    id: z.string().uuid().openapi({
      param: { name: 'id', in: 'path' },
      example: '00000000-0000-0000-0000-000000000000',
    }),
  })
  .openapi('RentPeriodIdParam');

export const RentPeriodListQuerySchema = z
  .object({
    leaseId: z
      .string()
      .uuid()
      .optional()
      .openapi({ param: { name: 'leaseId', in: 'query' } }),
    status: z
      .enum(RENT_PERIOD_STATUSES)
      .optional()
      .openapi({ param: { name: 'status', in: 'query' }, example: 'notice_sent' }),
    periodMonth: PeriodMonthQuerySchema.optional().openapi({
      param: { name: 'periodMonth', in: 'query' },
      example: '2026-05',
    }),
  })
  .openapi('RentPeriodListQuery');

/**
 * Body du PATCH /:id — mise à jour des ajustements uniquement (le loyer et
 * les charges restent figés depuis le snapshot du bail à la création de la
 * période). Le service refuse le PATCH si la période n'est plus `draft`.
 */
export const UpdateRentPeriodSchema = z
  .object({
    adjustments: z.array(AdjustmentSchema),
  })
  .openapi('UpdateRentPeriod');

export type RentPeriodPublic = z.infer<typeof RentPeriodSchema>;
export type AdjustmentInput = z.infer<typeof AdjustmentSchema>;
export type UpdateRentPeriodInput = z.infer<typeof UpdateRentPeriodSchema>;
export type RentPeriodStatusKey = (typeof RENT_PERIOD_STATUSES)[number];
