import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { auditLogs } from './schema/audit-logs.js';
import { configEntries } from './schema/config-entries.js';
import { documentShares } from './schema/document-shares.js';
import { documents } from './schema/documents.js';
import { guarantors } from './schema/guarantors.js';
import { invitations } from './schema/invitations.js';
import { landlordProfiles } from './schema/landlord-profiles.js';
import { leaseGuarantors } from './schema/lease-guarantors.js';
import { leaseTenants } from './schema/lease-tenants.js';
import { leases } from './schema/leases.js';
import { passwordResetTokens } from './schema/password-reset-tokens.js';
import { properties } from './schema/properties.js';
import { rentPeriods } from './schema/rent-periods.js';
import { sessions } from './schema/sessions.js';
import { tenants } from './schema/tenants.js';
import { users } from './schema/users.js';

const schema = {
  users,
  sessions,
  landlordProfiles,
  properties,
  tenants,
  guarantors,
  leases,
  leaseTenants,
  leaseGuarantors,
  invitations,
  passwordResetTokens,
  documents,
  documentShares,
  rentPeriods,
  configEntries,
  auditLogs,
};

/**
 * Détermine s'il faut chiffrer la connexion DB (TLS). On active SSL dès que
 * l'hôte n'est PAS local (loopback / host.docker.internal) : une connexion qui
 * sort de la machine doit être chiffrée. Pour un Postgres local (dev, ou DB
 * co-localisée derrière `host.docker.internal` sur le même VPS) on reste en
 * clair — le trafic ne quitte pas l'hôte et le cert TLS serait superflu.
 */
function shouldUseSsl(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // URL non parsable : on ne force pas SSL (l'app crashera de toute façon
    // au premier query si l'URL est invalide).
    return false;
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
  return !localHosts.has(host);
}

const queryClient = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'production' ? 20 : 5,
  // `ssl: 'require'` → sémantique `sslmode=require` (chiffre sans vérifier la
  // CA). Suffisant pour empêcher l'écoute passive sur un réseau public ; pour
  // une vérification stricte de cert il faudrait passer un objet `{ ca, … }`.
  ssl: shouldUseSsl(env.DATABASE_URL) ? 'require' : false,
});

export const db = drizzle(queryClient, { schema, logger: env.NODE_ENV !== 'production' });

export type Database = typeof db;
