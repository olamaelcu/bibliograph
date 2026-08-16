#!/usr/bin/env tsx
import { sql } from 'drizzle-orm';
import { db, closeDb } from './connection.js';
import { COLLECTION } from '../xrpc/views.js';

function dbLabel(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return '<unset>';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

async function tableCount(name: string, collection?: string): Promise<number> {
  const res = collection
    ? await db.execute(sql`SELECT COUNT(*) c FROM user_records WHERE collection = ${collection}`)
    : await db.execute(sql`SELECT COUNT(*) c FROM ${sql.raw(name)}`);
  return Number(res.rows[0]?.c ?? 0);
}

async function byStatus(tableName: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const res = await db.execute(
      sql`SELECT release_status s, COUNT(*) c FROM ${sql.raw(tableName)} GROUP BY release_status`,
    );
    for (const row of res.rows) out[row.s as string] = Number(row.c);
  } catch {
    /* table has no release_status */
  }
  return out;
}

function pad(label: string, width = 34): string {
  return label.padEnd(width);
}

async function main(): Promise<void> {
  console.log(`Database: ${dbLabel()}`);
  console.log('');

  const catalog: Array<{ label: string; table: string; collection?: string }> = [
    { label: 'books', table: 'books' },
    { label: 'works', table: 'works' },
    { label: 'contributors', table: 'contributors' },
    { label: 'genres', table: 'genres' },
    { label: 'contributor roles', table: 'contributor_roles' },
    { label: 'formats', table: 'formats' },
    { label: 'shelves', table: 'user_records', collection: COLLECTION.shelf },
    { label: 'reviews', table: 'user_records', collection: COLLECTION.review },
  ];

  console.log('Catalog counts:');
  for (const entry of catalog) {
    const n = await tableCount(entry.table, entry.collection);
    console.log(`  ${pad(entry.label)}${n < 0 ? '(no table)' : n.toLocaleString()}`);
  }
  console.log('');

  console.log('Release status:');
  for (const entry of catalog) {
    const st = await byStatus(entry.table);
    if (Object.keys(st).length === 0) continue;
    const parts = ['staged', 'released', 'rejected']
      .filter((s) => st[s] !== undefined)
      .map((s) => `${s}: ${st[s].toLocaleString()}`);
    console.log(`  ${pad(entry.label)}${parts.join('   ')}`);
  }
  console.log('');

  const openIssuesRes = await db.execute(sql`SELECT COUNT(*) c FROM import_issues WHERE status = 'open'`);
  const openIssues = Number(openIssuesRes.rows[0]?.c ?? 0);
  console.log(`Open import issues: ${openIssues.toLocaleString()}`);

  const states = (
    await db.execute(
      sql`SELECT name, complete, stopped, total_processed, total_records, file_size FROM backfill_state ORDER BY name`,
    )
  ).rows as Array<{
    name: string;
    complete: number;
    stopped: number;
    total_processed: number | null;
    total_records: number | null;
    file_size: number | null;
  }>;
  if (states.length > 0) {
    console.log('');
    console.log('Backfill state:');
    for (const s of states) {
      const sizeMb = s.file_size ? `${(s.file_size / 1024 / 1024).toFixed(0)} MB` : '-';
      const processed = s.total_processed ?? 0;
      const of = s.total_records
        ? ` of ${s.total_records.toLocaleString()} (${Math.round((processed / s.total_records) * 100).toLocaleString()}%)`
        : '';
      const status = s.complete ? 'complete' : s.stopped ? 'stopped' : 'in progress';
      console.log(
        `  ${pad(s.name)}${status}   processed: ${processed.toLocaleString()}${of}   dump: ${sizeMb}`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
