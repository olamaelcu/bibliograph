import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator } from 'opendal';
import { setCoverStorage, writeCover } from './cover-storage.js';
import { fetchCoverSource } from './cover-source.js';

describe('fetchCoverSource', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cover-source-'));
    setCoverStorage(new Operator('fs', { root: tmpDir }));
  });

  afterEach(() => {
    setCoverStorage(null);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads local cover from OpenDAL when URL is /covers/...', async () => {
    await writeCover('book', 'abc234567defg', 'M', 'jpg', Buffer.from('local-bytes'));
    const result = await fetchCoverSource('/covers/book/abc234567defg-M.jpg', {
      collection: 'book',
      rkey: 'abc234567defg',
    });
    expect(result?.bytes.toString()).toBe('local-bytes');
    expect(result?.contentType).toBe('image/jpeg');
  });

  it('returns null when local cover key is missing', async () => {
    const result = await fetchCoverSource('/covers/book/abc234567defg-M.jpg', {
      collection: 'book',
      rkey: 'abc234567defg',
    });
    expect(result).toBeNull();
  });

  it('rejects local URL with mismatched rkey', async () => {
    await writeCover('book', 'abc234567defg', 'M', 'jpg', Buffer.from('local'));
    const result = await fetchCoverSource('/covers/book/abc234567defg-M.jpg', {
      collection: 'book',
      rkey: 'differentrkey!!', // wrong
    });
    expect(result).toBeNull();
  });

  it('fetches remote URLs', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(Buffer.from('remote-bytes'), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCoverSource('https://example.com/c.jpg', {
      collection: 'book',
      rkey: 'abc234567defg',
    });
    expect(result?.bytes.toString()).toBe('remote-bytes');
    expect(result?.contentType).toBe('image/jpeg');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns null on non-ok remote response', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    const result = await fetchCoverSource('https://example.com/missing.jpg', {
      collection: 'book',
      rkey: 'abc234567defg',
    });
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    const result = await fetchCoverSource('https://example.com/c.jpg', {
      collection: 'book',
      rkey: 'abc234567defg',
    });
    expect(result).toBeNull();
  });
});
