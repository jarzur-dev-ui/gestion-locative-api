/**
 * Valeurs par défaut servies par /api/config.
 *
 * Convention : les listes d'options exposent `{ value, labelKey }`.
 * Les `labelKey` sont des clés i18n consommées par le bundle FR du front.
 * Le backend ne fournit AUCUNE traduction, juste la structure + les clés.
 */

export type ConfigDefault = {
  key: string;
  value: unknown;
  description: string;
};

export const CONFIG_DEFAULTS: ConfigDefault[] = [
  // ─── Defaults numériques ───
  {
    key: 'lease.default_payment_day',
    value: 5,
    description: 'Jour du mois par défaut pour l\'échéance du loyer (1-31).',
  },
  {
    key: 'lease.default_lease_type',
    value: 'empty',
    description: 'Type de bail par défaut à la création.',
  },
  {
    key: 'lease.default_charges_type',
    value: 'package',
    description: 'Type de charges par défaut.',
  },

  // ─── IRL (Indice de Référence des Loyers) — à mettre à jour annuellement ───
  {
    key: 'rent.irl_current_quarter',
    value: 'T4 2025',
    description:
      'Indice IRL de référence pour les révisions de loyer en cours. Doit être mis à jour 4× par an par le bailleur (INSEE).',
  },

  // ─── Listes d'options ───
  {
    key: 'lease.types',
    value: [
      { value: 'empty', labelKey: 'lease.types.empty' },
      { value: 'furnished', labelKey: 'lease.types.furnished' },
    ],
    description: 'Types de bail proposés au formulaire.',
  },
  {
    key: 'lease.charges_types',
    value: [
      { value: 'package', labelKey: 'lease.charges_types.package' },
      { value: 'real', labelKey: 'lease.charges_types.real' },
    ],
    description: 'Types de charges (forfait ou réel).',
  },
  {
    key: 'lease.statuses',
    value: [
      { value: 'draft', labelKey: 'lease.statuses.draft' },
      { value: 'active', labelKey: 'lease.statuses.active' },
      { value: 'ended', labelKey: 'lease.statuses.ended' },
    ],
    description: 'États possibles d\'un bail.',
  },
  {
    key: 'property.types',
    value: [
      { value: 'apartment', labelKey: 'property.types.apartment' },
      { value: 'house', labelKey: 'property.types.house' },
      { value: 'studio', labelKey: 'property.types.studio' },
      { value: 'parking', labelKey: 'property.types.parking' },
      { value: 'cellar', labelKey: 'property.types.cellar' },
      { value: 'other', labelKey: 'property.types.other' },
    ],
    description: 'Types de biens immobiliers.',
  },
  {
    key: 'property.dpe_grades',
    value: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    description: 'Échelle DPE / GES (7 grades).',
  },
  {
    key: 'civilities',
    value: [
      { value: 'M.', labelKey: 'civilities.mr' },
      { value: 'Mme', labelKey: 'civilities.mrs' },
    ],
    description: 'Civilités acceptées.',
  },
  {
    key: 'guarantor.types',
    value: [
      { value: 'person', labelKey: 'guarantor.types.person' },
      { value: 'organization', labelKey: 'guarantor.types.organization' },
    ],
    description: 'Types de garant (personne physique ou organisation type Visale).',
  },
  {
    key: 'guarantor.known_organizations',
    value: [
      { value: 'Visale', labelKey: 'guarantor.known.visale' },
      { value: 'Action Logement', labelKey: 'guarantor.known.action_logement' },
      { value: 'GLI', labelKey: 'guarantor.known.gli' },
    ],
    description: 'Suggestions d\'organisations de garantie connues (pour l\'autocomplete).',
  },

  // ─── Documents ───
  {
    key: 'document.statuses',
    value: [
      { value: 'pending_validation', labelKey: 'document.statuses.pending_validation' },
      { value: 'validated', labelKey: 'document.statuses.validated' },
      { value: 'rejected', labelKey: 'document.statuses.rejected' },
    ],
    description: 'États possibles d\'un document.',
  },

  // ─── Adjustments / régularisations rent_periods ───
  {
    key: 'rent_period.adjustment_types',
    value: [
      { value: 'teom', labelKey: 'rent_period.adjustment_types.teom' },
      { value: 'previous_balance', labelKey: 'rent_period.adjustment_types.previous_balance' },
      { value: 'charges_regularization', labelKey: 'rent_period.adjustment_types.charges_regularization' },
      { value: 'other', labelKey: 'rent_period.adjustment_types.other' },
    ],
    description: 'Types de régularisation ponctuelle pour une quittance (TEOM, solde antérieur, régul. charges).',
  },

  // ─── Limites applicatives ───
  {
    key: 'document.max_upload_bytes',
    value: 20 * 1024 * 1024,
    description: 'Taille maximale d\'un upload (octets). Aligné sur MAX_UPLOAD_BYTES du backend.',
  },
  {
    key: 'document.share.default_ttl_days',
    value: 7,
    description: 'TTL par défaut d\'un partage de document.',
  },
  {
    key: 'rent_period.undo_window_hours',
    value: 24,
    description: 'Fenêtre de temps après mark-paid pour annuler (mark-unpaid).',
  },
  {
    key: 'document.soft_delete_ttl_days',
    value: 90,
    description:
      'Durée (jours) entre le soft-delete d\'un document et sa purge physique par le cron. Min 7, max 365.',
  },
];
