import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { flagIssue, openIssuesFor, resolveIssuesForField } from './issues.js';

describe('issues', () => {
	it('flags, dedups, resolves', async () => {
		const { db } = await createTestDb();
		await flagIssue(db, { entityType: 'book', entityPk: 'book-dune', field: 'title', incomingValue: 'Dune Alt', storedValue: 'Dune', source: 'openlibrary' });
		await flagIssue(db, { entityType: 'book', entityPk: 'book-dune', field: 'title', incomingValue: 'Dune Alt', storedValue: 'Dune', source: 'openlibrary' });
		expect(await openIssuesFor(db, 'book', 'book-dune')).toHaveLength(1);

		await resolveIssuesForField(db, 'book', 'book-dune', 'title');
		expect(await openIssuesFor(db, 'book', 'book-dune')).toHaveLength(0);
	});
});
