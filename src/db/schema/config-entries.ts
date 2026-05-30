import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const configEntries = pgTable('config_entries', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ConfigEntry = typeof configEntries.$inferSelect;
export type NewConfigEntry = typeof configEntries.$inferInsert;
