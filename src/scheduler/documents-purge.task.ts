import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents } from '../db/schema/documents.js';
import { logger } from '../lib/logger.js';
import { deleteFile, getFileStat } from '../lib/storage.js';
import { getByKey } from '../modules/config/config.service.js';

/**
 * TTL par défaut (en jours) avant purge définitive d'un document soft-deleted.
 * Utilisé si `config_entries['document.soft_delete_ttl_days']` est absent
 * ou contient une valeur invalide.
 */
const DEFAULT_SOFT_DELETE_TTL_DAYS = 90;

/**
 * Batch max par run pour ne pas surcharger volume + DB sur un premier
 * passage. Le cron tourne quotidiennement → 100/jour = 3000/mois absorbés.
 */
const PURGE_BATCH_LIMIT = 100;

export type DocumentsPurgeResult = {
  /** Lignes définitivement supprimées de `documents`. */
  purged: number;
  /** Fichiers déjà absents du volume au moment de la purge (incohérence DB↔FS). */
  orphanFiles: number;
};

/**
 * Lit `config_entries['document.soft_delete_ttl_days']` avec fallback :
 *  - clé absente → DEFAULT_SOFT_DELETE_TTL_DAYS
 *  - valeur non numérique ou <= 0 → DEFAULT_SOFT_DELETE_TTL_DAYS (log warn)
 */
async function getSoftDeleteTtlDays(): Promise<number> {
  const entry = await getByKey('document.soft_delete_ttl_days');
  if (!entry) return DEFAULT_SOFT_DELETE_TTL_DAYS;

  const raw = entry.value;
  const n = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { key: 'document.soft_delete_ttl_days', value: raw },
      'documents-purge: TTL config invalide, fallback à la valeur par défaut',
    );
    return DEFAULT_SOFT_DELETE_TTL_DAYS;
  }
  return Math.floor(n);
}

/**
 * Purge définitive des documents soft-deleted dont `deleted_at < now() - TTL`.
 *
 * Pour chaque ligne candidate :
 *  1. Supprime le binaire du volume (`deleteFile` est idempotent).
 *  2. Supprime la ligne en DB.
 *
 * Les deux étapes sont enveloppées dans une transaction par document : si la
 * DB échoue après le `deleteFile`, on a un fichier déjà supprimé mais la
 * ligne reste — le run suivant la reprendra, et `deleteFile` no-op via son
 * idempotence (ENOENT swallowed). On compte ce cas comme `orphanFiles` pour
 * tracer les incohérences DB↔FS.
 *
 * Limite `PURGE_BATCH_LIMIT` par run.
 */
export async function runDocumentsPurgeTask(): Promise<DocumentsPurgeResult> {
  const ttlDays = await getSoftDeleteTtlDays();
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select({
      id: documents.id,
      filePath: documents.filePath,
    })
    .from(documents)
    .where(and(isNotNull(documents.deletedAt), lt(documents.deletedAt, cutoff)))
    .limit(PURGE_BATCH_LIMIT);

  if (candidates.length === 0) {
    logger.debug({ ttlDays, cutoff: cutoff.toISOString() }, 'documents-purge: rien à purger');
    return { purged: 0, orphanFiles: 0 };
  }

  let purged = 0;
  let orphanFiles = 0;

  for (const doc of candidates) {
    try {
      // Best-effort : on regarde si le fichier existait avant suppression
      // pour comptabiliser les orphans (fichier déjà absent côté volume).
      const existedBefore = await fileExistsBestEffort(doc.filePath);

      await db.transaction(async (tx) => {
        // On supprime d'abord le fichier (idempotent), puis la ligne. Si la
        // DELETE en DB throw, la transaction rollback la ligne mais le
        // fichier reste supprimé — c'est acceptable : prochain run, deleteFile
        // no-op, et la ligne sera nettoyée.
        await deleteFile(doc.filePath);
        await tx.delete(documents).where(eq(documents.id, doc.id));
      });

      if (!existedBefore) {
        orphanFiles += 1;
      }
      purged += 1;
    } catch (err) {
      logger.error(
        { err, documentId: doc.id, filePath: doc.filePath },
        "documents-purge: échec de la purge d'un document — sera retenté",
      );
    }
  }

  logger.info(
    {
      ttlDays,
      cutoff: cutoff.toISOString(),
      purged,
      orphanFiles,
      batch: candidates.length,
    },
    'documents-purge: run terminé',
  );

  return { purged, orphanFiles };
}

/**
 * Helper : best-effort pour savoir si un fichier existe avant suppression.
 * Si `getFileStat` lève (ex: perms), on assume qu'il existe pour ne pas
 * compter à tort en orphan.
 */
async function fileExistsBestEffort(relPath: string): Promise<boolean> {
  try {
    const stat = await getFileStat(relPath);
    return stat !== null;
  } catch {
    return true;
  }
}
