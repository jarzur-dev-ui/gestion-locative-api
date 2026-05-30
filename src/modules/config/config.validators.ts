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
 * Validates a config value against its key-specific schema.
 *
 * V1 policy: unknown keys (not present in `CONFIG_VALUE_SCHEMAS`) PASS through
 * without validation. This keeps the endpoint forward-compatible with new keys
 * introduced by future code before this validator is updated.
 * For V2 we may decide to refuse unknown keys.
 */
export function validateConfigValue(
  key: string,
  value: unknown,
):
  | { ok: true; value: unknown }
  | { ok: false; error: string; issues: unknown } {
  const schema = CONFIG_VALUE_SCHEMAS[key];
  if (!schema) {
    // Unknown key — pour V1 on accepte (forward-compat), pour V2 on pourrait refuser
    return { ok: true, value };
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
