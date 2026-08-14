import { eq } from 'drizzle-orm';
import { books, contributorRoles, contributors, genres, works } from '../db/schema.js';

export const RELEASED = 'released';

/** Tables with a releaseStatus column (lifecycle entities). */
export const lifecycleTables = { works, contributors, genres, contributorRoles, books } as const;

export function releasedFilter(table: (typeof lifecycleTables)[keyof typeof lifecycleTables]) {
	return eq(table.releaseStatus as never, RELEASED as never);
}
