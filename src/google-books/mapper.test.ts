import { describe, expect, it } from 'vitest';
import type { GbVolume } from './client.js';
import { COLLECTION } from '../lex/collections.js';
import {
	decodeGbCursor,
	encodeGbCursor,
	gbIdentifiersToIdentifiers,
	gbVolumeToEditionRecord,
} from './mapper.js';

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
	},
};

describe('gbIdentifiersToIdentifiers', () => {
	it('maps ISBN_10 to isbn10 + urn:isbn URI', () => {
		const out = gbIdentifiersToIdentifiers(SAMPLE.volumeInfo);
		expect(out).toContainEqual({ uri: 'urn:isbn:055380457X', resource: 'isbn10' });
		expect(out).toContainEqual({ uri: 'urn:isbn:9780553804577', resource: 'isbn13' });
	});
});

describe('gbVolumeToEditionRecord', () => {
	it('maps a full volume to a community edition record', () => {
		const rec = gbVolumeToEditionRecord(ctx, SAMPLE);
		expect(rec).toBeDefined();
		expect(rec?.$type).toBe(COLLECTION.edition);
		expect(rec?.title).toBe('The Google Story');
		expect(rec?.subtitle).toBe('Inside the Hottest Business, Media, and Technology Success of Our Time');
		expect(rec?.publishedYear).toBe(2005);
		expect(rec?.description).toBe('A story about Google.');
		const identifiers = rec?.identifiers as Array<{ uri: string; resource: string }>;
		expect(identifiers).toContainEqual({ uri: 'urn:isbn:055380457X', resource: 'isbn10' });
		expect(identifiers).toContainEqual({ uri: 'urn:isbn:9780553804577', resource: 'isbn13' });
	});

	it('returns undefined when title is missing', () => {
		expect(gbVolumeToEditionRecord(ctx, { id: 'x', volumeInfo: {} })).toBeUndefined();
	});

	it('handles minimal volumeInfo gracefully', () => {
		const v = gbVolumeToEditionRecord(ctx, {
			id: 'a_b-1',
			volumeInfo: { title: 'Minimal' },
		});
		expect(v?.title).toBe('Minimal');
		expect(v?.identifiers ?? []).toEqual([]);
	});

	it('omits publishedYear for unparseable dates', () => {
		const v = gbVolumeToEditionRecord(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', publishedDate: 'banana' },
		});
		expect(v?.publishedYear).toBeUndefined();
	});

	it('emits no coverUrl in the record (covers live in getImageForBook)', () => {
		const v = gbVolumeToEditionRecord(ctx, {
			id: 'x',
			volumeInfo: { title: 'T', imageLinks: { thumbnail: 'https://example.com/cover.jpg' } },
		});
		expect((v as Record<string, unknown>)?.coverUrl).toBeUndefined();
	});
});

describe('gb cursor', () => {
	it('round-trips a cursor', () => {
		const c = { q: 'foo', startIndex: 20 };
		const encoded = encodeGbCursor(c);
		expect(decodeGbCursor(encoded)).toEqual(c);
	});

	it('returns undefined for missing cursor', () => {
		expect(decodeGbCursor(undefined)).toBeUndefined();
	});

	it('returns undefined for invalid cursor', () => {
		expect(decodeGbCursor('not-base64!!')).toBeUndefined();
	});
});