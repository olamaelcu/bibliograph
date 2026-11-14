/**
 * Reading side of the cover cache: the path layout, the validator, and the
 * conditional-request helpers. No `$env` import, so node tests can call it.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A cached image never changes: the URL is keyed by the edition, not a version. */
export const COVER_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * `<dir>/<sha256(uri)[0..2]>/<sha256(uri)>`, identical to `coverCachePath` in
 * packages/worker/lib/cover-cache.js — the worker writes, this reads, and the
 * two must not drift apart.
 */
export function coverCachePath(cacheDir: string, editionUri: string): string {
  const hex = createHash('sha256').update(editionUri).digest('hex');
  return join(cacheDir, hex.slice(0, 2), hex);
}

/**
 * A strong validator built from the URI and the length. `immutable` caching
 * means a re-cache of the same URI is the rare case, and the byte size changes
 * with it, so the etag moves too.
 */
export function coverEtag(editionUri: string, byteSize: number): string {
  const hex = createHash('sha256').update(editionUri).digest('hex').slice(0, 16);
  return `"${hex}-${byteSize}"`;
}

/** `W/"x"` and list forms collapse to the bare validator, or `null`. */
export function normalizeIfNoneMatch(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const first = trimmed.split(',')[0]?.trim() ?? '';
  const bare = first.startsWith('W/') ? first.slice(2).trim() : first;
  return bare === '' ? null : bare;
}

/** The cached bytes, or `null` when the file is gone (a stale cache row). */
export async function readCover(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const file = await readFile(path);
    // A fresh, ArrayBuffer-backed copy: the Buffer `readFile` returns is a view
    // into Node's shared pool and an `ArrayBufferLike` the Response body type
    // does not accept.
    const bytes = new Uint8Array(file.byteLength);
    bytes.set(file);
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Byte size, or `null` when the file is gone. One `stat`, so a `HEAD` answers
 * Content-Length without mapping the image.
 */
export async function cachedCoverSize(
  cacheDir: string,
  editionUri: string
): Promise<number | null> {
  try {
    const info = await stat(coverCachePath(cacheDir, editionUri));
    return info.isFile() ? info.size : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}
