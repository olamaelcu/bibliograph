import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoodreadsProvider } from './goodreads.js';

describe('GoodreadsProvider', () => {
  let provider: GoodreadsProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new GoodreadsProvider();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getName', () => {
    it('returns "Goodreads"', () => {
      expect(provider.getName()).toBe('Goodreads');
    });
  });
});
