import { describe, expect, it } from 'vitest';
import { renderPage } from './render.js';
import { renderStatsPage } from './stats.js';
import { lexiconEndpoints, procedureCount, queryCount } from '../lexicon-catalog.js';

const queries = lexiconEndpoints.filter((e) => e.type === 'query');
const procedures = lexiconEndpoints.filter((e) => e.type === 'procedure');

describe('lexicon catalog', () => {
	it('extracts every query and procedure lexicon', () => {
		expect(lexiconEndpoints.length).toBeGreaterThanOrEqual(12);
		expect(queryCount).toBeGreaterThan(0);
		for (const endpoint of lexiconEndpoints) {
			expect(endpoint.type === 'query' || endpoint.type === 'procedure').toBe(true);
			expect(endpoint.id).toMatch(/^net\.olamaelcu\.livtet\.biblio\./);
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
});

describe('page templates', () => {
	it('renders backfill progress as X of Y records with a percentage', () => {
		const html = renderPage('stats', {
			title: 'Stats',
			description: 'd',
			stats: {
				catalog: [],
				openIssues: 0,
				backfill: [
					{ name: 'ol-works', complete: false, totalProcessed: 20_000_000, totalRecords: 40_000_000, fileSize: null },
				],
			},
		});
		expect(html).toContain('of 40,000,000 (50%)');
	});

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

	it('renders live catalog stats', () => {
		const html = renderStatsPage();
		expect(html).toContain('<!doctype html>');
		expect(html).toContain('did-ssr');
		for (const label of ['books', 'works', 'contributors', 'formats', 'Import issues', 'Backfill state']) {
			expect(html).toContain(label);
		}
	});

	it('marks cells updatable and includes the live polling script', () => {
		const html = renderStatsPage();
		expect(html).toContain('data-stat="total"');
		expect(html).toContain('data-stat="openIssues"');
		expect(html).toContain('data-catalog=');
		expect(html).toContain('id="backfill-container"');
		expect(html).toContain("fetch('/stats.json'");
		expect(html).toContain('setInterval(refresh, POLL_MS)');
	});
});
