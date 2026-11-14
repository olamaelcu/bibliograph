/**
 * The on-disk cover cache: path layout, byte validation, and download.
 *
 * Providers answer a missing cover with a small placeholder image, so a cover
 * URL alone does not mean a cover exists. Every provider cover is fetched once,
 * sniffed, and written to a cache keyed by the edition at-URI; the edge serves
 * the bytes from that same directory, and `edition_cover_files` records what is
 * there so nothing has to open the image to answer a request.
 *
 * Nothing here balances disk usage: the cache is unbounded by design and its
 * growth is reported by the infra textfile metrics.
 */

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { createGate } from './util.js';

/** Anything smaller than this is a provider placeholder, not a cover. */
export const MIN_COVER_BYTES = 4096;
/** A real cover is tens of kilobytes; this only catches an absurd response. */
export const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const COVER_DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * The image is unusable for good: retrying the same URL will not help, so the
 * ledger records a terminal `rejected` instead of a retryable failure.
 */
export class CoverRejectedError extends Error {
  /** @param {number} [byteSize] the rejected response's length, for the log */
  constructor(message, byteSize) {
    super(message);
    this.name = 'CoverRejectedError';
    this.byteSize = byteSize;
  }
}

function digest(editionUri) {
  return createHash('sha256').update(editionUri).digest('hex');
}

/**
 * `<dir>/<sha256(uri)[0..2]>/<sha256(uri)>` — two hex characters of fan-out, so
 * no single directory grows past a few thousand entries.
 *
 * Duplicated verbatim in `packages/web/src/lib/server/covers/cache.ts`, which
 * cannot import from this package; keep the two in step.
 */
export function coverCachePath(cacheDir, editionUri) {
  const hex = digest(editionUri);
  return join(cacheDir, hex.slice(0, 2), hex);
}

/** Byte size of the cached image, or `null` when nothing is cached. */
export async function cachedCoverSize(cacheDir, editionUri) {
  try {
    const info = await stat(coverCachePath(cacheDir, editionUri));
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Write the image through a temporary file and `rename`, so a reader never sees
 * a half-written cover. Returns the final path.
 */
export async function writeCachedCover(cacheDir, editionUri, bytes) {
  const target = coverCachePath(cacheDir, editionUri);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return target;
}

/** Drop a cached image; a file that is already gone is not an error. */
export async function removeCachedCover(cacheDir, editionUri) {
  await rm(coverCachePath(cacheDir, editionUri), { force: true });
}

/** Magic-byte sniff; the response's own Content-Type is never trusted. */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const ascii = (offset, length) => bytes.subarray(offset, offset + length).toString('latin1');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  const magic = ascii(0, 6);
  if (magic === 'GIF87a' || magic === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

function ipv4IsPrivate(address) {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b < 32) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function ipv6IsPrivate(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (!Number.isInteger(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '') return true;
  const family = isIP(host);
  if (family === 4) return ipv4IsPrivate(host);
  if (family === 6) return ipv6IsPrivate(host);
  return false;
}

/**
 * Accept only an http(s) URL on a public-looking host. Hostnames are not
 * resolved — the admin surface is token-gated, so this is SSRF hygiene rather
 * than a sandbox — but a literal private address is refused outright.
 */
export function assertCoverSourceUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new CoverRejectedError('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CoverRejectedError(`unsupported scheme ${url.protocol}`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new CoverRejectedError(`refusing private host ${url.hostname}`);
  }
  return url.toString();
}

/**
 * Approximately five image requests a second, shared by every job. Provider
 * JSON calls have their own gates; image bytes must not queue behind them (and
 * OpenLibrary's one-second JSON gate is far too slow for a 300k backfill).
 */
const coverGate = createGate(200);

/**
 * Fetch one cover and validate it, or throw.
 *
 * A non-2xx answer, an oversized response or a transport failure is a plain
 * `Error`: the provider may recover, so the job retries. A response that is
 * small or not an image at all is a `CoverRejectedError`: the URL is bad and
 * retrying it forever would only cost provider requests.
 */
export async function downloadCover(
  url,
  { fetchImpl = fetch, timeoutMs = COVER_DOWNLOAD_TIMEOUT_MS } = {}
) {
  const source = assertCoverSourceUrl(url);
  const response = await coverGate(() =>
    fetchImpl(source, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  );
  if (!response.ok) {
    // A 4xx (403 for a Google Books volume with no public cover, 404 for a
    // withdrawn image) answers the same way tomorrow, so the URL is terminal
    // and retrying it only spends provider requests. 408/429 and 5xx are the
    // provider asking for time, and a transport error never reaches here.
    const status = response.status;
    const message = `${source} answered ${status}`;
    const retryable = status === 408 || status === 429 || status >= 500;
    throw Object.assign(
      retryable ? new Error(message) : new CoverRejectedError(message),
      { status }
    );
  }

  const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
    throw new Error(`${source} declares ${declared} bytes, over the ${MAX_COVER_BYTES}-byte cap`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_COVER_BYTES) {
    throw new Error(`${source} returned ${bytes.length} bytes, over the ${MAX_COVER_BYTES}-byte cap`);
  }

  const contentType = sniffImageType(bytes);
  if (contentType === null) throw new CoverRejectedError('not an image', bytes.length);
  if (bytes.length < MIN_COVER_BYTES) throw new CoverRejectedError('too small', bytes.length);

  return { bytes, contentType, byteSize: bytes.length };
}

/**
 * Public origin the cover URLs advertise: the configured base, else the
 * publisher host the rest of the records already use.
 */
export function coversBaseUrlFromEnv(env = process.env, publisherHost = '') {
  const configured = (env.COVERS_PUBLIC_BASE_URL ?? '').trim();
  if (configured !== '') return configured;
  return publisherHost ? `https://${publisherHost}` : '';
}
