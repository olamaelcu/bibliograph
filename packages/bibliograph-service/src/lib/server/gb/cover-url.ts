const GB_HOST = 'books.google.com';
const GB_CDN_HOST = 'books.googleusercontent.com';
const READER_PATH = '/books/content';
const PUBLISHER_PATH = '/books/publisher/content';

/**
 * Google Books answers `/books/content` with 403 to datacenter IPs while
 * `/books/publisher/content` serves the same image. Bibliograph runs on a
 * datacenter host and its cover URLs are fetched by other datacenter hosts (the
 * Livtet cover proxy), so every Google cover URL it emits must use the
 * publisher path — otherwise those fetches fail even though a residential
 * browser would load the same URL fine.
 *
 * Non-Google URLs and already-rewritten URLs pass through unchanged.
 */
export function datacenterCoverUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== GB_HOST && parsed.hostname !== GB_CDN_HOST) return url;
  if (parsed.pathname !== READER_PATH) return url;
  parsed.protocol = 'https:';
  parsed.hostname = GB_HOST;
  parsed.pathname = PUBLISHER_PATH;
  return parsed.toString();
}
