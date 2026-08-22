import { describe, expect, it } from 'vitest';
import { exampleEntries, findExample, groupByCategory } from './categories.js';
import { lexiconEndpoints } from '../lexicon-catalog.js';

describe('exampleEntries', () => {
	it('returns one entry per query, excluding resolveLexicon', () => {
		const entries = exampleEntries(lexiconEndpoints);
		const names = entries.map((e) => e.endpoint.name).sort();
		expect(names).toEqual([
			'getActor',
			'getBook',
			'getBookOnShelf',
			'getContributor',
			'getGenre',
			'getShelf',
			'getShelvingOfBook',
			'listBooks',
			'listBooksOnShelf',
			'listGenres',
			'listShelves',
			'listShelvesWithBooks',
			'searchBooks',
			'searchContributors',
		]);
	});

	it('classifies endpoints into the right categories', () => {
		const entries = exampleEntries(lexiconEndpoints);
		const byName = Object.fromEntries(entries.map((e) => [e.endpoint.name, e.category]));
		expect(byName.getActor).toBe('independent');
		expect(byName.getBook).toBe('independent');
		expect(byName.getBookOnShelf).toBe('independent');
		expect(byName.getContributor).toBe('independent');
		expect(byName.getGenre).toBe('independent');
		expect(byName.getShelf).toBe('independent');
		expect(byName.getShelvingOfBook).toBe('composite');
		expect(byName.listBooksOnShelf).toBe('composite');
		expect(byName.listBooks).toBe('list');
		expect(byName.listGenres).toBe('list');
		expect(byName.listShelves).toBe('list');
		expect(byName.listShelvesWithBooks).toBe('list');
		expect(byName.searchBooks).toBe('list');
		expect(byName.searchContributors).toBe('list');
	});

	it('assigns a renderer to every entry', () => {
		const entries = exampleEntries(lexiconEndpoints);
		for (const entry of entries) {
			expect(entry.renderer).toMatch(/^render/);
		}
	});

	it('returns an empty list when given no endpoints', () => {
		expect(exampleEntries([])).toEqual([]);
	});
});

describe('groupByCategory', () => {
	it('groups entries into the three demo buckets', () => {
		const entries = exampleEntries(lexiconEndpoints);
		const groups = groupByCategory(entries);
		expect(groups.independent.length).toBe(6);
		expect(groups.composite.length).toBe(2);
		expect(groups.list.length).toBe(6);
	});
});

describe('findExample', () => {
	it('returns the demo entry for a known query name', () => {
		const entry = findExample(lexiconEndpoints, 'getBook');
		expect(entry).toBeDefined();
		expect(entry?.endpoint.id).toBe('net.olamaelcu.livtet.biblio.getBook');
		expect(entry?.category).toBe('independent');
		expect(entry?.renderer).toBe('renderBook');
	});

	it('returns undefined for an unknown name', () => {
		expect(findExample(lexiconEndpoints, 'doesNotExist')).toBeUndefined();
	});
});
