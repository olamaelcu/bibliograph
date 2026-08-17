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

	it('re-flags the same issue after resolve (the partial index only dedupes open)', async () => {
		const { db } = await createTestDb();
		await flagIssue(db, { entityType: 'book', entityPk: 'book-x', field: 'title', incomingValue: 'A', storedValue: 'B', source: 'openlibrary' });
		expect(await openIssuesFor(db, 'book', 'book-x')).toHaveLength(1);
		await resolveIssuesForField(db, 'book', 'book-x', 'title');
		expect(await openIssuesFor(db, 'book', 'book-x')).toHaveLength(0);
		// After resolve, a new flag with the same (type, pk, field, source) is allowed.
		await flagIssue(db, { entityType: 'book', entityPk: 'book-x', field: 'title', incomingValue: 'A', storedValue: 'B', source: 'openlibrary' });
		expect(await openIssuesFor(db, 'book', 'book-x')).toHaveLength(1);
	});

	it('dedupes NULL incomingValue via the SELECT fallback', async () => {
		const { db } = await createTestDb();
		await flagIssue(db, { entityType: 'work', entityPk: 'work-x', field: 'description', incomingValue: null, storedValue: 'stored', source: 'openlibrary' });
		await flagIssue(db, { entityType: 'work', entityPk: 'work-x', field: 'description', incomingValue: null, storedValue: 'stored', source: 'openlibrary' });
		expect(await openIssuesFor(db, 'work', 'work-x')).toHaveLength(1);
	});
});
