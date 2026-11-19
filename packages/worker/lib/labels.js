/**
 * Label creation, signing and the two reads the labeler serves.
 *
 * Labels are the ATProto way to say something about an account other than its
 * own records (https://atproto.com/specs/label). Bibliograph issues exactly one
 * value, `known-author`, when a librarian approves a contributor claim; a
 * revocation is the same label negated.
 *
 * ## Signing
 *
 * The signature covers the DAG-CBOR encoding of the label object without `sig`.
 * `@atproto/crypto`'s `sign()` hashes its input with SHA-256 and then signs that
 * digest, and its `verifySignature()` hashes and verifies the same way, so the
 * payload is signed and verified as bytes — never pre-hashed here, which would
 * hash twice and produce a signature no standard verifier accepts.
 *
 * @ipld/dag-cbor sorts map keys by length then bytewise, which for this object
 * is exactly DRISL's ordering rule: every key is three ASCII characters, so the
 * bytes are sorted outright. Nothing here is a float, a bigint or a CID.
 *
 * ## Delivery
 *
 * `label_outbox` is the queue (`labels.emit` fills `labeler_labels` from it) and
 * `labeler_labels` is the append-only stream `queryLabels`/`subscribeLabels`
 * serve. Both are in tables, so a restart loses nothing: the stream is its own
 * log and a cursor is a `seq` in it.
 */

import { createHash } from 'node:crypto';

import * as dagCbor from '@ipld/dag-cbor';

/** The one label value this deployment issues. */
export const LABEL_VALUE_KNOWN_AUTHOR = 'known-author';

export const LABEL_VERSION = 1;
export const MAX_LABEL_ATTEMPTS = 10;
const MAX_BACKOFF_SECONDS = 60 * 60;
const MAX_ERROR_LENGTH = 2000;

export class FutureCursorError extends Error {
  constructor(message = 'cursor is in the future') {
    super(message);
    this.name = 'FutureCursorError';
  }
}

function truncate(message) {
  return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH)}…`;
}

/**
 * A label timestamp as the RFC 3339 string the signature covers.
 *
 * `labeler_labels.cts` comes back from pg as a `Date`, so a label read from the
 * table must re-encode to the same bytes it was signed as — and a `Date` in the
 * payload is rejected by the encoder outright.
 */
function isoString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * The bytes a label's signature covers: `ver`, `src`, `uri`, `val`, `cts`, and
 * whichever of `neg`, `cid`, `exp` the label carries. `undefined` fields are
 * dropped rather than encoded as null.
 */
export function labelSigningPayload(label) {
  const payload = {
    ver: LABEL_VERSION,
    src: label.src,
    uri: label.uri,
    val: label.val,
    cts: isoString(label.cts)
  };
  if (label.neg === true) payload.neg = true;
  if (label.cid !== undefined && label.cid !== null) payload.cid = label.cid;
  if (label.exp !== undefined && label.exp !== null) payload.exp = isoString(label.exp);
  return dagCbor.encode(payload);
}

/** The SHA-256 digest of a label's signing payload, hex. Diagnostics and tests. */
export function labelPayloadDigest(label) {
  return createHash('sha256').update(labelSigningPayload(label)).digest('hex');
}

/**
 * Sign one label. Returns the full label object (the payload plus `sig`), with
 * `sig` as raw bytes — the JSON form is `encodeLabel`'s job.
 */
export async function signLabel(keypair, { src, uri, val, cts, neg, cid, exp }) {
  const label = { src, uri, val, cts };
  if (neg === true) label.neg = true;
  if (cid !== undefined && cid !== null) label.cid = cid;
  if (exp !== undefined && exp !== null) label.exp = exp;
  const sig = await keypair.sign(labelSigningPayload(label));
  return { ...label, sig };
}

/**
 * The JSON form of a label (`com.atproto.label.defs#label`): `sig` is the
 * lexicon's `bytes`, which JSON can only carry as `{ "$bytes": base64 }`.
 */
export function encodeLabel(label) {
  const encoded = {
    ver: LABEL_VERSION,
    src: label.src,
    uri: label.uri,
    val: label.val,
    cts: new Date(label.cts).toISOString(),
    sig: { $bytes: Buffer.from(label.sig).toString('base64') }
  };
  if (label.cid !== null && label.cid !== undefined) encoded.cid = label.cid;
  if (label.neg === true) encoded.neg = true;
  if (label.exp !== null && label.exp !== undefined) {
    encoded.exp = new Date(label.exp).toISOString();
  }
  return encoded;
}

/**
 * Drain `label_outbox` into `labeler_labels`.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED` inside the same transaction as the
 * inserts, so several workers may run this without signing a row twice and a
 * crash mid-batch rolls the whole claim back instead of parking it. Signing is
 * sub-millisecond, so the locks are held for microseconds of real work.
 *
 * A row that cannot be signed is charged an attempt and backed off with the same
 * policy `pds-publish` uses: `60s * 2^attempts`, capped at an hour, and parked
 * after `MAX_LABEL_ATTEMPTS`. A savepoint keeps one bad row from aborting its
 * neighbours' inserts.
 *
 * Returns `{ emitted, failed }`.
 */
export async function emitLabels({ pool, keypair, src, logger = console, limit = 100 }) {
  const client = await pool.connect();
  let emitted = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `WITH candidates AS (
         SELECT id
           FROM label_outbox
          WHERE next_at <= now()
            AND attempts < $2
          ORDER BY next_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE label_outbox o
          SET claimed_at = now()
         FROM candidates c
        WHERE o.id = c.id
        RETURNING o.id, o.uri, o.val, o.neg, o.attempts`,
      [limit, MAX_LABEL_ATTEMPTS]
    );

    for (const row of claimed.rows) {
      try {
        await client.query('SAVEPOINT label_row');
        const label = await signLabel(keypair, {
          src,
          uri: row.uri,
          val: row.val,
          cts: new Date().toISOString(),
          neg: row.neg
        });
        await client.query(
          `INSERT INTO labeler_labels (src, uri, cid, val, neg, cts, exp, sig)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            label.src,
            label.uri,
            label.cid ?? null,
            label.val,
            label.neg === true,
            label.cts,
            label.exp ?? null,
            Buffer.from(label.sig)
          ]
        );
        await client.query('DELETE FROM label_outbox WHERE id = $1', [row.id]);
        await client.query('RELEASE SAVEPOINT label_row');
        emitted += 1;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT label_row');
        const attempts = Number(row.attempts) + 1;
        const delay = Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.min(attempts, 10));
        await client.query(
          `UPDATE label_outbox
              SET attempts = $2,
                  claimed_at = NULL,
                  last_error = $3,
                  next_at = now() + make_interval(secs => $4)
            WHERE id = $1`,
          [row.id, attempts, truncate(error?.message ?? String(error)), delay]
        );
        failed += 1;
        logger.warn?.(
          `labels.emit: ${row.uri} ${row.val} failed (attempt ${attempts}/${MAX_LABEL_ATTEMPTS}, ` +
            `retry in ${delay}s): ${error?.message ?? String(error)}`
        );
      }
    }

    await client.query('COMMIT');
    return { emitted, failed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function uriPatternClause() {
  // `uriPatterns` entries are exact URIs or a prefix ending in `*`.
  return `(
    $1::text[] = '{}'::text[]
    OR EXISTS (
      SELECT 1
        FROM unnest($1::text[]) AS p(pattern)
       WHERE CASE
               WHEN right(p.pattern, 1) = '*'
                 THEN starts_with(l.uri, left(p.pattern, length(p.pattern) - 1))
               ELSE l.uri = p.pattern
             END
    )
  )`;
}

/**
 * One page of the label stream, newest state only.
 *
 * Rows are read in `seq` order (that is what a cursor means), then collapsed per
 * `(src, uri, val)` to the newest `cts`; a pair whose newest row is a negation is
 * dropped, because a negated label is not hydrated. `limit` bounds the rows read,
 * so a page may carry fewer labels than that after collapsing.
 *
 * Returns `{ labels, cursor }`; `cursor` is present only when a full page was
 * read and more rows remain.
 */
export async function queryLabels(
  pool,
  { uriPatterns = [], sources = [], limit = 50, cursor } = {}
) {
  const after = cursor === undefined || cursor === null || cursor === '' ? null : Number(cursor);
  if (after !== null && !Number.isInteger(after)) {
    throw new FutureCursorError('cursor must be an integer');
  }
  if (after !== null) {
    const head = await pool.query('SELECT COALESCE(max(seq), 0) AS max FROM labeler_labels');
    const max = Number(head.rows[0]?.max ?? 0);
    if (after > max) throw new FutureCursorError();
  }

  const result = await pool.query(
    `SELECT l.seq, l.src, l.uri, l.cid, l.val, l.neg, l.cts, l.exp, l.sig
       FROM labeler_labels l
      WHERE ${uriPatternClause()}
        AND ($2::text[] = '{}'::text[] OR l.src = ANY($2::text[]))
        AND ($3::bigint IS NULL OR l.seq > $3)
      ORDER BY l.seq
      LIMIT $4`,
    [uriPatterns, sources, after, limit + 1]
  );

  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;

  // `seq` ascending, so the newest row for a pair is the last one seen.
  const byPair = new Map();
  for (const row of rows) {
    byPair.set(`${row.src}\u0000${row.uri}\u0000${row.val}`, row);
  }
  const labels = [...byPair.values()]
    .filter((row) => row.neg !== true)
    .sort((left, right) => Number(left.seq) - Number(right.seq));

  return {
    labels,
    cursor: hasMore && rows.length > 0 ? String(rows[rows.length - 1].seq) : undefined
  };
}
