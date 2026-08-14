import { describe, expect, it } from 'vitest';
import { identifierResource, olKey, sourceKeySlug } from './slugs.js';

describe('sourceKeySlug', () => {
	it('slugifies OL keys', () => {
		expect(sourceKeySlug('/books/OL123M')).toBe('books/ol123m');
		expect(sourceKeySlug('/works/OL893423W')).toBe('works/ol893423w');
	});

	it('keeps hiveId rkeys stable', () => {
		expect(sourceKeySlug('3q2x4v')).toBe('3q2x4v');
	});

	it('throws on unusable keys', () => {
		expect(() => sourceKeySlug('///')).toThrow();
	});
});

describe('identifierResource', () => {
	it('namespaces values', () => {
		expect(identifierResource('openlibrary', 'OL123M')).toBe('openlibrary:OL123M');
		expect(identifierResource('hiveId', 'abc')).toBe('hiveId:abc');
	});
});
