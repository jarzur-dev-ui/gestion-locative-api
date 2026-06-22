import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import type { User } from '../../db/schema/users.js';
import { users } from '../../db/schema/users.js';
import type { UserPublic } from './auth.schemas.js';
import { verifyPassword } from './password.js';

export async function authenticateByEmailAndPassword(
  email: string,
  password: string,
): Promise<User> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  if (!user || !user.passwordHash) {
    // Même message que mot de passe invalide pour ne pas révéler si l'email existe.
    throw new HTTPException(401, { message: 'Identifiants invalides' });
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    throw new HTTPException(401, { message: 'Identifiants invalides' });
  }

  return user;
}

export function toPublicUser(user: User): UserPublic {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}
