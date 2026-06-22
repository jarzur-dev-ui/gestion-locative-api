import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { WEB_APP_BASE_URL } from '../../config/app.js';
import { db } from '../../db/client.js';
import { passwordResetTokens } from '../../db/schema/password-reset-tokens.js';
import { sessions } from '../../db/schema/sessions.js';
import { users } from '../../db/schema/users.js';
import { renderPasswordResetEmail } from '../../lib/email-templates.js';
import { sendEmail } from '../../lib/mailer.js';
import { hashPassword } from './password.js';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 heure

function generateResetToken(): string {
  // 32 bytes = 256 bits d'entropie, url-safe via base64url. Même format que les
  // tokens de session et d'invitation.
  return randomBytes(32).toString('base64url');
}

function buildResetLink(token: string): string {
  // Path param pour correspondre à la route front réelle `/reset-password/:token`.
  return `${WEB_APP_BASE_URL}/reset-password/${encodeURIComponent(token)}`;
}

/**
 * Démarre une demande de réinitialisation de mot de passe.
 *
 * Anti-énumération : on ne révèle JAMAIS si l'email correspond à un compte. La
 * fonction résout toujours normalement (la route renvoie 204 quoi qu'il arrive).
 * Un token n'est généré et un email envoyé QUE si l'utilisateur existe ET possède
 * déjà un mot de passe (`passwordHash` non null) — un invité non activé doit
 * utiliser son lien d'invitation, pas un reset.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  const [user] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  // Email inconnu OU compte sans mot de passe (invité non activé) : on ne fait
  // rien et on résout normalement pour ne pas révéler l'existence du compte.
  if (!user || !user.passwordHash) {
    return;
  }

  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await db.insert(passwordResetTokens).values({
    token,
    userId: user.id,
    expiresAt,
  });

  // Les erreurs SMTP sont déjà capturées et loguées par `sendEmail` — on ne fait
  // pas échouer la demande si l'envoi échoue.
  const { subject, html, text } = renderPasswordResetEmail({
    resetLink: buildResetLink(token),
  });
  await sendEmail({ to: user.email, subject, html, text });
}

/**
 * Consomme un token de réinitialisation : vérifie sa validité, met à jour le
 * mot de passe de l'utilisateur, marque le token `used_at = now()` et supprime
 * TOUTES les sessions de l'utilisateur (un reset doit invalider tout accès
 * potentiellement compromis). Le tout dans une transaction pour l'atomicité.
 *
 * N'ouvre PAS de session : l'utilisateur doit se reconnecter avec son nouveau
 * mot de passe.
 */
export async function resetPassword(opts: {
  token: string;
  password: string;
}): Promise<{ userId: string }> {
  return db.transaction(async (tx) => {
    const [resetToken] = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token, opts.token))
      .limit(1);

    if (!resetToken) {
      throw new HTTPException(404, { message: 'Lien introuvable' });
    }
    if (resetToken.usedAt !== null) {
      throw new HTTPException(410, { message: 'Lien déjà utilisé' });
    }
    if (resetToken.expiresAt.getTime() < Date.now()) {
      throw new HTTPException(410, { message: 'Lien expiré' });
    }

    // Compare-and-swap atomique : le filtre `usedAt IS NULL` agit comme un
    // verrou logique. Deux requêtes concurrentes avec le même token ne peuvent
    // pas toutes deux franchir cette étape (Postgres sérialise l'UPDATE) ; la
    // perdante voit 0 ligne mise à jour → 410 et rollback.
    const consumed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.token, opts.token), isNull(passwordResetTokens.usedAt)))
      .returning({ token: passwordResetTokens.token });

    if (consumed.length === 0) {
      throw new HTTPException(410, { message: 'Lien déjà utilisé' });
    }

    // Anti DoS (hash-amplification) : le hash Argon2 est coûteux (CPU + RAM).
    // On ne le calcule qu'APRÈS avoir validé ET consommé le token (CAS
    // `usedAt IS NULL` réussi) — un attaquant qui spamme l'endpoint avec un
    // token invalide est rejeté avant tout travail cryptographique.
    const passwordHash = await hashPassword(opts.password);

    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, resetToken.userId));

    // Invalide toutes les sessions existantes de l'utilisateur : un reset de mot
    // de passe doit révoquer tout accès potentiellement compromis.
    await tx.delete(sessions).where(eq(sessions.userId, resetToken.userId));

    return { userId: resetToken.userId };
  });
}
