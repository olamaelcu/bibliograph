import { describe, expect, it } from 'vitest';
import { mapAuthorToCandidate, mapEditionToCandidates, mapWorkToCandidate } from './openlibrary.js';

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
    expect(book.pk).toBe('books/ol123m');
    expect(book.identifiers.some((i) => i.resource === 'isbn:9780441172719')).toBe(true);
    expect(book.identifiers.some((i) => i.resource === 'openlibrary:books/OL123M')).toBe(true);
    expect(book.fields.workPk).toBe('works/ol893423w');
  });

  it('maps work and author', () => {
    const w = mapWorkToCandidate({ key: '/works/OL893423W', title: 'Dune' });
    expect(w.pk).toBe('works/ol893423w');
    const a = mapAuthorToCandidate({ key: '/authors/OL123A', name: 'Frank Herbert', bio: 'Author' });
    expect(a.pk).toBe('authors/ol123a');
    expect(a.fields.bio).toBe('Author');
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
});
