import { fail, redirect } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/admin';
import { upsertEdition } from '$lib/server/catalog/store';
import type { EditionInput } from '$lib/server/catalog/types';
import { searchEditions } from '$lib/server/api/isbndb';
import { searchEditions as gbSearchEditions } from '$lib/server/api/google-books';
import type { EditionItem } from '$lib/server/search/types';
import {
	identifierFromString,
	isbnIdentifier,
	providerIdentifier,
	type Identifier,
} from '$lib/server/identifiers';
import { createLogger } from '$lib/server/logger';
import type { Actions, PageServerLoad } from './$types';

const log = createLogger('isbn-import');

function cleanIsbn(q: string): string {
	return q.replace(/[-\s]/g, '');
}

function parseSelected(raw: string | null): EditionItem | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed as EditionItem;
	} catch {
		return null;
	}
}

/**
 * One form entry as a canonical identifier. `<issuer>:<value>` is read as an
 * exact pair; anything that looks like an ISBN is canonicalised to `isbn13`;
 * a provider page URL is read by the provider helpers.
 */
function parseIdentifierEntry(raw: string): Identifier | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const pair = identifierFromString(trimmed);
	if (pair) return pair;
	const isbn = isbnIdentifier(trimmed);
	if (isbn) return isbn;
	if (/^https?:\/\//i.test(trimmed)) return providerIdentifier('web', trimmed);
	return null;
}

async function search(q: string): Promise<Record<string, EditionItem[]>> {
	if (q.trim().length < 5) return {};
	const isbn = cleanIsbn(q);
	const [isbndbRes, gbRes] = await Promise.allSettled([
		searchEditions({ q: isbn, limit: 10 }, log, undefined),
		gbSearchEditions({ q: isbn, limit: 10 }, log, undefined),
	]);
	return {
		isbndb: isbndbRes.status === 'fulfilled' ? (isbndbRes.value.items ?? []) : [],
		'google-books': gbRes.status === 'fulfilled' ? (gbRes.value.items ?? []) : [],
	};
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const q = event.url.searchParams.get('q') ?? '';
	const selected = parseSelected(event.url.searchParams.get('selected'));
	return {
		isbnQuery: q,
		results: selected ? {} : await search(q),
		selected,
	};
};

export const actions: Actions = {
	search: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
		const isbn = String(form.get('isbn') ?? '').trim();
		if (!isbn) return fail(400, { error: 'ISBN required' });
		return { results: await search(isbn) };
	},

	import: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
		const title = String(form.get('title') ?? '').trim();
		if (!title) return fail(400, { error: 'Title is required.' });

		const identifiers: Identifier[] = [];
		const identifiersRaw = String(form.get('identifiers') ?? '').trim();
		for (const entry of identifiersRaw.split(',').map((value) => value.trim()).filter(Boolean)) {
			const identifier = parseIdentifierEntry(entry);
			if (!identifier) {
				return fail(400, {
					error: `Identifier "${entry}" is not readable; use issuer:value, e.g. isbn13:9780123456789.`,
				});
			}
			identifiers.push(identifier);
		}
		const isbnRaw = String(form.get('isbn') ?? '').trim();
		const isbn = isbnIdentifier(isbnRaw);
		if (isbn) identifiers.push(isbn);
		if (identifiers.length === 0) {
			return fail(400, { error: 'At least one identifier is required.' });
		}

		const authors = String(form.get('authors') ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean);
		const publisherName = String(form.get('publisher') ?? '').trim();
		const year = String(form.get('year') ?? '').trim();
		const pages = Number.parseInt(String(form.get('pages') ?? ''), 10);

		const input: EditionInput = {
			title,
			subtitle: String(form.get('subtitle') ?? '').trim() || null,
			language: String(form.get('language') ?? '').trim() || null,
			publishedDate: year || null,
			format: String(form.get('format') ?? '').trim() || null,
			pages: Number.isFinite(pages) ? pages : null,
			description: String(form.get('description') ?? '').trim() || null,
			coverUrl: String(form.get('coverUrl') ?? '').trim() || null,
			identifiers,
			contributors: authors.map((name) => ({ name, role: 'author' })),
			publisher: publisherName ? { name: publisherName } : null,
			createdAt: new Date().toISOString(),
		};

		try {
			const uri = await upsertEdition(input);
			if (!uri) return fail(400, { error: 'The edition has no valid identifiers.' });
			const rkey = uri.slice(uri.lastIndexOf('/') + 1);
			log.info({ stage: 'isbn-import', uri }, 'edition imported');
			return { ok: true, editionUri: uri, rkey, editionUrl: `/editions/${rkey}` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error({ stage: 'isbn-import', err }, 'import failed');
			return fail(500, { error: `Import failed: ${message}` });
		}
	},
};
