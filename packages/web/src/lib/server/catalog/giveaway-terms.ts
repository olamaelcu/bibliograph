/**
 * The closing date the AppView verified, and the record revision that stated it.
 *
 * A giveaway is a record in its author's repo, so `closesAt` is editable by the
 * account that owns it — including out of band, with `com.atproto.repo.putRecord`
 * and no app involved. `giveaway_terms` is what stops that from being a way to
 * move the end of a giveaway: the first sighting records the term and the CID
 * that stated it, and every later sighting must agree. The only way the stored
 * term moves forwards is `giveaway.extend`, which the author's own PDS
 * authenticates.
 *
 * A record that disagrees with the row is a *discrepancy*, not an edit: the
 * verification answers the stored term so the caller can rewrite the record back
 * to it, and the draw refuses to run on a disputed term.
 */

import type { EntityQueryable } from './entities.ts';
import { GIVEAWAY_EVENT_COLLECTION } from './giveaway.ts';

export const GIVEAWAY_TERMS_TABLE = 'giveaway_terms';

/** How the record's term relates to the verified one. */
export type TermRelation = 'earlier' | 'later' | 'invalid';

export type TermVerdict =
  | { ok: true; closesAt: string; cid: string }
  | { ok: false; reason: 'not-found' }
  | {
      ok: false;
      reason: 'mismatch';
      relation: TermRelation;
      /** The verified term: the one the record must be rewritten to. */
      stored: string;
      /** What the record currently says (empty when it cannot be parsed). */
      current: string;
    };

interface GiveawayRow {
  uri: string;
  did: string;
  cid: string;
  record: Record<string, unknown> | null;
}

interface TermRow {
  closes_at: Date | string;
  cid: string;
}

/** A stored timestamp as the ISO string the API answers. */
function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mismatch(relation: TermRelation, stored: string, current: string): TermVerdict {
  return { ok: false, reason: 'mismatch', relation, stored, current };
}

async function storedTerm(
  pool: EntityQueryable,
  giveawayUri: string
): Promise<TermRow | undefined> {
  const stored = await pool.query(
    `SELECT closes_at, cid FROM ${GIVEAWAY_TERMS_TABLE} WHERE giveaway = $1`,
    [giveawayUri]
  );
  return stored.rows[0] as TermRow | undefined;
}

/**
 * Verify one giveaway's closing date against the row, recording the first
 * sighting.
 *
 * The first sighting is trusted — there is nothing to compare it to — and it is
 * pinned with the CID that stated it, *unless* the term cannot be parsed, which is
 * never pinned: a giveaway with an unreadable end has no verified date, and
 * writing one down would make the repair path rewrite it to a fiction.
 *
 * Every sighting after that compares the record's term with the stored one and
 * answers the stored term when they disagree. A later sighting of a record whose
 * term is unchanged but whose CID moved (a rewrite of the title, say) is fine and
 * refreshes the audit trail: the invariant is the date, not the revision.
 */
export async function verifyGiveawayTerm(
  pool: EntityQueryable,
  giveawayUri: string
): Promise<TermVerdict> {
  const found = await pool.query(
    `SELECT uri, did, cid, record::jsonb AS record
       FROM happyview.happyview_records
      WHERE uri = $1 AND collection = $2`,
    [giveawayUri, GIVEAWAY_EVENT_COLLECTION]
  );
  const row = found.rows[0] as GiveawayRow | undefined;
  if (row === undefined) return { ok: false, reason: 'not-found' };

  const declared = row.record?.closesAt;
  const current = typeof declared === 'string' ? declared : '';
  const currentAt = Date.parse(current);

  const term = await storedTerm(pool, giveawayUri);
  if (term === undefined) {
    if (Number.isNaN(currentAt)) return mismatch('invalid', '', current);
    // The insert *is* the pin: whoever gets here first sets the term, and a
    // concurrent caller's insert is a no-op that falls through to the comparison.
    const pinned = await pool.query(
      `INSERT INTO ${GIVEAWAY_TERMS_TABLE} (giveaway, author_did, closes_at, cid, observed_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (giveaway) DO NOTHING
       RETURNING 1`,
      [giveawayUri, row.did, new Date(currentAt), row.cid]
    );
    if (pinned.rows.length > 0) {
      return { ok: true, closesAt: new Date(currentAt).toISOString(), cid: row.cid };
    }
    const raced = await storedTerm(pool, giveawayUri);
    if (raced === undefined) return { ok: false, reason: 'not-found' };
    return compare(raced, pool, row, giveawayUri, current, currentAt);
  }
  return compare(term, pool, row, giveawayUri, current, currentAt);
}

async function compare(
  term: TermRow,
  pool: EntityQueryable,
  row: GiveawayRow,
  giveawayUri: string,
  current: string,
  currentAt: number
): Promise<TermVerdict> {
  const storedAt = Date.parse(isoOf(term.closes_at));
  if (Number.isNaN(currentAt)) {
    return mismatch('invalid', new Date(storedAt).toISOString(), current);
  }
  if (currentAt !== storedAt) {
    return mismatch(
      currentAt < storedAt ? 'earlier' : 'later',
      new Date(storedAt).toISOString(),
      new Date(currentAt).toISOString()
    );
  }
  if (term.cid !== row.cid) {
    await pool.query(
      `UPDATE ${GIVEAWAY_TERMS_TABLE}
          SET cid = $2, observed_at = now()
        WHERE giveaway = $1`,
      [giveawayUri, row.cid]
    );
  }
  return { ok: true, closesAt: new Date(storedAt).toISOString(), cid: row.cid };
}

export type ExtensionVerdict =
  | { ok: true; closesAt: string }
  | { ok: false; reason: 'earlier' | 'not-found' };

/**
 * Authorise moving the stored term forwards, and move it.
 *
 * Called only after {@link verifyGiveawayTerm} has agreed with the record, so
 * "forwards" is measured from a term the record itself states. A request that is
 * not strictly later is refused: that is the whole protection, since everything
 * else about a giveaway may change without moving its end.
 */
export async function authorizeExtension(
  pool: EntityQueryable,
  giveawayUri: string,
  requested: string
): Promise<ExtensionVerdict> {
  const term = await storedTerm(pool, giveawayUri);
  if (term === undefined) return { ok: false, reason: 'not-found' };

  const storedAt = Date.parse(isoOf(term.closes_at));
  const next = Date.parse(requested);
  if (Number.isNaN(next) || next <= storedAt) return { ok: false, reason: 'earlier' };

  await pool.query(
    `UPDATE ${GIVEAWAY_TERMS_TABLE}
        SET closes_at = $2, observed_at = now()
      WHERE giveaway = $1`,
    [giveawayUri, new Date(next)]
  );
  return { ok: true, closesAt: new Date(next).toISOString() };
}

/** Whether a draw has already stored its winners for this giveaway. */
export async function isConcluded(
  pool: EntityQueryable,
  giveawayUri: string
): Promise<boolean> {
  const drawn = await pool.query('SELECT 1 FROM giveaway_draws WHERE giveaway = $1', [
    giveawayUri
  ]);
  return drawn.rows.length > 0;
}
