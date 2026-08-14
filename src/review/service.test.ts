import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { sql } from 'drizzle-orm';
import { books } from '../db/schema.js';
import {
	editField,
	listWithIssues,
	openIssueCount,
	setStatus,
	stagedDependents,
} from './service.js';
import { flagIssue } from '../import/issues.js';

describe('review service', () => {
	it('lists records with issues via review view', () => {
		const { db, seed } = createTestDb();
		seed();
		flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune Alt',
			storedValue: 'Dune',
			source: 'openlibrary',
		});
		const rows = listWithIssues(db, 'book');
		expect(rows).toHaveLength(1);
		expect(rows[0].pk).toBe('book-dune');
		expect(rows[0].openIssues).toBe(1);
	});

	it('edits a field and resolves its issue', () => {
		const { db, seed } = createTestDb();
		seed();
		flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune Alt',
			storedValue: 'Dune',
			source: 'openlibrary',
		});
		editField(db, 'book', 'book-dune', 'title', 'Dune (40th Anniversary)');
		expect(openIssueCount(db, 'book', 'book-dune')).toBe(0);
	});

	it('validates field types', () => {
		const { db, seed } = createTestDb();
		seed();
		expect(() => editField(db, 'book', 'book-dune', 'publishDate', 'not-a-date')).toThrow();
		expect(() => editField(db, 'book', 'book-dune', 'bogusField', 'x')).toThrow();
	});

	it('approve guards: setStatus + staged dependents', () => {
		const { db, seed } = createTestDb();
		seed();
		db.run(sql`UPDATE works SET release_status = 'staged' WHERE pk = 'work-dune'`);
		const deps = stagedDependents(db, 'book-dune');
		expect(deps).toContain('work work-dune');
		setStatus(db, 'book', 'book-dune', 'released');
		const row = db.select().from(books).all();
		const b = row.find((r: { pk: string }) => r.pk === 'book-dune') as unknown as { releaseStatus: string };
		expect(b.releaseStatus).toBe('released');
	});
});
