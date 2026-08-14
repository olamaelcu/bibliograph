import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { eq, sql } from 'drizzle-orm';
import { bookContributors, bookGenres, books, contributors, genres, importIssues } from '../db/schema.js';
import {
	approveAll,
	dismissIssue,
	editField,
	listForReview,
	listWithIssues,
	openIssueCount,
	resolveIssue,
	setStatus,
	stagedDependents,
} from './service.js';
import { flagIssue, openIssuesFor } from '../import/issues.js';
import { coerceValue } from './fields.js';

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
		expect(rows[0].status).toBe('released');
		expect(rows[0].name).toBe('Dune (40th Anniversary)');
	});

	it('lists records for review with pk and name', () => {
		const { db, seed } = createTestDb();
		seed();
		const rows = listForReview(db, 'book');
		expect(rows[0].pk).toBe('book-dune');
		expect(rows[0].name).toBe('Dune (40th Anniversary)');
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

	it('stagedDependents lists staged contributors and genres', () => {
		const { db, seed } = createTestDb();
		seed();
		const now = Math.floor(Date.now() / 1000);
		db.insert(contributors)
			.values({
				pk: 'contrib-staged',
				name: 'Staged Writer',
				sortName: null,
				bio: null,
				imageUrl: null,
				createdAt: now,
				updatedAt: null,
				releaseStatus: 'staged',
				releasedAt: null,
			})
			.run();
		db.insert(genres)
			.values({
				pk: 'genre-staged',
				name: 'Staged Genre',
				description: 'Staged',
				emoji: '📚',
				iconImageUrl: null,
				parentPk: null,
				createdAt: now,
				releaseStatus: 'staged',
				releasedAt: null,
			})
			.run();
		db.insert(bookContributors)
			.values({ bookPk: 'book-dune', contributorPk: 'contrib-staged', rolePk: 'author', createdAt: now })
			.run();
		db.insert(bookGenres).values({ bookPk: 'book-dune', genrePk: 'genre-staged' }).run();
		const deps = stagedDependents(db, 'book-dune');
		expect(deps).toContain('contributor contrib-staged');
		expect(deps).toContain('genre genre-staged');
	});

	it('setStatus rejected clears releasedAt', () => {
		const { db, seed } = createTestDb();
		seed();
		setStatus(db, 'book', 'book-dune', 'rejected');
		const b = db.select().from(books).where(eq(books.pk, 'book-dune')).get();
		expect(b?.releaseStatus).toBe('rejected');
		expect(b?.releasedAt).toBeNull();
	});

	it('resolveIssue closes the issue; dismissIssue marks it dismissed', () => {
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
		flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-flowers',
			field: 'description',
			incomingValue: 'Alt',
			storedValue: 'Stored',
			source: 'openlibrary',
		});

		const dune = openIssuesFor(db, 'book', 'book-dune');
		expect(dune).toHaveLength(1);
		resolveIssue(db, dune[0].pk);
		expect(openIssueCount(db, 'book', 'book-dune')).toBe(0);

		const flowers = openIssuesFor(db, 'book', 'book-flowers');
		dismissIssue(db, flowers[0].pk);
		const row = db.select().from(importIssues).where(eq(importIssues.pk, flowers[0].pk)).get();
		expect(row?.status).toBe('dismissed');
	});

	it('coerceValue converts dates to unix seconds and passes http(s) URIs', () => {
		expect(coerceValue('book', 'publishDate', '2020-01-02')).toBe(Math.floor(Date.parse('2020-01-02') / 1000));
		expect(coerceValue('book', 'coverUrl', 'https://example.com/cover.jpg')).toBe('https://example.com/cover.jpg');
	});

	it('listForReview reports real open issue counts', () => {
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
		const rows = listForReview(db, 'book');
		const dune = rows.find((r) => r.pk === 'book-dune');
		const flowers = rows.find((r) => r.pk === 'book-flowers');
		expect(dune?.openIssues).toBe(1);
		expect(flowers?.openIssues).toBe(0);
	});

	it('editField throws on a nonexistent pk', () => {
		const { db, seed } = createTestDb();
		seed();
		expect(() => editField(db, 'book', 'does-not-exist', 'title', 'X')).toThrow();
	});

	it('setStatus throws on a nonexistent pk', () => {
		const { db, seed } = createTestDb();
		seed();
		expect(() => setStatus(db, 'book', 'does-not-exist', 'released')).toThrow();
	});

	it('resolveIssue and dismissIssue throw on a nonexistent pk', () => {
		const { db, seed } = createTestDb();
		seed();
		expect(() => resolveIssue(db, 999999)).toThrow();
		expect(() => dismissIssue(db, 999999)).toThrow();
	});

	it('approveAll releases staged books and skips ones with open issues', () => {
		const { db, seed } = createTestDb();
		seed();
		db.run(sql`UPDATE books SET release_status = 'staged'`); // seed books are released by default
		const now = Math.floor(Date.now() / 1000);
		db.insert(books)
			.values({ pk: 'book-extra', title: 'Extra', workPk: null, formatPk: null, createdAt: now, releaseStatus: 'staged', releasedAt: null })
			.run();
		flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-extra',
			field: 'title',
			incomingValue: 'Extra Alt',
			storedValue: 'Extra',
			source: 'openlibrary',
		});

		const res = approveAll(db, 'book');
		expect(res.approved).toBe(2); // book-dune + book-flowers
		expect(res.skippedWithIssues).toBe(1); // book-extra

		const dune = db.select().from(books).where(eq(books.pk, 'book-dune')).get();
		expect(dune?.releaseStatus).toBe('released');
		const extra = db.select().from(books).where(eq(books.pk, 'book-extra')).get();
		expect(extra?.releaseStatus).toBe('staged');
	});

	it('approveAll with keepIssues releases everything; dryRun writes nothing', () => {
		const { db, seed } = createTestDb();
		seed();
		db.run(sql`UPDATE books SET release_status = 'staged'`);
		const now = Math.floor(Date.now() / 1000);
		db.insert(books)
			.values({ pk: 'book-extra', title: 'Extra', workPk: null, formatPk: null, createdAt: now, releaseStatus: 'staged', releasedAt: null })
			.run();
		flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-extra',
			field: 'title',
			incomingValue: 'Extra Alt',
			storedValue: 'Extra',
			source: 'openlibrary',
		});

		const dry = approveAll(db, 'book', { dryRun: true });
		expect(dry.approved).toBe(2);
		expect(db.select().from(books).where(eq(books.pk, 'book-dune')).get()?.releaseStatus).toBe('staged'); // untouched

		const res = approveAll(db, 'book', { keepIssues: true });
		expect(res.approved).toBe(3);
		expect(res.skippedWithIssues).toBe(0);
		expect(db.select().from(books).where(eq(books.pk, 'book-extra')).get()?.releaseStatus).toBe('released');
	});

	it('approveAll respects limit and reports empty entities', () => {
		const { db, seed } = createTestDb();
		seed();
		db.run(sql`UPDATE books SET release_status = 'staged'`);
		const res = approveAll(db, 'book', { limit: 1 });
		expect(res.approved).toBe(1);
		expect(res.skippedWithIssues).toBe(0);

		const none = approveAll(db, 'genre', { limit: 5 });
		expect(none.approved).toBe(0);
		expect(none.skippedWithIssues).toBe(0);
	});
});
