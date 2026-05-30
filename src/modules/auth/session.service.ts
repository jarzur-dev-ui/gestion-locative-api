import { randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema/sessions.js';
import type { Session } from '../../db/schema/sessions.js';
import { users } from '../../db/schema/users.js';
import type { User } from '../../db/schema/users.js';
import { env } from '../../config/env.js';

export const SESSION_COOKIE_NAME = 'gl_session';
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function generateSessionToken(): string {
  // 32 bytes = 256 bits d'entropie, encodé en base64url → 43 caractères url-safe.
  return randomBytes(32).toString('base64url');
}

export async function createSession(opts: {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<Session> {
  const id = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await db
    .insert(sessions)
    .values({
      id,
      userId: opts.userId,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    })
    .returning();
  if (!session) throw new Error('Impossible de créer la session');
  return session;
}

export type SessionWithUser = { session: Session; user: User };

export async function getSessionWithUser(token: string): Promise<SessionWithUser | null> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Session expirée → on la supprime et on renvoie null.
  if (row.session.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, token));
    return null;
  }

  // Refresh sliding-window : on bump last_seen_at à chaque requête authentifiée.
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, token));

  return row;
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, token));
}

export async function deleteExpiredSessions(): Promise<number> {
  const deleted = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning();
  return deleted.length;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}
