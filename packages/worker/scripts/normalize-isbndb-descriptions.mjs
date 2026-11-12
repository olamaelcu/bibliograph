#!/usr/bin/env node
// One-off backfill for ISBNdb synopses stored before the provider learned to
// unwrap `"Body."--Back cover.` style citations.
//
// Dry run (default): reports matching editions and a short before/after sample.
//   node scripts/normalize-isbndb-descriptions.mjs
//
// Apply: updates only descriptions whose normalized form differs. The editions
// trigger queues `pds_outbox` rows, so `pds-publish` republishes them; this
// script never talks to the PDS itself. Re-running is safe: unchanged rows are
// left alone.
//   node scripts/normalize-isbndb-descriptions.mjs --apply
import pg from 'pg';

import { cleanIsbndbSynopsis } from '../lib/providers/isbndb.js';

const APPLY = process.argv.includes('--apply');
const SAMPLE_SIZE = 5;
const PREVIEW_LENGTH = 80;

function preview(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  const shortened =
    text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 3)}...` : text;
  return JSON.stringify(shortened);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('normalize-isbndb-descriptions: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT uri, description
         FROM editions
        WHERE description LIKE '"%' OR description LIKE '“%'
        ORDER BY uri`
    );

    const changes = [];
    let unchanged = 0;
    for (const row of result.rows) {
      const cleaned = cleanIsbndbSynopsis(row.description);
      // `undefined` means the normalized value is empty; keep the stored text
      // rather than nulling a description the provider did not empty.
      if (cleaned !== undefined && cleaned !== row.description) {
        changes.push({ uri: row.uri, before: row.description, after: cleaned });
      } else {
        unchanged += 1;
      }
    }

    console.log(
      `normalize-isbndb-descriptions: ${result.rowCount} edition(s) start with a quote; ` +
        `${changes.length} ${APPLY ? 'changed' : 'would change'}, ${unchanged} unchanged.`
    );
    for (const change of changes.slice(0, SAMPLE_SIZE)) {
      console.log(`  ${change.uri}`);
      console.log(`    before: ${preview(change.before)}`);
      console.log(`    after:  ${preview(change.after)}`);
    }
    if (changes.length > SAMPLE_SIZE) {
      console.log(`  ... ${changes.length - SAMPLE_SIZE} more`);
    }

    if (!APPLY) {
      console.log('Dry run: no rows written. Re-run with --apply to update descriptions.');
      return;
    }
    if (changes.length === 0) {
      console.log('Nothing to apply.');
      return;
    }

    let applied = 0;
    await client.query('BEGIN');
    try {
      for (const change of changes) {
        const updated = await client.query(
          'UPDATE editions SET description = $2 WHERE uri = $1 AND description = $3',
          [change.uri, change.after, change.before]
        );
        applied += updated.rowCount;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    console.log(
      `Applied ${applied} description update(s); pds_outbox now queues their republication.`
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('normalize-isbndb-descriptions failed:', error);
  process.exitCode = 1;
});
