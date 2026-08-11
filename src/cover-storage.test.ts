import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator } from 'opendal';
import {
  setCoverStorage,
  coverKey,
  coverPublicUrl,
  writeCover,
  readCover,
  coverExists,
  contentTypeFor,
} from './cover-storage.js';

describe('cover-storage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cover-storage-'));
    setCoverStorage(new Operator('fs', { root: tmpDir }));
  });

  afterEach(() => {
    setCoverStorage(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds storage keys and public URLs', () => {
    expect(coverKey('book', 'abc234567defg', 'M', 'jpg')).toBe('book/abc234567defg-M.jpg');
    expect(coverPublicUrl('book', 'abc234567defg', 'M', 'jpg')).toBe('/covers/book/abc234567defg-M.jpg');
  });

  it('round-trips a buffer', async () => {
    await writeCover('book', 'abc234567defg', 'M', 'jpg', Buffer.from('jpeg-bytes'));
    const data = await readCover('book', 'abc234567defg', 'M', 'jpg');
    expect(data?.toString()).toBe('jpeg-bytes');
  });

  it('returns null when reading missing key', async () => {
    const data = await readCover('book', 'abc234567defg', 'M', 'jpg');
    expect(data).toBeNull();
  });

  it('checks existence', async () => {
    expect(await coverExists('book', 'abc234567defg', 'M', 'jpg')).toBe(false);
    await writeCover('book', 'abc234567defg', 'M', 'jpg', Buffer.from('x'));
    expect(await coverExists('book', 'abc234567defg', 'M', 'jpg')).toBe(true);
  });

  it('separates book and shelf namespaces', async () => {
    await writeCover('book', 'abc234567defg', 'M', 'jpg', Buffer.from('book'));
    await writeCover('shelf', 'abc234567defg', 'M', 'jpg', Buffer.from('shelf'));
    expect((await readCover('book', 'abc234567defg', 'M', 'jpg'))?.toString()).toBe('book');
    expect((await readCover('shelf', 'abc234567defg', 'M', 'jpg'))?.toString()).toBe('shelf');
  });

  it('returns the right content type', () => {
    expect(contentTypeFor('jpg')).toBe('image/jpeg');
    expect(contentTypeFor('avif')).toBe('image/avif');
  });
});
