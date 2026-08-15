import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { userRecords } from '../db/schema.js';
import type { PdsRecord } from '../xrpc/views.js';

type Db = BetterSQLite3Database;

interface UserRecordRow {
	did: string;
	collection: string;
	rkey: string;
	cid: string;
	record: unknown;
}

function toPdsRecord(row: UserRecordRow): PdsRecord {
	return {
		uri: `at://${row.did}/${row.collection}/${row.rkey}`,
		cid: row.cid,
		value: row.record,
	};
}

/** Fetch a single Jetstream-indexed user record by its identity, or undefined if not indexed. */
export function getUserRecord(db: Db, did: string, collection: string, rkey: string): PdsRecord | undefined {
	const row = db
		.select()
		.from(userRecords)
		.where(and(eq(userRecords.did, did), eq(userRecords.collection, collection), eq(userRecords.rkey, rkey)))
		.get();
	return row ? toPdsRecord(row) : undefined;
}

/** List every Jetstream-indexed record in a collection, across all DIDs. */
export function listByCollection(db: Db, collection: string): PdsRecord[] {
	const rows = db.select().from(userRecords).where(eq(userRecords.collection, collection)).all();
	return rows.map(toPdsRecord);
}
