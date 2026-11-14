/**
 * `GET|HEAD /api/covers/<encodeURIComponent(edition at-URI)>`.
 *
 * The worker caches every cover image on disk and records it in
 * `edition_cover_files`; this route is the only reader. Serving the bytes from
 * our own origin replaces a hotlink to OpenLibrary/Google, which is the reason
 * edition records and XRPC views point here.
 *
 * Order of answers: bad URI (`400`), rate limit (`429`), unknown edition
 * (`404`), cached file (`200`/`304`), and finally a `302` to the provider URL —
 * a cache row can exist while the file does not (a wiped cache directory), and a
 * reader must get the picture either way.
 */

import { json } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from './$types';
import { catalogPool } from '$lib/server/catalog/db';
import { EDITION_COLLECTION } from '$lib/server/catalog/genres';
import { parseEntityUri } from '$lib/server/catalog/entities';
import { metrics, recordCoverBytes, recordCoverRequest } from '$lib/server/metrics';
import {
  COVER_CACHE_CONTROL,
  cachedCoverSize,
  coverCachePath,
  coverEtag,
  normalizeIfNoneMatch,
  readCover
} from '$lib/server/covers/cache';
import { coversCacheDir, coversRateLimitPerMinute } from '$lib/server/covers/config';
import { createTokenBucket } from '$lib/server/covers/rate-limit';

const NO_STORE = { 'cache-control': 'no-store' } as const;

// One bucket per process; the allowance is a rate, not a session.
const ratePerMinute = coversRateLimitPerMinute();
const limiter = createTokenBucket({
  capacity: ratePerMinute,
  refillPerSecond: ratePerMinute / 60
});

type CoverRow = {
  cover_url: string | null;
  content_type: string | null;
  byte_size: number | null;
};

async function serve(event: RequestEvent, method: 'GET' | 'HEAD'): Promise<Response> {
  const editionUri = event.params.atUri ?? '';
  if (parseEntityUri(editionUri, EDITION_COLLECTION) === null) {
    // No cover metric: an anonymous scan of bad URIs is an HTTP-level fact.
    return json({ error: 'InvalidRequest' }, { status: 400, headers: NO_STORE });
  }

  // adapter-node's `getClientAddress()` throws when `ADDRESS_HEADER` is set but
  // the header is absent; a development run has neither, so every request there
  // shares one key.
  let key = 'unknown';
  try {
    key = event.getClientAddress();
  } catch {
    key = 'unknown';
  }
  const allowance = limiter.take(key);
  if (!allowance.allowed) {
    recordCoverRequest(metrics, 'rate_limited');
    return new Response(null, {
      status: 429,
      headers: { ...NO_STORE, 'retry-after': String(allowance.retryAfterSeconds) }
    });
  }

  let row: CoverRow | undefined;
  try {
    const result = await catalogPool().query<CoverRow>(
      `SELECT e.cover_url, f.content_type, f.byte_size
         FROM editions e
         LEFT JOIN edition_cover_files f
                ON f.edition_uri = e.uri AND f.source_url = e.cover_url
        WHERE e.uri = $1`,
      [editionUri]
    );
    row = result.rows[0];
  } catch (error) {
    console.error('[web] cover lookup failed', error);
    recordCoverRequest(metrics, 'error');
    return new Response(null, { status: 503, headers: NO_STORE });
  }

  if (row === undefined) {
    recordCoverRequest(metrics, 'not_found');
    return json({ error: 'NotFound' }, { status: 404, headers: NO_STORE });
  }

  // No configured directory means there is nothing to read: the cache row is
  // still useful as a hint, but the answer is the provider redirect below.
  const cacheDir = coversCacheDir();
  if (cacheDir !== '' && row.content_type !== null && row.byte_size !== null) {
    const etag = coverEtag(editionUri, row.byte_size);
    // The validator comes from the row, so a revalidation costs no file I/O.
    if (normalizeIfNoneMatch(event.request.headers.get('if-none-match')) === etag) {
      recordCoverRequest(metrics, 'hit');
      return new Response(null, {
        status: 304,
        headers: { etag, 'cache-control': COVER_CACHE_CONTROL }
      });
    }

    const headers = {
      'content-type': row.content_type,
      etag,
      'cache-control': COVER_CACHE_CONTROL,
      'x-content-type-options': 'nosniff'
    };

    if (method === 'HEAD') {
      const size = await cachedCoverSize(cacheDir, editionUri);
      if (size !== null) {
        recordCoverRequest(metrics, 'hit');
        return new Response(null, {
          status: 200,
          headers: { ...headers, 'content-length': String(size) }
        });
      }
    } else {
      const bytes = await readCover(coverCachePath(cacheDir, editionUri));
      if (bytes !== null) {
        recordCoverRequest(metrics, 'hit');
        recordCoverBytes(metrics, bytes.length);
        return new Response(bytes, {
          status: 200,
          headers: { ...headers, 'content-length': String(bytes.length) }
        });
      }
    }
  }

  const providerCover = (row.cover_url ?? '').trim();
  if (providerCover !== '') {
    recordCoverRequest(metrics, 'redirect');
    return new Response(null, {
      status: 302,
      headers: { location: providerCover, 'cache-control': 'public, max-age=60' }
    });
  }

  recordCoverRequest(metrics, 'not_found');
  return json({ error: 'NotFound' }, { status: 404, headers: NO_STORE });
}

export const GET: RequestHandler = (event) => serve(event, 'GET');
export const HEAD: RequestHandler = (event) => serve(event, 'HEAD');
