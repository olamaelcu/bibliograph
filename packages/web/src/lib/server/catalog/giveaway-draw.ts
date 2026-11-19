/**
 * `net.olamaelcu.livtet.biblio.giveaway.draw` — concluding a giveaway.
 *
 * Two properties make the draw trustworthy, and this module is where both live:
 *
 * **Deterministic given a seed.** The winner selection is a partial
 * Fisher–Yates over the canonical entrant order, driven by a SHA-256 counter
 * stream. Nothing reads the clock or the transaction id, so a stored seed plus a
 * stored entrant list always reproduces the winners.
 *
 * **Idempotent by insert.** The first call stores the seed and the winners it
 * drew; every later call answers that row instead of drawing again. The entrant
 * list is stored with it, so a stored draw stays replayable even after an entrant
 * deletes their record — recomputing from the index would change the winners,
 * which is exactly the outcome a giveaway must never produce.
 *
 * Idempotency is deliberately *not* folded into the entropy check above:
 * determinism alone is not idempotency, because the input set can change between
 * calls.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import { GIVEAWAY_ENTRY_COLLECTION, GIVEAWAY_EVENT_COLLECTION } from './giveaway.ts';

/** Only what `concludeGiveaway` uses: a pool it can check out a client from. */
export type DrawPool = Pick<Pool, 'connect'>;

export type DrawResult = {
  giveaway: string;
  drawnAt: string;
  seed: string;
  /** Distinct entrants the draw covered. */
  entries: number;
  winners: string[];
};

export type DrawOutcome =
  | { ok: true; value: DrawResult }
  | { ok: false; reason: 'not-found' };

const TWO_TO_THE_32 = 0x1_0000_0000;

/**
 * A stream of unbiased integers, `below(bound)` returning one in `[0, bound)`.
 *
 * The words come from `SHA-256(seed || counter)` so the sequence is a pure
 * function of the seed, and a word in the biased tail (`>= floor(2^32 / bound) *
 * bound`) is discarded rather than reduced — `word % bound` over the whole 32-bit
 * range would favour the low indexes by up to a word per bucket, which is exactly
 * the bias a draw must not have.
 */
function wordStream(seed: string): { below: (bound: number) => number } {
  let counter = 0;
  let buffer = createHash('sha256').update(seed).update(String(counter++)).digest();
  let offset = 0;

  const nextWord = (): number => {
    if (offset + 4 > buffer.length) {
      buffer = createHash('sha256').update(seed).update(String(counter++)).digest();
      offset = 0;
    }
    const word = buffer.readUInt32BE(offset);
    offset += 4;
    return word;
  };

  return {
    below(bound: number): number {
      const limit = Math.floor(TWO_TO_THE_32 / bound) * bound;
      for (;;) {
        const word = nextWord();
        if (word < limit) return word % bound;
      }
    }
  };
}

/**
 * Pick `quantity` winners from `entrantDids`, in draw order.
 *
 * The input is deduped first, so one reader with two entry records cannot win
 * twice and cannot shift the odds; the surviving order is the order `listEntries`
 * answers, which is what the author saw on the page.
 */
export function drawWinners(
  entrantDids: readonly string[],
  seed: string,
  quantity: number
): string[] {
  const unique = [...new Set(entrantDids)];
  const wanted = Math.trunc(quantity);
  if (unique.length === 0 || !Number.isFinite(wanted) || wanted < 1) return [];
  if (wanted >= unique.length) return unique;

  const { below } = wordStream(seed);
  const shuffled = [...unique];
  for (let i = 0; i < wanted; i += 1) {
    const j = i + below(shuffled.length - i);
    const held = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = held;
  }
  return shuffled.slice(0, wanted);
}

type DrawRow = {
  giveaway: string;
  author_did: string;
  seed: string;
  entrant_dids: unknown;
  winners: unknown;
  drawn_at: Date | string;
};

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function resultOf(row: DrawRow): DrawResult {
  const drawnAt = row.drawn_at instanceof Date ? row.drawn_at.toISOString() : String(row.drawn_at);
  return {
    giveaway: row.giveaway,
    drawnAt,
    seed: row.seed,
    entries: stringsOf(row.entrant_dids).length,
    winners: stringsOf(row.winners)
  };
}

/**
 * Conclude one giveaway, storing the draw the first time and replaying it after.
 *
 * Runs in one transaction: the giveaway row, the entrant list and the insert must
 * agree, or a concurrent second call could store a draw over a different entrant
 * set than the one it read.
 */
export async function concludeGiveaway(
  pool: DrawPool,
  giveawayUri: string
): Promise<DrawOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const giveaway = await client.query(
      `SELECT uri, did, record::jsonb AS record
         FROM happyview.happyview_records
        WHERE uri = $1 AND collection = $2`,
      [giveawayUri, GIVEAWAY_EVENT_COLLECTION]
    );
    const row = giveaway.rows[0] as
      | { uri: string; did: string; record: Record<string, unknown> | null }
      | undefined;
    if (row === undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not-found' };
    }

    const declared = row.record?.prizeQuantity;
    const quantity =
      typeof declared === 'number' && Number.isInteger(declared) && declared >= 1 ? declared : 1;

    // One DID per entrant, ordered by the entry that got them in first — the
    // order `listEntries` answers, so the author can follow the draw.
    const entrants = await client.query(
      `SELECT did
         FROM (SELECT e.did,
                      min(e.record::jsonb->>'createdAt') AS first_at,
                      min(e.uri) AS first_uri
                 FROM happyview.happyview_records e
                WHERE e.collection = $1
                  AND e.record::jsonb->'giveaway'->>'uri' = $2
                GROUP BY e.did) per_entrant
        ORDER BY first_at ASC, first_uri ASC`,
      [GIVEAWAY_ENTRY_COLLECTION, giveawayUri]
    );
    const entrantDids = (entrants.rows as { did: string }[]).map((entrant) => entrant.did);

    const seed = randomBytes(32).toString('hex');
    const winners = drawWinners(entrantDids, seed, quantity);

    const inserted = await client.query(
      `INSERT INTO giveaway_draws (giveaway, author_did, seed, entrant_dids, winners, drawn_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now())
       ON CONFLICT (giveaway) DO NOTHING
       RETURNING giveaway, author_did, seed, entrant_dids, winners, drawn_at`,
      [giveawayUri, row.did, seed, JSON.stringify(entrantDids), JSON.stringify(winners)]
    );

    let stored = inserted.rows[0] as DrawRow | undefined;
    if (stored === undefined) {
      // The insert was a no-op: another call concluded this giveaway first, so the
      // fresh seed is discarded and its row is the answer.
      const existing = await client.query(
        `SELECT giveaway, author_did, seed, entrant_dids, winners, drawn_at
           FROM giveaway_draws
          WHERE giveaway = $1`,
        [giveawayUri]
      );
      stored = existing.rows[0] as DrawRow | undefined;
    }

    await client.query('COMMIT');
    if (stored === undefined) {
      // Unreachable: the conflict can only be raised by a row, and the row is read
      // back inside the same transaction. Answer `not-found` rather than throw so a
      // caller never sees a 500 over a give-away state.
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, value: resultOf(stored) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
