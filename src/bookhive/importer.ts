import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, sql, like } from 'drizzle-orm';
import { encode } from '@atcute/cbor';
import { fromDigest, CODEC_DCBOR, toString as cidToString } from '@atcute/cid';
import { createHash } from 'node:crypto';
import * as schema from '../db/schema.js';
import { computeDeduplicationHash } from '../dedup.js';
import { generateRkey } from '../rkey.js';
import { COLLECTIONS, makeRecordUri } from '../records.js';
import type { BookhiveMappedBook } from './mapper.js';
import { logger } from '../logger.js';

function getServiceDid(): string {
  return process.env.ATP_SERVICE_DID || 'did:web:localhost';
}

export interface ImportResult {
  action: 'inserted' | 'updated' | 'skipped' | 'failed';
}

function recordCid(record: Record<string, unknown>): string {
  const cborBytes = encode(record as never);
  const sha = createHash('sha256').update(cborBytes).digest();
  return cidToString(fromDigest(CODEC_DCBOR, sha));
}

interface ContributorRow {
  uri: string;
  cid: string;
  name: string;
}

function findOrComputeContributor(
  db: BetterSQLite3Database<typeof schema>,
  name: string,
): ContributorRow {
  const existing = db
    .select()
    .from(schema.contributors)
    .where(sql`LOWER(${schema.contributors.name}) = LOWER(${name})`)
    .get();
  if (existing) {
    const cid = recordCid({
      $type: COLLECTIONS.contributor,
      name: existing.name,
      createdAt: existing.createdAt,
    });
    return { uri: existing.uri, cid, name: existing.name };
  }
  const rkey = generateRkey();
  const uri = makeRecordUri(getServiceDid(), COLLECTIONS.contributor, rkey);
  const createdAt = new Date().toISOString();
  const cid = recordCid({
    $type: COLLECTIONS.contributor,
    name,
    createdAt,
  });
  db.insert(schema.contributors)
    .values({
      uri,
      did: getServiceDid(),
      name,
      altNames: [],
      images: [],
      identifiers: [],
      createdAt,
    })
    .run();
  return { uri, cid, name };
}

function loadAuthorRole(db: BetterSQLite3Database<typeof schema>): {
  uri: string;
  cid: string;
} {
  const row = db
    .select()
    .from(schema.contributorTypes)
    .where(eq(schema.contributorTypes.name, 'author'))
    .get();
  if (!row) {
    throw new Error(
      "author contributor type not found; ensure bootstrapContributorTypes() ran at startup",
    );
  }
  const cid = recordCid({
    $type: COLLECTIONS.contributorType,
    name: row.name,
    createdAt: row.createdAt,
  });
  return { uri: row.uri, cid };
}

function mergeIdentifiers(
  existing: Array<{ type: string; value: string }> | null | undefined,
  incoming: Array<{ type: string; value: string }>,
): Array<{ type: string; value: string }> {
  const seen = new Set<string>();
  const out: Array<{ type: string; value: string }> = [];
  for (const id of existing ?? []) {
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

export function importBookhiveCatalogBook(
  db: BetterSQLite3Database<typeof schema>,
  mapped: BookhiveMappedBook,
): ImportResult {
  try {
    return db.transaction((tx) => {
      // 1. Resolve/create contributors and the author role strongRef
      const contribs: Array<{
        contributor: { uri: string; cid: string };
        role: { uri: string; cid: string };
        order: number;
      }> = [];
      for (const c of mapped.contributors) {
        const contributor = findOrComputeContributor(tx as never, c.name);
        const role = loadAuthorRole(tx as never);
        contribs.push({ contributor, role, order: c.order });
      }
      const role = loadAuthorRole(tx as never);

      // 2. Look up any existing row for merge-data
      const existing = tx
        .select()
        .from(schema.books)
        .where(eq(schema.books.uri, mapped.uri))
        .get();

      const mergedIdentifiers = mergeIdentifiers(
        (existing?.identifiers as Array<{ type: string; value: string }> | undefined) ?? null,
        mapped.identifiers,
      );

      const now = new Date().toISOString();
      const dedupHash = computeDeduplicationHash(
        mapped.title,
        mapped.author,
        undefined,
      );

      const inlineContributors = contribs.map((c) => ({
        contributor: { uri: c.contributor.uri, cid: c.contributor.cid },
        role: { uri: c.role.uri, cid: c.role.cid },
        order: c.order,
      }));

      const data = {
        uri: mapped.uri,
        did: mapped.did,
        title: mapped.title,
        author: mapped.author,
        isbn: mapped.isbn ?? null,
        description: mapped.description ?? null,
        coverUrl: mapped.coverUrl ?? null,
        categories: mapped.categories,
        identifiers: mergedIdentifiers,
        contributors: inlineContributors,
        status: 'active' as const,
        deduplicationHash: dedupHash,
        updatedAt: now,
        ...(existing
          ? {}
          : { createdAt: now }),
      };

      if (existing) {
        tx.update(schema.books).set(data).where(eq(schema.books.uri, mapped.uri)).run();
      } else {
        tx.insert(schema.books).values({ ...data, createdAt: now }).run();
      }

      // 3. Refresh book_contributors join rows for this book
      tx.delete(schema.bookContributors).where(eq(schema.bookContributors.bookUri, mapped.uri)).run();
      for (const c of contribs) {
        tx.insert(schema.bookContributors)
          .values({
            bookUri: mapped.uri,
            contributorUri: c.contributor.uri,
            contributorCid: c.contributor.cid,
            roleUri: c.role.uri,
            roleCid: c.role.cid,
            ordering: c.order,
          })
          .run();
      }

      return existing ? { action: 'updated' as const } : { action: 'inserted' as const };
    });
  } catch (err) {
    logger.error({ err, uri: mapped.uri }, 'bookhive import: insert failed');
    return { action: 'failed' as const };
  }
}
