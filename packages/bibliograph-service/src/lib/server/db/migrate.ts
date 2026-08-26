#!/usr/bin/env tsx
// Programmatic drizzle migrator — runs against DATABASE_URL once per deploy.
//
// Dokku prerelease hook (`release:` in Procfile) executes this before the
// `web` and `worker` dynos are restarted. Fails closed: any unrecognized
// migration error aborts the release and the previous release keeps serving
// traffic.
//
// Invariants:
//   - Idempotent. drizzle tracks applied migrations in `drizzle.__drizzle_migrations`.
//   - Reads migrations from ./drizzle/ relative to this file's package.
//   - Uses `drizzle-orm/migrator` (already in `dependencies`) — no `drizzle-kit`
//     at runtime.
//   - Tolerant of "already exists" PG errors at the statement level: when an
//     instance was bootstrapped by hand (`psql -f`) before this migrator
//     existed, the SQL fails with `42P07` (duplicate_table) or `42710`
//     (duplicate_object) and we record the migration as applied instead of
//     aborting the release.

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required');
	process.exit(1);
}

const folder = new URL('../../../../drizzle/', import.meta.url).pathname;

const DUPLICATE_PG_CODES = new Set(['42P07', '42710', '42701']);

function pgErrorCode(err: unknown): string | undefined {
	const e = err as { cause?: { code?: string }; code?: string };
	return e?.cause?.code ?? e?.code;
}

async function run(): Promise<void> {
	console.log(`[migrate] running migrations from ${folder}`);

	const pool = new Pool({ connectionString: url, max: 1 });
	const client = await pool.connect();
	try {
		await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)
		`);

		const migrations = readMigrationFiles({ migrationsFolder: folder });
		const rows = await client.query<{ created_at: string }>(
			`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
		);
		const lastApplied = rows.rows[0]?.created_at ? Number(rows.rows[0].created_at) : -Infinity;

		let applied = 0;
		let skipped = 0;
		for (const migration of migrations) {
			if (lastApplied >= migration.folderMillis) {
				skipped++;
				continue;
			}
			let allDuplicate = true;
			let anyExecuted = false;
			for (const stmt of migration.sql) {
				const trimmed = stmt.trim();
				if (trimmed === '') continue;
				try {
					await client.query(stmt);
					anyExecuted = true;
				} catch (err) {
					if (pgErrorCode(err) && DUPLICATE_PG_CODES.has(pgErrorCode(err)!)) continue;
					allDuplicate = false;
					throw err;
				}
			}
			if (anyExecuted || allDuplicate) {
				await client.query(
					`insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)`,
					[migration.hash, String(migration.folderMillis)],
				);
				applied++;
				console.log(`[migrate] applied ${migration.hash.slice(0, 12)}… (${allDuplicate ? 'already applied' : 'executed'})`);
			} else {
				skipped++;
			}
		}
		console.log(`[migrate] complete: applied=${applied} skipped=${skipped}`);
	} finally {
		client.release();
		await pool.end();
	}
}

run().catch((err) => {
	console.error('[migrate] failed:', err);
	process.exit(1);
});