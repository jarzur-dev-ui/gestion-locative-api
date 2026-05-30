import { z } from '@hono/zod-openapi';

export const TenantSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    createdByUserId: z.string().uuid(),
    civility: z.string().nullable(),
    lastName: z.string(),
    firstName: z.string(),
    email: z.string().email(),
    phone: z.string().nullable(),
    // Date ISO YYYY-MM-DD (sans heure).
    birthDate: z.string().date().nullable(),
    birthPlace: z.string().nullable(),
    currentAddressLine: z.string().nullable(),
    currentPostalCode: z.string().nullable(),
    currentCity: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Tenant');

export const CreateTenantSchema = z
  .object({
    civility: z.string().min(1).optional(),
    lastName: z.string().min(1),
    firstName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(1).optional(),
    birthDate: z.string().date().optional(),
    birthPlace: z.string().min(1).optional(),
    currentAddressLine: z.string().min(1).optional(),
    currentPostalCode: z.string().min(1).optional(),
    currentCity: z.string().min(1).optional(),
  })
  .openapi('CreateTenant');

export const UpdateTenantSchema = z
  .object({
    civility: z.string().min(1).optional(),
    lastName: z.string().min(1),
    firstName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(1).optional(),
    birthDate: z.string().date().optional(),
    birthPlace: z.string().min(1).optional(),
    currentAddressLine: z.string().min(1).optional(),
    currentPostalCode: z.string().min(1).optional(),
    currentCity: z.string().min(1).optional(),
  })
  .openapi('UpdateTenant');

export const TenantIdParamsSchema = z
  .object({
    id: z.string().uuid().openapi({
      param: { name: 'id', in: 'path' },
      example: '00000000-0000-0000-0000-000000000000',
    }),
  })
  .openapi('TenantIdParams');

export const TenantListSchema = z.array(TenantSchema).openapi('TenantList');

export type TenantPublic = z.infer<typeof TenantSchema>;
export type CreateTenantInput = z.infer<typeof CreateTenantSchema>;
export type UpdateTenantInput = z.infer<typeof UpdateTenantSchema>;
