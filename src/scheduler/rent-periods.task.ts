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
  noticeCutoffDate,
  periodMonthToFirstDay,
} from '../modules/rent-periods/period-generation.js';
import { sendLeaseCycle } from '../modules/rent-periods/rent-periods.service.js';

// Avis envoyé 3 jours avant l'échéance (paiement dans le mois — cf. cadence
// façon agence : la quittance du mois précédent + l'avis du mois à venir).
const NOTICE_LEAD_DAYS = 3;

export type DailyTaskResult = {
  periodsCreated: number;
  cyclesDelivered: number;
  cyclesFailed: number;
};

export async function runDailyRentPeriodTasks(): Promise<DailyTaskResult> {
  const periodsCreated = await createUpcomingPeriods();
  const { delivered, failed } = await sendDueCycles();
  return { periodsCreated, cyclesDelivered: delivered, cyclesFailed: failed };
}

/**
 * Pour chaque bail actif, crée le rent_period du mois prochain s'il n'existe pas déjà.
 * Idempotent grâce à la contrainte UNIQUE (lease_id, period_month).
 */
async function createUpcomingPeriods(): Promise<number> {
  const nextMonth = getNextPeriodMonth();
  const nextMonthFirstDay = periodMonthToFirstDay(nextMonth);

  const activeLeases = await db.select().from(leases).where(eq(leases.statusKey, 'active'));

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
 * Trouve tous les baux ayant une période draft dont la due_date est <= J+3
 * et sans avis envoyé, puis envoie le document de cycle (quittances + avis)
 * une fois par bail.
 */
async function sendDueCycles(): Promise<{ delivered: number; failed: number }> {
  const cutoffDate = noticeCutoffDate(new Date(), NOTICE_LEAD_DAYS);

  // Lookup periods with their lease owner — the scheduler acts "as" the landlord
  // for each period so the existing ACL passes naturally.
  const dueDrafts = await db
    .select({ leaseId: rentPeriods.leaseId, ownerUserId: properties.ownerUserId })
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

  // Sécurité : normalement ≤ 1 période draft due par bail, mais on déduplique
  // pour ne pas envoyer le cycle deux fois au même bail.
  const ownerIdByLeaseId = new Map<string, string>();
  for (const { leaseId, ownerUserId } of dueDrafts) {
    ownerIdByLeaseId.set(leaseId, ownerUserId);
  }

  let delivered = 0;
  let failed = 0;
  for (const [leaseId, ownerUserId] of ownerIdByLeaseId) {
    try {
      const result = await sendLeaseCycle(leaseId, ownerUserId, new Date(), NOTICE_LEAD_DAYS);
      if (result.delivered) {
        delivered += 1;
        await recordSchedulerAudit({
          action: 'rent_period.send_cycle',
          entityType: 'lease',
          entityId: leaseId,
          payload: {
            automated: true,
            receiptCount: result.receiptCount,
            noticeSent: result.noticeSent,
          },
        });
      }
    } catch (err) {
      failed += 1;
      logger.error({ err, leaseId }, 'scheduler: send-cycle failed');
    }
  }

  if (delivered > 0 || failed > 0) {
    logger.info({ delivered, failed, cutoffDate }, 'scheduler: cycles processed');
  }
  return { delivered, failed };
}
