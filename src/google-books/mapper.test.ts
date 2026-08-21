import { describe, expect, it } from 'vitest';
import type { GbVolume } from './client.js';
import { COLLECTION } from '../lex/collections.js';
import { decodeGbCursor, encodeGbCursor, gbAuthorSlugToName, gbVolumeToBookView } from './mapper.js';

const ctx = { serviceDid: 'did:web:books.example.com' };

const SAMPLE: GbVolume = {
	id: '_LettPDhwR0C',
	volumeInfo: {
		title: 'The Google Story',
		subtitle: 'Inside the Hottest Business, Media, and Technology Success of Our Time',
		authors: ['David A. Vise', 'Mark Malseed'],
		publishedDate: '2005-11-15',
		description: 'A story about Google.',
		industryIdentifiers: [
			{ type: 'ISBN_10', identifier: '055380457X' },
			{ type: 'ISBN_13', identifier: '9780553804577' },
		],
		imageLinks: { thumbnail: 'https://example.com/cover.jpg' },
	},
};

describe('gbVolumeToBookView', () => {
	it('maps a full volume to a BookView', async () => {
		const view = await gbVolumeToBookView(ctx, SAMPLE);
		expect(view).toBeDefined();
		expect(view?.uri).toBe(`at://${ctx.serviceDid}/${COLLECTION.book}/gb-_LettPDhwR0C`);
		expect(view?.title).toBe('The Google Story');
		expect(view?.identifiers).toEqual([
			{ resource: 'isbn_10:055380457X', url: 'https://books.google.com/books?id=_LettPDhwR0C' },
			{ resource: 'isbn_13:9780553804577', url: 'https://books.google.com/books?id=_LettPDhwR0C' },
		]);
		expect(view?.coverUrl).toBe('https://example.com/cover.jpg');
		expect(view?.publishDate).toBe('2005-11-15T00:00:00.000Z');
		expect(view?.description).toBe('A story about Google.');
		expect(view?.contributors).toHaveLength(2);
		expect(view?.contributors?.[0].contributor.name).toBe('David A. Vise');
		expect(view?.contributors?.[0].role).toContain('contributorRole/author');
	});

	it('returns undefined when title is missing', async () => {
		expect(await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: {} })).toBeUndefined();
	});

	it('handles minimal volumeInfo gracefully', async () => {
		const v = await gbVolumeToBookView(ctx, { id: 'a_b-1', volumeInfo: { title: 'Minimal' } });
		expect(v?.title).toBe('Minimal');
		expect(v?.identifiers).toEqual([]);
		expect(v?.contributors).toEqual([]);
		expect(v?.coverUrl).toBeUndefined();
		expect(v?.publishDate).toBeUndefined();
		expect(v?.description).toBeUndefined();
	});

	it('falls back to smallThumbnail when thumbnail is absent', async () => {
		const v = await gbVolumeToBookView(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', imageLinks: { smallThumbnail: 'https://example.com/small.jpg' } },
		});
		expect(v?.coverUrl).toBe('https://example.com/small.jpg');
	});

	it('parses partial publish dates (YYYY and YYYY-MM)', async () => {
		const v1 = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: '1890' } });
		expect(v1?.publishDate).toBe('1890-01-01T00:00:00.000Z');
		const v2 = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: '2010-05' } });
		expect(v2?.publishDate).toBe('2010-05-01T00:00:00.000Z');
	});

	it('omits publishDate for unparseable dates', async () => {
		const v = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: 'sometime' } });
		expect(v?.publishDate).toBeUndefined();
	});

	it('rejects publishDate rollovers (Feb 30, Apr 31, month 13)', async () => {
		const v1 = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: '2024-02-30' } });
		expect(v1?.publishDate).toBeUndefined();
		const v2 = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: '2024-04-31' } });
		expect(v2?.publishDate).toBeUndefined();
		const v3 = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: '2024-13-01' } });
		expect(v3?.publishDate).toBeUndefined();
		const v4 = await gbVolumeToBookView(ctx, { id: 'x', volumeInfo: { title: 'T', publishedDate: '2023-02-29' } });
		expect(v4?.publishDate).toBeUndefined();
	});

	it('slugs authors deterministically and falls back to a hash for non-ASCII names', async () => {
		const a = await gbVolumeToBookView(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', authors: ['Tolkien, J.R.R.', '村上春樹'] },
		});
		const names = a?.contributors?.map((c) => c.contributor.uri.split('/').pop());
		expect(names?.[0]).toMatch(/^gbauthors-tolkien-j-r-r$/);
		expect(names?.[1]).toMatch(/^gbauthors-xn-[a-z0-9]+$/);
	});

	it('does not collide with names whose slug starts with c-', async () => {
		// "C. S. Lewis" must slug to a real-name shape, NOT the xn- hash fallback.
		// The old `c-` prefix on the hash fallback would have produced
		// `gbauthors-c-s-lewis` and collided with this real name.
		const a = await gbVolumeToBookView(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', authors: ['C. S. Lewis'] },
		});
		const slug = a?.contributors?.[0].contributor.uri.split('/').pop();
		expect(slug).toBe('gbauthors-c-s-lewis');
		expect(slug).not.toMatch(/^gbauthors-xn-/);
	});

	it('upgrades http cover URLs to https', async () => {
		const v = await gbVolumeToBookView(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', imageLinks: { thumbnail: 'http://example.com/cover.jpg' } },
		});
		expect(v?.coverUrl).toBe('https://example.com/cover.jpg');
	});

	it('upgrades http smallThumbnail when thumbnail is absent', async () => {
		const v = await gbVolumeToBookView(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', imageLinks: { smallThumbnail: 'http://example.com/small.jpg' } },
		});
		expect(v?.coverUrl).toBe('https://example.com/small.jpg');
	});

	it('passes https URLs through unchanged', async () => {
		const v = await gbVolumeToBookView(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', imageLinks: { thumbnail: 'https://example.com/cover.jpg' } },
		});
		expect(v?.coverUrl).toBe('https://example.com/cover.jpg');
	});
});

describe('gbAuthorSlugToName', () => {
	it('maps a real-name slug back to its space-joined form', () => {
		expect(gbAuthorSlugToName('gbauthors-c-s-lewis')).toBe('c s lewis');
		expect(gbAuthorSlugToName('gbauthors-tolkien-j-r-r')).toBe('tolkien j r r');
	});

	it('passes through a hash-fallback slug as the base36 token', () => {
		// Hash is opaque; just verify shape and that no `-` rewriting happens
		// inside the token.
		const result = gbAuthorSlugToName('gbauthors-xn-1abc23');
		expect(result).toBe('1abc23');
	});

	it('throws on a slug that lacks the gbauthors- prefix', () => {
		expect(() => gbAuthorSlugToName('tolkien-j-r-r')).toThrow(/not a gbauthor slug/);
		expect(() => gbAuthorSlugToName('other-authors-tolkien')).toThrow(/not a gbauthor slug/);
	});

	it('throws on empty or whitespace input', () => {
		expect(() => gbAuthorSlugToName('')).toThrow(/not a gbauthor slug/);
		expect(() => gbAuthorSlugToName('gbauthors-')).toThrow(/not a gbauthor slug/);
	});
});

describe('cursor codec', () => {
	it('round-trips a cursor', () => {
		const c = { q: 'flowers', startIndex: 40 };
		expect(decodeGbCursor(encodeGbCursor(c))).toEqual(c);
	});

	it('returns undefined for missing/invalid input', () => {
		expect(decodeGbCursor(undefined)).toBeUndefined();
		expect(decodeGbCursor('')).toBeUndefined();
		expect(decodeGbCursor('not-base64!')).toBeUndefined();
		expect(decodeGbCursor(Buffer.from('{}', 'utf8').toString('base64url'))).toBeUndefined();
	});
});