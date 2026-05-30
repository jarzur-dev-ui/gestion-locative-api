import { and, eq, isNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leases } from '../db/schema/leases.js';
import { properties } from '../db/schema/properties.js';
import { rentPeriods } from '../db/schema/rent-periods.js';
import { recordSchedulerAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import {
  computeDueDate,
  computeTotalDueCents,
  getNextPeriodMonth,
  periodMonthToFirstDay,
} from '../modules/rent-periods/period-generation.js';
import { sendNotice } from '../modules/rent-periods/rent-periods.service.js';

const NOTICE_LEAD_DAYS = 10;

export type DailyTaskResult = {
  periodsCreated: number;
  noticesSent: number;
  noticesFailed: number;
};

export async function runDailyRentPeriodTasks(): Promise<DailyTaskResult> {
  const periodsCreated = await createUpcomingPeriods();
  const { sent, failed } = await sendDueNotices();
  return { periodsCreated, noticesSent: sent, noticesFailed: failed };
}

/**
 * Pour chaque bail actif, crée le rent_period du mois prochain s'il n'existe pas déjà.
 * Idempotent grâce à la contrainte UNIQUE (lease_id, period_month).
 */
async function createUpcomingPeriods(): Promise<number> {
  const nextMonth = getNextPeriodMonth();
  const nextMonthFirstDay = periodMonthToFirstDay(nextMonth);

  const activeLeases = await db
    .select()
    .from(leases)
    .where(eq(leases.statusKey, 'active'));

  let created = 0;
  for (const lease of activeLeases) {
    const totalDueCents = computeTotalDueCents(
      lease.monthlyRentCents,
      lease.monthlyChargesCents,
      [],
    );
    const dueDate = computeDueDate(nextMonth, lease.paymentDay);

    try {
      const inserted = await db
        .insert(rentPeriods)
        .values({
          leaseId: lease.id,
          periodMonth: nextMonthFirstDay,
          baseRentCents: lease.monthlyRentCents,
          baseChargesCents: lease.monthlyChargesCents,
          adjustments: [],
          totalDueCents,
          dueDate,
          statusKey: 'draft',
        })
        .onConflictDoNothing({ target: [rentPeriods.leaseId, rentPeriods.periodMonth] })
        .returning({ id: rentPeriods.id });

      if (inserted.length > 0) created += 1;
    } catch (err) {
      logger.error(
        { err, leaseId: lease.id, periodMonth: nextMonth },
        'scheduler: rent-period creation failed',
      );
    }
  }

  if (created > 0) {
    logger.info({ count: created, periodMonth: nextMonth }, 'scheduler: rent-periods created');
  }
  return created;
}

/**
 * Trouve toutes les périodes draft dont la due_date est dans <= 10 jours
 * et n'ont pas encore d'avis envoyé, puis envoie l'avis pour chacune.
 */
async function sendDueNotices(): Promise<{ sent: number; failed: number }> {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + NOTICE_LEAD_DAYS);
  // Date column comparison : format YYYY-MM-DD
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  // Lookup periods with their lease owner — the scheduler acts "as" the landlord
  // for each period so the existing ACL passes naturally.
  const dueDrafts = await db
    .select({ id: rentPeriods.id, ownerUserId: properties.ownerUserId })
    .from(rentPeriods)
    .innerJoin(leases, eq(leases.id, rentPeriods.leaseId))
    .innerJoin(properties, eq(properties.id, leases.propertyId))
    .where(
      and(
        eq(rentPeriods.statusKey, 'draft'),
        lte(rentPeriods.dueDate, cutoffDate),
        isNull(rentPeriods.noticeSentAt),
      ),
    );

  let sent = 0;
  let failed = 0;
  for (const { id, ownerUserId } of dueDrafts) {
    try {
      await sendNotice(id, ownerUserId);
      sent += 1;
      // Audit non-bloquant : le helper avale toute exception (cf. recordSchedulerAudit).
      // `automated: true` permet de distinguer côté investigation un envoi
      // automatique d'un envoi manuel (lui audité par `rent_period.send_notice`
      // côté route avec `actorType = user`).
      await recordSchedulerAudit({
        action: 'rent_period.send_notice',
        entityType: 'rent_period',
        entityId: id,
        payload: { automated: true },
      });
    } catch (err) {
      failed += 1;
      logger.error({ err, rentPeriodId: id }, 'scheduler: send-notice failed');
    }
  }

  if (sent > 0 || failed > 0) {
    logger.info({ sent, failed, cutoffDate }, 'scheduler: notices processed');
  }
  return { sent, failed };
}
