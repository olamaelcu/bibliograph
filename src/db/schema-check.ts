import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { logger } from '../logger.js';

type Database = NodePgDatabase<typeof schema>;

export interface DriftEntry {
	table: string;
	column: string;
	expected: string;
	actual: string;
}

/**
 * Columns whose drizzle schema vs PostgreSQL data_type mismatch is known to
 * crash the import or jetstream hot path. Verify they are aligned at startup
 * so a forgotten `pnpm run db:migrate` is loud, not silent.
 *
 * Add to this list when a new column's overflow risk is identified.
 */
const EXPECTED_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
	// OL dumps exceed 2 GB; integer would overflow on the first checkpoint.
	{ table: 'backfill_state', column: 'file_size', type: 'bigint' },
	{ table: 'backfill_state', column: 'last_byte_offset', type: 'bigint' },
	// jetstream_cursor.cursor receives microsecond unix times (~1.78e15) → INT4 overflow.
	{ table: 'jetstream_cursor', column: 'cursor', type: 'bigint' },
];

export async function detectSchemaDrift(db: Database): Promise<DriftEntry[]> {
	const result = await db.execute<{ table_name: string; column_name: string; data_type: string }>(sql`
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE (table_name = 'backfill_state' AND column_name IN ('file_size', 'last_byte_offset'))
		   OR (table_name = 'jetstream_cursor' AND column_name = 'cursor')
	`);
	const drift: DriftEntry[] = [];
	for (const row of result.rows) {
		const expected = EXPECTED_COLUMNS.find((c) => c.table === row.table_name && c.column === row.column_name);
		if (!expected) continue;
		if (row.data_type !== expected.type) {
			drift.push({ table: row.table_name, column: row.column_name, expected: expected.type, actual: row.data_type });
		}
	}
	return drift;
}

export async function assertNoDrift(db: Database): Promise<void> {
	const drift = await detectSchemaDrift(db);
	if (drift.length === 0) return;
	const summary = drift.map((d) => `${d.table}.${d.column} expected=${d.expected} actual=${d.actual}`).join('; ');
	throw new Error(
		`Schema drift detected (${summary}). Run \`pnpm run db:migrate\` to apply pending migrations.`,
	);
}

export async function logIfDrift(db: Database): Promise<DriftEntry[]> {
	const drift = await detectSchemaDrift(db);
	if (drift.length > 0) {
		const summary = drift.map((d) => `${d.table}.${d.column} expected=${d.expected} actual=${d.actual}`).join('; ');
		logger.error({ drift }, `Schema drift detected (${summary}). Run \`pnpm run db:migrate\` to apply pending migrations.`);
	}
	return drift;
}