#!/usr/bin/env tsx
// Upload lexicons and Lua query scripts to HappyView, then apply the activity
// indexes. Run with `pnpm --filter bibliograph-service hv:deploy`.
//
// HappyView is an upstream, not the public origin: HAPPYVIEW_URL is the loopback
// service, HAPPYVIEW_ADMIN_KEY is an `hv_` admin API key.

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Pool } from 'pg';

const ADMIN_KEY = process.env.HAPPYVIEW_ADMIN_KEY;
const BASE = `${process.env.HAPPYVIEW_URL ?? 'http://127.0.0.1:3000'}/~/hv`;
const ROOT = new URL('.', import.meta.url).pathname;
const LEXICONS = new URL('../lexicons/', import.meta.url).pathname;

if (!ADMIN_KEY) {
	console.warn('[hv:deploy] HAPPYVIEW_ADMIN_KEY is unset; skipping (nothing uploaded)');
	process.exit(0);
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${ADMIN_KEY}`,
			'content-type': 'application/json',
			...(init.headers ?? {}),
		},
	});
}

async function requireOk(label: string, res: Response): Promise<void> {
	if (res.ok) return;
	const body = await res.text().catch(() => '');
	throw new Error(`${label} failed: ${res.status} ${body}`);
}

async function readLexicon(nsid: string): Promise<Record<string, unknown>> {
	const path = join(LEXICONS, `${nsid.split('.').join('/')}.json`);
	return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** Record lexicons: indexed from Jetstream/backfill. */
const RECORD_LEXICONS = [
	'net.olamaelcu.livtet.biblio.bookShelving',
	'net.olamaelcu.livtet.biblio.shelf',
	'net.olamaelcu.livtet.biblio.shelfItem',
	'net.olamaelcu.livtet.biblio.follow',
	'net.olamaelcu.livtet.biblio.readingGoal',
	'net.olamaelcu.livtet.actor.profile',
	'community.lexicon.media.book.review',
];

/** Query lexicons: each reads one collection, so it is the target collection. */
const QUERY_LEXICONS: Array<[nsid: string, targetCollection: string]> = [
	['net.olamaelcu.livtet.biblio.graph.isFollowing', 'net.olamaelcu.livtet.biblio.follow'],
	['net.olamaelcu.livtet.biblio.graph.listFollowers', 'net.olamaelcu.livtet.biblio.follow'],
	['net.olamaelcu.livtet.biblio.graph.listFollowees', 'net.olamaelcu.livtet.biblio.follow'],
	['net.olamaelcu.livtet.biblio.getReadingGoal', 'net.olamaelcu.livtet.biblio.readingGoal'],
	['net.olamaelcu.livtet.biblio.getActorProfile', 'net.olamaelcu.livtet.actor.profile'],
	['net.olamaelcu.livtet.biblio.getShelf', 'net.olamaelcu.livtet.biblio.shelf'],
	['net.olamaelcu.livtet.biblio.listShelves', 'net.olamaelcu.livtet.biblio.shelf'],
	['net.olamaelcu.livtet.biblio.listShelvesWithBooks', 'net.olamaelcu.livtet.biblio.shelf'],
	['net.olamaelcu.livtet.biblio.getShelvingOfBook', 'net.olamaelcu.livtet.biblio.bookShelving'],
	['net.olamaelcu.livtet.biblio.getShelversOfBook', 'net.olamaelcu.livtet.biblio.bookShelving'],
	['net.olamaelcu.livtet.biblio.listBooksOnShelf', 'net.olamaelcu.livtet.biblio.bookShelving'],
	['net.olamaelcu.livtet.biblio.listRecentShelving', 'net.olamaelcu.livtet.biblio.bookShelving'],
	['net.olamaelcu.livtet.biblio.getBookOnShelf', 'net.olamaelcu.livtet.biblio.bookShelving'],
	['net.olamaelcu.livtet.biblio.listShelfItems', 'net.olamaelcu.livtet.biblio.shelfItem'],
	['net.olamaelcu.livtet.biblio.listShelfItemsByBook', 'net.olamaelcu.livtet.biblio.shelfItem'],
	['net.olamaelcu.livtet.biblio.getReviewsByBook', 'community.lexicon.media.book.review'],
	['net.olamaelcu.livtet.biblio.listReviewsByActor', 'community.lexicon.media.book.review'],
];

/** Expand `-- @include path` recursively (v2 has no `require`). */
async function expand(body: string, seen = new Set<string>()): Promise<string> {
	const lines = body.split('\n');
	const out: string[] = [];
	for (const line of lines) {
		const match = /^--\s*@include\s+(.+)$/.exec(line.trim());
		if (!match) {
			out.push(line);
			continue;
		}
		const includePath = join(ROOT, match[1]!.trim());
		if (seen.has(includePath)) continue;
		seen.add(includePath);
		out.push(await expand(await readFile(includePath, 'utf8'), seen));
	}
	return out.join('\n');
}

async function uploadLexicons(): Promise<number> {
	let count = 0;
	for (const nsid of RECORD_LEXICONS) {
		const lexicon = await readLexicon(nsid);
		const res = await admin('/admin/lexicons', {
			method: 'POST',
			body: JSON.stringify({ lexicon_json: lexicon, backfill: true, target_collection: nsid }),
		});
		await requireOk(`lexicon ${nsid}`, res);
		count += 1;
	}
	for (const [nsid, target] of QUERY_LEXICONS) {
		const lexicon = await readLexicon(nsid);
		const res = await admin('/admin/lexicons', {
			method: 'POST',
			body: JSON.stringify({ lexicon_json: lexicon, backfill: false, target_collection: target }),
		});
		await requireOk(`lexicon ${nsid}`, res);
		count += 1;
	}
	return count;
}

async function uploadScripts(): Promise<number> {
	const dir = join(ROOT, 'scripts/xrpc/query');
	const files = (await readdir(dir)).filter((name) => name.endsWith('.lua')).sort();
	let count = 0;
	for (const file of files) {
		const nsid = file.replace(/\.lua$/, '');
		const body = await expand(await readFile(join(dir, file), 'utf8'));
		const res = await admin('/admin/scripts', {
			method: 'POST',
			body: JSON.stringify({
				id: `xrpc.query:${nsid}`,
				script_type: 'lua',
				body,
				description: `Bibliograph query ${nsid} (generated from ${relative(ROOT, join(dir, file))})`,
			}),
		});
		await requireOk(`script ${nsid}`, res);
		count += 1;
	}
	return count;
}

async function applyIndexes(): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is required to apply happyview/sql/indexes.sql');
	const sql = await readFile(join(ROOT, 'sql/indexes.sql'), 'utf8');
	const pool = new Pool({ connectionString: url, max: 1 });
	try {
		await pool.query(sql);
	} finally {
		await pool.end();
	}
}

async function main(): Promise<void> {
	const lexicons = await uploadLexicons();
	const scripts = await uploadScripts();

	const variables = await admin('/admin/script-variables', {
		method: 'POST',
		body: JSON.stringify({ key: 'PUBLISHER_DID', value: process.env.PUBLISHER_DID ?? '' }),
	});
	await requireOk('script variables', variables);

	await applyIndexes();
	console.log(`[hv:deploy] uploaded ${lexicons} lexicons and ${scripts} scripts; indexes applied`);
}

main().catch((err) => {
	console.error('[hv:deploy] failed:', err);
	process.exit(1);
});
