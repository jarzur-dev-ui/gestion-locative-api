import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type ConfigEntry, configEntries } from '../../db/schema/config-entries.js';

export type ConfigMap = Record<string, unknown>;

export async function listAll(): Promise<ConfigMap> {
  const rows = await db.select().from(configEntries);
  const map: ConfigMap = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export async function getByKey(key: string): Promise<ConfigEntry | null> {
  const [row] = await db.select().from(configEntries).where(eq(configEntries.key, key)).limit(1);
  return row ?? null;
}

export async function upsertByKey(
  key: string,
  value: unknown,
  description: string | null | undefined,
): Promise<ConfigEntry> {
  const [row] = await db
    .insert(configEntries)
    .values({
      key,
      value,
      description: description ?? null,
    })
    .onConflictDoUpdate({
      target: configEntries.key,
      set: {
        value,
        ...(description !== undefined ? { description: description ?? null } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('Impossible de upsert la config entry');
  return row;
}

export function toPublicEntry(row: ConfigEntry): {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
} {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    updatedAt: row.updatedAt.toISOString(),
  };
}
