import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import * as schema from '../db/schema.js';
import {
	contributors,
	contributorIdentifiers,
	bookContributors,
	bookGenres,
	bookIdentifiers,
	books,
	contributorRoles,
	formats,
	genreIdentifiers,
	genres,
} from '../db/schema.js';

export const SERVICE_DID = 'did:web:books.example.com';
export const SERVICE_HOST = 'books.example.com';

const COLLECTION = {
	book: 'net.olamaelcu.livtet.biblio.book',
	contributor: 'net.olamaelcu.livtet.biblio.contributor',
	contributorRole: 'net.olamaelcu.livtet.biblio.contributorRole',
	format: 'net.olamaelcu.livtet.biblio.format',
	genre: 'net.olamaelcu.livtet.biblio.genre',
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelving',
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
	// The cached handle is shared across all createTestDb calls in this test file
	// (one process per file under vitest forks). Re-establish the SQLite :memory:
	// contract — every call returns tables in a pristine state, not whatever a
	// previous test left behind.
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

	const formatRows = [
		{ pk: 'paperback', description: 'Paperback', emoji: '📖', iconImageUrl: 'https://cdn.example.com/fmt-paperback.png', unit: 'pages' },
		{ pk: 'ebook', description: 'E-book', emoji: '📱', iconImageUrl: null, unit: 'percent' },
	];
	const genreRows = [
		{ pk: 'fiction', name: 'Fiction', description: 'Imaginary narratives', emoji: '📚', iconImageUrl: null, parentPk: null, createdAt: now, releaseStatus: 'released', releasedAt: now },
		{ pk: 'scifi', name: 'Science Fiction', description: 'Speculative futures', emoji: '🚀', iconImageUrl: null, parentPk: 'fiction', createdAt: now, releaseStatus: 'released', releasedAt: now },
	];
	const roleRows = [
		{ pk: 'author', name: 'Author', description: 'Wrote the book', iconImageUrl: null, createdAt: now, releaseStatus: 'released', releasedAt: now },
		{ pk: 'translator', name: 'Translator', description: 'Translated the book', iconImageUrl: null, createdAt: now, releaseStatus: 'released', releasedAt: now },
	];
	const contributorRows = [
		{ pk: 'author-herbert', name: 'Frank Herbert', sortName: 'Herbert, Frank', bio: 'American author', imageUrl: null, createdAt: now, updatedAt: null, releaseStatus: 'released', releasedAt: now },
		{ pk: 'author-algernon', name: 'Daniel Keyes', sortName: 'Keyes, Daniel', bio: 'American writer', imageUrl: null, createdAt: now, updatedAt: null, releaseStatus: 'released', releasedAt: now },
	];
	const bookRows = [
		{ pk: 'book-dune', title: 'Dune (40th Anniversary)', formatPk: 'paperback', publishDate: 1119484800, description: 'The classic', coverUrl: 'https://cdn.example.com/dune.jpg', createdAt: now, updatedAt: null, releaseStatus: 'released', releasedAt: now },
		{ pk: 'book-flowers', title: 'Flowers for Algernon', formatPk: 'ebook', publishDate: 1119484800, description: 'A touching story', coverUrl: null, createdAt: now, updatedAt: null, releaseStatus: 'released', releasedAt: now },
	];
	await db.insert(formats).values(formatRows);
	await db.insert(genres).values(genreRows);
	await db.insert(contributorRoles).values(roleRows);
	await db.insert(contributors).values(contributorRows);
	await db.insert(books).values(bookRows);

	await db.insert(bookGenres).values([
		{ bookPk: 'book-dune', genrePk: 'fiction' },
		{ bookPk: 'book-dune', genrePk: 'scifi' },
	]);
	await db.insert(bookContributors).values([
		{ bookPk: 'book-dune', contributorPk: 'author-herbert', rolePk: 'author', createdAt: now },
		{ bookPk: 'book-flowers', contributorPk: 'author-algernon', rolePk: 'author', createdAt: now },
	]);
	await db.insert(bookIdentifiers).values([
		{ bookPk: 'book-dune', resource: 'isbn:0441172717', url: 'https://isbn.example.com/0441172717' },
	]);
	await db.insert(contributorIdentifiers).values([
		{ contributorPk: 'author-herbert', resource: 'viaf:59083797', url: 'https://viaf.example.com/59083797' },
	]);
	await db.insert(genreIdentifiers).values([
		{ genrePk: 'scifi', resource: 'babelio:science-fiction', url: 'https://babelio.example.com/science-fiction' },
	]);
}

export { COLLECTION };
