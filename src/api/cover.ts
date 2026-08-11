import type { Context } from 'hono';
import { readCover, contentTypeFor } from '../cover-storage.js';
import {
  type CoverCollection,
  type CoverFormat,
  type CoverSize,
  isCoverCollection,
  isCoverFormat,
  isCoverSize,
  isLikelyRkey,
} from '../cover-types.js';
import { logger } from '../logger.js';

const CACHE_HEADER = 'public, max-age=31536000, immutable';

const PATH_PATTERN = /^\/covers\/(book|shelf)\/([234567abcdefghijklmnopqrstuvwxyz]{13})-(S|M|L)\.(jpg|avif)$/;

function parsePath(path: string): { collection: CoverCollection; rkey: string; size: CoverSize; ext: CoverFormat } | null {
  const m = PATH_PATTERN.exec(path);
  if (!m) return null;
  return {
    collection: m[1] as CoverCollection,
    rkey: m[2],
    size: m[3] as CoverSize,
    ext: m[4] as CoverFormat,
  };
}

export async function serveCover(c: Context): Promise<Response> {
  const parsed = parsePath(c.req.path);
  if (!parsed) {
    return c.json({ error: 'InvalidPath' }, 400);
  }
  const { collection, rkey, size, ext } = parsed;
  if (!isCoverCollection(collection) || !isLikelyRkey(rkey) || !isCoverSize(size) || !isCoverFormat(ext)) {
    return c.json({ error: 'InvalidPath' }, 400);
  }

  const safeCollection: CoverCollection = collection;
  const safeRkey: string = rkey;
  const safeSize: CoverSize = size;
  const safeFormat: CoverFormat = ext;

  try {
    const data = await readCover(safeCollection, safeRkey, safeSize, safeFormat);
    if (!data) {
      return c.json({ error: 'NotFound' }, 404);
    }
    return c.body(data as unknown as ArrayBuffer, 200, {
      'Content-Type': contentTypeFor(safeFormat),
      'Cache-Control': CACHE_HEADER,
      ETag: `"${safeCollection}-${safeRkey}-${safeSize}-${safeFormat}"`,
    });
  } catch (err) {
    logger.error(
      { err, collection: safeCollection, rkey: safeRkey, size: safeSize, format: safeFormat },
      'cover serve: read failed',
    );
    return c.json({ error: 'InternalServerError' }, 500);
  }
}
