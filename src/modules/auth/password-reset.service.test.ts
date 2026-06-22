import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// On mocke la couche DB et le mailer pour tester la logique métier du service
// (anti-énumération, garde compare-and-swap, invalidation des sessions) sans
// base de données réelle. Les chaînes Drizzle (`select().from().where()...`)
// sont reproduites via des thenable / objets chaînables.

const { dbMock, sendEmailMock, hashPasswordMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  sendEmailMock: vi.fn(),
  hashPasswordMock: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../lib/mailer.js', () => ({ sendEmail: sendEmailMock }));
vi.mock('./password.js', () => ({ hashPassword: hashPasswordMock }));
// On ne teste pas le rendu HTML ici — juste qu'un email est envoyé.
vi.mock('../../lib/email-templates.js', () => ({
  renderPasswordResetEmail: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
}));

import { requestPasswordReset, resetPassword } from './password-reset.service.js';

// ---------------------------------------------------------------------------
// Helpers : builders de chaînes Drizzle mockées
// ---------------------------------------------------------------------------

/** Chaîne `select().from().where().limit()` qui résout vers `rows`. */
function selectReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

/** Chaîne `update().set().where()[.returning()]` qui résout vers `rows`. */
function updateReturning(rows: unknown[]) {
  // `where` peut être terminal (UPDATE users, awaité directement) ou suivi de
  // `.returning()` (CAS sur le token). On renvoie donc une vraie Promise (donc
  // awaitable) sur laquelle on greffe une méthode `returning` chaînable.
  const whereResult = Object.assign(Promise.resolve(rows), {
    returning: vi.fn(() => Promise.resolve(rows)),
  });
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => whereResult),
  };
  return chain;
}

/** Chaîne `delete().where()` awaitable. */
function deleteReturning() {
  const chain = {
    where: vi.fn(() => Promise.resolve([])),
  };
  return chain;
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  hashPasswordMock.mockResolvedValue('hashed-pw');
  sendEmailMock.mockResolvedValue({ delivered: true });
});

// ---------------------------------------------------------------------------
// requestPasswordReset — anti-énumération
// ---------------------------------------------------------------------------

describe('requestPasswordReset', () => {
  it("ne jette pas et n'envoie aucun email pour un email inconnu", async () => {
    dbMock.select.mockReturnValueOnce(selectReturning([]));

    await expect(requestPasswordReset('inconnu@example.com')).resolves.toBeUndefined();

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("n'envoie aucun email si l'utilisateur n'a pas de passwordHash (invité non activé)", async () => {
    dbMock.select.mockReturnValueOnce(
      selectReturning([{ id: 'u1', email: 'a@b.fr', passwordHash: null }]),
    );

    await expect(requestPasswordReset('a@b.fr')).resolves.toBeUndefined();

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("génère un token et envoie l'email si l'utilisateur existe avec un passwordHash", async () => {
    dbMock.select.mockReturnValueOnce(
      selectReturning([{ id: 'u1', email: 'a@b.fr', passwordHash: 'h' }]),
    );
    const valuesMock = vi.fn((_values: unknown) => Promise.resolve(undefined));
    dbMock.insert.mockReturnValueOnce({ values: valuesMock });

    await requestPasswordReset('  A@B.FR  ');

    // Email normalisé (lowercase + trim) lors du lookup.
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    const inserted = valuesMock.mock.calls[0]?.[0] as {
      token: string;
      userId: string;
      expiresAt: Date;
    };
    expect(inserted.userId).toBe('u1');
    expect(typeof inserted.token).toBe('string');
    expect(inserted.token.length).toBeGreaterThan(20);
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.fr' }));
  });

  it("ne jette pas si l'envoi SMTP échoue (degrade gracefully)", async () => {
    dbMock.select.mockReturnValueOnce(
      selectReturning([{ id: 'u1', email: 'a@b.fr', passwordHash: 'h' }]),
    );
    dbMock.insert.mockReturnValueOnce({ values: vi.fn(() => Promise.resolve(undefined)) });
    sendEmailMock.mockResolvedValueOnce({ delivered: false });

    await expect(requestPasswordReset('a@b.fr')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resetPassword — garde de validité, CAS, invalidation des sessions
// ---------------------------------------------------------------------------

/**
 * Fabrique un faux `tx` pour `db.transaction`. `tokenRow` est ce que renvoie le
 * SELECT initial ; `casRows` ce que renvoie le UPDATE compare-and-swap.
 * Capture les appels delete/update pour les assertions.
 */
function buildTx(opts: { tokenRow: unknown; casRows: unknown[] }) {
  const deleteChain = deleteReturning();
  const userUpdateChain = updateReturning([]);
  const casChain = updateReturning(opts.casRows);

  let updateCall = 0;
  const tx = {
    select: vi.fn(() => selectReturning(opts.tokenRow ? [opts.tokenRow] : [])),
    update: vi.fn(() => {
      // 1er update = CAS sur le token ; 2e = users.
      updateCall += 1;
      return updateCall === 1 ? casChain : userUpdateChain;
    }),
    delete: vi.fn(() => deleteChain),
  };
  return { tx, deleteChain, userUpdateChain };
}

describe('resetPassword', () => {
  it('happy path : hash le mot de passe, marque usedAt, supprime les sessions', async () => {
    const tokenRow = {
      token: 'tok',
      userId: 'u1',
      usedAt: null,
      expiresAt: FUTURE,
    };
    const { tx, deleteChain, userUpdateChain } = buildTx({ tokenRow, casRows: [{ token: 'tok' }] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    const result = await resetPassword({ token: 'tok', password: 'newpassword123' });

    expect(result).toEqual({ userId: 'u1' });
    expect(hashPasswordMock).toHaveBeenCalledWith('newpassword123');
    // users update appelé avec le hash.
    expect(userUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: 'hashed-pw' }),
    );
    // Sessions supprimées.
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });

  it('token introuvable → 404', async () => {
    const { tx } = buildTx({ tokenRow: null, casRows: [] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    await expect(resetPassword({ token: 'x', password: 'newpassword123' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('token déjà utilisé → 410', async () => {
    const tokenRow = { token: 'tok', userId: 'u1', usedAt: new Date(), expiresAt: FUTURE };
    const { tx } = buildTx({ tokenRow, casRows: [] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    const err = await resetPassword({ token: 'tok', password: 'newpassword123' }).catch((e) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect(err.status).toBe(410);
  });

  it('token expiré → 410', async () => {
    const tokenRow = { token: 'tok', userId: 'u1', usedAt: null, expiresAt: PAST };
    const { tx } = buildTx({ tokenRow, casRows: [] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    const err = await resetPassword({ token: 'tok', password: 'newpassword123' }).catch((e) => e);
    expect(err.status).toBe(410);
  });

  it('CAS concurrent : 0 ligne mise à jour → 410', async () => {
    // Le token paraît valide au SELECT mais le CAS UPDATE ne renvoie aucune
    // ligne (consommé entre-temps par une requête concurrente).
    const tokenRow = { token: 'tok', userId: 'u1', usedAt: null, expiresAt: FUTURE };
    const { tx } = buildTx({ tokenRow, casRows: [] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    const err = await resetPassword({ token: 'tok', password: 'newpassword123' }).catch((e) => e);
    expect(err.status).toBe(410);
    // Le mot de passe ne doit PAS avoir été modifié (pas de delete sessions).
    expect(tx.delete).not.toHaveBeenCalled();
  });

  // Hardening H1a — anti DoS hash-amplification : le hash Argon2 (coûteux) ne
  // doit jamais s'exécuter tant que le token n'est pas validé ET consommé.
  it('token invalide → ne calcule PAS le hash Argon2', async () => {
    const { tx } = buildTx({ tokenRow: null, casRows: [] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    await resetPassword({ token: 'x', password: 'newpassword123' }).catch(() => undefined);

    expect(hashPasswordMock).not.toHaveBeenCalled();
  });

  it('CAS concurrent perdant → ne calcule PAS le hash Argon2', async () => {
    const tokenRow = { token: 'tok', userId: 'u1', usedAt: null, expiresAt: FUTURE };
    const { tx } = buildTx({ tokenRow, casRows: [] });
    dbMock.transaction.mockImplementationOnce((cb: (t: unknown) => unknown) => cb(tx));

    await resetPassword({ token: 'tok', password: 'newpassword123' }).catch(() => undefined);

    expect(hashPasswordMock).not.toHaveBeenCalled();
  });
});
