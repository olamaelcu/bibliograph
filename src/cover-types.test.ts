import { describe, it, expect } from 'vitest';
import {
  COVER_SIZES,
  COVER_FORMATS,
  COVER_SIZE_PX,
  isCoverSize,
  isCoverFormat,
  isCoverCollection,
  isLikelyRkey,
  rkeyFromUri,
  setCoverVariant,
  getCoverVariant,
  missingCoverVariants,
  hasAnyCover,
  coverFromUrl,
  deriveCover,
  variantUrl,
  variantKey,
} from './cover-types.js';

describe('isCoverSize', () => {
  it('accepts S/M/L', () => {
    expect(isCoverSize('S')).toBe(true);
    expect(isCoverSize('M')).toBe(true);
    expect(isCoverSize('L')).toBe(true);
  });
  it('rejects other values', () => {
    expect(isCoverSize('s')).toBe(false);
    expect(isCoverSize('XL')).toBe(false);
    expect(isCoverSize(undefined)).toBe(false);
  });
});

describe('isCoverFormat', () => {
  it('accepts jpg/avif', () => {
    expect(isCoverFormat('jpg')).toBe(true);
    expect(isCoverFormat('avif')).toBe(true);
  });
  it('rejects other values', () => {
    expect(isCoverFormat('png')).toBe(false);
    expect(isCoverFormat('webp')).toBe(false);
    expect(isCoverFormat(undefined)).toBe(false);
  });
});

describe('isCoverCollection', () => {
  it('accepts book/shelf', () => {
    expect(isCoverCollection('book')).toBe(true);
    expect(isCoverCollection('shelf')).toBe(true);
  });
  it('rejects other values', () => {
    expect(isCoverCollection('user')).toBe(false);
    expect(isCoverCollection(undefined)).toBe(false);
  });
});

describe('isLikelyRkey', () => {
  it('accepts 13-char rkey alphabet', () => {
    expect(isLikelyRkey('abc234567defg')).toBe(true);
    expect(isLikelyRkey('234567abcdefg')).toBe(true);
  });
  it('rejects others', () => {
    expect(isLikelyRkey('short')).toBe(false);
    expect(isLikelyRkey('way-too-long-key-here')).toBe(false);
    expect(isLikelyRkey('abc1234567ABC')).toBe(false); // uppercase not allowed
  });
  it('rejects keys containing 0 or 1', () => {
    expect(isLikelyRkey('abc1234567890')).toBe(false);
  });
});

describe('rkeyFromUri', () => {
  it('extracts rkey from an atproto URI', () => {
    expect(rkeyFromUri('at://did:plc:abc/community.lexicon.book.book/abc234567defg')).toBe('abc234567defg');
  });
  it('rejects non-atproto URIs', () => {
    expect(() => rkeyFromUri('https://example.com')).toThrow();
  });
  it('rejects URIs without a 13-char rkey', () => {
    expect(() => rkeyFromUri('at://did:plc:abc/community.lexicon.book.book/short')).toThrow();
  });
});

describe('variantKey / variantUrl', () => {
  it('builds storage keys', () => {
    expect(variantKey('book', 'abc234567defg', 'M', 'jpg')).toBe('book/abc234567defg-M.jpg');
    expect(variantKey('shelf', 'abc234567defg', 'L', 'avif')).toBe('shelf/abc234567defg-L.avif');
  });
  it('builds public URLs', () => {
    expect(variantUrl('book', 'abc234567defg', 'M', 'jpg')).toBe('/covers/book/abc234567defg-M.jpg');
    expect(variantUrl('shelf', 'abc234567defg', 'S', 'avif')).toBe('/covers/shelf/abc234567defg-S.avif');
  });
});

describe('setCoverVariant / getCoverVariant', () => {
  it('round-trips JPG variants', () => {
    const cover = setCoverVariant({}, 'S', 'jpg', '/a');
    expect(getCoverVariant(cover, 'S', 'jpg')).toBe('/a');
    expect(getCoverVariant(cover, 'M', 'jpg')).toBeUndefined();
  });
  it('round-trips AVIF variants', () => {
    const cover = setCoverVariant({}, 'L', 'avif', '/b');
    expect(getCoverVariant(cover, 'L', 'avif')).toBe('/b');
    expect(getCoverVariant(cover, 'L', 'jpg')).toBeUndefined();
  });
  it('preserves unrelated fields', () => {
    const cover = { color: '#ff0000', source: 'openlibrary' as const };
    const next = setCoverVariant(cover, 'M', 'jpg', '/c');
    expect(next.color).toBe('#ff0000');
    expect(next.source).toBe('openlibrary');
  });
});

describe('missingCoverVariants', () => {
  it('returns all 6 sizes when no variants present', () => {
    expect(missingCoverVariants({}).length).toBe(6);
  });
  it('returns empty when all 6 variants present', () => {
    const full = {};
    for (const size of COVER_SIZES) {
      for (const format of COVER_FORMATS) {
        Object.assign(full, setCoverVariant(full, size, format, '/x'));
      }
    }
    expect(missingCoverVariants(full).length).toBe(0);
  });
});

describe('hasAnyCover', () => {
  it('returns true if any URL is set', () => {
    expect(hasAnyCover({ medium: '/m' })).toBe(true);
    expect(hasAnyCover({ small: '/s' })).toBe(true);
  });
  it('returns false for empty or null', () => {
    expect(hasAnyCover({})).toBe(false);
    expect(hasAnyCover(null)).toBe(false);
    expect(hasAnyCover(undefined)).toBe(false);
  });
});

describe('coverFromUrl', () => {
  it('returns a minimal cover with medium + source', () => {
    const cover = coverFromUrl('https://example.com/c.jpg', 'user');
    expect(cover?.medium).toBe('https://example.com/c.jpg');
    expect(cover?.source).toBe('user');
    expect(cover?.updatedAt).toBeTruthy();
  });
  it('returns undefined for missing URL', () => {
    expect(coverFromUrl(undefined, 'user')).toBeUndefined();
  });
});

describe('deriveCover', () => {
  it('prefers an existing cover with content', () => {
    const cover = { medium: '/local', source: 'openlibrary' as const };
    expect(deriveCover({ cover, coverUrl: 'https://x', source: 'user' })).toBe(cover);
  });
  it('falls back to deriving from coverUrl', () => {
    const result = deriveCover({ coverUrl: 'https://x', source: 'user' });
    expect(result?.medium).toBe('https://x');
    expect(result?.source).toBe('user');
  });
  it('returns undefined when nothing is provided', () => {
    expect(deriveCover({ source: 'user' })).toBeUndefined();
  });
});

describe('size constants', () => {
  it('defines pixel widths for each size', () => {
    expect(COVER_SIZE_PX.S).toBeLessThan(COVER_SIZE_PX.M);
    expect(COVER_SIZE_PX.M).toBeLessThan(COVER_SIZE_PX.L);
  });
});
