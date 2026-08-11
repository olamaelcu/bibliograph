import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator } from 'opendal';
import { Hono } from 'hono';
import { setCoverStorage, writeCover } from '../cover-storage.js';
import { serveCover } from './cover.js';

function buildApp(): Hono {
  const app = new Hono();
  app.get('/covers/*', serveCover);
  return app;
}

describe('serveCover', () => {
  let tmpDir: string;
  let app: Hono;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cover-api-'));
    setCoverStorage(new Operator('fs', { root: tmpDir }));
    app = buildApp();
  });

  afterEach(() => {
    setCoverStorage(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 400 for invalid collection', async () => {
    const res = await app.request('/covers/user/abc234567defg-M.jpg');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'InvalidPath' });
  });

  it('returns 400 for invalid rkey', async () => {
    const res = await app.request('/covers/book/short-M.jpg');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'InvalidPath' });
  });

  it('returns 400 for invalid size', async () => {
    const res = await app.request('/covers/book/abc234567defg-XL.jpg');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'InvalidPath' });
  });

  it('returns 400 for invalid format', async () => {
    const res = await app.request('/covers/book/abc234567defg-M.png');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'InvalidPath' });
  });

  it('returns 404 when key does not exist', async () => {
    const res = await app.request('/covers/book/abc234567defg-M.jpg');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'NotFound' });
  });

  it('returns the image bytes with correct content-type', async () => {
    await writeCover('book', 'abc234567defg', 'M', 'jpg', Buffer.from('jpeg-data'));
    const res = await app.request('/covers/book/abc234567defg-M.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe('"book-abc234567defg-M-jpg"');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe('jpeg-data');
  });

  it('serves AVIF with the avif content-type', async () => {
    await writeCover('book', 'abc234567defg', 'M', 'avif', Buffer.from('avif-data'));
    const res = await app.request('/covers/book/abc234567defg-M.avif');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/avif');
  });

  it('serves shelf covers', async () => {
    await writeCover('shelf', 'abc234567defg', 'S', 'jpg', Buffer.from('shelf-jpg'));
    const res = await app.request('/covers/shelf/abc234567defg-S.jpg');
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe('shelf-jpg');
  });
});
