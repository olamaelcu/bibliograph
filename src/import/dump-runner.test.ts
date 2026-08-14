import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { inArray } from 'drizzle-orm';
import { books } from '../db/schema.js';
import { createTestDb } from '../test-utils/db.js';
import { runDumpImport } from './dump-runner.js';

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
      keyOf: (f) => f[1] ?? null,
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
        keyOf: (f) => f[1] ?? null,
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
});
