import { z } from '@hono/zod-openapi';

export const LandlordProfileSchema = z
  .object({
    userId: z.string().uuid(),
    civility: z.string().nullable(),
    lastName: z.string(),
    firstName: z.string(),
    addressLine: z.string(),
    postalCode: z.string(),
    city: z.string(),
    email: z.string().email().nullable(),
    phone: z.string().nullable(),
    iban: z.string().nullable(),
    signatureFilePath: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('LandlordProfile');

export const UpsertLandlordProfileSchema = z
  .object({
    civility: z.string().min(1).optional(),
    lastName: z.string().min(1),
    firstName: z.string().min(1),
    addressLine: z.string().min(1),
    postalCode: z.string().min(1),
    city: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    iban: z.string().min(1).optional(),
    signatureFilePath: z.string().min(1).optional(),
  })
  .openapi('UpsertLandlordProfile');

export type LandlordProfilePublic = z.infer<typeof LandlordProfileSchema>;
export type UpsertLandlordProfileInput = z.infer<typeof UpsertLandlordProfileSchema>;
