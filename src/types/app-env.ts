import type { Session } from '../db/schema/sessions.js';
import type { User } from '../db/schema/users.js';

export type AppVariables = {
  user: User | null;
  session: Session | null;
};

export type AppEnv = {
  Variables: AppVariables;
};
