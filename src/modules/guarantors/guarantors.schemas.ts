import { z } from '@hono/zod-openapi';

export const GUARANTOR_TYPES = ['person', 'organization'] as const;

/**
 * Réponse JSON : on expose tous les champs, et on laisse au consommateur le
 * soin de filtrer selon `guarantorTypeKey`. Les champs spécifiques à l'autre
 * type sont simplement `null`. On ne fait pas de union côté réponse car le
 * client (frontend) reçoit les champs sous une forme stable et c'est lui qui
 * décide quoi afficher en fonction du discriminant.
 */
export const GuarantorSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    createdByUserId: z.string().uuid(),
    guarantorTypeKey: z.enum(GUARANTOR_TYPES),
    // Champs `person` (null si organization).
    civility: z.string().nullable(),
    lastName: z.string().nullable(),
    firstName: z.string().nullable(),
    email: z.string().email().nullable(),
    phone: z.string().nullable(),
    birthDate: z.string().date().nullable(),
    birthPlace: z.string().nullable(),
    addressLine: z.string().nullable(),
    postalCode: z.string().nullable(),
    city: z.string().nullable(),
    // Champs `organization` (null si person).
    organizationName: z.string().nullable(),
    organizationReference: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Guarantor');

/**
 * Variante `person` : last_name + first_name requis.
 * Les champs `organization*` sont volontairement ABSENTS (et non `null`) —
 * Zod les rejettera si présents grâce à `.strict()`.
 */
const CreatePersonGuarantorSchema = z
  .object({
    guarantorTypeKey: z.literal('person'),
    civility: z.string().min(1).optional(),
    lastName: z.string().min(1),
    firstName: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    birthDate: z.string().date().optional(),
    birthPlace: z.string().min(1).optional(),
    addressLine: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
  })
  .openapi('CreatePersonGuarantor');

/**
 * Variante `organization` : organization_name requis.
 */
const CreateOrganizationGuarantorSchema = z
  .object({
    guarantorTypeKey: z.literal('organization'),
    organizationName: z.string().min(1),
    organizationReference: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    addressLine: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
  })
  .openapi('CreateOrganizationGuarantor');

/**
 * Discriminated union sur `guarantorTypeKey` :
 * - `person` → last_name + first_name requis ;
 * - `organization` → organization_name requis.
 *
 * Note OpenAPI : `z.discriminatedUnion(...)` est rendu en `oneOf` avec
 * `discriminator` côté @hono/zod-openapi — c'est exactement ce qu'on veut
 * exposer au front (ainsi qu'aux autres clients OpenAPI).
 */
export const CreateGuarantorSchema = z
  .discriminatedUnion('guarantorTypeKey', [
    CreatePersonGuarantorSchema,
    CreateOrganizationGuarantorSchema,
  ])
  .openapi('CreateGuarantor');

/**
 * PATCH (JSON Merge Patch, RFC 7396) :
 * - Clé absente → ne touche pas la colonne
 * - Clé à `null` → set la colonne à NULL
 * - Clé avec valeur → update la colonne
 *
 * Toutes les colonnes de la table `guarantors` (hors PK / discriminant) sont
 * nullables en DB, ce qui rend la sémantique du patch homogène quel que soit
 * le type. Le service rejette en 400 toute tentative de changer
 * `guarantorTypeKey` (immutable via PATCH — passer par delete + recreate pour
 * un switch person↔organization).
 *
 * Note : on ne fait PAS de discriminated union ici, sinon le client devrait
 * resaisir `guarantorTypeKey` à chaque appel — ce qui contredit la sémantique
 * "patch partiel". Le `guarantorTypeKey` est accepté en entrée (pour les
 * clients qui voudraient le passer par symétrie avec POST) mais doit
 * correspondre à la valeur existante.
 */
export const PatchGuarantorSchema = z
  .object({
    guarantorTypeKey: z.enum(GUARANTOR_TYPES).optional(),
    // Champs `person`.
    civility: z.string().min(1).nullable().optional(),
    lastName: z.string().min(1).nullable().optional(),
    firstName: z.string().min(1).nullable().optional(),
    // Champs partagés / `organization`.
    email: z.string().email().nullable().optional(),
    phone: z.string().min(1).nullable().optional(),
    birthDate: z.string().date().nullable().optional(),
    birthPlace: z.string().min(1).nullable().optional(),
    addressLine: z.string().min(1).nullable().optional(),
    postalCode: z.string().min(1).nullable().optional(),
    city: z.string().min(1).nullable().optional(),
    // Champs `organization`.
    organizationName: z.string().min(1).nullable().optional(),
    organizationReference: z.string().min(1).nullable().optional(),
  })
  .openapi('PatchGuarantor');

export const GuarantorIdParamsSchema = z
  .object({
    id: z.string().uuid().openapi({
      param: { name: 'id', in: 'path' },
      example: '00000000-0000-0000-0000-000000000000',
    }),
  })
  .openapi('GuarantorIdParams');

export const GuarantorListQuerySchema = z
  .object({
    type: z
      .enum(GUARANTOR_TYPES)
      .optional()
      .openapi({
        param: { name: 'type', in: 'query' },
        example: 'person',
      }),
  })
  .openapi('GuarantorListQuery');

export const GuarantorListSchema = z.array(GuarantorSchema).openapi('GuarantorList');

export type GuarantorPublic = z.infer<typeof GuarantorSchema>;
export type CreateGuarantorInput = z.infer<typeof CreateGuarantorSchema>;
export type PatchGuarantorInput = z.infer<typeof PatchGuarantorSchema>;
export type GuarantorTypeKey = (typeof GUARANTOR_TYPES)[number];
