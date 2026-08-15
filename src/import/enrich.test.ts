import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { contributors, works, contributorIdentifiers, workIdentifiers } from '../db/schema.js';
import { createTestDb } from '../test-utils/db.js';
import { enrichContributors, enrichWorks } from './enrich.js';

const now = Math.floor(Date.now() / 1000);

function authorsGz(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'enrich-authors-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ol-authors.txt.gz'), gzipSync(lines.join('\n') + '\n'));
  return dir;
}

function worksGz(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'enrich-works-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ol-works.txt.gz'), gzipSync(lines.join('\n') + '\n'));
  return dir;
}

function seedContributor(db: ReturnType<typeof createTestDb>['db'], pk: string, released: boolean, bio: string | null, sortName: string | null) {
  db.insert(contributors).values({
    pk,
    name: pk,
    bio,
    sortName,
    createdAt: now,
    releaseStatus: released ? 'released' : 'staged',
  }).run();
}

function addContributorId(db: ReturnType<typeof createTestDb>['db'], pk: string, resource: string) {
  db.insert(contributorIdentifiers).values({ contributorPk: pk, resource, url: `https://openlibrary.org${resource.slice('openlibrary:'.length)}` }).run();
}

function seedWork(db: ReturnType<typeof createTestDb>['db'], pk: string, released: boolean, originalPublishDate: number | null) {
  db.insert(works).values({ pk, title: pk, originalPublishDate, createdAt: now, releaseStatus: released ? 'released' : 'staged' }).run();
}

function addWorkId(db: ReturnType<typeof createTestDb>['db'], pk: string, resource: string) {
  db.insert(workIdentifiers).values({ workPk: pk, resource, url: `https://openlibrary.org${resource.slice('openlibrary:'.length)}` }).run();
}

describe('enrichContributors', () => {
  it('fills null bio/sortName on released contributors only, never overwriting', async () => {
    const dir = authorsGz([
      '/type/author\t/authors/OL1A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL1A","name":"Alpha","personal_name":"Alpha M","bio":"Wrote things"}',
      '/type/author\t/authors/OL2A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL2A","name":"Beta","personal_name":"Beta S","bio":"Fresh bio"}',
      '/type/author\t/authors/OL3A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL3A","name":"Gamma"}',
      '/type/author\t/authors/OL4A\t1\t2026-01-01T00:00:00Z\t{"not valid json',
    ]);
    const { db } = createTestDb();

    seedContributor(db, 'authors-ol1a', true, null, null); // fully missing → both filled
    addContributorId(db, 'authors-ol1a', 'openlibrary:authors/OL1A');

    seedContributor(db, 'authors-ol2a', true, 'Existing bio', null); // bio exists → only sortName
    addContributorId(db, 'authors-ol2a', 'openlibrary:authors/OL2A');

    seedContributor(db, 'authors-ol3a', false, null, null); // staged → not eligible
    addContributorId(db, 'authors-ol3a', 'openlibrary:authors/OL3A');

    const res = await enrichContributors(db, { dumpPath: dir });

    const c1 = db.select().from(contributors).where(eq(contributors.pk, 'authors-ol1a')).get();
    expect(c1?.bio).toBe('Wrote things');
    expect(c1?.sortName).toBe('Alpha M');

    const c2 = db.select().from(contributors).where(eq(contributors.pk, 'authors-ol2a')).get();
    expect(c2?.bio).toBe('Existing bio'); // never overwritten
    expect(c2?.sortName).toBe('Beta S');

    const c3 = db.select().from(contributors).where(eq(contributors.pk, 'authors-ol3a')).get();
    expect(c3?.bio).toBeNull();

    expect(res.enriched).toBe(2); // OL1A (bio+sortName) + OL2A (sortName)
    expect(res.processed).toBe(4);
    expect(res.failed).toBe(0); // out-of-set malformed record never parsed
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('enrichWorks', () => {
  it('fills null originalPublishDate on released works when the dump has a parseable first_publish_date', async () => {
    const dir = worksGz([
      '/type/work\t/works/OL1W\t1\t2026-01-01T00:00:00Z\t{"key":"/works/OL1W","title":"Dune","first_publish_date":"1965"}',
      '/type/work\t/works/OL2W\t1\t2026-01-01T00:00:00Z\t{"key":"/works/OL2W","title":"Unparseable","first_publish_date":"Not a date"}',
    ]);
    const { db } = createTestDb();

    seedWork(db, 'works-ol1w', true, null);
    addWorkId(db, 'works-ol1w', 'openlibrary:works/OL1W');
    seedWork(db, 'works-ol2w', true, null);
    addWorkId(db, 'works-ol2w', 'openlibrary:works/OL2W');

    const res = await enrichWorks(db, { dumpPath: dir });

    const w1 = db.select().from(works).where(eq(works.pk, 'works-ol1w')).get();
    expect(w1?.originalPublishDate).toBe(Math.floor(new Date('1965').getTime() / 1000));
    const w2 = db.select().from(works).where(eq(works.pk, 'works-ol2w')).get();
    expect(w2?.originalPublishDate).toBeNull();

    expect(res.enriched).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
