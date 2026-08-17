import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mapAuthorToCandidate, mapEditionToCandidates, mapWorkToCandidate, skipSeenContributors, skipSeenWorks } from './openlibrary.js';
import { createTestDb } from '../../test-utils/db.js';
import { contributors, works, contributorIdentifiers, workIdentifiers } from '../../db/schema.js';

const edition: any = {
  key: '/books/OL123M',
  title: 'Dune',
  publish_date: '1965',
  description: { value: 'A desert planet saga' },
  works: [{ key: '/works/OL893423W' }],
  authors: [{ key: '/authors/OL123A', name: 'Frank Herbert' }],
  isbn_13: ['9780441172719'],
  physical_format: 'paperback',
};

describe('OL mappers', () => {
  it('maps edition to work, contributor, book candidates', () => {
    const cands = mapEditionToCandidates(edition);
    expect(cands.map((c) => c.entityType)).toEqual(['work', 'contributor', 'book']);
    const book = cands[2];
		expect(book.pk).toBe('books-ol123m');
    expect(book.identifiers.some((i) => i.resource === 'isbn:9780441172719')).toBe(true);
    expect(book.identifiers.some((i) => i.resource === 'openlibrary:books/OL123M')).toBe(true);
		expect(book.fields.workPk).toBe('works-ol893423w');
  });

  it('also attaches the edition\'s ISBN-13/ISBN-10 identifiers to its work', () => {
    const cands = mapEditionToCandidates({
      key: '/books/OL123M',
      title: 'Dune',
      works: [{ key: '/works/OL893423W' }],
      isbn_13: ['9780441172719'],
      isbn_10: ['0441172717'],
    });
    const work = cands.find((c) => c.entityType === 'work');
    expect(work?.identifiers.some((i) => i.resource === 'openlibrary:works/OL893423W')).toBe(true);
    expect(work?.identifiers.some((i) => i.resource === 'isbn:9780441172719')).toBe(true);
    expect(work?.identifiers.some((i) => i.resource === 'isbn:0441172717')).toBe(true);
  });

  it('does not attach any ISBNs to a work when the edition has none', () => {
    const cands = mapEditionToCandidates({ key: '/books/OL1M', title: 'X', works: [{ key: '/works/OL1W' }] });
    const work = cands.find((c) => c.entityType === 'work');
    expect(work?.identifiers).toHaveLength(1);
    expect(work?.identifiers[0].resource).toBe('openlibrary:works/OL1W');
  });

  it('maps work and author', () => {
    const w = mapWorkToCandidate({ key: '/works/OL893423W', title: 'Dune' });
		expect(w.pk).toBe('works-ol893423w');
    const a = mapAuthorToCandidate({ key: '/authors/OL123A', name: 'Frank Herbert', bio: 'Author' });
		expect(a.pk).toBe('authors-ol123a');
    expect(a.fields.bio).toBe('Author');
  });

	 it('skips contributor candidates for edition author entries without a name', () => {
			const cands = mapEditionToCandidates({ key: '/books/OL1M', title: 'X', authors: [{ key: '/authors/OL1A' }] });
			expect(cands.map((c) => c.entityType)).toEqual(['book']);
	});

	 it('returns null for authors dump entries without a name or personal_name', () => {
			const a = mapAuthorToCandidate({ key: '/authors/OL123A' });
			expect(a).toBeNull();
	});

	 it('maps authors with only personal_name (name fallback)', () => {
			const a = mapAuthorToCandidate({ key: '/authors/OL123A', personal_name: 'Frank Herbert' });
			expect(a).not.toBeNull();
			expect(a!.fields.name).toBe('Frank Herbert');
			expect(a!.fields.sortName).toBe('Frank Herbert');
		});

	it('nulls unparseable edition publish dates instead of writing NaN', () => {
    const cands = mapEditionToCandidates({ key: '/books/OL1M', title: 'X', publish_date: 'Not specified', works: [{ key: '/works/OL1W' }] });
    const work = cands.find((c) => c.entityType === 'work');
    const book = cands.find((c) => c.entityType === 'book');
    expect(work?.fields.originalPublishDate).toBeNull();
    expect(book?.fields.publishDate).toBeNull();
  });

  it('nulls unparseable work publish dates instead of writing NaN', () => {
    const w = mapWorkToCandidate({ key: '/works/OL1W', title: 'X', first_publish_date: '19--' });
    expect(w.fields.originalPublishDate).toBeNull();
  });

  it('normalizes hyphenated ISBNs into a bare isbn resource', () => {
    const cands = mapEditionToCandidates({ key: '/books/OL1M', title: 'X', isbn_13: ['978-0-441-17271-9'] });
    const book = cands.find((c) => c.entityType === 'book');
    expect(book?.identifiers.some((i) => i.resource === 'isbn:9780441172719')).toBe(true);
  });

  it('skips book candidate when title is missing', () => {
    const cands = mapEditionToCandidates({ key: '/books/OL1M' });
    expect(cands.find((c) => c.entityType === 'book')).toBeUndefined();
  });
  
  it('skipSeenContributors is true only for keys already in contributor identifiers', async () => {
    const { db } = await createTestDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(contributors).values({ pk: 'authors-ol1a', name: 'Alpha', createdAt: now, releaseStatus: 'staged' });
    await db.insert(contributorIdentifiers).values({
      contributorPk: 'authors-ol1a',
      resource: 'openlibrary:authors/OL1A',
      url: 'https://openlibrary.org/authors/OL1A',
    });

    const skip = skipSeenContributors(db);
    expect(await skip('/authors/OL1A', '')).toBe(true);
    expect(await skip('/authors/OLNEW', '')).toBe(false);
    expect(await skip(null, '')).toBe(false);
  });

  it('skipSeenWorks is true only for keys already in work identifiers', async () => {
    const { db } = await createTestDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(works).values({ pk: 'works-ol1w', title: 'Dune', createdAt: now, releaseStatus: 'staged' });
    await db.insert(workIdentifiers).values({
      workPk: 'works-ol1w',
      resource: 'openlibrary:works/OL1W',
      url: 'https://openlibrary.org/works/OL1W',
    });

    const skip = skipSeenWorks(db);
    expect(await skip('/works/OL1W', '')).toBe(true);
    expect(await skip('/works/OLNEW', '')).toBe(false);
    expect(await skip(null, '')).toBe(false);
  });
});
