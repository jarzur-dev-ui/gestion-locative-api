import { z } from '@hono/zod-openapi';

// Each key declares the Zod schema its `value` must conform to.
// Keep this in sync with config.defaults.ts.

const optionListSchema = z.array(
  z.object({
    value: z.string(),
    labelKey: z.string(),
  }),
);

export const CONFIG_VALUE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // Defaults numériques
  'lease.default_payment_day': z.number().int().min(1).max(31),
  'lease.default_lease_type': z.enum(['empty', 'furnished']),
  'lease.default_charges_type': z.enum(['package', 'real']),

  // IRL — texte libre (mais format reconnaissable)
  'rent.irl_current_quarter': z.string().regex(/^T[1-4]\s\d{4}$/),

  // Listes d'options
  'lease.types': optionListSchema,
  'lease.charges_types': optionListSchema,
  'lease.statuses': optionListSchema,
  'property.types': optionListSchema,
  'property.dpe_grades': z.array(z.string().length(1)), // ['A','B','C','D','E','F','G']
  civilities: optionListSchema,
  'guarantor.types': optionListSchema,
  'guarantor.known_organizations': optionListSchema,
  'document.statuses': optionListSchema,
  'rent_period.adjustment_types': optionListSchema,

  // Limites applicatives
  'document.max_upload_bytes': z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024), // max 100MB hard cap
  'document.share.default_ttl_days': z.number().int().min(1).max(90),
  'rent_period.undo_window_hours': z.number().int().min(1).max(168), // max 1 semaine
  'document.soft_delete_ttl_days': z.number().int().min(7).max(365), // entre 7j et 1 an
};

/**
 * Borne dure sur la taille de la valeur sérialisée (JSON). Empêche qu'un PUT
 * stocke un blob arbitrairement gros en base via l'endpoint config (DoS
 * stockage / mémoire). 64 Kio couvre très largement nos listes d'options.
 */
const MAX_CONFIG_VALUE_BYTES = 64 * 1024;

/**
 * Validates a config value against its key-specific schema.
 *
 * Sécurité (mono-bailleur, scoping multi-tenant hors périmètre) : on REFUSE les
 * clés inconnues. La config n'est PAS un key/value store libre — n'accepter que
 * les clés déclarées dans `CONFIG_VALUE_SCHEMAS` (alignées sur `config.defaults`)
 * évite qu'un bailleur (ou un token compromis) injecte des entrées arbitraires
 * lues plus tard par le front. On plafonne aussi la taille de la valeur.
 */
export function validateConfigValue(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string; issues: unknown } {
  const schema = CONFIG_VALUE_SCHEMAS[key];
  if (!schema) {
    // Clé inconnue : refus explicite (anciennement accepté en V1 pour
    // forward-compat — désormais bloqué, cf. hardening M1).
    return {
      ok: false,
      error: `Clé de configuration inconnue : "${key}"`,
      issues: null,
    };
  }

  // Cap de taille : on mesure la valeur sérialisée en JSON.
  const serializedBytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  if (serializedBytes > MAX_CONFIG_VALUE_BYTES) {
    return {
      ok: false,
      error: `Valeur trop volumineuse pour la clé "${key}" (max ${MAX_CONFIG_VALUE_BYTES} octets)`,
      issues: null,
    };
  }

  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: `Valeur invalide pour la clé "${key}"`,
    issues: result.error.flatten(),
  };
}
