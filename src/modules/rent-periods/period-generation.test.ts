import { describe, expect, it } from 'vitest';
import { getNextPeriodMonth } from './period-generation.js';

describe('getNextPeriodMonth', () => {
  it('retourne le mois suivant en milieu d’année', () => {
    expect(getNextPeriodMonth(new Date('2026-08-07T08:00:00Z'))).toBe('2026-09');
  });

  it('bascule sur janvier de l’année suivante en décembre', () => {
    expect(getNextPeriodMonth(new Date('2026-12-15T08:00:00Z'))).toBe('2027-01');
  });

  it('reste stable quel que soit le jour du mois', () => {
    expect(getNextPeriodMonth(new Date('2026-08-01T00:00:00Z'))).toBe('2026-09');
    expect(getNextPeriodMonth(new Date('2026-08-31T23:00:00Z'))).toBe('2026-09');
  });
});
