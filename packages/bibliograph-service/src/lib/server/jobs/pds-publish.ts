// Publish catalog editions to the publisher PDS.
//
// The outbox triggers on the catalog tables write one row per edition; this
// worker drains them into `community.lexicon.media.book.edition` records. Only
// editions are published: works, contributors and publishers no longer exist as
// records.

import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { editionRecordValue } from '../edition-record';
import { loadAppviewBook } from '../catalog/store';
import { PUBLISHER_DID } from '../did';

const PDS_URL = process.env.PDS_URL ?? 'http://127.0.0.1:2583';
const BATCH = 100;

interface OutboxRow {
	uri: string;
	rkey: string;
	op: 'create' | 'update' | 'delete';
	attempts: number;
}

interface Session {
	accessJwt: string;
}

function rowsOf<T>(result: unknown): T[] {
	return (result as { rows?: T[] }).rows ?? [];
}

async function createSession(): Promise<Session> {
	const identifier = process.env.PDS_ACCOUNT_DID ?? PUBLISHER_DID;
	const password = process.env.PDS_ACCOUNT_PASSWORD;
	if (!password) throw new Error('PDS_ACCOUNT_PASSWORD is required');
	const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier, password }),
	});
	if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
	return (await res.json()) as Session;
}

async function applyWrites(session: Session, writes: unknown[]): Promise<Response> {
	return fetch(`${PDS_URL}/xrpc/com.atproto.repo.applyWrites`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${session.accessJwt}`,
		},
		body: JSON.stringify({ repo: PUBLISHER_DID, validate: false, writes }),
	});
}

async function claimBatch(): Promise<OutboxRow[]> {
	return rowsOf<OutboxRow>(
		await db.execute(sql`
			WITH picked AS (
				SELECT uri FROM pds_outbox
				WHERE next_at <= now() AND attempts < 10
				  AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
				ORDER BY updated_at
				LIMIT ${BATCH}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE pds_outbox o SET claimed_at = now()
			FROM picked WHERE o.uri = picked.uri
			RETURNING o.uri, o.rkey, o.op, o.attempts
		`),
	);
}

async function knownCid(uri: string): Promise<string | null> {
	const rows = rowsOf<{ cid: string }>(
		await db.execute(sql`SELECT cid FROM pds_cids WHERE uri = ${uri} LIMIT 1`),
	);
	return rows[0]?.cid ?? null;
}

async function finish(uri: string): Promise<void> {
	await db.execute(sql`DELETE FROM pds_outbox WHERE uri = ${uri}`);
}

async function recordCid(uri: string, cid: string): Promise<void> {
	await db.execute(sql`
		INSERT INTO pds_cids (uri, cid, updated_at) VALUES (${uri}, ${cid}, now())
		ON CONFLICT (uri) DO UPDATE SET cid = excluded.cid, updated_at = now()
	`);
}

async function fail(row: OutboxRow, message: string): Promise<void> {
	const attempts = row.attempts + 1;
	await db.execute(sql`
		UPDATE pds_outbox
		SET attempts = ${attempts},
		    claimed_at = NULL,
		    last_error = ${message.slice(0, 2000)},
		    next_at = now() + (interval '1 minute' * power(2, ${Math.min(attempts, 10)})),
		    updated_at = now()
		WHERE uri = ${row.uri}
	`);
}

interface ApplyResult {
	results?: Array<{ uri?: string; cid?: string }>;
}

async function publishOne(session: Session, row: OutboxRow, log: Logger): Promise<boolean> {
	if (row.op === 'delete') {
		const res = await applyWrites(session, [
			{ $type: 'com.atproto.repo.applyWrites#delete', collection: 'community.lexicon.media.book.edition', rkey: row.rkey },
		]);
		if (res.ok || res.status === 400) {
			// `RecordNotFound` on delete is success.
			await db.execute(sql`DELETE FROM pds_cids WHERE uri = ${row.uri}`);
			await finish(row.uri);
			return true;
		}
		await fail(row, `delete failed: ${res.status} ${await res.text()}`);
		return false;
	}

	const book = await loadAppviewBook(row.uri);
	const value = book ? editionRecordValue(book) : null;
	if (!value) {
		await fail(row, 'edition has no identifiers; not lexicon-valid');
		return false;
	}

	const existing = await knownCid(row.uri);
	const write = {
		$type: existing
			? 'com.atproto.repo.applyWrites#update'
			: 'com.atproto.repo.applyWrites#create',
		collection: 'community.lexicon.media.book.edition',
		rkey: row.rkey,
		value,
	};
	const res = await applyWrites(session, [write]);
	if (res.ok) {
		const body = (await res.json().catch(() => ({}))) as ApplyResult;
		const cid = body.results?.[0]?.cid;
		if (cid) await recordCid(row.uri, cid);
		await finish(row.uri);
		return true;
	}
	const text = await res.text();
	// A stale `pds_cids` row is the common failure: retry with the other op once.
	if (/AlreadyExists/i.test(text) || /RecordNotFound/i.test(text)) {
		const retry = {
			$type: write.$type.endsWith('#create')
				? 'com.atproto.repo.applyWrites#update'
				: 'com.atproto.repo.applyWrites#create',
			collection: write.collection,
			rkey: write.rkey,
			value,
		};
		const second = await applyWrites(session, [retry]);
		if (second.ok) {
			const body = (await second.json().catch(() => ({}))) as ApplyResult;
			const cid = body.results?.[0]?.cid;
			if (cid) await recordCid(row.uri, cid);
			await finish(row.uri);
			return true;
		}
		await fail(row, `applyWrites retry failed: ${second.status} ${await second.text()}`);
		return false;
	}
	log.warn({ err: text.slice(0, 500), uri: row.uri }, 'pds publish failed');
	await fail(row, `applyWrites failed: ${res.status} ${text}`);
	return false;
}

/** Drain up to one batch. Returns how many rows remain. */
export async function publishPendingEditions(log: Logger): Promise<number> {
	const rows = await claimBatch();
	if (rows.length === 0) return 0;
	let session = await createSession();
	let published = 0;
	for (const row of rows) {
		const ok = await publishOne(session, row, log);
		if (ok) published += 1;
	}
	const remaining = rowsOf<{ count: string }>(
		await db.execute(sql`SELECT count(*)::text AS count FROM pds_outbox WHERE attempts < 10`),
	)[0];
	log.info({ published, remaining: Number(remaining?.count ?? 0) }, 'pds outbox drained');
	return Number(remaining?.count ?? 0);
}
