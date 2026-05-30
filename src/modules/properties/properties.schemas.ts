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

/**
 * Patch (JSON Merge Patch, RFC 7396) :
 * - Champ absent → ne touche pas la colonne
 * - Champ à `null` → set la colonne à NULL (autorisé uniquement pour les colonnes nullables en DB)
 * - Champ avec valeur → update la colonne
 *
 * Les colonnes NOT NULL côté DB (addressLine, postalCode, city, propertyTypeKey, furnished)
 * n'acceptent PAS `null` (l'absence est OK, mais pas la suppression explicite).
 */
export const PatchPropertySchema = z
  .object({
    addressLine: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    propertyTypeKey: z.string().min(1).optional(),
    surfaceM2: z.number().positive().nullable().optional(),
    roomCount: z.number().int().nonnegative().nullable().optional(),
    builtYear: z.number().int().nullable().optional(),
    dpeGrade: z.enum(DPE_GRADES).nullable().optional(),
    gesGrade: z.enum(DPE_GRADES).nullable().optional(),
    furnished: z.boolean().optional(),
  })
  .openapi('PatchProperty');

export const PropertyListSchema = z.array(PropertySchema).openapi('PropertyList');

export const PropertyIdParamSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' }, example: '00000000-0000-0000-0000-000000000000' }),
});

export type PropertyPublic = z.infer<typeof PropertySchema>;
export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>;
export type PatchPropertyInput = z.infer<typeof PatchPropertySchema>;
