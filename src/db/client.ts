import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { sessions } from './schema/sessions.js';
import { users } from './schema/users.js';

const schema = { users, sessions };

const queryClient = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'production' ? 20 : 5,
});

export const db = drizzle(queryClient, { schema, logger: env.NODE_ENV !== 'production' });

export type Database = typeof db;
