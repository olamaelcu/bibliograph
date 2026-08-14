import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { flagIssue, openIssuesFor, resolveIssuesForField } from './issues.js';

describe('issues', () => {
	it('flags, dedups, resolves', () => {
		const { db } = createTestDb();
		flagIssue(db, { entityType: 'book', entityPk: 'book-dune', field: 'title', incomingValue: 'Dune Alt', storedValue: 'Dune', source: 'openlibrary' });
		flagIssue(db, { entityType: 'book', entityPk: 'book-dune', field: 'title', incomingValue: 'Dune Alt', storedValue: 'Dune', source: 'openlibrary' });
		expect(openIssuesFor(db, 'book', 'book-dune')).toHaveLength(1);

		resolveIssuesForField(db, 'book', 'book-dune', 'title');
		expect(openIssuesFor(db, 'book', 'book-dune')).toHaveLength(0);
	});
});
