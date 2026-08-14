import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BlobStore } from '../storage/store.js';
import { flagIssue } from '../import/issues.js';
import { logger } from '../logger.js';

export interface ImageFetchResult {
	kind: 'cover' | 'portrait';
	fetched: boolean;
	url: string | null;
}

const USER_AGENT = 'bibliograph/0.1.0 (+https://github.com/olamaelcu/bibliograph)';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
	const res = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
	// Strip parameters (e.g. "; charset=...") and require an exact match so a
	// content-type like 'x-image/jpegx' cannot pass the gate.
	const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!ALLOWED_TYPES.includes(contentType)) {
		throw new Error(`unexpected content-type: ${contentType}`);
	}
	// Reject by content-length before downloading the body when the header is present.
	const contentLength = Number(res.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
		throw new Error(`image too large: ${contentLength}`);
	}
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength > MAX_BYTES) throw new Error(`image too large: ${buf.byteLength}`);
	return { bytes: buf, mimeType: contentType };
}

/** Fetch a book cover from OpenLibrary. */
export async function fetchBookCover(
	db: BetterSQLite3Database,
	store: BlobStore,
	bookPk: string,
	olCoverId: number | undefined,
): Promise<ImageFetchResult> {
	if (olCoverId == null) return { kind: 'cover', fetched: false, url: null };
	const url = `https://covers.openlibrary.org/b/id/${olCoverId}-L.jpg`;
	try {
		const { bytes, mimeType } = await fetchImageBytes(url);
		const blob = await store.put({ entityType: 'book', entityPk: bookPk, kind: 'cover', bytes, mimeType, source: 'openlibrary' });
		return { kind: 'cover', fetched: true, url: blob.url };
	} catch (err) {
		logger.warn({ bookPk, url, err: (err as Error).message }, 'cover fetch failed');
		flagIssue(db, { entityType: 'book', entityPk: bookPk, field: 'coverUrl', incomingValue: url, storedValue: null, source: 'openlibrary' });
		return { kind: 'cover', fetched: false, url: null };
	}
}

/** Fetch a contributor portrait: OL photo, else Wikipedia REST thumbnail. */
export async function fetchContributorPortrait(
	db: BetterSQLite3Database,
	store: BlobStore,
	contributorPk: string,
	name: string,
	olPhotoId: number | undefined,
): Promise<ImageFetchResult> {
	if (olPhotoId != null) {
		const url = `https://covers.openlibrary.org/b/id/${olPhotoId}-L.jpg`;
		try {
			const { bytes, mimeType } = await fetchImageBytes(url);
			const blob = await store.put({ entityType: 'contributor', entityPk: contributorPk, kind: 'portrait', bytes, mimeType, source: 'openlibrary' });
			return { kind: 'portrait', fetched: true, url: blob.url };
		} catch (err) {
			logger.warn({ contributorPk, url, err: (err as Error).message }, 'OL portrait failed; trying Wikipedia');
		}
	}
	// Wikipedia fallback: REST summary endpoint thumbnail.
	const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/\s+/g, '_'))}`;
	try {
		const res = await fetch(wikiUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`wikipedia summary failed: ${res.status}`);
		const body = (await res.json()) as { thumbnail?: { source?: string } };
		const thumb = body.thumbnail?.source;
		if (!thumb) throw new Error('no wikipedia thumbnail');
		const { bytes, mimeType } = await fetchImageBytes(thumb);
		const blob = await store.put({ entityType: 'contributor', entityPk: contributorPk, kind: 'portrait', bytes, mimeType, source: 'wikipedia' });
		return { kind: 'portrait', fetched: true, url: blob.url };
	} catch (err) {
		logger.warn({ contributorPk, err: (err as Error).message }, 'portrait fetch failed');
		flagIssue(db, { entityType: 'contributor', entityPk: contributorPk, field: 'imageUrl', incomingValue: wikiUrl, storedValue: null, source: 'wikipedia' });
		return { kind: 'portrait', fetched: false, url: null };
	}
}
