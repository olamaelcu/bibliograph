import { describe, expect, it, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../test-utils/db.js';
import { detectSchemaDrift, assertNoDrift } from './schema-check.js';

describe('schema-check', () => {
	let dbHandle: Awaited<ReturnType<typeof createTestDb>>['db'] | undefined;

	afterEach(async () => {
		// Reset any column types we widened/contracted back to bigint so the
		// truncate-all reset between tests doesn't trip over a mismatched type.
		if (dbHandle) {
			await dbHandle.execute(
				sql`ALTER TABLE jetstream_cursor ALTER COLUMN cursor SET DATA TYPE bigint`,
			);
		}
	});

	it('reports no drift on a freshly migrated test DB', async () => {
		const { db } = await createTestDb();
		dbHandle = db;
		const drift = await detectSchemaDrift(db);
		expect(drift).toEqual([]);
		await expect(assertNoDrift(db)).resolves.toBeUndefined();
	});

	it('detects drift when a known column regresses to integer', async () => {
		const { db } = await createTestDb();
		dbHandle = db;
		await db.execute(
			sql`ALTER TABLE jetstream_cursor ALTER COLUMN cursor SET DATA TYPE integer`,
		);
		const drift = await detectSchemaDrift(db);
		expect(drift).toContainEqual({
			table: 'jetstream_cursor',
			column: 'cursor',
			expected: 'bigint',
			actual: 'integer',
		});
		await expect(assertNoDrift(db)).rejects.toThrow(/Schema drift detected/);
	});
});
