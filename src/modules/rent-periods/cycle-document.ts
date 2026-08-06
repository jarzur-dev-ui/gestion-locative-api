import type {
  CycleDocumentData,
  CycleNoticeSection,
  CycleReceiptSection,
  LandlordInfo,
  PropertyInfo,
  RentAdjustment,
  TenantInfo,
} from '../../lib/pdf-renderer.js';
import type { LeaseCyclePlan } from './cycle-planning.js';
import { firstDayToPeriodMonth } from './period-generation.js';

// ---------------------------------------------------------------------------
// Assemblage du document de cycle (logique pure, testable sans DB).
//
// Transforme les lignes `rent_periods` + le plan produit par `planLeaseCycle`
// en `CycleDocumentData` prêt pour le renderer PDF. Aucun accès DB ici.
// ---------------------------------------------------------------------------

export type CyclePeriodRow = {
  id: string;
  /** 'YYYY-MM-01' (colonne DB `date`). */
  periodMonth: string;
  baseRentCents: number;
  baseChargesCents: number;
  adjustments: { type: string; labelKey?: string; label?: string; amountCents: number }[];
  totalDueCents: number;
  /** 'YYYY-MM-DD'. */
  dueDate: string;
  paidAt: Date | null;
};

export type CycleLeaseContext = {
  landlord: LandlordInfo;
  tenants: TenantInfo[];
  property: PropertyInfo;
};

function mapAdjustments(adjs: CyclePeriodRow['adjustments']): RentAdjustment[] {
  return adjs.map((a) => ({
    labelKey: a.labelKey ?? a.type,
    amountCents: a.amountCents,
    label: a.label,
  }));
}

export function assembleCycleDocument(
  ctx: CycleLeaseContext,
  periods: CyclePeriodRow[],
  plan: LeaseCyclePlan,
  generatedAt: Date,
): CycleDocumentData {
  const periodsById = new Map(periods.map((p) => [p.id, p]));

  const receipts: CycleReceiptSection[] = plan.receiptPeriodIds
    .map((id) => periodsById.get(id))
    .filter((p): p is CyclePeriodRow => p !== undefined)
    .map((p) => ({
      periodMonth: firstDayToPeriodMonth(p.periodMonth),
      baseRentCents: p.baseRentCents,
      baseChargesCents: p.baseChargesCents,
      adjustments: mapAdjustments(p.adjustments),
      totalDueCents: p.totalDueCents,
      paidAt: (p.paidAt ?? generatedAt).toISOString().slice(0, 10),
    }));

  const noticePeriod =
    plan.noticePeriodId === null ? undefined : periodsById.get(plan.noticePeriodId);

  const notice: CycleNoticeSection | null = noticePeriod
    ? {
        periodMonth: firstDayToPeriodMonth(noticePeriod.periodMonth),
        baseRentCents: noticePeriod.baseRentCents,
        baseChargesCents: noticePeriod.baseChargesCents,
        adjustments: mapAdjustments(noticePeriod.adjustments),
        totalDueCents: noticePeriod.totalDueCents,
        dueDate: noticePeriod.dueDate,
        previousBalanceCents: plan.previousBalanceCents,
      }
    : null;

  return {
    landlord: ctx.landlord,
    tenants: ctx.tenants,
    property: ctx.property,
    receipts,
    notice,
    generatedAt,
  };
}
