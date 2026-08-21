import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { userRecords } from '../db/schema.js';
import type { PdsRecord } from '../lex/collections.js';

type Db = NodePgDatabase<typeof schema>;

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
export async function getUserRecord(db: Db, did: string, collection: string, rkey: string): Promise<PdsRecord | undefined> {
	const row = (await db
		.select()
		.from(userRecords)
		.where(and(eq(userRecords.did, did), eq(userRecords.collection, collection), eq(userRecords.rkey, rkey))))[0];
	return row ? toPdsRecord(row) : undefined;
}

/** List every Jetstream-indexed record in a collection, across all DIDs. */
export async function listByCollection(db: Db, collection: string): Promise<PdsRecord[]> {
	const rows = await db.select().from(userRecords).where(eq(userRecords.collection, collection));
	return rows.map(toPdsRecord);
}
