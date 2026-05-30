import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export const ALLOWED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

// NOTE (V1): the mime type is trusted from the caller (multipart claim).
// We do not sniff content magic bytes here — that would require a dep like
// `file-type`. Hardening flagged for M2.5.
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export class UnsupportedMimeTypeError extends StorageError {
  constructor(mimeType: string) {
    super(`Unsupported mime type: ${mimeType}`);
    this.name = 'UnsupportedMimeTypeError';
  }
}

export class FileTooLargeError extends StorageError {
  constructor(sizeBytes: number) {
    super(`File too large: ${sizeBytes} bytes (max ${MAX_UPLOAD_BYTES})`);
    this.name = 'FileTooLargeError';
  }
}

export class FileNotFoundError extends StorageError {
  constructor(relPath: string) {
    super(`File not found: ${relPath}`);
    this.name = 'FileNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StoredFile = {
  path: string;
  sizeBytes: number;
  mimeType: string;
  originalFilename: string;
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Absolute, resolved storage root. Resolved once at module init so that all
 * subsequent path-traversal checks have a stable anchor.
 */
const STORAGE_ROOT = path.resolve(env.FILES_STORAGE_PATH);

/**
 * Resolve a caller-supplied relative path against the storage root and ensure
 * the resulting absolute path stays inside the root. Protects against path
 * traversal (e.g. "../../etc/passwd", absolute paths, symlink-looking inputs).
 *
 * We rely on path.resolve to normalise "." and ".." segments, then compare
 * against the root with a trailing separator so that "/var/filesXYZ" is not
 * accepted when the root is "/var/files".
 */
function resolveSafePath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new StorageError('Invalid path');
  }
  const absolute = path.resolve(STORAGE_ROOT, relPath);
  const rootWithSep = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep;
  if (absolute !== STORAGE_ROOT && !absolute.startsWith(rootWithSep)) {
    throw new StorageError('Invalid path');
  }
  return absolute;
}

function extForMime(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new UnsupportedMimeTypeError(mimeType);
  }
  return ext;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a file to the volume. Validates mime type and size.
 * Generates a UUID-based path under <year>/<month>/.
 */
export async function storeFile(
  data: Buffer | Uint8Array,
  mimeType: string,
  originalFilename: string,
): Promise<StoredFile> {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new UnsupportedMimeTypeError(mimeType);
  }

  const sizeBytes = data.byteLength;
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new FileTooLargeError(sizeBytes);
  }

  const ext = extForMime(mimeType);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const uuid = randomUUID();
  const relPath = path.posix.join(year, month, `${uuid}.${ext}`);

  const absolutePath = resolveSafePath(relPath);
  const parentDir = path.dirname(absolutePath);

  await mkdir(parentDir, { recursive: true });
  await writeFile(absolutePath, data);

  logger.debug(
    {
      path: relPath,
      sizeBytes,
      mimeType,
      originalFilename,
    },
    'storage: file stored',
  );

  return {
    path: relPath,
    sizeBytes,
    mimeType,
    originalFilename,
  };
}

/**
 * Read a file as a Node Readable stream (for streaming to the HTTP response).
 * Throws FileNotFoundError if the path doesn't exist.
 */
export async function readFileStream(relPath: string): Promise<NodeJS.ReadableStream> {
  const absolute = resolveSafePath(relPath);

  // Confirm existence up-front so the caller gets a typed error instead of a
  // delayed stream-level 'error' event.
  try {
    await stat(absolute);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      throw new FileNotFoundError(relPath);
    }
    throw err;
  }

  return createReadStream(absolute);
}

/**
 * Read a file as a Buffer (utility for small files / preview).
 */
export async function readFileBuffer(relPath: string): Promise<Buffer> {
  const absolute = resolveSafePath(relPath);
  try {
    return await readFile(absolute);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      throw new FileNotFoundError(relPath);
    }
    throw err;
  }
}

/**
 * Get metadata for an existing file. Returns null if not found.
 */
export async function getFileStat(
  relPath: string,
): Promise<{ sizeBytes: number; mtime: Date } | null> {
  const absolute = resolveSafePath(relPath);
  try {
    const s = await stat(absolute);
    return { sizeBytes: s.size, mtime: s.mtime };
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Delete a file. No-op if already gone (idempotent).
 */
export async function deleteFile(relPath: string): Promise<void> {
  const absolute = resolveSafePath(relPath);
  try {
    await unlink(absolute);
    logger.debug({ path: relPath }, 'storage: file deleted');
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      // Idempotent: already gone is fine.
      return;
    }
    throw err;
  }
}
