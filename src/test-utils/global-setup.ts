// Runs once in the main vitest process, before any test file. The app-level
// connection (src/db/connection.ts) opens DB_PATH unmigrated at import time,
// but production runs the migrator before serving (src/index.ts). Mirror
// that here so routes that read tables (e.g. /stats) work under test.
//
// The path is forced unconditionally: the ambient shell env (mise) exports
// DB_PATH=data/bibliograph.sqlite, which must NEVER be migrated or deleted by
// the test suite. The scratch test DB is a shared on-disk file, so start it
// clean and migrate exactly once up front (a stale WAL from an aborted run
// leaves a lock bit).
import { rmSync } from 'node:fs';

const TEST_DB_PATH = 'data/test.sqlite';

export default async function globalSetup(): Promise<void> {
	process.env.DB_PATH = TEST_DB_PATH;
	rmSync(TEST_DB_PATH, { force: true });
	rmSync(`${TEST_DB_PATH}-wal`, { force: true });
	rmSync(`${TEST_DB_PATH}-shm`, { force: true });
	const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
	const { db } = await import('../db/connection.js');
	migrate(db, { migrationsFolder: 'drizzle' });
}
