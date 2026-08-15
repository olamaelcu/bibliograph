import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { inArray, eq } from 'drizzle-orm';
import { backfillState, books, contributors, contributorIdentifiers } from '../db/schema.js';
import { createTestDb } from '../test-utils/db.js';
import { runDumpImport } from './dump-runner.js';
import { mapAuthorToCandidate, olKeyOf } from './mappers/openlibrary.js';

function authorFixture(dir: string, lines: string[]) {
  const dumpPath = join(dir, 'dump');
  mkdirSync(dumpPath, { recursive: true });
  writeFileSync(join(dumpPath, 'ol-authors.txt.gz'), gzipSync(lines.join('\n') + '\n'));
  return dumpPath;
}

const authorParse = (fields: string[]) => [mapAuthorToCandidate(JSON.parse(fields[4]))];

describe('runDumpImport', () => {
  it('imports a real gz TSV fixture via merge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-run-'));
    const dumpPath = join(dir, 'dump');
    mkdirSync(dumpPath, { recursive: true });
    const lines = [
      '/type/edition\t/books/OL1M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL1M","title":"Alpha"}',
      '/type/edition\t/books/OL2M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL2M","title":"Beta"}',
    ];
    writeFileSync(join(dumpPath, 'ol-editions.txt.gz'), gzipSync(lines.join('\n') + '\n'));

    const { db } = createTestDb();
    const summary = await runDumpImport({
      db,
      stateName: 'ol-editions',
      url: 'https://example.invalid/dump.gz', // noDownload path avoids fetching
      dumpPath,
      noDownload: true,
      keyOf: olKeyOf,
      parse: (fields) => {
        const rec = JSON.parse(fields[4]);
        return [{
          entityType: 'book',
          pk: `books/${rec.key.replace('/books/', 'ol').toLowerCase()}`,
          source: 'openlibrary',
          matchName: rec.title,
          identifiers: [{ resource: `openlibrary:${rec.key.replace(/^\//, '')}`, url: `https://ol${rec.key}` }],
          fields: { title: rec.title },
        }];
      },
    });
    expect(summary.processed).toBe(2);
    const rows = db.select().from(books).where(inArray(books.pk, ['books/olol1m', 'books/olol2m'])).all();
    expect(rows).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists totalRecords and totalProcessed to backfill state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-run-'));
    const dumpPath = join(dir, 'dump');
    mkdirSync(dumpPath, { recursive: true });
    const lines = [
      '/type/edition\t/books/OL1M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL1M","title":"Alpha"}',
      '/type/edition\t/books/OL2M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL2M","title":"Beta"}',
    ];
    writeFileSync(join(dumpPath, 'ol-editions.txt.gz'), gzipSync(lines.join('\n') + '\n'));

    const { db } = createTestDb();
    await runDumpImport({
      db,
      stateName: 'ol-editions',
      url: 'https://example.invalid/dump.gz',
      dumpPath,
      noDownload: true,
      keepDump: true,
      keyOf: olKeyOf,
      parse: (fields) => {
        const rec = JSON.parse(fields[4]);
        return [{
          entityType: 'book',
          pk: `books/${rec.key.replace('/books/', 'ol').toLowerCase()}`,
          source: 'openlibrary',
          matchName: rec.title,
          identifiers: [{ resource: `openlibrary:${rec.key.replace(/^\//, '')}`, url: `https://ol${rec.key}` }],
          fields: { title: rec.title },
        }];
      },
    });

    const state = db.select().from(backfillState).where(eq(backfillState.name, 'ol-editions')).get();
    expect(state?.totalRecords).toBe(2);
    expect(state?.totalProcessed).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-import skips records that already exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-run-'));
    const dumpPath = join(dir, 'dump');
    mkdirSync(dumpPath, { recursive: true });
    const lines = [
      '/type/edition\t/books/OL1M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL1M","title":"Alpha"}',
    ];
    writeFileSync(join(dumpPath, 'ol-editions.txt.gz'), gzipSync(lines.join('\n') + '\n'));

    const { db } = createTestDb();
    const run = () =>
      runDumpImport({
        db,
        stateName: 'ol-editions',
        url: 'https://example.invalid/dump.gz',
        dumpPath,
        noDownload: true,
        keepDump: true,
        keyOf: olKeyOf,
        parse: (fields) => {
          const rec = JSON.parse(fields[4]);
          return [{
            entityType: 'book',
            pk: `books/${rec.key.replace('/books/', 'ol').toLowerCase()}`,
            source: 'openlibrary',
            matchName: rec.title,
            identifiers: [{ resource: `openlibrary:${rec.key.replace(/^\//, '')}`, url: `https://ol${rec.key}` }],
            fields: { title: rec.title },
          }];
        },
      });

    const first = await run();
    expect(first.inserted).toBe(1);
    const second = await run();
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skipIfSeen short-circuits existing records before parse/merge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-run-'));
    const lines = [
      '/type/author\t/authors/OL1A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL1A","name":"Alpha"}',
      '/type/author\t/authors/OL2A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL2A","name":"Beta"}',
    ];
    const dumpPath = authorFixture(dir, lines);

    const { db } = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(contributors).values({ pk: 'authors-ol1a', name: 'Alpha', createdAt: now, releaseStatus: 'staged' }).run();
    db.insert(contributorIdentifiers).values({
      contributorPk: 'authors-ol1a',
      resource: 'openlibrary:authors/OL1A',
      url: 'https://openlibrary.org/authors/OL1A',
    }).run();

    const parsed: string[] = [];
    const summary = await runDumpImport({
      db,
      stateName: 'ol-authors',
      url: 'https://example.invalid/dump.gz',
      dumpPath,
      noDownload: true,
      keepDump: true,
      keyOf: olKeyOf,
      skipIfSeen: (key) => key === '/authors/OL1A',
      parse: (fields) => {
        parsed.push(fields[4]);
        return authorParse(fields);
      },
    });

    expect(parsed).toEqual([lines[1].split('\t')[4]]); // only the non-skipped record was parsed
    expect(summary.processed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.inserted).toBe(1);
    const row = db.select().from(contributors).where(eq(contributors.pk, 'authors-ol1a')).get();
    expect(row?.name).toBe('Alpha');
    rmSync(dir, { recursive: true, force: true });
  });

  it('checkpoints mid-run so an interrupted import resumes from the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-run-'));
    const lines = [
      '/type/author\t/authors/OL1A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL1A","name":"Alpha"}',
      '/type/author\t/authors/OL2A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL2A","name":"Beta"}',
      '/type/author\t/authors/OL3A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL3A","name":"Gamma"}',
    ];
    const dumpPath = authorFixture(dir, lines);

    const { db } = createTestDb();
    const run = (onImportProgress?: (processed: number, total: number | null) => void) =>
      runDumpImport({
        db,
        stateName: 'ol-authors',
        url: 'https://example.invalid/dump.gz',
        dumpPath,
        noDownload: true,
        keepDump: true,
        batchSize: 1,
        keyOf: olKeyOf,
        parse: authorParse,
        onImportProgress,
      });

    await expect(run((processed) => {
      if (processed === 1) throw new Error('simulated interrupt');
    })).rejects.toThrow('simulated interrupt');

    const mid = db.select().from(backfillState).where(eq(backfillState.name, 'ol-authors')).get();
    expect(mid?.cursor).toBe('/authors/OL1A');
    expect(mid?.totalProcessed).toBe(1);
    expect(mid?.complete).toBe(0);

    const summary = await run();
    expect(summary.processed).toBe(2); // OL2A + OL3A past the cursor
    const fin = db.select().from(backfillState).where(eq(backfillState.name, 'ol-authors')).get();
    expect(fin?.cursor).toBeNull();
    expect(fin?.totalProcessed).toBe(3);
    expect(fin?.complete).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds an uncompressed snapshot and resumes from a byte offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-run-'));
    const lines = [
      '/type/author\t/authors/OL1A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL1A","name":"Alpha"}',
      '/type/author\t/authors/OL2A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL2A","name":"Beta"}',
      '/type/author\t/authors/OL3A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL3A","name":"Gamma"}',
    ];
    const dumpPath = authorFixture(dir, lines);
    const snapshotPath = join(dumpPath, 'ol-authors.txt.gz.txt');

    const { db } = createTestDb();
    const run = (onImportProgress?: (processed: number, total: number | null) => void) =>
      runDumpImport({
        db,
        stateName: 'ol-authors',
        url: 'https://example.invalid/dump.gz',
        dumpPath,
        noDownload: true,
        keepDump: true,
        useSnapshot: true,
        batchSize: 1,
        keyOf: olKeyOf,
        parse: authorParse,
        onImportProgress,
      });

    await expect(run((processed) => {
      if (processed === 1) throw new Error('simulated interrupt');
    })).rejects.toThrow('simulated interrupt');

    expect(existsSync(snapshotPath)).toBe(true);
    const mid = db.select().from(backfillState).where(eq(backfillState.name, 'ol-authors')).get();
    expect(mid?.lastByteOffset).toBeGreaterThan(0);
    expect(mid?.cursor).toBe('/authors/OL1A');

    const summary = await run();
    expect(summary.processed).toBe(2); // resumes past the check-pointed byte offset
    const fin = db.select().from(backfillState).where(eq(backfillState.name, 'ol-authors')).get();
    expect(fin?.totalProcessed).toBe(3);
    expect(fin?.complete).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
