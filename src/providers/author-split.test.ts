import { describe, it, expect } from 'vitest';
import { splitHumanAuthorString } from './author-split.js';

describe('splitHumanAuthorString', () => {
  it('returns a single-element array for a single name', () => {
    expect(splitHumanAuthorString('Frank Herbert')).toEqual(['Frank Herbert']);
  });

  it('splits on comma', () => {
    expect(splitHumanAuthorString('Frank Herbert, Brian Herbert')).toEqual([
      'Frank Herbert',
      'Brian Herbert',
    ]);
  });

  it('splits on the word "and" with surrounding whitespace', () => {
    expect(splitHumanAuthorString('Frank Herbert and Brian Herbert')).toEqual([
      'Frank Herbert',
      'Brian Herbert',
    ]);
  });

  it('splits on "&" with surrounding whitespace', () => {
    expect(splitHumanAuthorString('Frank Herbert & Brian Herbert')).toEqual([
      'Frank Herbert',
      'Brian Herbert',
    ]);
  });

  it('splits on a mix of commas, "and", and "&"', () => {
    expect(
      splitHumanAuthorString('Alice, Bob and Carol & Dave'),
    ).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('trims whitespace around each name', () => {
    expect(splitHumanAuthorString('  Alice  ,  Bob  ')).toEqual(['Alice', 'Bob']);
  });

  it('drops empty segments from consecutive separators', () => {
    expect(splitHumanAuthorString('Alice,,, Bob')).toEqual(['Alice', 'Bob']);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitHumanAuthorString('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(splitHumanAuthorString('   ')).toEqual([]);
  });

  it('preserves a single name that contains "and" in the middle (only splits on word boundary)', () => {
    expect(splitHumanAuthorString('Alexanderander')).toEqual(['Alexanderander']);
  });
});