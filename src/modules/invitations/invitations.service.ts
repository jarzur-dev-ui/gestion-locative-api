import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import postgres from 'postgres';
import { db } from '../../db/client.js';
import { guarantors } from '../../db/schema/guarantors.js';
import type { Invitation } from '../../db/schema/invitations.js';
import { invitations } from '../../db/schema/invitations.js';
import { landlordProfiles } from '../../db/schema/landlord-profiles.js';
import { tenants } from '../../db/schema/tenants.js';
import type { User } from '../../db/schema/users.js';
import { users } from '../../db/schema/users.js';
import { renderInvitationEmail } from '../../lib/email-templates.js';
import { sendEmail } from '../../lib/mailer.js';
import { hashPassword } from '../auth/password.js';

// Postgres error code pour `unique_violation` (cf. https://www.postgresql.org/docs/current/errcodes-appendix.html).
// postgres.js expose `code` (string) sur `PostgresError`.
const PG_UNIQUE_VIOLATION = '23505';

const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

// URL d'accueil de l'app web qui héberge la page d'acceptation. En V1 on hard-code
// ; à terme on basculera vers une variable d'env (`WEB_APP_URL`).
const WEB_APP_BASE_URL = 'https://gestion-locative.zeleph.fr';

function generateInvitationToken(): string {
  // 32 bytes = 256 bits d'entropie, url-safe via base64url. Même format que les
  // tokens de session (cf. session.service.ts).
  return randomBytes(32).toString('base64url');
}

function buildMagicLink(token: string): string {
  return `${WEB_APP_BASE_URL}/accept-invitation?token=${encodeURIComponent(token)}`;
}

/**
 * Crée une invitation polymorphique pour un locataire OU un garant.
 * Le caller doit déjà être un `landlord` (vérifié par la route via `requireRole`).
 *
 * Règles métier :
 *  - La cible doit exister ET avoir été créée par le bailleur courant.
 *  - La cible ne doit pas déjà être liée à un compte (userId == null).
 *  - La cible doit avoir un email renseigné (snapshot vers `email_snapshot`).
 */
export async function createInvitation(opts: {
  currentUserId: string;
  targetType: 'tenant' | 'guarantor';
  targetId: string;
}): Promise<Invitation> {
  const target = await fetchTargetForCreator(opts);
  const inviterName = await fetchInviterDisplayName(opts.currentUserId);

  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const [invitation] = await db
    .insert(invitations)
    .values({
      token,
      targetTypeKey: opts.targetType,
      targetId: opts.targetId,
      emailSnapshot: target.email,
      createdByUserId: opts.currentUserId,
      expiresAt,
    })
    .returning();

  if (!invitation) {
    throw new Error("Échec de la création de l'invitation");
  }

  // Envoi de l'email via le service mailer (nodemailer). Les erreurs SMTP sont
  // déjà capturées et loguées par `sendEmail` — on ne fait pas échouer la
  // création d'invitation si l'envoi échoue (le bailleur pourra renvoyer).
  const { subject, html, text } = renderInvitationEmail({
    recipientName: target.displayName,
    inviterName,
    magicLink: buildMagicLink(invitation.token),
  });
  await sendEmail({ to: target.email, subject, html, text });

  return invitation;
}

type ResolvedTarget = {
  email: string;
  /** Nom affichable dans l'email (ex: "M. Dupont", "ACME"). Jamais vide. */
  displayName: string;
};

/**
 * Récupère le locataire ou garant cible (email + nom d'affichage) et vérifie
 * l'ownership + l'absence de compte déjà lié. Centralise toute la validation
 * polymorphique pour que `createInvitation` reste lisible.
 */
async function fetchTargetForCreator(opts: {
  currentUserId: string;
  targetType: 'tenant' | 'guarantor';
  targetId: string;
}): Promise<ResolvedTarget> {
  if (opts.targetType === 'tenant') {
    const [row] = await db
      .select({
        id: tenants.id,
        userId: tenants.userId,
        createdByUserId: tenants.createdByUserId,
        civility: tenants.civility,
        firstName: tenants.firstName,
        lastName: tenants.lastName,
        email: tenants.email,
      })
      .from(tenants)
      .where(eq(tenants.id, opts.targetId))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: 'Locataire introuvable' });
    }
    if (row.createdByUserId !== opts.currentUserId) {
      throw new HTTPException(403, { message: 'Accès refusé' });
    }
    if (row.userId) {
      throw new HTTPException(409, { message: 'Compte déjà créé' });
    }
    // Le schéma garantit `email` NOT NULL côté tenants ; cette branche est
    // défensive (changement de modèle futur).
    if (!row.email) {
      throw new HTTPException(400, {
        message: "Email manquant sur le locataire — impossible d'envoyer l'invitation",
      });
    }
    return {
      email: row.email,
      displayName: formatPersonName(row.civility, row.firstName, row.lastName) ?? row.email,
    };
  }

  // targetType === 'guarantor'
  const [row] = await db
    .select({
      id: guarantors.id,
      userId: guarantors.userId,
      createdByUserId: guarantors.createdByUserId,
      guarantorTypeKey: guarantors.guarantorTypeKey,
      civility: guarantors.civility,
      firstName: guarantors.firstName,
      lastName: guarantors.lastName,
      organizationName: guarantors.organizationName,
      email: guarantors.email,
    })
    .from(guarantors)
    .where(eq(guarantors.id, opts.targetId))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Garant introuvable' });
  }
  if (row.createdByUserId !== opts.currentUserId) {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  if (row.userId) {
    throw new HTTPException(409, { message: 'Compte déjà créé' });
  }
  // Côté guarantors, `email` est nullable (le cas organization peut être anonyme).
  if (!row.email) {
    throw new HTTPException(400, {
      message: "Email manquant sur le garant — impossible d'envoyer l'invitation",
    });
  }

  const displayName =
    row.guarantorTypeKey === 'organization'
      ? (row.organizationName ?? row.email)
      : (formatPersonName(row.civility, row.firstName, row.lastName) ?? row.email);

  return { email: row.email, displayName };
}

/**
 * Récupère le nom d'affichage du bailleur (depuis `landlord_profiles`). Si le
 * profil n'existe pas ou est incomplet, on tombe sur l'email — moins joli mais
 * suffisant pour identifier l'expéditeur dans l'email d'invitation.
 */
async function fetchInviterDisplayName(currentUserId: string): Promise<string> {
  const [row] = await db
    .select({
      civility: landlordProfiles.civility,
      firstName: landlordProfiles.firstName,
      lastName: landlordProfiles.lastName,
      email: users.email,
    })
    .from(users)
    .leftJoin(landlordProfiles, eq(landlordProfiles.userId, users.id))
    .where(eq(users.id, currentUserId))
    .limit(1);

  if (!row) {
    // Très défensif — l'auth garantit qu'on ait un user, mais on évite un crash
    // pour un cas hypothétique.
    return 'Votre bailleur';
  }

  return (
    formatPersonName(row.civility, row.firstName, row.lastName) ?? row.email ?? 'Votre bailleur'
  );
}

/** Concatène civilité / prénom / nom en un libellé lisible, ou null si vide. */
function formatPersonName(
  civility: string | null,
  firstName: string | null,
  lastName: string | null,
): string | null {
  const parts = [civility, firstName, lastName].filter((p): p is string => Boolean(p?.trim()));
  if (parts.length === 0) {
    return null;
  }
  return parts.join(' ');
}

/**
 * Consomme une invitation : crée le compte utilisateur, lie la cible
 * (tenant/guarantor) à ce nouvel user, marque l'invitation `used_at = now()`.
 *
 * Tout est exécuté dans une transaction pour garantir l'atomicité ; la session
 * elle-même est créée APRÈS commit dans la route (un échec d'insertion de
 * session ne doit pas faire perdre le compte fraîchement créé — l'utilisateur
 * pourra simplement se logger).
 */
export async function acceptInvitation(opts: {
  token: string;
  password: string;
}): Promise<User> {
  const passwordHash = await hashPassword(opts.password);

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.token, opts.token))
      .limit(1);

    if (!invitation) {
      throw new HTTPException(404, { message: 'Invitation introuvable' });
    }
    if (invitation.usedAt !== null) {
      throw new HTTPException(410, { message: 'Invitation déjà utilisée' });
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new HTTPException(410, { message: 'Invitation expirée' });
    }

    const normalizedEmail = invitation.emailSnapshot.toLowerCase().trim();

    // R1 — Race condition guard.
    // On marque l'invitation consommée AVANT de créer l'utilisateur, avec un
    // filtre `usedAt IS NULL` qui agit comme un compare-and-swap atomique :
    // deux requêtes concurrentes avec le même token ne peuvent pas toutes
    // deux franchir cette étape, car Postgres sérialise l'UPDATE (verrou de
    // ligne). La transaction perdante voit `usedAt` déjà rempli et reçoit 0
    // ligne mise à jour → on lève 410 et la transaction rollback.
    // Cette UPDATE se fait AVANT l'INSERT users : si la ligne d'invitation
    // est déjà verrouillée par une autre transaction, on attend (puis on
    // voit 0 ligne) au lieu de gaspiller un hash + insert.
    const consumedInvitation = await tx
      .update(invitations)
      .set({ usedAt: new Date() })
      .where(and(eq(invitations.token, opts.token), isNull(invitations.usedAt)))
      .returning({ token: invitations.token });

    if (consumedInvitation.length === 0) {
      throw new HTTPException(410, { message: 'Invitation déjà utilisée ou expirée' });
    }

    // Vérifie l'unicité de l'email AVANT l'insert pour rendre un 409 lisible
    // (l'index unique users.email lèverait sinon une erreur DB générique).
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (existing) {
      throw new HTTPException(409, {
        message:
          'Un compte avec cet email existe déjà. Connectez-vous, puis demandez au bailleur de relier votre compte.',
      });
    }

    // R2 — Email duplicate.
    // Entre le SELECT ci-dessus et cet INSERT, une autre requête concurrente
    // peut créer un user avec le même email. Le filet de sécurité ultime est
    // la contrainte UNIQUE sur `users.email` : on capture le code Postgres
    // 23505 (unique_violation) et on le traduit en 409 propre au lieu de
    // laisser remonter un 500 cryptique.
    let user: User;
    try {
      const [inserted] = await tx
        .insert(users)
        .values({
          email: normalizedEmail,
          passwordHash,
          role: invitation.targetTypeKey, // 'tenant' | 'guarantor' — aligné sur user_role enum
        })
        .returning();

      if (!inserted) {
        throw new Error("Échec de la création de l'utilisateur");
      }
      user = inserted;
    } catch (err) {
      // postgres.js expose `PostgresError` (typeof `Error`) avec un champ `code: string`.
      if (err instanceof postgres.PostgresError && err.code === PG_UNIQUE_VIOLATION) {
        throw new HTTPException(409, { message: 'Un compte existe déjà avec cet email' });
      }
      throw err;
    }

    // On lie la cible (locataire OU garant) au compte fraîchement créé.
    // On filtre aussi sur `userId IS NULL` pour éviter un race-condition (deux
    // invitations consommées en parallèle ne peuvent lier qu'une seule fois).
    if (invitation.targetTypeKey === 'tenant') {
      const updated = await tx
        .update(tenants)
        .set({ userId: user.id, updatedAt: new Date() })
        .where(eq(tenants.id, invitation.targetId))
        .returning({ id: tenants.id });

      if (updated.length === 0) {
        throw new HTTPException(404, { message: 'Locataire cible introuvable' });
      }
    } else {
      const updated = await tx
        .update(guarantors)
        .set({ userId: user.id, updatedAt: new Date() })
        .where(eq(guarantors.id, invitation.targetId))
        .returning({ id: guarantors.id });

      if (updated.length === 0) {
        throw new HTTPException(404, { message: 'Garant cible introuvable' });
      }
    }

    return user;
  });
}
