import { describe, expect, it } from 'vitest';
import { normalizeIsbn } from './isbn.js';

describe('normalizeIsbn', () => {
	it('strips hyphens and spaces', () => {
		expect(normalizeIsbn('978-0-441-17271-9')).toBe('9780441172719');
		expect(normalizeIsbn('978 0 441 17271 9')).toBe('9780441172719');
	});

	it('strips middle dots', () => {
		expect(normalizeIsbn('978·0·441·17271·9')).toBe('9780441172719');
	});

	it('leaves bare digits unchanged', () => {
		expect(normalizeIsbn('9780441172719')).toBe('9780441172719');
	});
});
