import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderPage } from './render.js';
import { catalogRecordNsids, lexiconEndpoints, procedureCount, queryCount, recordLexicons } from '../lexicon-catalog.js';
import { createTestDb } from '../test-utils/db.js';

const dbHolder = vi.hoisted(() => ({
	db: undefined as
		| Awaited<ReturnType<typeof createTestDb>>['db']
		| undefined,
}));
vi.mock('../db/connection.js', () => ({
	get db() {
		return dbHolder.db;
	},
}));

beforeAll(async () => {
	const { db } = await createTestDb();
	dbHolder.db = db;
});

const queries = lexiconEndpoints.filter((e) => e.type === 'query');
const procedures = lexiconEndpoints.filter((e) => e.type === 'procedure');

describe('lexicon catalog', () => {
	it('extracts every query and procedure lexicon', () => {
		expect(lexiconEndpoints.length).toBeGreaterThanOrEqual(12);
		expect(queryCount).toBeGreaterThan(0);
		for (const endpoint of lexiconEndpoints) {
			expect(endpoint.type === 'query' || endpoint.type === 'procedure').toBe(true);
			expect(endpoint.id).toMatch(/^(net\.olamaelcu\.livtet\.biblio\.|com\.atproto\.)/);
		}
	});

	it('no longer catalogs any write procedures (writes go browser → user PDS directly)', () => {
		const writeIds = lexiconEndpoints
			.filter((e) => /^(put|delete)/.test(e.name))
			.map((e) => e.id)
			.sort();
		expect(writeIds).toEqual([]);
		expect(procedureCount).toBe(0);
		for (const endpoint of lexiconEndpoints) {
			expect(endpoint.lexiconPath).toBeDefined();
		}
	});

	it('documents parameters and output of searchBooks', () => {
		const search = lexiconEndpoints.find((e) => e.name === 'searchBooks');
		expect(search).toBeDefined();
		expect(search?.params.some((p) => p.name === 'q' && p.required)).toBe(true);
		expect(search?.output?.properties.some((p) => p.name === 'books')).toBe(true);
	});

	it('marks params required/optional and includes descriptions', () => {
		const getBook = lexiconEndpoints.find((e) => e.name === 'getBook');
		expect(getBook?.params).toEqual([
			expect.objectContaining({ name: 'uri', type: 'string', required: true }),
		]);
		expect(getBook?.description).toMatch(/hydrated view/);
	});

	describe('record lexicons', () => {
		it('extracts every record-type lexicon', () => {
			expect(recordLexicons.length).toBeGreaterThanOrEqual(9);
			for (const record of recordLexicons) {
				expect(record.type).toBe('record');
				expect(record.id).toMatch(/^net\.olamaelcu\.livtet\.biblio\./);
			}
		});

		it('classifies the catalog records by ownership', () => {
			const catalog = recordLexicons.filter((r) => catalogRecordNsids.has(r.id));
			const users = recordLexicons.filter((r) => !catalogRecordNsids.has(r.id));
		expect(catalog.map((r) => r.name).sort()).toEqual([
			'book',
			'bookContributor',
			'contributor',
			'contributorRole',
			'format',
			'genre',
		]);
		expect(users.map((r) => r.name).sort()).toEqual([
			'actor',
			'bookShelving',
			'shelf',
		]);
		});

		it('captures schema constraints on record properties', () => {
			const bookShelving = recordLexicons.find((r) => r.name === 'bookShelving');
			expect(bookShelving).toBeDefined();
			const shelf = bookShelving?.properties.find((p) => p.name === 'shelf');
			expect(shelf?.type).toMatch(/^ref /);
			expect(shelf?.required).toBe(true);
			const metadata = bookShelving?.properties.find((p) => p.name === 'metadata');
			expect(metadata?.type).toMatch(/^ref/);
		});
	});
});

describe('page templates', () => {
	it('renders a full document with declarative shadow DOM', () => {
		const html = renderPage('home', { title: 'Overview', description: 'd', queryCount, procedureCount });
		expect(html).toContain('<!doctype html>');
		expect(html).toContain('did-ssr');
		expect(html).toContain('shadowrootmode');
	});

	it('lists every query endpoint on the queries page and no procedures', () => {
		const html = renderPage('queries', { title: 'Queries', description: 'd', endpoints: queries });
		for (const e of queries) {
			expect(html).toContain(e.id);
		}
		for (const e of procedures) {
			expect(html).not.toContain(e.id);
		}
	});

	it('lists every procedure endpoint on the procedures page and no queries', () => {
		const html = renderPage('procedures', { title: 'Procedures', description: 'd', endpoints: procedures });
		for (const e of procedures) {
			expect(html).toContain(e.id);
		}
		for (const e of queries) {
			expect(html).not.toContain(e.id);
		}
	});

	it('includes the ssr loader and theme stylesheet', () => {
		const html = renderPage('home', { title: 'Overview', description: 'd', queryCount, procedureCount });
		expect(html).toContain('/webawesome/dist-cdn/webawesome.ssr-loader.js');
		expect(html).toContain('/webawesome/dist-cdn/styles/webawesome.css');
	});

	it('lists every record lexicon on the records page, grouped by ownership', () => {
		const catalog = recordLexicons.filter((r) => catalogRecordNsids.has(r.id));
		const users = recordLexicons.filter((r) => !catalogRecordNsids.has(r.id));
		const html = renderPage('records', {
			title: 'Records',
			description: 'd',
			catalog,
			users,
		});
		expect(html).toContain('AppView catalog records');
		expect(html).toContain('User-owned records');
		for (const r of recordLexicons) {
			expect(html).toContain(r.id);
			expect(html).toContain(r.lexiconPath);
		}
	});

	it('renders the search page with a form and the searchBooks XRPC query', () => {
		const html = renderPage('search', { title: 'Search', description: 'd' });
		expect(html).toContain('id="search-form"');
		expect(html).toContain('id="search-q"');
		expect(html).toContain('/xrpc/net.olamaelcu.livtet.biblio.searchBooks');
		expect(html).toContain('bc.contributor?.name');
		expect(html).toContain('book.coverUrl');
	});

	it('wires up cursor-based load-more pagination in the search script', () => {
		const html = renderPage('search', { title: 'Search', description: 'd' });
		expect(html).toContain('let currentCursor = null');
		expect(html).toContain('currentCursor = data.cursor');
		expect(html).toContain('cursor: currentCursor');
		expect(html).toContain('appendLoadMore');
		expect(html).toContain('load-more-btn');
		expect(html).toContain('End of results');
	});

	it('renders the examples index with one section per category and every query NSID', async () => {
		const { groupByCategory, exampleEntries } = await import('./categories.js');
		const html = renderPage('examples', {
			title: 'Examples',
			description: 'd',
			groups: groupByCategory(exampleEntries(lexiconEndpoints)),
		});
		expect(html).toContain('Independent lookups');
		expect(html).toContain('Composite / cross-entity');
		expect(html).toContain('Lists &amp; search');
		for (const e of exampleEntries(lexiconEndpoints)) {
			expect(html).toContain(e.endpoint.id);
		}
	});

	it('renders a per-query example page with form, output container, and renderer import', async () => {
		const { findExample } = await import('./categories.js');
		const entry = findExample(lexiconEndpoints, 'getBook');
		expect(entry).toBeDefined();
		const html = renderPage('examples/getBook', {
			title: 'getBook',
			description: 'd',
			nsid: entry!.endpoint.id,
			renderer: entry!.renderer,
			endpoint: entry!.endpoint,
		});
		expect(html).toContain('id="example-form"');
		expect(html).toContain('id="example-output"');
		expect(html).toContain('id="param-uri"');
		expect(html).toContain('net.olamaelcu.livtet.biblio.getBook');
		expect(html).toContain('/static/examples-client.js');
		expect(html).toContain('/static/renderers.js');
		expect(html).toContain('renderBook');
	});

	it('includes the active nav marker on the Examples page', () => {
		const html = renderPage('examples', {
			title: 'Examples',
			description: 'd',
			groups: { independent: [], composite: [], list: [] },
		});
		expect(html).toContain('href="/examples"');
		expect(html).toContain('Examples');
	});
});
