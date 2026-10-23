// Labeler core: sign, persist, and select ATProto labels.
//
// A label is a self-authenticating object. Per the spec, the signature covers the
// DRISL/dag-cbor encoding of the schema fields only — `ver` included, `sig` and
// any `$type` excluded — hashed with SHA-256, with the raw hash bytes signed by
// the `#atproto_label` key in the labeler's DID document.
//
// Signatures are persisted next to the label because the signing key can rotate:
// stored signatures are what let old labels keep being served without pretending
// the new key signed them.

import { cborEncode } from '@atproto/lex-cbor';
import type { LexValue } from '@atproto/lex-cbor';
import { Secp256k1Keypair, sha256 } from '@atproto/crypto';
import { and, desc, eq, gt, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index';
import { labels } from '../db/schema';
import type { LabelRow } from '../db/schema';
import type { DbExecutor } from '../stats';
import { PUBLISHER_DID } from '../did';

/** The labeler identity. Same `did:web` as the publisher, per deployment choice. */
export const LABELER_DID = PUBLISHER_DID;

export const LIBRARIAN_LABEL = 'librarian';

/** Cap on rows considered when serving a query; keeps memory bounded. */
const MAX_SCAN = 10_000;

export interface LabelInput {
  uri: string;
  val: string;
  cid?: string;
  neg?: boolean;
  cts?: Date;
  exp?: Date;
}

export interface LabelFields {
  ver: 1;
  src: string;
  uri: string;
  val: string;
  cts: string;
  cid?: string;
  neg?: boolean;
  exp?: string;
}

/**
 * The exact object that gets signed. Field set is fixed by the spec: adding
 * anything else would make signatures unverifiable by other implementations.
 */
export function labelSigningFields(input: {
  src: string;
  uri: string;
  val: string;
  cts: Date;
  cid?: string;
  neg?: boolean;
  exp?: Date;
}): LabelFields {
  const fields: LabelFields = {
    ver: 1,
    src: input.src,
    uri: input.uri,
    val: input.val,
    cts: input.cts.toISOString(),
  };
  if (input.cid) fields.cid = input.cid;
  if (input.neg) fields.neg = true;
  if (input.exp) fields.exp = input.exp.toISOString();
  return fields;
}

let keyPromise: Promise<Secp256k1Keypair> | undefined;

/** Load the label signing key, or throw when the labeler is not configured. */
export function getLabelSigningKey(): Promise<Secp256k1Keypair> {
  keyPromise ??= (async () => {
    const hex = process.env.ATP_LABEL_SIGNING_KEY;
    if (!hex) {
      throw new Error(
        'ATP_LABEL_SIGNING_KEY is not set; the labeler cannot sign labels. ' +
          'Generate one with scripts/gen-label-key.ts.',
      );
    }
    // Allows reusing the repo signing key locally without copying it into a
    // second variable; production should keep the two keys distinct.
    const keyHex = hex === 'same-as-repo' ? process.env.ATP_SIGNING_KEY : hex;
    if (!keyHex) throw new Error('ATP_LABEL_SIGNING_KEY is "same-as-repo" but ATP_SIGNING_KEY is unset');
    return Secp256k1Keypair.import(keyHex, { exportable: false });
  })();
  return keyPromise;
}

/** Sign the canonical label encoding. Returns the raw signature bytes. */
export async function signLabelFields(fields: LabelFields): Promise<Uint8Array> {
  const key = await getLabelSigningKey();
  const encoded = cborEncode(fields as unknown as LexValue);
  return key.sign(await sha256(encoded));
}

/**
 * Issue a label. Persists the signed label and returns the stored row, whose
 * `seq` is its position in the public stream.
 */
export async function emitLabel(
  input: LabelInput,
  db: DbExecutor = defaultDb,
): Promise<LabelRow> {
  const cts = input.cts ?? new Date();
  const fields = labelSigningFields({
    src: LABELER_DID,
    uri: input.uri,
    val: input.val,
    cts,
    cid: input.cid,
    neg: input.neg,
    exp: input.exp,
  });
  const sig = await signLabelFields(fields);

  const [row] = await db
    .insert(labels)
    .values({
      src: LABELER_DID,
      uri: input.uri,
      val: input.val,
      cid: input.cid ?? null,
      neg: input.neg ?? false,
      cts,
      exp: input.exp ?? null,
      sig: Buffer.from(sig).toString('base64'),
    })
    .returning();
  if (!row) throw new Error('label insert returned no row');
  return row;
}

/** Retract a previously issued label (spec: same src/uri/val with `neg: true`). */
export async function revokeLabel(
  uri: string,
  val: string,
  db: DbExecutor = defaultDb,
): Promise<LabelRow> {
  return emitLabel({ uri, val, neg: true }, db);
}

/**
 * The label currently in force for (uri, val), or null when there is none.
 * Newest by `cts`, ties broken by `seq` so two labels in the same millisecond
 * still resolve deterministically.
 */
export async function activeLabel(
  uri: string,
  val: string,
  db: DbExecutor = defaultDb,
): Promise<LabelRow | null> {
  const [row] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.uri, uri), eq(labels.val, val)))
    .orderBy(desc(labels.cts), desc(labels.seq))
    .limit(1);
  if (!row) return null;
  if (row.neg) return null;
  if (row.exp && row.exp.getTime() <= Date.now()) return null;
  return row;
}

/** Whether an account currently holds the `librarian` label. */
export async function isLibrarian(did: string, db: DbExecutor = defaultDb): Promise<boolean> {
  return (await activeLabel(did, LIBRARIAN_LABEL, db)) !== null;
}

export interface QueryLabelsInput {
  uriPatterns: string[];
  sources?: string[];
  cursor?: number;
  limit?: number;
}

/** Turn an atproto URI pattern into a SQL predicate (`_` suffix = prefix match). */
function patternPredicate(pattern: string) {
  if (pattern.endsWith('_')) {
    const prefix = pattern.slice(0, -1).replaceAll('%', '\\%').replaceAll('_', '\\_');
    return sql`${labels.uri} like ${`${prefix}%`}`;
  }
  return eq(labels.uri, pattern);
}

export interface QueryLabelsResult {
  labels: LabelRow[];
  cursor?: number;
}

/**
 * Serve labels for `com.atproto.label.queryLabels`.
 *
 * Only the label currently in force is returned: the newest row per (uri, val),
 * with negated and expired labels omitted. Pagination walks `seq` ascending and
 * the returned cursor is the last `seq` served, so a client that keeps calling
 * backfills the whole set without seeing duplicates.
 */
export async function queryLabels(
  input: QueryLabelsInput,
  db: DbExecutor = defaultDb,
): Promise<QueryLabelsResult> {
  if (input.uriPatterns.length === 0) return { labels: [] };

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 250);
  const patternWhere = or(...input.uriPatterns.map(patternPredicate));
  const conditions = [patternWhere];
  if (input.sources && input.sources.length > 0) {
    conditions.push(or(...input.sources.map((s) => eq(labels.src, s))));
  }

  const rows = await db
    .select()
    .from(labels)
    .where(and(...conditions))
    .orderBy(labels.uri, labels.val, desc(labels.cts), desc(labels.seq))
    .limit(MAX_SCAN);

  // Keep the newest row per (uri, val), then drop negated/expired ones.
  const newest = new Map<string, LabelRow>();
  for (const row of rows) {
    const key = `${row.uri}\u0000${row.val}`;
    if (!newest.has(key)) newest.set(key, row);
  }
  const now = Date.now();
  const active = [...newest.values()].filter(
    (row) => !row.neg && !(row.exp && row.exp.getTime() <= now),
  );

  active.sort((a, b) => a.seq - b.seq);
  const afterCursor = input.cursor ? active.filter((row) => row.seq > input.cursor!) : active;
  const page = afterCursor.slice(0, limit);

  return {
    labels: page,
    cursor: page.length === limit ? page[page.length - 1]?.seq : undefined,
  };
}

/** Rows for the public stream, ordered by `seq`, used by subscribeLabels. */
export async function labelsSince(
  cursor: number,
  limit: number,
  db: DbExecutor = defaultDb,
): Promise<LabelRow[]> {
  // The stream is an event log, not a view: expired labels still happened, and
  // consumers apply expiry themselves. Only negations matter structurally, and
  // they are delivered like any other event.
  return db
    .select()
    .from(labels)
    .where(gt(labels.seq, cursor))
    .orderBy(labels.seq)
    .limit(limit);
}

/** Latest stream position, for the `OutdatedCursor` check. */
export async function maxSeq(db: DbExecutor = defaultDb): Promise<number> {
  const [row] = await db.select({ seq: sql<number>`coalesce(max(${labels.seq}), 0)` }).from(labels);
  return Number(row?.seq ?? 0);
}

/** Serialize a stored label for JSON transport (signature as `$bytes`). */
export function labelToJson(row: LabelRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ver: 1,
    src: row.src,
    uri: row.uri,
    val: row.val,
    cts: row.cts.toISOString(),
    sig: { $bytes: row.sig },
  };
  if (row.cid) out.cid = row.cid;
  if (row.neg) out.neg = true;
  if (row.exp) out.exp = row.exp.toISOString();
  return out;
}
