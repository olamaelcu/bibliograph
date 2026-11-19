/**
 * Fixtures shared by the worker suites that need HappyView's record index.
 *
 * HappyView owns `happyview.happyview_records`; the throwaway database the suite
 * runs against has only the catalog schema. The claim reads are the only thing
 * that needs the index, so this creates it with HappyView's own column shapes
 * (text `record`, text `created_at`) — the same shapes `0003-feed-read.sql`
 * documents as a dependency, and the reason the claim queries cast
 * `record::jsonb`.
 *
 * Not a `*.test.js` file: `vitest.config.js` includes only `test/*.test.js`, so
 * this directory is never collected as a suite.
 */

/**
 * Create HappyView's record table (and its schema) when it is absent.
 *
 * Vitest runs files concurrently against one database, so two suites can enter
 * this at the same instant. `IF NOT EXISTS` is checked before the catalogue
 * write, which makes a concurrent second create fail with `duplicate_schema` /
 * `duplicate_table` rather than no-op — swallowed here, because the object it
 * reports already existing is exactly the outcome wanted.
 */
export async function ensureHappyviewRecords(pool) {
  await pool.query(`
    DO $fixture$
    BEGIN
      CREATE SCHEMA IF NOT EXISTS happyview;
      CREATE TABLE IF NOT EXISTS happyview.happyview_records (
        uri        text PRIMARY KEY,
        did        text NOT NULL,
        collection text NOT NULL,
        rkey       text NOT NULL,
        record     text NOT NULL,
        cid        text NOT NULL,
        indexed_at text,
        created_at text NOT NULL
      );
    EXCEPTION
      WHEN duplicate_schema OR duplicate_table OR duplicate_object THEN NULL;
    END
    $fixture$
  `);
}

/** The claim record URI an account writes; rkey `self` is the whole rule. */
export function claimUriFor(did) {
  return `at://${did}/net.olamaelcu.livtet.biblio.contributorClaim/self`;
}

/** Insert the claim record HappyView would have indexed for an account. */
export async function indexClaim(pool, did, contributorUri, message = 'I am this person.') {
  await pool.query(
    `INSERT INTO happyview.happyview_records
       (uri, did, collection, rkey, record, cid, created_at)
     VALUES ($1, $2, $3, 'self', $4, 'bafyclaim', $5)
     ON CONFLICT (uri) DO UPDATE SET record = EXCLUDED.record`,
    [
      claimUriFor(did),
      did,
      'net.olamaelcu.livtet.biblio.contributorClaim',
      JSON.stringify({
        contributor: contributorUri,
        message,
        createdAt: '2026-02-01T00:00:00.000Z'
      }),
      '2026-02-01T00:00:00.000Z'
    ]
  );
}
