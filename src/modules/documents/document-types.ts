/**
 * Whitelist des types de documents autorisés par rôle utilisateur.
 *
 * - `landlord` : documents que le bailleur peut produire (bail, quittance,
 *   diagnostics, états des lieux, révision de loyer…).
 * - `tenant`   : pièces justificatives uploadées par un locataire (assurance,
 *   identité, fiches de paie, avis d'imposition…).
 * - `guarantor`: pièces justificatives uploadées par un garant (mêmes pièces
 *   que le locataire + attestation de garantie + justificatif de propriété).
 *
 * On garde un `as const satisfies` pour avoir à la fois la précision des
 * tuples typés (utile pour Zod côté API) ET la garantie qu'on couvre bien
 * les trois rôles.
 */
export const DOCUMENT_TYPES_BY_ROLE = {
  landlord: [
    'lease',
    'rent_receipt',
    'rent_notice',
    'inventory_in',
    'inventory_out',
    'dpe',
    'notice_info',
    'risk_diagnosis',
    'lead_diagnosis',
    'asbestos_diagnosis',
    'gas_diagnosis',
    'electrical_diagnosis',
    'charges_breakdown',
    'rent_revaluation_notice',
  ],
  tenant: [
    'insurance_certificate',
    'identity_document',
    'payslip',
    'tax_notice',
    'employment_proof',
    'bank_details',
  ],
  guarantor: [
    'identity_document',
    'payslip',
    'tax_notice',
    'employment_proof',
    'bank_details',
    'guarantee_attestation',
    'home_ownership_proof',
  ],
} as const satisfies Record<'landlord' | 'tenant' | 'guarantor', readonly string[]>;

export type DocumentRole = keyof typeof DOCUMENT_TYPES_BY_ROLE;

export function isAllowedTypeForRole(role: DocumentRole, typeKey: string): boolean {
  return (DOCUMENT_TYPES_BY_ROLE[role] as readonly string[]).includes(typeKey);
}
