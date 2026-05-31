import { z } from '@hono/zod-openapi';

/**
 * Shape du legacy export depuis le localStorage du front V1 (zeleph.fr).
 * On accepte des champs partiellement absents — tout ce qui manque est traité
 * comme une chaîne vide / valeur par défaut.
 */
export const LegacyBailleurSchema = z
  .object({
    nom: z.string().optional(),
    adresse: z.string().optional(),
    cpVille: z.string().optional(),
    email: z.string().optional(),
    lieuSignature: z.string().optional(),
    signatureDataUrl: z.string().optional(),
  })
  .openapi('LegacyBailleur');

export const LegacyBailSchema = z
  .object({
    id: z.string().optional(),
    civilite: z.string().optional(),
    locataire: z.string().optional(),
    locataireEmail: z.string().optional(),
    garant: z.string().optional(),
    type: z.string().optional(),
    rue: z.string().optional(),
    cpVille: z.string().optional(),
    batiment: z.string().optional(),
    surface: z.string().optional(),
    nbPieces: z.string().optional(),
    dpe: z.string().optional(),
    periodeConstruction: z.string().optional(),
    dateEffet: z.string().optional(),
    duree: z.string().optional(),
    loyer: z.number().optional(),
    charges: z.number().optional(),
    modaliteCharges: z.string().optional(),
    jourEcheance: z.number().optional(),
    depotGarantie: z.number().optional(),
  })
  .openapi('LegacyBail');

export const ImportRequestSchema = z
  .object({
    bailleur: LegacyBailleurSchema,
    baux: z.array(LegacyBailSchema),
  })
  .openapi('ImportRequest');

export const ImportReportSchema = z
  .object({
    profile: z.object({
      created: z.boolean(),
      updated: z.boolean(),
    }),
    properties: z.object({
      created: z.number(),
      skipped: z.number(),
    }),
    tenants: z.object({
      created: z.number(),
      skipped: z.number(),
    }),
    guarantors: z.object({
      created: z.number(),
      skipped: z.number(),
    }),
    leases: z.object({
      created: z.number(),
      skipped: z.number(),
    }),
    warnings: z.array(z.string()),
  })
  .openapi('ImportReport');

export type ImportRequest = z.infer<typeof ImportRequestSchema>;
export type LegacyBail = z.infer<typeof LegacyBailSchema>;
export type LegacyBailleur = z.infer<typeof LegacyBailleurSchema>;
