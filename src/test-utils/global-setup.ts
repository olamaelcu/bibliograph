// Runs once in the main vitest process, before any test file. Test databases
// are created lazily per worker in src/test-utils/db.ts (bibliograph_test_<pid>),
// so this setup only has to verify the local Postgres is reachable. The test
// toolchain never touches a real database: each worker CREATE DATABASEs its own
// throwaway DB from the DATABASE_URL credentials and drops nothing on exit.
import { Client } from 'pg';

const DEFAULT_URL = 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph_test';

export default async function globalSetup(): Promise<void> {
	const connectionString = process.env.DATABASE_URL ?? DEFAULT_URL;
	const adminUrl = new URL(connectionString);
	adminUrl.pathname = '/postgres';
	const client = new Client({ connectionString: adminUrl.toString() });
	try {
		await client.connect();
	} finally {
		await client.end();
	}
}
