import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
	XRPCRouter,
	json,
	InvalidRequestError,
	XRPCError,
} from '@atcute/xrpc-server';
import { ComAtprotoIdentityResolveHandle, ComAtprotoRepoDescribeRepo, ComAtprotoRepoGetRecord, ComAtprotoRepoListRecords } from '@atcute/atproto';
import { cidForRecord } from './cid.js';
import {
	COLLECTIONS,
	isOwnedCollection,
	loadCid,
	loadRecord,
	persistCid,
	type OwnedCollection,
} from './records.js';
import { buildDidDocument } from '../did.js';
import { contributors, contributorRoles, formats, genres, works, books } from '../db/schema.js';
import { releasedFilter } from '../xrpc/gate.js';
import type { ViewContext } from '../xrpc/views.js';

type Db = BetterSQLite3Database;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function recordKeyUri(did: string, collection: string, pk: string): string {
	return `at://${did}/${collection}/${pk}`;
}

function rkeyFromParam(rkey: string): string {
	// record-key format allows alphanumerics, `.`, `-`, `_`, `:`, `~`
	if (!/^[A-Za-z0-9.\-_:~]{1,512}$/.test(rkey)) {
		throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'invalid record key' });
	}
	return rkey;
}

/** True when `repo` is our DID or our bare host (handle). */
function requestHost(request: Request): string {
	const header =
		request.headers.get('x-forwarded-host') ??
		request.headers.get('host') ??
		new URL(request.url).host ??
		'';
	return header.split(':')[0];
}

function isOwnedRepo(ctx: ViewContext, host: string, repo: string): boolean {
	if (repo === ctx.serviceDid) return true;
	if (host && repo.toLowerCase() === host.toLowerCase()) return true;
	return false;
}

function errorInvalidRequest(message: string): never {
	throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message });
}

function errorRecordNotFound(message: string): never {
	throw new XRPCError({ status: 400, error: 'RecordNotFound', message });
}

export function registerPdsHandlers(router: XRPCRouter, db: Db, ctx: ViewContext): void {
	// ─── getRecord ────────────────────────────────────────────────────────
	router.addQuery(ComAtprotoRepoGetRecord.mainSchema, {
		async handler({ params, request }) {
			const host = requestHost(request);
			if (!isOwnedRepo(ctx, host, params.repo)) {
				errorInvalidRequest(`repo not hosted by this PDS: ${params.repo}`);
			}
			if (!isOwnedCollection(params.collection)) {
				errorInvalidRequest(`unsupported collection: ${params.collection}`);
			}
			const rkey = rkeyFromParam(params.rkey);

			const value = await loadRecord(db, ctx, params.collection, rkey);
			if (!value) {
				errorRecordNotFound(`record not found: ${params.repo}/${params.collection}/${rkey}`);
			}

			let cid = loadCid(db, params.collection, rkey);
			if (!cid) {
				cid = await cidForRecord(value!);
				persistCid(db, params.collection, rkey, cid);
			}

			if (params.cid && params.cid !== cid) {
				errorInvalidRequest(`cid mismatch: stored=${cid} requested=${params.cid}`);
			}

			return json({
				uri: recordKeyUri(ctx.serviceDid, params.collection, rkey) as ComAtprotoRepoGetRecord.$output['uri'],
				cid,
				value: value!,
			});
		},
	});

	// ─── listRecords ──────────────────────────────────────────────────────
	router.addQuery(ComAtprotoRepoListRecords.mainSchema, {
		async handler({ params, request }) {
			const host = requestHost(request);
			if (!isOwnedRepo(ctx, host, params.repo)) {
				errorInvalidRequest(`repo not hosted by this PDS: ${params.repo}`);
			}
			if (!isOwnedCollection(params.collection)) {
				errorInvalidRequest(`unsupported collection: ${params.collection}`);
			}

			const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
			const reverse = params.reverse ?? false;
			const cursorRkey = params.cursor ? rkeyFromParam(decodeCursor(params.cursor)) : null;

			const rows = await listPage(db, params.collection, {
				limit,
				reverse,
				cursorRkey,
			});

			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;

			const out = [];
			for (const pk of page) {
				const value = await loadRecord(db, ctx, params.collection, pk);
				if (!value) continue;
				let cid = loadCid(db, params.collection, pk);
				if (!cid) {
					cid = await cidForRecord(value);
					persistCid(db, params.collection, pk, cid);
				}
				out.push({
					uri: recordKeyUri(ctx.serviceDid, params.collection, pk) as ComAtprotoRepoListRecords.$output['records'][number]['uri'],
					cid,
					value,
				});
			}

			const nextCursor =
				hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : undefined;

			return json({ records: out, ...(nextCursor ? { cursor: nextCursor } : {}) });
		},
	});

	// ─── describeRepo ─────────────────────────────────────────────────────
	router.addQuery(ComAtprotoRepoDescribeRepo.mainSchema, {
		async handler({ params, request }) {
			const host = requestHost(request);
			if (!isOwnedRepo(ctx, host, params.repo)) {
				errorInvalidRequest(`repo not hosted by this PDS: ${params.repo}`);
			}

			const proto = request.headers.get('x-forwarded-proto') ?? 'https';
			const endpoint = `${proto}://${host}`;
			const didDoc = buildDidDocument(ctx.serviceDid.replace(/^did:web:/, ''), proto);

			return json({
				handle: host as ComAtprotoRepoDescribeRepo.$output['handle'],
				did: ctx.serviceDid as ComAtprotoRepoDescribeRepo.$output['did'],
				didDoc,
				collections: Object.values(COLLECTIONS),
				handleIsCorrect: true,
			});
		},
	});

	// ─── resolveHandle ────────────────────────────────────────────────────
	router.addQuery(ComAtprotoIdentityResolveHandle.mainSchema, {
		async handler({ params, request }) {
			const handle = requestHost(request).toLowerCase();
			if (params.handle.toLowerCase() !== handle) {
				errorInvalidRequest(`handle not hosted by this PDS: ${params.handle}`);
			}
			return json({ did: ctx.serviceDid as ComAtprotoIdentityResolveHandle.$output['did'] });
		},
	});
}

// ─── page loading ────────────────────────────────────────────────────────────

async function listPage(
	db: Db,
	collection: OwnedCollection,
	opts: { limit: number; reverse: boolean; cursorRkey: string | null },
): Promise<string[]> {
	const { limit, reverse, cursorRkey } = opts;
	const t = tableFor(collection);
	const base = db.select({ pk: t.pk }).from(t);
	const conds: any[] = [];
	if (cursorRkey) {
		conds.push(reverse ? sql`${t.pk} < ${cursorRkey}` : sql`${t.pk} > ${cursorRkey}`);
	}
	if ('releaseStatus' in t) {
		conds.push(releasedFilter(t));
	}
	const rows = base
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(reverse ? sql`${t.pk} DESC` : sql`${t.pk} ASC`)
		.limit(limit + 1)
		.all();
	return rows.map((r) => r.pk);
}

function tableFor(collection: OwnedCollection) {
	switch (collection) {
		case COLLECTIONS.book:
			return books;
		case COLLECTIONS.work:
			return works;
		case COLLECTIONS.contributor:
			return contributors;
		case COLLECTIONS.contributorRole:
			return contributorRoles;
		case COLLECTIONS.format:
			return formats;
		case COLLECTIONS.genre:
			return genres;
	}
}

function encodeCursor(pk: string): string {
	return Buffer.from(pk, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
	try {
		return Buffer.from(cursor, 'base64url').toString('utf8');
	} catch {
		errorInvalidRequest('invalid cursor');
	}
}
