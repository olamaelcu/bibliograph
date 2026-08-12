/**
 * Author-dump upsert.
 *
 * For each contributor in a batch we apply a tiered lookup:
 *   1. OL key match  → merge altNames + identifiers; fill bio if empty.
 *   2. Case-insensitive name match → add the OL key identifier.
 *   3. No match → INSERT a new contributor with a deterministic at-uri.
 *
 * The whole batch runs in a single SQLite transaction so a partial failure
 * rolls back the batch instead of leaving half-written rows.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { COLLECTIONS, makeRecordUri } from '../../records.js';
import { generateRkey } from '../../rkey.js';
import { logger } from '../../logger.js';

export interface ContributorRecord {
  name: string;
  altNames: string[];
  bio?: string;
  identifiers: Array<{ type: string; value: string }>;
}

export interface UpsertSummary {
  imported: number;
  skipped: number;
  failed: number;
  notFound: number;
}

export function upsertAuthorBatch(
  db: BetterSQLite3Database<typeof schema>,
  records: ContributorRecord[],
): UpsertSummary {
  const summary: UpsertSummary = { imported: 0, skipped: 0, failed: 0, notFound: 0 };
  const seenOlKeys = new Set<string>();
  const serviceDid = process.env.ATP_SERVICE_DID || 'did:web:localhost';

  db.transaction(() => {
    for (const record of records) {
      const olIdentifier = record.identifiers.find((i) => i.type === 'openlibrary');
      const olKey = olIdentifier?.value;
      if (!olKey) {
        summary.failed += 1;
        continue;
      }
      if (seenOlKeys.has(olKey)) {
        summary.skipped += 1;
        continue;
      }
      seenOlKeys.add(olKey);

      try {
        const byKey = findByOpenLibraryKey(db, olKey);
        if (byKey) {
          applyKeyMatchUpdate(db, byKey, record);
          continue;
        }

        const byName = findByCaseInsensitiveName(db, record.name);
        if (byName) {
          applyNameMatchUpdate(db, byName, record.identifiers);
          continue;
        }

        insertNewContributor(db, serviceDid, record);
        summary.imported += 1;
      } catch (err) {
        logger.error({ err, name: record.name }, 'upsertAuthorBatch: per-record failure');
        summary.failed += 1;
      }
    }
  });

  return summary;
}

function findByOpenLibraryKey(
  db: BetterSQLite3Database<typeof schema>,
  olKey: string,
): schema.Contributor | undefined {
  return db
    .select()
    .from(schema.contributors)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${schema.contributors.identifiers}) je WHERE json_extract(je.value, '$.type') = 'openlibrary' AND json_extract(je.value, '$.value') = ${olKey})`,
    )
    .get();
}

function findByCaseInsensitiveName(
  db: BetterSQLite3Database<typeof schema>,
  name: string,
): schema.Contributor | undefined {
  return db
    .select()
    .from(schema.contributors)
    .where(sql`LOWER(${schema.contributors.name}) = LOWER(${name})`)
    .get();
}

function applyKeyMatchUpdate(
  db: BetterSQLite3Database<typeof schema>,
  existing: schema.Contributor,
  incoming: ContributorRecord,
): void {
  const existingIdents = readJsonField<Array<{ type: string; value: string }>>(existing.identifiers) ?? [];
  const existingAltNames = readJsonField<string[]>(existing.altNames) ?? [];
  const mergedIdents = mergeIdentifiers(existingIdents, incoming.identifiers);
  const mergedAltNames = mergeAltNames(existingAltNames, incoming.altNames);
  const newBio = existing.bio ?? incoming.bio ?? null;

  db.update(schema.contributors)
    .set({
      altNames: mergedAltNames,
      identifiers: mergedIdents,
      bio: newBio,
    })
    .where(eq(schema.contributors.uri, existing.uri))
    .run();
}

function applyNameMatchUpdate(
  db: BetterSQLite3Database<typeof schema>,
  existing: schema.Contributor,
  incomingIdents: Array<{ type: string; value: string }>,
): void {
  const existingIdents = readJsonField<Array<{ type: string; value: string }>>(existing.identifiers) ?? [];
  const mergedIdents = mergeIdentifiers(existingIdents, incomingIdents);
  db.update(schema.contributors)
    .set({ identifiers: mergedIdents })
    .where(eq(schema.contributors.uri, existing.uri))
    .run();
}

function insertNewContributor(
  db: BetterSQLite3Database<typeof schema>,
  serviceDid: string,
  record: ContributorRecord,
): void {
  const now = new Date().toISOString();
  const uri = makeRecordUri(serviceDid, COLLECTIONS.contributor, generateRkey());
  db.insert(schema.contributors)
    .values({
      uri,
      did: serviceDid,
      name: record.name,
      altNames: record.altNames,
      images: [],
      identifiers: record.identifiers,
      bio: record.bio ?? null,
      createdAt: now,
    })
    .run();
}

function mergeIdentifiers(
  existing: Array<{ type: string; value: string }>,
  incoming: Array<{ type: string; value: string }>,
): Array<{ type: string; value: string }> {
  const seen = new Set<string>();
  const out: Array<{ type: string; value: string }> = [];
  for (const id of existing) {
    const key = `${id.type}|${id.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(id);
    }
  }
  for (const id of incoming) {
    const key = `${id.type}|${id.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

function mergeAltNames(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of existing) {
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  for (const name of incoming) {
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

function readJsonField<T>(value: T | string | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value;
}
