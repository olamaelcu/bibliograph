import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Disk-backed cache for cover bytes fetched from the catalog cover providers.
 *
 * `getImageForBook` used to hand clients the provider URL, so every reader and
 * every deploy re-fetched the same JPEG from the provider. The bytes never
 * change for a stable cover URL, and the providers are slow and rate-limited —
 * exactly what a local cache is for. The key is the normalized source URL, so a
 * cover is fetched once per host and then served from `COVER_CACHE_DIR`.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/**
 * Providers Bibliograph itself emits cover URLs for. An allowlist keeps this
 * route from becoming an open proxy; add a host here only when a catalog source
 * can actually produce it.
 */
const ALLOWED_COVER_HOSTS = new Set([
  'books.google.com',
  'books.googleusercontent.com',
  'covers.isbndb.com',
  'i.gr-assets.com',
  'images.gr-assets.com',
]);

/** A cover host may redirect through `archive.org` to `ia*.archive.org`. */
function isAllowedCoverHost(hostname: string): boolean {
  return ALLOWED_COVER_HOSTS.has(hostname) || hostname === 'archive.org' || hostname.endsWith('.archive.org');
}

export interface CachedCover {
  body: Buffer;
  contentType: string;
}

const inflight = new Map<string, Promise<CachedCover | null>>();

/** True when `value` is an https URL from a provider we are willing to cache. */
export function isAllowedCoverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isAllowedCoverHost(url.hostname);
  } catch {
    return false;
  }
}

/** The directory systemd or the operator designated for cover bytes. */
export function coverCacheDir(): string {
  if (process.env.COVER_CACHE_DIR) return process.env.COVER_CACHE_DIR;
  // systemd sets this for a unit with StateDirectory=; in production that is
  // /var/lib/bibliograph, which survives package upgrades.
  const stateDirectory = process.env.STATE_DIRECTORY?.split(':')[0];
  if (stateDirectory) return join(stateDirectory, 'covers');
  return join(process.cwd(), 'data', 'covers');
}

export function coverCacheKey(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/** The public URL the XRPC hands clients, which serves and fills the cache. */
export function coverProxyUrl(source: string, origin: string): string {
  return `${origin.replace(/\/$/, '')}/image/cover?url=${encodeURIComponent(source)}`;
}

async function readFromDisk(key: string): Promise<CachedCover | null> {
  const dir = coverCacheDir();
  try {
    const [body, metaRaw] = await Promise.all([
      readFile(join(dir, `${key}.bin`)),
      readFile(join(dir, `${key}.json`), 'utf8'),
    ]);
    const meta: unknown = JSON.parse(metaRaw);
    if (
      !meta ||
      typeof meta !== 'object' ||
      !('contentType' in meta) ||
      typeof meta.contentType !== 'string' ||
      !ALLOWED_CONTENT_TYPES.has(meta.contentType)
    ) {
      return null;
    }
    return { body, contentType: meta.contentType };
  } catch {
    // A missing or unreadable entry is a miss; the caller fetches upstream.
    return null;
  }
}

async function writeToDisk(key: string, cover: CachedCover, source: string): Promise<void> {
  const dir = coverCacheDir();
  await mkdir(dir, { recursive: true });
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const bodyPath = join(dir, `${key}.bin`);
  const metaPath = join(dir, `${key}.json`);
  const bodyTmp = `${bodyPath}.${suffix}.tmp`;
  const metaTmp = `${metaPath}.${suffix}.tmp`;
  try {
    await writeFile(bodyTmp, cover.body);
    await writeFile(
      metaTmp,
      JSON.stringify({
        contentType: cover.contentType,
        source,
        cachedAt: new Date().toISOString(),
      }),
    );
    // Rename the body first and the metadata second: a reader only accepts the
    // pair, so a crash between the two leaves a retryable miss, never a
    // truncated image.
    await rename(bodyTmp, bodyPath);
    await rename(metaTmp, metaPath);
  } finally {
    await Promise.all([
      rm(bodyTmp, { force: true }),
      rm(metaTmp, { force: true }),
    ]);
  }
}

async function fetchCover(source: string): Promise<CachedCover | null> {
  let url = source;
  // Follow redirects manually so every hop stays on the cover allowlist. The
  // provider chain runs through archive.org -> ia*.archive.org; a blanket
  // redirect policy would let a compromised or open redirect reach an
  // internal host.
  for (let hop = 0; hop < 5; hop += 1) {
    if (!isAllowedCoverUrl(url)) return null;
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          accept: 'image/*',
          'user-agent': 'Bibliograph/0.1 (+https://biblio.livtet.olamaelcu.net)',
        },
      });
    } catch {
      return null;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) return null;
      url = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) return null;
    return await readCoverResponse(response);
  }
  return null;
}

async function readCoverResponse(response: Response): Promise<CachedCover | null> {
  const contentType =
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return null;

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) return null;

  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_COVER_BYTES) return null;
  return { body, contentType };
}

/**
 * Return the cached cover, fetching it once on a miss. Concurrent callers for
 * the same URL share one upstream request.
 */
export async function getCachedCover(source: string): Promise<CachedCover | null> {
  if (!isAllowedCoverUrl(source)) return null;

  const key = coverCacheKey(source);
  const cached = await readFromDisk(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const fetched = await fetchCover(source);
    if (!fetched) return null;
    // A cache write failure must not fail the response; the next request
    // retries the write.
    await writeToDisk(key, fetched, source).catch(() => {});
    return fetched;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}
