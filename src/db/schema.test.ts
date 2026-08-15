import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../test-utils/db.js';
import { importIssues } from './schema.js';
import { sql } from 'drizzle-orm';

describe('staged-release schema', () => {
	it('applies release_status defaults and CHECK constraints', () => {
		const { sqlite } = createTestDb();
		const rows = sqlite
			.prepare(
				"SELECT name FROM pragma_table_info('books') WHERE name IN ('release_status', 'released_at')",
			)
			.all() as Array<{ name: string }>;
		expect(rows.map((r) => r.name).sort()).toEqual(['release_status', 'released_at']);
		sqlite.close();
	});

	it('rejects invalid release_status', () => {
		const { db, sqlite } = createTestDb();
		expect(() =>
			db.run(sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('b1', 'T', 0, 'bogus')`),
		).toThrow();
		sqlite.close();
	});

	it('rejects invalid import_issues entity_type', () => {
		const { db, sqlite } = createTestDb();
		expect(() =>
			db
				.insert(importIssues)
				.values({
					entityType: 'bogus',
					entityPk: 'x',
					field: 'title',
					source: 'openlibrary',
					createdAt: 0,
				})
				.run(),
		).toThrow();
		sqlite.close();
	});

	it('enforces unique identifier resource', () => {
		const { db, sqlite } = createTestDb();
		expect(() => {
			db.run(sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('b1', 'One', 0, 'staged')`);
			db.run(sql`INSERT INTO books (pk, title, created_at, release_status) VALUES ('b2', 'Two', 0, 'staged')`);
			db.run(
				sql`INSERT INTO book_identifiers (book_pk, resource, url) VALUES ('b1', 'isbn:9780000000001', 'u1')`,
			);
			db.run(
				sql`INSERT INTO book_identifiers (book_pk, resource, url) VALUES ('b2', 'isbn:9780000000001', 'u2')`,
			);
		}).toThrow();
		sqlite.close();
	});

	it('exposes review views with aggregated open issues', () => {
		const { db, sqlite, seed } = createTestDb();
		seed();
		const now = Math.floor(Date.now() / 1000);
		db.insert(importIssues)
			.values({
				entityType: 'book',
				entityPk: 'book-dune',
				field: 'title',
				incomingValue: 'Dune (Alternate)',
				storedValue: 'Dune (40th Anniversary)',
				source: 'openlibrary',
				status: 'open',
				createdAt: now,
			})
			.run();
		const rows = db.all(sql`SELECT pk, open_issues FROM book_import_issues`) as Array<{
			pk: string;
			open_issues: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].pk).toBe('book-dune');
		const issues = JSON.parse(rows[0].open_issues);
		expect(issues).toHaveLength(1);
		expect(issues[0].field).toBe('title');
		expect(issues[0].incomingValue).toBe('Dune (Alternate)');
		sqlite.close();
	});

	it('applies DEFAULT staged to new inserts', () => {
		const { db, sqlite } = createTestDb();
		db.run(sql`INSERT INTO books (pk, title, created_at) VALUES ('fresh', 'New Book', 0)`);
		const row = sqlite.prepare("SELECT release_status FROM books WHERE pk = 'fresh'").get() as {
			release_status: string;
		};
		expect(row.release_status).toBe('staged');
		sqlite.close();
	});

	it('creates the backfill and catalog tables', () => {
		const { sqlite } = createTestDb();
		const names = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('import_issues', 'backfill_state', 'backfill_reservation', 'catalog_blobs')")
			.all() as Array<{ name: string }>;
		expect(names.map((r) => r.name).sort()).toEqual([
			'backfill_reservation',
			'backfill_state',
			'catalog_blobs',
			'import_issues',
		]);
		sqlite.close();
	});

	it('applies 0004 to a populated FK-ON database without losing relational data', () => {
		// Regression: migration 0004 must add lifecycle columns WITHOUT a table-rebuild.
		// The rebuild's PRAGMA foreign_keys=OFF is a no-op inside the migrator's
		// transaction, so DROP TABLE would cascade-delete every ON DELETE CASCADE
		// child on an FK-ON connection (as production uses). This test builds the
		// pre-0004 schema from a trimmed journal, seeds a populated graph, then
		// runs the real migrator so 0004 executes against real rows.
		const trimDir = mkdtempSync(join(tmpdir(), 'drizzle-trim-'));
		try {
			cpSync('drizzle/meta', join(trimDir, 'meta'), { recursive: true });
			const preLifecycleTags = ['0000_reflective_lake', '0001_parallel_chronomancer', '0002_perfect_charles_xavier', '0003_pretty_violations'];
			for (const tag of preLifecycleTags) {
				cpSync(`drizzle/${tag}.sql`, join(trimDir, `${tag}.sql`));
			}
			const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
			// Keep only the migrations actually copied above — any migration added
			// after 0003 must be excluded here too, not just 0004/0005 by name.
			journal.entries = journal.entries.filter((e: { tag: string }) => preLifecycleTags.includes(e.tag));
			writeFileSync(join(trimDir, 'meta/_journal.json'), JSON.stringify(journal));

			const sqlite = new Database(':memory:');
			sqlite.pragma('foreign_keys = ON');
			const db = drizzle(sqlite);
			migrate(db, { migrationsFolder: trimDir });

			sqlite.exec(`
				INSERT INTO contributors (pk, name, created_at) VALUES ('author-herbert', 'Frank Herbert', 0);
				INSERT INTO contributor_roles (pk, name, description, created_at) VALUES ('author', 'Author', 'Wrote the book', 0);
				INSERT INTO works (pk, title, created_at) VALUES ('work-dune', 'Dune', 0);
				INSERT INTO genres (pk, name, description, emoji, created_at) VALUES ('fiction', 'Fiction', 'Imaginary', 'f', 0);
				INSERT INTO formats (pk, description, emoji, unit) VALUES ('paperback', 'Paperback', 'p', 'pages');
				INSERT INTO books (pk, title, work_pk, format_pk, created_at) VALUES ('book-dune', 'Dune', 'work-dune', 'paperback', 0);
				INSERT INTO book_identifiers (book_pk, resource, url) VALUES ('book-dune', 'isbn:0441172717', 'u');
				INSERT INTO book_contributors (book_pk, contributor_pk, role_pk, created_at) VALUES ('book-dune', 'author-herbert', 'author', 0);
				INSERT INTO book_genres (book_pk, genre_pk) VALUES ('book-dune', 'fiction');
			`);

			migrate(db, { migrationsFolder: 'drizzle' });

			const count = (table: string) =>
				(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
			expect(count('books')).toBe(1);
			expect(count('book_identifiers')).toBe(1);
			expect(count('book_contributors')).toBe(1);
			expect(count('book_genres')).toBe(1);
			expect(count('works')).toBe(1);
			expect(count('genres')).toBe(1);
			expect(count('contributors')).toBe(1);

			// Existing rows backfilled to DEFAULT 'staged' by the ADD COLUMN.
			const backfilled = sqlite.prepare("SELECT release_status FROM books WHERE pk = 'book-dune'").get() as {
				release_status: string;
			};
			expect(backfilled.release_status).toBe('staged');

			const ddl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'books'").get() as {
				sql: string;
			};
			expect(ddl.sql).toContain('books_release_status_check');
			sqlite.close();
		} finally {
			rmSync(trimDir, { recursive: true, force: true });
		}
	});
});
