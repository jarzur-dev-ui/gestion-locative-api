import 'dotenv/config';
import postgres from 'postgres';
import { hashPassword } from '../src/modules/auth/password.js';

(async () => {
  const email = process.argv[2] ?? 'bailleur@zeleph.fr';
  const password = process.argv[3] ?? 'Test1234!';
  const role = (process.argv[4] ?? 'landlord') as 'landlord' | 'tenant' | 'guarantor';

  const sql = postgres(process.env.DATABASE_URL!);
  const hash = await hashPassword(password);

  try {
    const result = await sql`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${hash}, ${role})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
      RETURNING id, email, role
    `;
    console.log('User upserted:', result[0]);
    console.log(`\n🔑 Identifiants:\n  email: ${email}\n  password: ${password}`);
  } finally {
    await sql.end();
  }
})();
