import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operator } from 'opendal';
import sharp from 'sharp';
import { setCoverStorage, readCover } from './cover-storage.js';
import { createTestDb, type TestDb } from './test-utils/db.js';
import { generateRkey } from './rkey.js';
import { runCoverWorker } from './cover-worker.js';
import { makeRecordUri, COLLECTIONS } from './records.js';
import { coverFromUrl } from './cover-types.js';
import { eq } from 'drizzle-orm';

function makeBookWithCoverUrl(env: TestDb, isbn: string, coverUrl: string): string {
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
    coverUrl,
    createdAt: now,
    updatedAt: now,
  }).run();
  return uri;
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 150, channels: 3, background: { r: 100, g: 80, b: 60 } },
  }).jpeg().toBuffer();
}

describe('backfill-cover-json flow', () => {
  let env: TestDb;
  let tmpDir: string;

  beforeEach(() => {
    env = createTestDb();
    tmpDir = mkdtempSync(join(tmpdir(), 'backfill-cover-'));
    setCoverStorage(new Operator('fs', { root: tmpDir }));
  });

  afterEach(() => {
    setCoverStorage(null);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('populates cover.medium from coverUrl for legacy rows', () => {
    const uri = makeBookWithCoverUrl(env, '9780000000001', 'https://covers.openlibrary.org/b/id/12345-M.jpg');
    const before = env.db.select().from(env.schema.books).where(eq(env.schema.books.uri, uri)).get();
    expect(before?.cover).toBeNull();

    const cover = coverFromUrl(before?.coverUrl ?? undefined, 'openlibrary');
    env.db.update(env.schema.books).set({ cover }).where(eq(env.schema.books.uri, uri)).run();

    const after = env.db.select().from(env.schema.books).where(eq(env.schema.books.uri, uri)).get();
    expect(after?.cover?.medium).toBe('https://covers.openlibrary.org/b/id/12345-M.jpg');
  });

  it('picks up legacy rows in the missing-variants view after cover is populated', async () => {
    const uri = makeBookWithCoverUrl(env, '9780000000002', 'https://covers.openlibrary.org/b/id/99999-M.jpg');
    const cover = coverFromUrl('https://covers.openlibrary.org/b/id/99999-M.jpg', 'openlibrary');
    env.db.update(env.schema.books).set({ cover }).where(eq(env.schema.books.uri, uri)).run();

    const jpg = await jpegBuffer();
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(jpg), { status: 200, headers: { 'content-type': 'image/jpeg' } }));

    const result = await runCoverWorker(env.db, { batchSize: 10 });
    expect(result.processed).toBe(1);

    const updated = env.db.select().from(env.schema.books).where(eq(env.schema.books.uri, uri)).get();
    expect(updated?.cover?.medium).toMatch(/^\/covers\/book\//);
    expect(updated?.cover?.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('excludes rows that already have cover.medium', () => {
    makeBookWithCoverUrl(env, '9780000000003', 'https://x/a.jpg');
    const cover = coverFromUrl('https://x/a.jpg', 'openlibrary');
    env.db.update(env.schema.books).set({ cover }).where(eq(env.schema.books.uri, '9780000000003' as any)).run();

    const rows = env.db.all(sql`SELECT uri FROM books_missing_cover_variants`);
    expect((rows as { uri: string }[]).length).toBe(0);
  });
});
