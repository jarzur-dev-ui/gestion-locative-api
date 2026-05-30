import { z } from '@hono/zod-openapi';

export const ConfigEntrySchema = z
  .object({
    key: z.string(),
    value: z.unknown(),
    description: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .openapi('ConfigEntry');

// Wrappé dans un objet pour la compatibilité avec le strict typing OpenAPI
// (z.record direct produit un type qui ne s'aligne pas avec TypedResponse).
export const ConfigMapResponseSchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('ConfigMapResponse');

export const UpsertConfigSchema = z
  .object({
    value: z.unknown(),
    description: z.string().nullable().optional(),
  })
  .openapi('UpsertConfig');

export const ConfigKeyParamSchema = z.object({
  key: z.string().min(1).max(128),
});
