import type { Context } from 'hono';
import { db } from '../db/client.js';
import { auditLogs } from '../db/schema/audit-logs.js';
import { logger } from './logger.js';

/**
 * Liste typée des actions auditables. Ajouter une entrée ici quand une
 * nouvelle opération sensible apparaît dans le code. Convention :
 *   <entity>.<verb_or_event>
 * Les actions sans entité (login/logout) restent à plat.
 */
export type AuditAction =
  | 'login'
  | 'logout'
  | 'lease.create'
  | 'lease.update'
  | 'lease.status_change'
  | 'lease.delete'
  | 'property.create'
  | 'property.update'
  | 'property.delete'
  | 'tenant.create'
  | 'tenant.update'
  | 'tenant.delete'
  | 'guarantor.create'
  | 'guarantor.update'
  | 'guarantor.delete'
  | 'document.upload'
  | 'document.validate'
  | 'document.reject'
  | 'document.delete'
  | 'document.restore'
  | 'document_share.create'
  | 'document_share.revoke'
  | 'invitation.create'
  | 'invitation.accept'
  | 'rent_period.update'
  | 'rent_period.mark_paid'
  | 'rent_period.mark_unpaid'
  | 'rent_period.send_notice'
  | 'config.update'
  | 'landlord_profile.update'
  | 'migration.import';

export type AuditEntry = {
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  payload?: unknown;
};

/**
 * Enregistre une action effectuée par un utilisateur authentifié. L'IP et
 * le user-agent sont extraits du contexte HTTP courant.
 *
 * Règle d'or : un échec d'insertion ne doit JAMAIS faire échouer la requête
 * applicative — on log et on continue. L'audit est un best-effort.
 */
export async function recordUserAudit(
  c: Context,
  userId: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorType: 'user',
      actorUserId: userId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      payload: entry.payload as object | null | undefined,
      // `x-forwarded-for` peut contenir une chaîne d'IPs (proxy chain) ; on
      // ne garde que la première (l'IP cliente d'origine).
      ipAddress: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
  } catch (err) {
    // Audit failure must NEVER break the user request
    logger.warn({ err, entry, userId }, 'audit: insert failed (non-blocking)');
  }
}

/**
 * Enregistre une action déclenchée par le scheduler (cron, jobs récurrents).
 * Aucun acteur user n'est associé.
 */
export async function recordSchedulerAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorType: 'scheduler',
      actorUserId: null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      payload: entry.payload as object | null | undefined,
      ipAddress: null,
      userAgent: 'scheduler',
    });
  } catch (err) {
    logger.warn({ err, entry }, 'audit: scheduler insert failed (non-blocking)');
  }
}

/**
 * Enregistre une action système (bootstrap, migration, opération de
 * maintenance). Aucun acteur user n'est associé.
 */
export async function recordSystemAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorType: 'system',
      actorUserId: null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      payload: entry.payload as object | null | undefined,
      ipAddress: null,
      userAgent: 'system',
    });
  } catch (err) {
    logger.warn({ err, entry }, 'audit: system insert failed (non-blocking)');
  }
}
