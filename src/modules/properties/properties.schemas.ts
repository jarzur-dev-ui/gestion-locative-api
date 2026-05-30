import { z } from '@hono/zod-openapi';

const DPE_GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

export const PropertySchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    addressLine: z.string(),
    postalCode: z.string(),
    city: z.string(),
    propertyTypeKey: z.string(),
    // `surfaceM2` est `numeric` en Postgres → converti côté service en `number` pour le JSON.
    surfaceM2: z.number().nullable(),
    roomCount: z.number().int().nullable(),
    builtYear: z.number().int().nullable(),
    dpeGrade: z.enum(DPE_GRADES).nullable(),
    gesGrade: z.enum(DPE_GRADES).nullable(),
    furnished: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Property');

export const CreatePropertySchema = z
  .object({
    addressLine: z.string().min(1),
    postalCode: z.string().min(1),
    city: z.string().min(1),
    propertyTypeKey: z.string().min(1),
    surfaceM2: z.number().positive().optional(),
    roomCount: z.number().int().nonnegative().optional(),
    builtYear: z.number().int().optional(),
    dpeGrade: z.enum(DPE_GRADES).optional(),
    gesGrade: z.enum(DPE_GRADES).optional(),
    furnished: z.boolean().optional().default(false),
  })
  .openapi('CreateProperty');

export const UpdatePropertySchema = z
  .object({
    addressLine: z.string().min(1),
    postalCode: z.string().min(1),
    city: z.string().min(1),
    propertyTypeKey: z.string().min(1),
    surfaceM2: z.number().positive().optional(),
    roomCount: z.number().int().nonnegative().optional(),
    builtYear: z.number().int().optional(),
    dpeGrade: z.enum(DPE_GRADES).optional(),
    gesGrade: z.enum(DPE_GRADES).optional(),
    furnished: z.boolean().optional().default(false),
  })
  .openapi('UpdateProperty');

export const PropertyListSchema = z.array(PropertySchema).openapi('PropertyList');

export const PropertyIdParamSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' }, example: '00000000-0000-0000-0000-000000000000' }),
});

export type PropertyPublic = z.infer<typeof PropertySchema>;
export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>;
export type UpdatePropertyInput = z.infer<typeof UpdatePropertySchema>;
