import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCachedCover, isAllowedCoverUrl } from '$lib/server/cover-cache';

const CACHE_CONTROL = 'public, max-age=604800, s-maxage=2592000, immutable';

/**
 * Serve a provider cover once and keep the bytes on disk for the next reader.
 * `getImageForBook` points here; the provider URL is an allowlisted source, not
 * an open proxy input.
 */
export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('url');
  if (!source) throw error(400, 'missing cover url');
  if (!isAllowedCoverUrl(source)) throw error(400, 'cover host is not allowed');

  const cover = await getCachedCover(source);
  if (!cover) throw error(502, 'cover unavailable');

  // A Node Buffer is a view onto a pooled ArrayBuffer; hand Response exactly
  // these bytes rather than the whole pool when it is a subarray.
  const body =
    cover.body.byteOffset === 0 &&
    cover.body.byteLength === cover.body.buffer.byteLength
      ? (cover.body.buffer as ArrayBuffer)
      : (cover.body.buffer.slice(
          cover.body.byteOffset,
          cover.body.byteOffset + cover.body.byteLength,
        ) as ArrayBuffer);

  return new Response(body, {
    headers: {
      'content-type': cover.contentType,
      'content-length': String(cover.body.byteLength),
      'cache-control': CACHE_CONTROL,
      'access-control-allow-origin': '*',
    },
  });
};
