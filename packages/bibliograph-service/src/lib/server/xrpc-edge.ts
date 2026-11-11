// Edge-served XRPC methods: catalog, labels, lexicons, image and feeds.
//
// Activity reads live in HappyView; nothing here reads a user's PDS or a
// backlink service. Catalog procedures are read-only lookups over the local
// tables.

import { identifierFromString, type Identifier } from './identifiers';
import { resolvePublishedLexicon } from './lex/resolve';
import { queryLabels, labelToJson } from './labeler/labels';
import { describeFeedGenerator, getFeedSkeleton } from './feed-generator';
import { allowRequest } from './rate-limit';
import { coverUrlForEdition, loadAppviewBooksOrdered, searchEditionRows } from './catalog/store';
import { bookViewFromAppview, editionViewFromAppview, usableCoverUrl } from './media-book-view';
import { coverProxyUrl, isAllowedCoverUrl } from './cover-cache';
import { publicOrigin } from './public-origin';

const EDGE_NSIDS: Record<string, true> = {
	'com.atproto.lexicon.resolveLexicon': true,
	'com.atproto.label.queryLabels': true,
	'com.atproto.feed.describeFeedGenerator': true,
	'com.atproto.feed.getFeedSkeleton': true,
	'community.lexicon.media.book.searchEditions': true,
	'community.lexicon.media.book.resolveEditions': true,
	'net.olamaelcu.livtet.biblio.getEditions': true,
	'net.olamaelcu.livtet.biblio.getImageForBook': true,
};

function errorResponse(status: number, error: string, message: string): Response {
	return Response.json({ error, message }, { status });
}

function allParams(params: URLSearchParams, name: string): string[] {
	const values = params.getAll(name).flatMap((value) => value.split(','));
	return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function limitParam(raw: string | null, fallback: number, max: number): number {
	const parsed = raw === null ? fallback : Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, 1), max);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await request.json();
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		return value as Record<string, unknown>;
	} catch {
		return null;
	}
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return typeof value === 'string' ? value : undefined;
}

function identifierList(body: Record<string, unknown>): Identifier[] | null {
	const raw = body.identifiers;
	if (!Array.isArray(raw)) return null;
	const out: Identifier[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string') {
			const parsed = identifierFromString(entry);
			if (parsed) out.push(parsed);
			continue;
		}
		if (!entry || typeof entry !== 'object') continue;
		if (!('issuer' in entry) || !('value' in entry)) continue;
		if (typeof entry.issuer !== 'string' || typeof entry.value !== 'string') continue;
		if (!entry.issuer || !entry.value) continue;
		const url = 'url' in entry && typeof entry.url === 'string' ? entry.url : undefined;
		out.push(url ? { issuer: entry.issuer, value: entry.value, url } : { issuer: entry.issuer, value: entry.value });
	}
	return out;
}

async function handleSearchEditions(request: Request): Promise<Response> {
	const body = await readJson(request);
	if (!body) return errorResponse(400, 'InvalidRequest', 'A JSON object body is required');

	const q = stringField(body, 'q')?.trim();
	const title = stringField(body, 'title')?.trim();
	const author = stringField(body, 'author')?.trim();
	const identifiers = identifierList(body) ?? [];
	const titleText = q || title;

	if (!titleText && !author && identifiers.length === 0) {
		return errorResponse(400, 'InvalidQuery', 'At least one of q, title, author, or identifiers is required');
	}

	const offset = typeof body.offset === 'number' ? body.offset : 0;
	const limit = typeof body.limit === 'number' ? body.limit : 25;
	const result = await searchEditionRows({ titleText, author, identifiers, offset, limit });
	return Response.json({
		items: result.rows.map(editionViewFromAppview),
		hasMore: result.hasMore,
		...(result.total === undefined ? {} : { total: result.total }),
	});
}

async function handleResolveEditions(request: Request): Promise<Response> {
	const body = await readJson(request);
	if (!body) return errorResponse(400, 'InvalidRequest', 'A JSON object body is required');
	const identifiers = identifierList(body);
	if (!identifiers || identifiers.length === 0) {
		return errorResponse(400, 'InvalidQuery', 'identifiers is required');
	}
	const offset = typeof body.offset === 'number' ? body.offset : 0;
	const limit = typeof body.limit === 'number' ? body.limit : 25;
	const result = await searchEditionRows({ identifiers, offset, limit });
	return Response.json({
		items: result.rows.map(editionViewFromAppview),
		hasMore: result.hasMore,
		...(result.total === undefined ? {} : { total: result.total }),
	});
}

async function handleQueryLabels(params: URLSearchParams): Promise<Response> {
	const uriPatterns = allParams(params, 'uriPatterns');
	if (uriPatterns.length === 0) {
		return errorResponse(400, 'InvalidRequest', 'uriPatterns is required');
	}
	const sources = allParams(params, 'sources');
	const cursorRaw = params.get('cursor');
	const cursor = cursorRaw === null ? undefined : Number.parseInt(cursorRaw, 10);
	const result = await queryLabels({
		uriPatterns,
		sources: sources.length > 0 ? sources : undefined,
		cursor: Number.isFinite(cursor) ? cursor : undefined,
		limit: limitParam(params.get('limit'), 50, 250),
	});
	return Response.json({ labels: result.labels.map(labelToJson), cursor: result.cursor });
}

async function handleFeedSkeleton(request: Request, params: URLSearchParams): Promise<Response> {
	const feed = params.get('feed');
	if (!feed) return errorResponse(400, 'InvalidRequest', 'feed is required');
	const result = await getFeedSkeleton(request, {
		feed,
		cursor: params.get('cursor') ?? undefined,
		limit: limitParam(params.get('limit'), 5, 100),
	});
	return Response.json(result);
}

async function handleGetEditions(params: URLSearchParams): Promise<Response> {
	const uris = Array.from(new Set(allParams(params, 'uris')));
	if (uris.length === 0) return errorResponse(400, 'InvalidRequest', 'uris is required');
	if (uris.length > 100) return errorResponse(400, 'InvalidRequest', 'At most 100 uris per request');
	const rows = await loadAppviewBooksOrdered(uris);
	return Response.json({ editions: rows.map(bookViewFromAppview) });
}

async function handleGetImageForBook(params: URLSearchParams): Promise<Response> {
	const uri = params.get('uri');
	if (!uri) return errorResponse(400, 'InvalidRequest', 'uri is required');
	const cover = await coverUrlForEdition(uri);
	if (cover === undefined) {
		return errorResponse(404, 'RecordNotFound', `No catalog edition exists at ${uri}`);
	}
	const usable = usableCoverUrl(cover);
	if (!usable) return Response.json({});
	const url = isAllowedCoverUrl(usable) ? coverProxyUrl(usable, publicOrigin()) : usable;
	return Response.json({ url });
}

/** Dispatch one edge endpoint. Returns `null` when the NSID is not edge-served. */
export async function handleEdgeXrpc(request: Request, nsid: string): Promise<Response | null> {
	if (!EDGE_NSIDS[nsid]) return null;
	const url = new URL(request.url);
	const params = url.searchParams;

	if (nsid === 'com.atproto.lexicon.resolveLexicon') {
		const requested = params.get('nsid');
		if (!requested) return errorResponse(400, 'InvalidRequest', 'nsid is required');
		const resolved = await resolvePublishedLexicon(requested);
		if (!resolved) return errorResponse(400, 'LexiconNotFound', `No lexicon published for ${requested}`);
		return Response.json(resolved);
	}

	if (nsid === 'com.atproto.label.queryLabels') return handleQueryLabels(params);

	if (nsid === 'com.atproto.feed.describeFeedGenerator') return Response.json(describeFeedGenerator());

	if (nsid === 'com.atproto.feed.getFeedSkeleton') {
		const ip = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() ?? 'unknown';
		if (!allowRequest(ip, nsid)) {
			const limited = errorResponse(429, 'RateLimited', 'Too many requests');
			limited.headers.set('retry-after', '60');
			return limited;
		}
		return handleFeedSkeleton(request, params);
	}

	if (nsid === 'community.lexicon.media.book.searchEditions') return handleSearchEditions(request);
	if (nsid === 'community.lexicon.media.book.resolveEditions') return handleResolveEditions(request);
	if (nsid === 'net.olamaelcu.livtet.biblio.getEditions') return handleGetEditions(params);
	if (nsid === 'net.olamaelcu.livtet.biblio.getImageForBook') return handleGetImageForBook(params);

	return null;
}
