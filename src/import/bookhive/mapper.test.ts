import { describe, expect, it } from 'vitest';
import { mapCatalogBook } from './mapper.js';

describe('mapCatalogBook', () => {
  it('maps a catalog book to contributor + book candidates', () => {
    const cands = mapCatalogBook({
      identifiers: { hiveId: 'hive-1' },
      title: 'Dune',
      authors: [{ name: 'Frank Herbert' }],
      isbn: '9780441172719',
    });
    expect(cands.map((c) => c.entityType)).toEqual(['contributor', 'book']);
    const book = cands[1];
    expect(book.identifiers.some((i) => i.resource === 'hiveId:hive-1')).toBe(true);
    expect(book.identifiers.some((i) => i.resource === 'isbn:9780441172719')).toBe(true);
  });

  it('tolerates missing fields', () => {
    const cands = mapCatalogBook({ title: 'Untitled' });
    expect(cands).toHaveLength(1);
    expect(cands[0].entityType).toBe('book');
    expect(cands[0].matchName).toBe('Untitled');
  });

  it('normalizes hyphenated ISBNs into a bare isbn resource', () => {
    const cands = mapCatalogBook({ identifiers: { hiveId: 'hive-2' }, title: 'Dune', isbn: '978-0-441-17271-9' });
    const book = cands.find((c) => c.entityType === 'book');
    expect(book?.identifiers.some((i) => i.resource === 'isbn:9780441172719')).toBe(true);
  });

  it('derives a deterministic hash pk for non-ASCII author names', () => {
    const cands = mapCatalogBook({
      identifiers: { hiveId: 'hive-3' },
      title: 'CJK Book',
      authors: '岡田 斗司夫',
    });
    const contributor = cands.find((c) => c.entityType === 'contributor');
    expect(contributor).toBeDefined();
    expect(contributor?.pk.startsWith('c-')).toBe(true);
    expect(contributor?.matchName).toBe('岡田 斗司夫');
  });
});
