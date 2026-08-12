import { describe, it, expect } from 'vitest';
import { toContributorRecord, type DumpAuthorRecord } from './mapper.js';

const baseRecord = (): DumpAuthorRecord => ({
  key: '/authors/OL12345A',
  type: '/type/author',
  name: 'Frank Herbert',
});

describe('authorMapper.toContributorRecord', () => {
  it('maps a fully populated author record', () => {
    const r: DumpAuthorRecord = {
      ...baseRecord(),
      personal_name: 'Franklin Patrick Herbert Jr.',
      alternate_names: ['Frank H.', 'Franklin Herbert'],
      birth_date: '1920-10-08',
      death_date: '1986-02-11',
      bio: 'American science fiction author.',
      links: [{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Frank_Herbert' }],
    };

    const out = toContributorRecord(r);
    expect(out).toEqual({
      name: 'Frank Herbert',
      altNames: ['Frank H.', 'Franklin Herbert'],
      bio: 'American science fiction author.',
      identifiers: [{ type: 'openlibrary', value: '/authors/OL12345A' }],
    });
  });

  it('returns null when key is missing', () => {
    const r: DumpAuthorRecord = { ...baseRecord(), key: '' };
    expect(toContributorRecord(r)).toBeNull();
  });

  it('returns null when key is not a string', () => {
    const r = { ...baseRecord(), key: 12345 } as unknown as DumpAuthorRecord;
    expect(toContributorRecord(r)).toBeNull();
  });

  it('returns null when name is missing', () => {
    const r: DumpAuthorRecord = { ...baseRecord(), name: undefined as unknown as string };
    expect(toContributorRecord(r)).toBeNull();
  });

  it('returns null when name is empty string', () => {
    const r: DumpAuthorRecord = { ...baseRecord(), name: '' };
    expect(toContributorRecord(r)).toBeNull();
  });

  it('drops personal_name, birth_date, death_date, and links from the output', () => {
    const r: DumpAuthorRecord = {
      ...baseRecord(),
      personal_name: 'Personal',
      birth_date: '1900',
      death_date: '2000',
      links: [{ url: 'https://example.com' }],
    };
    const out = toContributorRecord(r)!;
    expect(out).not.toHaveProperty('personal_name');
    expect(out).not.toHaveProperty('birth_date');
    expect(out).not.toHaveProperty('death_date');
    expect(out).not.toHaveProperty('links');
  });

  it('treats bio as a plain string', () => {
    const out = toContributorRecord({ ...baseRecord(), bio: 'A bio.' })!;
    expect(out.bio).toBe('A bio.');
  });

  it('extracts bio from { value } wrapper when given the long form', () => {
    const out = toContributorRecord({
      ...baseRecord(),
      bio: { value: 'A much longer biography paragraph.' },
    })!;
    expect(out.bio).toBe('A much longer biography paragraph.');
  });

  it('returns bio undefined when the record has no bio', () => {
    const out = toContributorRecord(baseRecord())!;
    expect(out.bio).toBeUndefined();
  });

  it('defaults altNames to an empty array when alternate_names is missing', () => {
    const out = toContributorRecord(baseRecord())!;
    expect(out.altNames).toEqual([]);
  });

  it('accepts the real OL dump shape where type is an object', () => {
    const r = { ...baseRecord(), type: { key: '/type/author' } } as unknown as DumpAuthorRecord;
    const out = toContributorRecord(r);
    expect(out).not.toBeNull();
    expect(out?.name).toBe('Frank Herbert');
  });

  it('rejects records whose type is neither /type/author nor the { key: "/type/author" } form', () => {
    const r1 = { ...baseRecord(), type: '/type/edition' } as unknown as DumpAuthorRecord;
    const r2 = { ...baseRecord(), type: { key: '/type/work' } } as unknown as DumpAuthorRecord;
    const r3 = { ...baseRecord(), type: 999 } as unknown as DumpAuthorRecord;
    expect(toContributorRecord(r1)).toBeNull();
    expect(toContributorRecord(r2)).toBeNull();
    expect(toContributorRecord(r3)).toBeNull();
  });

  it('returns null for non-object inputs', () => {
    expect(toContributorRecord(null as unknown as DumpAuthorRecord)).toBeNull();
    expect(toContributorRecord(undefined as unknown as DumpAuthorRecord)).toBeNull();
    expect(toContributorRecord(123 as unknown as DumpAuthorRecord)).toBeNull();
    expect(toContributorRecord('string' as unknown as DumpAuthorRecord)).toBeNull();
  });

  it('uses the OL key as the openlibrary identifier value', () => {
    const r: DumpAuthorRecord = { ...baseRecord(), key: '/authors/OL999A' };
    const out = toContributorRecord(r)!;
    expect(out.identifiers).toEqual([{ type: 'openlibrary', value: '/authors/OL999A' }]);
  });
});
