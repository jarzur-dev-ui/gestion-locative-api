import type { Dirent } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { documents } from '../db/schema/documents.js';
import { logger } from '../lib/logger.js';
import { deleteFile } from '../lib/storage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Age threshold below which we won't delete a disk file even if it has no DB
 * reference. This is the safety margin against the inherent race between
 * `storeFile` (volume write) and the subsequent `INSERT` into `documents` :
 *   1. POST /documents writes the file to the volume.
 *   2. The API process inserts the row into `documents`.
 *   3. Between 1 and 2 (or if 2 fails / the process crashes) the file is
 *      orphaned on disk.
 *
 * If the cron ran during step 1→2 and we deleted everything it saw, we'd
 * race-delete in-flight uploads. 7 days is wildly more than any reasonable
 * upload + retry window, while still bounding disk leaks to a week.
 */
const ORPHAN_AGE_THRESHOLD_DAYS = 7;
const ORPHAN_AGE_THRESHOLD_MS = ORPHAN_AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrphanCleanupResult = {
  filesScanned: number;
  orphansFound: number;
  orphansDeleted: number;
  orphansSkippedYoung: number;
  errors: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Convert a (potentially Windows-style) relative path to POSIX form so it
 * matches what `storeFile` writes into `documents.file_path` — `storeFile`
 * always uses `path.posix.join`, so on disk the canonical reference is the
 * forward-slash form regardless of the host OS.
 */
function toPosix(relPath: string): string {
  if (path.sep === '/') return relPath;
  return relPath.split(path.sep).join('/');
}

/**
 * Recursively walk `dir` and push every regular file's absolute path into
 * `out`. Symlinks (file or dir) are ignored — we never follow them and never
 * delete them. Errors on individual entries are caught and counted via the
 * `onError` callback so that one unreadable file doesn't abort the scan.
 */
async function walkRegularFiles(
  dir: string,
  out: string[],
  onError: (err: unknown, context: string) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Directory disappeared mid-scan or unreadable — record and move on.
    if (isNodeErrnoException(err) && err.code === 'ENOENT') return;
    onError(err, `readdir ${dir}`);
    return;
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);

    // Defensive: skip symlinks even though we'd already detect them via the
    // dirent. `withFileTypes` populates entry.isSymbolicLink() reliably.
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkRegularFiles(abs, out, onError);
      continue;
    }

    if (entry.isFile()) {
      out.push(abs);
    }
    // Other entry types (sockets, devices, FIFOs…) are silently ignored.
  }
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export async function runDocumentsOrphanCleanupTask(): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    filesScanned: 0,
    orphansFound: 0,
    orphansDeleted: 0,
    orphansSkippedYoung: 0,
    errors: 0,
  };

  const storageRoot = path.resolve(env.FILES_STORAGE_PATH);

  logger.info(
    {
      storageRoot,
      thresholdDays: ORPHAN_AGE_THRESHOLD_DAYS,
    },
    'scheduler: orphan-cleanup — start',
  );

  // ---------------------------------------------------------------------
  // 0. Pre-flight : storage root must exist and be a directory.
  // ---------------------------------------------------------------------
  try {
    const rootStat = await lstat(storageRoot);
    if (!rootStat.isDirectory()) {
      logger.warn(
        { storageRoot },
        'scheduler: orphan-cleanup — storage root is not a directory, skipping',
      );
      return result;
    }
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      logger.warn({ storageRoot }, 'scheduler: orphan-cleanup — storage root missing, skipping');
      return result;
    }
    result.errors += 1;
    logger.error({ err, storageRoot }, 'scheduler: orphan-cleanup — pre-flight lstat failed');
    return result;
  }

  // ---------------------------------------------------------------------
  // 1. Build the DB-known set of file paths.
  //
  // We deliberately do NOT filter by deletedAt : soft-deleted documents
  // still have their physical file on the volume (purge happens in a
  // separate TTL job). Removing them here would corrupt the soft-delete
  // contract.
  // ---------------------------------------------------------------------
  let dbPaths: Set<string>;
  try {
    const rows = await db.select({ filePath: documents.filePath }).from(documents);
    dbPaths = new Set(rows.map((r) => toPosix(r.filePath)));
  } catch (err) {
    result.errors += 1;
    logger.error({ err }, 'scheduler: orphan-cleanup — failed to load DB file paths');
    return result;
  }

  // ---------------------------------------------------------------------
  // 2. Walk the volume.
  // ---------------------------------------------------------------------
  const diskFiles: string[] = [];
  await walkRegularFiles(storageRoot, diskFiles, (err, context) => {
    result.errors += 1;
    logger.error({ err, context }, 'scheduler: orphan-cleanup — walk error');
  });
  result.filesScanned = diskFiles.length;

  // ---------------------------------------------------------------------
  // 3. For each disk file, decide : known / young orphan / deletable.
  // ---------------------------------------------------------------------
  const now = Date.now();

  for (const absPath of diskFiles) {
    const relPath = toPosix(path.relative(storageRoot, absPath));

    if (dbPaths.has(relPath)) {
      continue;
    }

    result.orphansFound += 1;

    // Stat to get mtime. If the file vanished between walk and stat
    // (e.g. concurrent cleanup, manual rm), ignore it.
    let mtimeMs: number;
    try {
      const s = await stat(absPath);
      mtimeMs = s.mtimeMs;
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') {
        // Already gone — nothing to do.
        continue;
      }
      result.errors += 1;
      logger.error({ err, path: relPath }, 'scheduler: orphan-cleanup — stat failed');
      continue;
    }

    const ageMs = now - mtimeMs;

    if (ageMs < ORPHAN_AGE_THRESHOLD_MS) {
      result.orphansSkippedYoung += 1;
      continue;
    }

    try {
      await deleteFile(relPath);
      result.orphansDeleted += 1;
      logger.debug(
        { path: relPath, ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)) },
        'scheduler: orphan-cleanup — orphan deleted',
      );
    } catch (err) {
      result.errors += 1;
      logger.error({ err, path: relPath }, 'scheduler: orphan-cleanup — delete failed');
    }
  }

  logger.info({ ...result }, 'scheduler: orphan-cleanup — done');

  return result;
}
