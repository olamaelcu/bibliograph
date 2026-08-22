import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import * as schema from '../db/schema.js';
import {
	contributors,
	contributorIdentifiers,
	editions,
	bookIdentifiers,
} from '../db/schema.js';

export const SERVICE_DID = 'did:web:books.example.com';
export const SERVICE_HOST = 'books.example.com';

export const COLLECTION = {
	edition: 'community.lexicon.book.edition',
	contributor: 'community.lexicon.book.contributor',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
} as const;

export function uri(collection: string, pk: string): string {
	return `at://${SERVICE_DID}/${collection}/${pk}`;
}

export interface TestDb {
	db: NodePgDatabase<typeof schema>;
	seed: () => Promise<void>;
	reset: () => Promise<void>;
	close: () => Promise<void>;
}

type Database = NodePgDatabase<typeof schema>;

/**
 * Vitest's forks pool runs one process per test file, so a database named after
 * the worker pid gives cross-file isolation with no coordination: each file
 * CREATE DATABASEs its own throwaway `bibliograph_test_<pid>` on first use,
 * runs migrations once per process, and truncates between tests within the
 * file. The DATABASE_URL host/port/credentials are reused as-is; only the
 * database name is swapped, so tests can run against the docker-compose
 * Postgres unchanged.
 */
const TEST_DB_CACHE = new Map<string, TestDb>();

export async function createTestDb(): Promise<TestDb> {
	const baseUrl = new URL(process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph_test');
	const dbName = `bibliograph_test_${process.pid}`;
	let testDb = TEST_DB_CACHE.get(dbName);
	if (!testDb) {
		await ensureDatabase(baseUrl, dbName);

		const url = new URL(baseUrl);
		url.pathname = `/${dbName}`;
		const pool = new Pool({ connectionString: url.toString(), max: 1 });
		const db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });

		testDb = {
			db,
			seed: async () => {
				await seed(db);
			},
			reset: async () => {
				await truncateAll(db);
			},
			close: async () => {
				await pool.end();
			},
		};
		TEST_DB_CACHE.set(dbName, testDb);
	}
	await testDb.reset();
	return testDb;
}

async function ensureDatabase(baseUrl: URL, dbName: string): Promise<void> {
	const adminUrl = new URL(baseUrl);
	adminUrl.pathname = '/postgres';
	const client = new Client({ connectionString: adminUrl.toString() });
	try {
		await client.connect();
		const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
		if (existing.rowCount === 0) {
			await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
		}
	} finally {
		await client.end();
	}
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

async function truncateAll(db: Database): Promise<void> {
	const result = await db.execute(
		sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'`,
	);
	const tables = result.rows.map((r) => (r as { tablename: string }).tablename);
	if (tables.length === 0) return;
	await db.execute(sql.raw(`TRUNCATE TABLE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`));
}

async function seed(db: Database) {
	const now = Math.floor(Date.now() / 1000);

	const contributorRows = [
		{ pk: 'ctest-author-herbert', name: 'Frank Herbert', sortName: 'Herbert, Frank', bio: 'American author', createdAt: now, updatedAt: null },
		{ pk: 'ctest-author-algernon', name: 'Daniel Keyes', sortName: 'Keyes, Daniel', bio: 'American writer', createdAt: now, updatedAt: null },
	];
	await db.insert(contributors).values(contributorRows);

	// GB lazy-load rkey (`gb-*`) for one edition, plus a TID rkey for another.
	// Lets image-lookup tests cover both paths.
	const duneTid = 'test-edition-dune';
	const duneGb = 'gb-dune';
	const duneRkey = duneTid; // GB lazy-load keyed by `gb-<volumeId>`
	const flowersTid = 'test-edition-flowers';
	void duneGb;

	const editionRows = [
		{
			pk: duneTid,
			title: 'Dune (40th Anniversary)',
			subtitle: null,
			language: 'en',
			place: null,
			workUri: null,
			publisherUri: null,
			publishedYear: 2005,
			description: 'The classic.',
			contributors: [
				{ subject: 'ctest-author-herbert', role: 'author' },
			],
			cid: '',
			createdAt: now,
			updatedAt: null,
		},
		{
			pk: flowersTid,
			title: 'Flowers for Algernon',
			subtitle: null,
			language: 'en',
			place: null,
			workUri: null,
			publisherUri: null,
			publishedYear: 1966,
			description: 'A touching story.',
			contributors: [
				{ subject: 'ctest-author-algernon', role: 'author' },
			],
			cid: '',
			createdAt: now,
			updatedAt: null,
		},
	];
	await db.insert(editions).values(editionRows);

	await db.insert(bookIdentifiers).values([
		{ bookPk: duneTid, valueScheme: 'isbn13', value: '9780441172719', uri: 'urn:isbn:9780441172719' },
		{ bookPk: duneTid, valueScheme: 'googleBooks', value: 'dune-vol', uri: 'https://www.googleapis.com/books/v1/volumes/dune-vol' },
		{ bookPk: flowersTid, valueScheme: 'isbn10', value: '0156030083', uri: 'urn:isbn:0156030083' },
	]);

	await db.insert(contributorIdentifiers).values([
		{ contributorPk: 'ctest-author-herbert', valueScheme: 'viaf', value: '59083797', uri: 'https://viaf.example.com/59083797' },
	]);
	void duneRkey;
}