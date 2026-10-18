import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTS = {
  memoryCost: 19_456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS);
}

// Hash de référence pour un email inconnu : le login coûte alors le même temps qu'un vrai compte.
let dummyHash: Promise<string> | undefined;

export async function verifyPasswordAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
  return false;
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTS);
  } catch {
    return false;
  }
}
