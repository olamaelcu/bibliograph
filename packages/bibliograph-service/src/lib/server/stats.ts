import { count } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db as defaultDb } from './db';
import { works, editions, contributors, publishers } from './db/schema';

export type DbExecutor = typeof defaultDb;

export type Counts = {
  works: number;
  editions: number;
  contributors: number;
  publishers: number;
  generatedAt: string;
};

async function countTable(db: DbExecutor, table: PgTable): Promise<number> {
  const [row] = await db.select({ c: count() }).from(table);
  return Number(row?.c ?? 0);
}

export async function fetchCounts(db: DbExecutor = defaultDb): Promise<Counts> {
  const [worksCount, editionsCount, contributorsCount, publishersCount] = await Promise.all([
    countTable(db, works),
    countTable(db, editions),
    countTable(db, contributors),
    countTable(db, publishers),
  ]);
  return {
    works: worksCount,
    editions: editionsCount,
    contributors: contributorsCount,
    publishers: publishersCount,
    generatedAt: new Date().toISOString(),
  };
}