import 'dotenv/config';
import postgres from 'postgres';
import { CONFIG_DEFAULTS } from '../src/modules/config/config.defaults.js';

(async () => {
  const overwrite = process.argv.includes('--overwrite');
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const { key, value, description } of CONFIG_DEFAULTS) {
      const existing = await sql`SELECT key FROM config_entries WHERE key = ${key}`;
      if (existing.length === 0) {
        await sql`
          INSERT INTO config_entries (key, value, description)
          VALUES (${key}, ${sql.json(value as object)}, ${description})
        `;
        inserted += 1;
      } else if (overwrite) {
        await sql`
          UPDATE config_entries
          SET value = ${sql.json(value as object)}, description = ${description}, updated_at = NOW()
          WHERE key = ${key}
        `;
        updated += 1;
      } else {
        skipped += 1;
      }
    }
    console.log(
      `Seed config: inserted=${inserted}, updated=${updated}, skipped=${skipped} (total=${CONFIG_DEFAULTS.length})`,
    );
    if (skipped > 0 && !overwrite) {
      console.log('Pass --overwrite to refresh existing keys with the new defaults.');
    }
  } finally {
    await sql.end();
  }
})();
