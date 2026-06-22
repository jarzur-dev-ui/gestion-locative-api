import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// On mocke la couche DB pour tester la logique de résolution d'un partage
// public (révoqué / expiré / document soft-deleted) sans base réelle.

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/client.js', () => ({ db: dbMock }));

import { resolveShareForDownload } from './document-shares.service.js';

/** Chaîne `select().from().innerJoin().where().limit()` qui résout vers `rows`. */
function selectReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function validShare(overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok',
    documentId: 'd1',
    revokedAt: null,
    expiresAt: FUTURE,
    ...overrides,
  };
}

describe('resolveShareForDownload', () => {
  it('retourne le partage + document quand tout est valide', async () => {
    dbMock.select.mockReturnValueOnce(
      selectReturning([{ share: validShare(), document: { id: 'd1', deletedAt: null } }]),
    );

    const result = await resolveShareForDownload('tok');
    expect(result).not.toBeNull();
    expect(result?.document.id).toBe('d1');
  });

  it('retourne null quand le token est inconnu', async () => {
    dbMock.select.mockReturnValueOnce(selectReturning([]));
    expect(await resolveShareForDownload('absent')).toBeNull();
  });

  it('retourne null quand le partage est révoqué', async () => {
    dbMock.select.mockReturnValueOnce(
      selectReturning([
        { share: validShare({ revokedAt: new Date() }), document: { id: 'd1', deletedAt: null } },
      ]),
    );
    expect(await resolveShareForDownload('tok')).toBeNull();
  });

  it('retourne null quand le partage est expiré', async () => {
    dbMock.select.mockReturnValueOnce(
      selectReturning([
        { share: validShare({ expiresAt: PAST }), document: { id: 'd1', deletedAt: null } },
      ]),
    );
    expect(await resolveShareForDownload('tok')).toBeNull();
  });

  // Hardening M2 — un document soft-deleted ne doit plus être téléchargeable
  // via un lien public. Le filtre `isNull(documents.deletedAt)` est appliqué
  // côté SQL (dans le WHERE du join) : la ligne ne remonte pas, donc la
  // résolution renvoie null → la route renverra 410.
  it('retourne null quand le document est soft-deleted (filtré côté join)', async () => {
    // Le document soft-deleted est exclu par le WHERE → la requête ne renvoie
    // aucune ligne, exactement comme un token inconnu.
    dbMock.select.mockReturnValueOnce(selectReturning([]));
    expect(await resolveShareForDownload('tok')).toBeNull();
  });
});
