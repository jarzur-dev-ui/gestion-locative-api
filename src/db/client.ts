import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { documentShares } from './schema/document-shares.js';
import { documents } from './schema/documents.js';
import { guarantors } from './schema/guarantors.js';
import { invitations } from './schema/invitations.js';
import { landlordProfiles } from './schema/landlord-profiles.js';
import { leaseGuarantors } from './schema/lease-guarantors.js';
import { leaseTenants } from './schema/lease-tenants.js';
import { leases } from './schema/leases.js';
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
  documents,
  documentShares,
  rentPeriods,
};

const queryClient = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'production' ? 20 : 5,
});

export const db = drizzle(queryClient, { schema, logger: env.NODE_ENV !== 'production' });

export type Database = typeof db;
