import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { AuditLog } from '../../db/schema/audit-logs.js';
import { auditLogs } from '../../db/schema/audit-logs.js';
import { AUDIT_LOG_MAX_LIMIT } from './audit-logs.schemas.js';

export type ListAuditLogsForUserOpts = {
  /** Utilisateur courant : seules ses propres actions sont retournées en V1. */
  userId: string;
  /** Taille de page. Bornée côté service en plus de la validation Zod. */
  limit: number;
  /** Curseur cursor-based : created_at < before. */
  before?: Date;
  /** Filtre optionnel sur le nom d'action. */
  action?: string;
  /** Filtre optionnel sur le type d'acteur. */
  actorType?: 'user' | 'scheduler' | 'system';
  /** Filtre optionnel sur le type d'entité visée. */
  entityType?: string;
};

/**
 * Liste les entrées d'audit visibles par un bailleur.
 *
 * V1 — scope minimal :
 *   On retourne uniquement les actions dont l'utilisateur est l'auteur
 *   (`actor_user_id = :userId`). Cela couvre 100 % de "ses propres actions".
 *
 * V2 — élargissement prévu :
 *   Pour exposer aussi les actions effectuées par d'autres acteurs (locataire,
 *   garant, scheduler) SUR des entités dont le bailleur est propriétaire
 *   (baux, propriétés, documents…), il faudra joindre dynamiquement chaque
 *   `entity_type` à sa table source pour vérifier l'ownership. Ce sera plus
 *   coûteux et nécessite probablement une vue matérialisée ou un index
 *   spécifique. Hors-scope V1 par souci de simplicité.
 */
export async function listAuditLogsForUser(
  opts: ListAuditLogsForUserOpts,
): Promise<AuditLog[]> {
  const limit = Math.min(Math.max(opts.limit, 1), AUDIT_LOG_MAX_LIMIT);

  const conditions: SQL[] = [eq(auditLogs.actorUserId, opts.userId)];

  if (opts.before) {
    conditions.push(lt(auditLogs.createdAt, opts.before));
  }
  if (opts.action) {
    conditions.push(eq(auditLogs.action, opts.action));
  }
  if (opts.actorType) {
    conditions.push(eq(auditLogs.actorType, opts.actorType));
  }
  if (opts.entityType) {
    conditions.push(eq(auditLogs.entityType, opts.entityType));
  }

  // `and(...conditions)` retourne toujours une expression définie ici car
  // on a au minimum la condition sur actorUserId — pas besoin de gérer un
  // cas "where vide".
  const where = and(...conditions);

  return db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}

/**
 * Sérialisation publique. Le champ `payload` est typé `unknown` (jsonb libre).
 */
export function toPublicAuditLog(row: AuditLog): {
  id: string;
  actorType: 'user' | 'scheduler' | 'system';
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  payload: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
} {
  return {
    id: row.id,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payload,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}
