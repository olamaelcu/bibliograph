import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator } from 'opendal';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { setCoverStorage, readCover } from './cover-storage.js';
import { createTestDb, type TestDb } from './test-utils/db.js';
import { generateRkey } from './rkey.js';
import { runCoverWorker } from './cover-worker.js';
import { makeRecordUri, COLLECTIONS } from './records.js';

function seedBookWithCover(env: TestDb, isbn: string, cover: object): string {
  const rkey = generateRkey();
  const uri = makeRecordUri('did:plc:test', COLLECTIONS.book, rkey);
  const now = new Date().toISOString();
  env.db.insert(env.schema.books).values({
    uri,
    did: 'did:plc:test',
    title: 'Test Book',
    author: 'Test Author',
    isbn,
    status: 'active',
    cover,
    createdAt: now,
    updatedAt: now,
  }).run();
  return uri;
}

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 150, channels: 3, background: { r: 100, g: 80, b: 60 } },
  }).jpeg().toBuffer();
}

describe('runCoverWorker', () => {
  let env: TestDb;
  let tmpDir: string;

  beforeEach(() => {
    env = createTestDb();
    tmpDir = mkdtempSync(join(tmpdir(), 'cover-worker-'));
    setCoverStorage(new Operator('fs', { root: tmpDir }));
  });

  afterEach(() => {
    setCoverStorage(null);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('processes a row whose cover.medium is a remote URL', async () => {
    const jpg = await makeJpeg();
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(jpg), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const uri = seedBookWithCover(env, '9780000000001', { medium: 'https://example.com/c.jpg', source: 'openlibrary' });

    const result = await runCoverWorker(env.db, { batchSize: 10 });
    expect(result.processed).toBe(1);
    expect(result.scanned).toBe(1);

    // All 6 variants loaded from OpenDAL
    const rkey = uri.slice(-13);
    expect((await readCover('book', rkey, 'S', 'jpg'))?.length).toBeGreaterThan(0);
    expect((await readCover('book', rkey, 'M', 'jpg'))?.length).toBeGreaterThan(0);
    expect((await readCover('book', rkey, 'L', 'jpg'))?.length).toBeGreaterThan(0);
    expect((await readCover('book', rkey, 'S', 'avif'))?.length).toBeGreaterThan(0);
    expect((await readCover('book', rkey, 'M', 'avif'))?.length).toBeGreaterThan(0);
    expect((await readCover('book', rkey, 'L', 'avif'))?.length).toBeGreaterThan(0);

    // cover.medium is now a local URL
    const updated = env.db.select().from(env.schema.books).where(eq(env.schema.books.uri, uri)).get();
    expect(updated?.cover?.medium).toBe(`/covers/book/${rkey}-M.jpg`);
    expect(updated?.cover?.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(updated?.cover?.width).toBe(100);
    expect(updated?.cover?.height).toBe(150);
  });

  it('skips rows whose source fetch fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    seedBookWithCover(env, '9780000000002', { medium: 'https://example.com/missing.jpg' });

    const result = await runCoverWorker(env.db, { batchSize: 10 });
    expect(result.scanned).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('skips rows whose source image is invalid', async () => {
    vi.stubGlobal('fetch', async () => new Response('not an image', { status: 200 }));
    seedBookWithCover(env, '9780000000003', { medium: 'https://example.com/bad.jpg' });

    const result = await runCoverWorker(env.db, { batchSize: 10 });
    expect(result.scanned).toBe(1);
    expect(result.processed).toBe(0);
  });

  it('processes multiple rows in batch', async () => {
    const jpg = await makeJpeg();
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(jpg), { status: 200, headers: { 'content-type': 'image/jpeg' } }));

    seedBookWithCover(env, '9780000000004', { medium: 'https://example.com/a.jpg' });
    seedBookWithCover(env, '9780000000005', { medium: 'https://example.com/b.jpg' });
    seedBookWithCover(env, '9780000000006', { medium: 'https://example.com/c.jpg' });

    const result = await runCoverWorker(env.db, { batchSize: 10 });
    expect(result.processed).toBe(3);
  });
});
