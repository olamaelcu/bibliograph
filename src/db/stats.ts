#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dbPath = resolve(process.env.DB_PATH);

if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}; run 'mise run migrate' or set DB_PATH`);
  process.exit(1);
}

const sqlite = new Database(dbPath, { readonly: true });

function table(name: string): number {
  try {
    return (sqlite.prepare(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c;
  } catch {
    return -1;
  }
}

function byStatus(tableName: string): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const row of sqlite
      .prepare(`SELECT release_status s, COUNT(*) c FROM "${tableName}" GROUP BY release_status`)
      .all() as Array<{ s: string; c: number }>) {
      out[row.s] = row.c;
    }
  } catch {
    /* table has no release_status */
  }
  return out;
}

function pad(label: string, width = 34): string {
  return label.padEnd(width);
}

console.log(`Database: ${dbPath}`);
console.log('');

const catalog: Array<[string, string]> = [
  ['books', 'books'],
  ['works', 'works'],
  ['contributors', 'contributors'],
  ['genres', 'genres'],
  ['contributor_roles', 'contributor_roles'],
  ['formats', 'formats'],
  ['shelves', 'shelves'],
  ['reviews', 'reviews'],
];

console.log('Catalog counts:');
for (const [label, t] of catalog) {
  const n = table(t);
  console.log(`  ${pad(label)}${n < 0 ? '(no table)' : n.toLocaleString()}`);
}
console.log('');

console.log('Release status:');
for (const [label, t] of catalog) {
  const st = byStatus(t);
  if (Object.keys(st).length === 0) continue;
  const parts = ['staged', 'released', 'rejected']
    .filter((s) => st[s] !== undefined)
    .map((s) => `${s}: ${st[s].toLocaleString()}`);
  console.log(`  ${pad(label)}${parts.join('   ')}`);
}
console.log('');

const openIssues = (sqlite.prepare("SELECT COUNT(*) c FROM import_issues WHERE status = 'open'").get() as { c: number }).c;
console.log(`Open import issues: ${openIssues.toLocaleString()}`);

const states = sqlite
  .prepare('SELECT name, complete, total_processed, total_records, file_size FROM backfill_state ORDER BY name')
  .all() as Array<{
  name: string;
  complete: number;
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
    console.log(
      `  ${pad(s.name)}${s.complete ? 'complete' : 'in progress'}   processed: ${processed.toLocaleString()}${of}   dump: ${sizeMb}`,
    );
  }
}

sqlite.close();
