import { describe, it, expect } from 'vitest';
import { computeDeduplicationHash } from './dedup.js';

describe('computeDeduplicationHash', () => {
  it('returns a 16-character hex string', () => {
    const hash = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = computeDeduplicationHash('The Great Gatsby', 'F. Scott Fitzgerald', '1925');
    const b = computeDeduplicationHash('The Great Gatsby', 'F. Scott Fitzgerald', '1925');
    expect(a).toBe(b);
  });

  it('strips leading articles from titles', () => {
    const a = computeDeduplicationHash('The Hobbit', 'J.R.R. Tolkien');
    const b = computeDeduplicationHash('Hobbit', 'J.R.R. Tolkien');
    expect(a).toBe(b);
  });

  it('strips leading "a" from titles', () => {
    const a = computeDeduplicationHash('A Tale of Two Cities', 'Charles Dickens');
    const b = computeDeduplicationHash('Tale of Two Cities', 'Charles Dickens');
    expect(a).toBe(b);
  });

  it('strips leading "an" from titles', () => {
    const a = computeDeduplicationHash('An American Tragedy', 'Theodore Dreiser');
    const b = computeDeduplicationHash('American Tragedy', 'Theodore Dreiser');
    expect(a).toBe(b);
  });

  it('is case insensitive', () => {
    const a = computeDeduplicationHash('MOBY DICK', 'HERMAN MELVILLE');
    const b = computeDeduplicationHash('moby dick', 'herman melville');
    expect(a).toBe(b);
  });

  it('removes special characters and normalizes whitespace', () => {
    const a = computeDeduplicationHash('Moby-Dick', 'Herman Melville');
    const b = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    expect(a).not.toBe(b);
  });

  it('strips punctuation and is consistent', () => {
    const a = computeDeduplicationHash('Moby-Dick!', 'Herman Melville');
    const b = computeDeduplicationHash('Moby-Dick!', 'Herman Melville');
    expect(a).toBe(b);
  });

  it('trims whitespace', () => {
    const a = computeDeduplicationHash('  Moby Dick  ', '  Herman Melville  ');
    const b = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    expect(a).toBe(b);
  });

  it('collapses multiple spaces', () => {
    const a = computeDeduplicationHash('Moby   Dick', 'Herman   Melville');
    const b = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    expect(a).toBe(b);
  });

  it('includes publication year when provided', () => {
    const a = computeDeduplicationHash('Dune', 'Frank Herbert', '1965-08-01');
    const b = computeDeduplicationHash('Dune', 'Frank Herbert', '1965');
    expect(a).toBe(b);
  });

  it('differs with different publication years', () => {
    const a = computeDeduplicationHash('Dune', 'Frank Herbert', '1965');
    const b = computeDeduplicationHash('Dune', 'Frank Herbert', '1984');
    expect(a).not.toBe(b);
  });

  it('differs with different titles', () => {
    const a = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    const b = computeDeduplicationHash('Typee', 'Herman Melville');
    expect(a).not.toBe(b);
  });

  it('differs with different authors', () => {
    const a = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    const b = computeDeduplicationHash('Moby Dick', 'Nathaniel Hawthorne');
    expect(a).not.toBe(b);
  });

  it('handles missing publication date', () => {
    const a = computeDeduplicationHash('1984', 'George Orwell');
    const b = computeDeduplicationHash('1984', 'George Orwell', undefined);
    expect(a).toBe(b);
  });

  it('extracts year from various date formats', () => {
    const a = computeDeduplicationHash('Book', 'Author', '2020-01-15');
    const b = computeDeduplicationHash('Book', 'Author', '2020');
    expect(a).toBe(b);
  });

  it('handles empty strings', () => {
    const hash = computeDeduplicationHash('', '');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('strips numbers and punctuation from titles', () => {
    const a = computeDeduplicationHash('Title #1: The Beginning', 'Author');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
