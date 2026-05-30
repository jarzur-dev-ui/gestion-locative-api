import 'dotenv/config';
import postgres from 'postgres';

(async () => {
  const leaseId = process.argv[2];
  if (!leaseId) {
    console.error('Usage: pnpm tsx scripts/seed-rent-period.ts <leaseId> [periodMonth=2026-06]');
    process.exit(1);
  }
  const periodMonth = process.argv[3] ?? '2026-06';
  const periodFirstDay = `${periodMonth}-01`;
  const dueDate = `${periodMonth}-05`;

  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const result = await sql`
      INSERT INTO rent_periods (
        lease_id, period_month, base_rent_cents, base_charges_cents,
        total_due_cents, due_date, status_key, adjustments
      )
      VALUES (${leaseId}, ${periodFirstDay}, 85000, 5000, 90000, ${dueDate}, 'draft', '[]'::jsonb)
      ON CONFLICT (lease_id, period_month) DO UPDATE SET
        status_key = 'draft',
        paid_at = NULL,
        paid_by_user_id = NULL,
        receipt_document_id = NULL,
        notice_sent_at = NULL,
        notice_document_id = NULL,
        updated_at = NOW()
      RETURNING id, lease_id, period_month, status_key
    `;
    console.log('Period upserted:', result[0]);
  } finally {
    await sql.end();
  }
})();
