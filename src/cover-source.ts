import { readCover } from './cover-storage.js';
import type { CoverCollection, CoverFormat } from './cover-types.js';
import { COVER_FORMATS } from './cover-types.js';
import { logger } from './logger.js';

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_USER_AGENT = 'bibliograph-cover-worker/1.0';

export interface SourceFetchResult {
  bytes: Buffer;
  contentType: string | null;
}

export async function fetchCoverSource(
  url: string,
  ctx: { collection: CoverCollection; rkey: string },
): Promise<SourceFetchResult | null> {
  if (url.startsWith('/covers/')) {
    return await readLocalCover(url, ctx);
  }
  return await fetchRemoteCover(url);
}

async function readLocalCover(
  url: string,
  ctx: { collection: CoverCollection; rkey: string },
): Promise<SourceFetchResult | null> {
  const parsed = parseLocalCoverPath(url);
  if (!parsed) {
    logger.warn({ url }, 'cover source: unparseable local URL');
    return null;
  }
  if (parsed.collection !== ctx.collection || parsed.rkey !== ctx.rkey) {
    logger.warn({ url, ctx, parsed }, 'cover source: local URL does not match expected key');
    return null;
  }
  const bytes = await readCover(parsed.collection, parsed.rkey, parsed.size, parsed.format);
  if (!bytes) {
    logger.warn({ url }, 'cover source: local key not found');
    return null;
  }
  return { bytes, contentType: contentTypeFor(parsed.format) };
}

async function fetchRemoteCover(url: string): Promise<SourceFetchResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        Accept: 'image/jpeg,image/png,image/webp,image/avif,*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'cover source: remote fetch not ok');
      return null;
    }
    const arr = await res.arrayBuffer();
    return {
      bytes: Buffer.from(arr),
      contentType: res.headers.get('content-type'),
    };
  } catch (err) {
    logger.warn({ url, err: serializeError(err) }, 'cover source: remote fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface LocalPath {
  collection: CoverCollection;
  rkey: string;
  size: 'S' | 'M' | 'L';
  format: CoverFormat;
}

function parseLocalCoverPath(url: string): LocalPath | null {
  const m = /^\/covers\/(book|shelf)\/([A-Za-z0-9]+)-(S|M|L)\.(jpg|avif)$/.exec(url);
  if (!m) return null;
  return {
    collection: m[1] as CoverCollection,
    rkey: m[2],
    size: m[3] as LocalPath['size'],
    format: m[4] as CoverFormat,
  };
}

function contentTypeFor(format: CoverFormat): string {
  return format === 'avif' ? 'image/avif' : 'image/jpeg';
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export { COVER_FORMATS };
