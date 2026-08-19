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
import type { ApproveAllProgress } from './service.js';
import { flagIssue, openIssuesFor } from '../import/issues.js';
import { coerceValue } from './fields.js';

describe('review service', () => {
	it('lists records with issues via review view', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune Alt',
			storedValue: 'Dune',
			source: 'openlibrary',
		});
		const rows = await listWithIssues(db, 'book');
		expect(rows).toHaveLength(1);
		expect(rows[0].pk).toBe('book-dune');
		expect(rows[0].openIssues).toBe(1);
		expect(rows[0].status).toBe('released');
		expect(rows[0].name).toBe('Dune (40th Anniversary)');
	});

	it('lists records for review with pk and name', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const rows = await listForReview(db, 'book');
		expect(rows[0].pk).toBe('book-dune');
		expect(rows[0].name).toBe('Dune (40th Anniversary)');
	});

	it('edits a field and resolves its issue', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune Alt',
			storedValue: 'Dune',
			source: 'openlibrary',
		});
		await editField(db, 'book', 'book-dune', 'title', 'Dune (40th Anniversary)');
		expect(await openIssueCount(db, 'book', 'book-dune')).toBe(0);
	});

	it('validates field types', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await expect(editField(db, 'book', 'book-dune', 'publishDate', 'not-a-date')).rejects.toThrow();
		await expect(editField(db, 'book', 'book-dune', 'bogusField', 'x')).rejects.toThrow();
	});

	it('approve guards: setStatus + staged dependents', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await db.execute(sql`UPDATE works SET release_status = 'staged' WHERE pk = 'work-dune'`);
		const deps = await stagedDependents(db, 'book-dune');
		expect(deps).toContain('work work-dune');
		await setStatus(db, 'book', 'book-dune', 'released');
		const row = await db.select().from(books);
		const b = row.find((r: { pk: string }) => r.pk === 'book-dune') as unknown as { releaseStatus: string };
		expect(b.releaseStatus).toBe('released');
	});

	it('stagedDependents lists staged contributors and genres', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		const now = Math.floor(Date.now() / 1000);
		await db.insert(contributors).values({
			pk: 'contrib-staged',
			name: 'Staged Writer',
			sortName: null,
			bio: null,
			imageUrl: null,
			createdAt: now,
			updatedAt: null,
			releaseStatus: 'staged',
			releasedAt: null,
		});
		await db.insert(genres).values({
			pk: 'genre-staged',
			name: 'Staged Genre',
			description: 'Staged',
			emoji: '📚',
			iconImageUrl: null,
			parentPk: null,
			createdAt: now,
			releaseStatus: 'staged',
			releasedAt: null,
		});
		await db.insert(bookContributors).values({ bookPk: 'book-dune', contributorPk: 'contrib-staged', rolePk: 'author', createdAt: now });
		await db.insert(bookGenres).values({ bookPk: 'book-dune', genrePk: 'genre-staged' });
		const deps = await stagedDependents(db, 'book-dune');
		expect(deps).toContain('contributor contrib-staged');
		expect(deps).toContain('genre genre-staged');
	});

	it('setStatus rejected clears releasedAt', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await setStatus(db, 'book', 'book-dune', 'rejected');
		const b = (await db.select().from(books).where(eq(books.pk, 'book-dune')))[0];
		expect(b?.releaseStatus).toBe('rejected');
		expect(b?.releasedAt).toBeNull();
	});

	it('resolveIssue closes the issue; dismissIssue marks it dismissed', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune Alt',
			storedValue: 'Dune',
			source: 'openlibrary',
		});
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-flowers',
			field: 'description',
			incomingValue: 'Alt',
			storedValue: 'Stored',
			source: 'openlibrary',
		});

		const dune = await openIssuesFor(db, 'book', 'book-dune');
		expect(dune).toHaveLength(1);
		await resolveIssue(db, dune[0].pk);
		expect(await openIssueCount(db, 'book', 'book-dune')).toBe(0);

		const flowers = await openIssuesFor(db, 'book', 'book-flowers');
		await dismissIssue(db, flowers[0].pk);
		const row = (await db.select().from(importIssues).where(eq(importIssues.pk, flowers[0].pk)))[0];
		expect(row?.status).toBe('dismissed');
	});

	it('coerceValue converts dates to unix seconds and passes http(s) URIs', () => {
		expect(coerceValue('book', 'publishDate', '2020-01-02')).toBe(Math.floor(Date.parse('2020-01-02') / 1000));
		expect(coerceValue('book', 'coverUrl', 'https://example.com/cover.jpg')).toBe('https://example.com/cover.jpg');
	});

	it('listForReview reports real open issue counts', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-dune',
			field: 'title',
			incomingValue: 'Dune Alt',
			storedValue: 'Dune',
			source: 'openlibrary',
		});
		const rows = await listForReview(db, 'book');
		const dune = rows.find((r) => r.pk === 'book-dune');
		const flowers = rows.find((r) => r.pk === 'book-flowers');
		expect(dune?.openIssues).toBe(1);
		expect(flowers?.openIssues).toBe(0);
	});

	it('editField throws on a nonexistent pk', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await expect(editField(db, 'book', 'does-not-exist', 'title', 'X')).rejects.toThrow();
	});

	it('setStatus throws on a nonexistent pk', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await expect(setStatus(db, 'book', 'does-not-exist', 'released')).rejects.toThrow();
	});

	it('resolveIssue and dismissIssue throw on a nonexistent pk', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await expect(resolveIssue(db, 999999)).rejects.toThrow();
		await expect(dismissIssue(db, 999999)).rejects.toThrow();
	});

	it('approveAll releases staged books and skips ones with open issues', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await db.execute(sql`UPDATE books SET release_status = 'staged'`); // seed books are released by default
		const now = Math.floor(Date.now() / 1000);
		await db.insert(books).values({ pk: 'book-extra', title: 'Extra', workPk: null, formatPk: null, createdAt: now, releaseStatus: 'staged', releasedAt: null });
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-extra',
			field: 'title',
			incomingValue: 'Extra Alt',
			storedValue: 'Extra',
			source: 'openlibrary',
		});

		const res = await approveAll(db, 'book');
		expect(res.approved).toBe(2); // book-dune + book-flowers
		expect(res.skippedWithIssues).toBe(1); // book-extra

		const dune = (await db.select().from(books).where(eq(books.pk, 'book-dune')))[0];
		expect(dune?.releaseStatus).toBe('released');
		const extra = (await db.select().from(books).where(eq(books.pk, 'book-extra')))[0];
		expect(extra?.releaseStatus).toBe('staged');
	});

	it('approveAll with keepIssues releases everything; dryRun writes nothing', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await db.execute(sql`UPDATE books SET release_status = 'staged'`);
		const now = Math.floor(Date.now() / 1000);
		await db.insert(books).values({ pk: 'book-extra', title: 'Extra', workPk: null, formatPk: null, createdAt: now, releaseStatus: 'staged', releasedAt: null });
		await flagIssue(db, {
			entityType: 'book',
			entityPk: 'book-extra',
			field: 'title',
			incomingValue: 'Extra Alt',
			storedValue: 'Extra',
			source: 'openlibrary',
		});

		const dry = await approveAll(db, 'book', { dryRun: true });
		expect(dry.approved).toBe(2);
		expect((await db.select().from(books).where(eq(books.pk, 'book-dune')))[0]?.releaseStatus).toBe('staged'); // untouched

		const res = await approveAll(db, 'book', { keepIssues: true });
		expect(res.approved).toBe(3);
		expect(res.skippedWithIssues).toBe(0);
		expect((await db.select().from(books).where(eq(books.pk, 'book-extra')))[0]?.releaseStatus).toBe('released');
	});

	it('approveAll respects limit and reports empty entities', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await db.execute(sql`UPDATE books SET release_status = 'staged'`);
		const res = await approveAll(db, 'book', { limit: 1 });
		expect(res.approved).toBe(1);
		expect(res.skippedWithIssues).toBe(0);

		const none = await approveAll(db, 'genre', { limit: 5 });
		expect(none.approved).toBe(0);
		expect(none.skippedWithIssues).toBe(0);
	});

	it('approveAll bulk-releases staged rows that span multiple chunks', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await db.execute(sql`UPDATE contributors SET release_status = 'staged'`);
		const now = Math.floor(Date.now() / 1000);
		const TOTAL = 600;
		const WITH_ISSUES = 50;
		const SEED_STAGED = 2;
		const bulk: Array<typeof contributors.$inferInsert> = [];
		for (let i = 0; i < TOTAL; i++) {
			bulk.push({
				pk: `bulk-c-${i}`,
				name: `Bulk C ${i}`,
				sortName: null,
				bio: null,
				imageUrl: null,
				createdAt: now,
				updatedAt: null,
				releaseStatus: 'staged',
				releasedAt: null,
			});
		}
		await db.insert(contributors).values(bulk);
		for (let i = 0; i < WITH_ISSUES; i++) {
			await flagIssue(db, {
				entityType: 'contributor',
				entityPk: `bulk-c-${i}`,
				field: 'name',
				incomingValue: `Bulk C ${i} alt`,
				storedValue: `Bulk C ${i}`,
				source: 'openlibrary',
			});
		}

		const res = await approveAll(db, 'contributor');
		expect(res.approved).toBe(SEED_STAGED + TOTAL - WITH_ISSUES);
		expect(res.skippedWithIssues).toBe(WITH_ISSUES);

		const stillStaged = (await db.select({ pk: contributors.pk }).from(contributors).where(eq(contributors.releaseStatus, 'staged'))).map((r) => r.pk);
		expect(stillStaged).toEqual(Array.from({ length: WITH_ISSUES }, (_, i) => `bulk-c-${i}`));
		expect(stillStaged).not.toContain('bulk-c-50');
	});

	it('approveAll emits progress events per chunk and at completion', async () => {
		const { db, seed } = await createTestDb();
		await seed();
		await db.execute(sql`UPDATE contributors SET release_status = 'staged'`);
		const now = Math.floor(Date.now() / 1000);
		const TOTAL = 1200;
		const bulk: Array<typeof contributors.$inferInsert> = [];
		for (let i = 0; i < TOTAL; i++) {
			bulk.push({
				pk: `prog-${i}`,
				name: `Prog ${i}`,
				sortName: null,
				bio: null,
				imageUrl: null,
				createdAt: now,
				updatedAt: null,
				releaseStatus: 'staged',
				releasedAt: null,
			});
		}
		await db.insert(contributors).values(bulk);

		const events: ApproveAllProgress[] = [];
		const res = await approveAll(db, 'contributor', {
			onProgress: (p) => events.push(p),
		});
		expect(res.approved).toBe(2 + TOTAL);

		const approving = events.filter((e) => e.phase === 'approving');
		expect(approving.length).toBe(3);
		expect(approving[0]).toMatchObject({ phase: 'approving', approved: 500, total: 2 + TOTAL, chunk: 1, totalChunks: 3, skippedWithIssues: 0 });
		expect(approving[1]).toMatchObject({ phase: 'approving', approved: 1000, total: 2 + TOTAL, chunk: 2, totalChunks: 3, skippedWithIssues: 0 });
		expect(approving[2]).toMatchObject({ phase: 'approving', approved: 1202, total: 2 + TOTAL, chunk: 3, totalChunks: 3, skippedWithIssues: 0 });

		const complete = events.filter((e) => e.phase === 'complete');
		expect(complete.length).toBe(1);
		expect(complete[0]).toMatchObject({ phase: 'complete', approved: 2 + TOTAL, total: 2 + TOTAL, skippedWithIssues: 0 });
	});
});
