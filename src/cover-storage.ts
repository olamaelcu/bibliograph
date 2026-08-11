import { Operator } from 'opendal';
import type { CoverCollection, CoverFormat, CoverSize } from './cover-types.js';
import { variantKey, variantUrl } from './cover-types.js';

let _op: Operator | null = null;

export interface CoverStorageConfig {
  kind: string;
  root: string;
}

/**
 * Read COVER_STORAGE_KIND / COVER_STORAGE_ROOT from the environment, with
 * sensible defaults for dev (local filesystem under ./data/covers).
 */
export function loadCoverStorageConfig(env: NodeJS.ProcessEnv = process.env): CoverStorageConfig {
  return {
    kind: env.COVER_STORAGE_KIND ?? 'fs',
    root: env.COVER_STORAGE_ROOT ?? './data/covers',
  };
}

/**
 * Lazily-initialised OpenDAL operator. Subsequent calls reuse the same
 * instance. Re-call `setCoverStorage(null)` in tests to reset.
 */
export function getCoverStorage(): Operator {
  if (_op) return _op;
  const cfg = loadCoverStorageConfig();
  _op = new Operator(cfg.kind, { root: cfg.root });
  return _op;
}

export function setCoverStorage(op: Operator | null): void {
  _op = op;
}

export function coverKey(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
): string {
  return variantKey(collection, rkey, size, format);
}

export function coverPublicUrl(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
): string {
  return variantUrl(collection, rkey, size, format);
}

export async function readCover(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
): Promise<Buffer | null> {
  const op = getCoverStorage();
  const key = coverKey(collection, rkey, size, format);
  try {
    return await op.read(key);
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function writeCover(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
  data: Buffer,
): Promise<void> {
  const op = getCoverStorage();
  const key = coverKey(collection, rkey, size, format);
  await op.write(key, data);
}

export async function coverExists(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
): Promise<boolean> {
  const op = getCoverStorage();
  const key = coverKey(collection, rkey, size, format);
  try {
    await op.stat(key);
    return true;
  } catch (err: unknown) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    return msg.includes('NotFound') || msg.toLowerCase().includes('not found');
  }
  return false;
}

export function contentTypeFor(format: CoverFormat): string {
  return format === 'avif' ? 'image/avif' : 'image/jpeg';
}
