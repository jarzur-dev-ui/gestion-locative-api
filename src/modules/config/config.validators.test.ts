import { describe, expect, it } from 'vitest';
import { validateConfigValue } from './config.validators.js';

describe('validateConfigValue', () => {
  it('accepte une valeur valide pour une clé connue', () => {
    const res = validateConfigValue('lease.default_payment_day', 5);
    expect(res.ok).toBe(true);
  });

  it('refuse une valeur invalide pour une clé connue', () => {
    const res = validateConfigValue('lease.default_payment_day', 99);
    expect(res.ok).toBe(false);
  });

  // Hardening M1 — les clés inconnues sont désormais refusées (anciennement
  // acceptées en forward-compat). La config n'est pas un key/value store libre.
  it('refuse une clé inconnue', () => {
    const res = validateConfigValue('attacker.injected_key', 'whatever');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('inconnue');
    }
  });

  // Hardening M1 — plafond de taille sur la valeur sérialisée.
  it('refuse une valeur trop volumineuse', () => {
    // 'lease.statuses' attend une liste d'options ; on dépasse le cap 64 Kio.
    const huge = Array.from({ length: 5000 }, (_, i) => ({
      value: `v${i}`,
      labelKey: 'x'.repeat(50),
    }));
    const res = validateConfigValue('lease.statuses', huge);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('volumineuse');
    }
  });
});
