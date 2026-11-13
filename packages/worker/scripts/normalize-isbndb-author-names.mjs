#!/usr/bin/env node
// One-off backfill for ISBNdb authors stored as `"Le Guin, Ursula K."`.
//
// Dry run (default): reports how many rows the parser would rewrite, plus
// samples of candidates, conflicts and skipped values. Nothing is written.
//   DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs
//
// Apply: updates `name` and `name_inverted` for rows whose stored name is an
// unambiguous inverted personal name. The existing triggers queue the
// contributor record and every linked edition for republication; this script
// never talks to the PDS and never writes `pds_outbox` directly. Re-running is
// safe: rows that already have `name_inverted` are not selected (or, with
// `--include-identified`, are reported and left alone).
//   DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs --apply
//
// Options:
//   --apply                write the changes (default is a dry run)
//   --limit N              inspect at most N comma-name rows
//   --include-identified   also scan rows that already have a name_inverted;
//                          those rows are reported but never overwritten
//   --sample N             examples printed per bucket (default 8)
//
// Conflicts: if another contributor already has the target
// `(lower(name), identifiers)` identity, the row is skipped and reported. This
// script does not merge or delete contributor rows; that is a curation
// decision, not a name normalization.
//
// v1 touches `name` and `name_inverted` only. `id`, `at_uri`, `created_at` and
// every edition link stay exactly as they are.
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { parseIsbndbAuthor } from '../lib/isbndb-names.js';

const USAGE =
  'Usage: normalize-isbndb-author-names.mjs [--apply] [--limit N] ' +
  '[--include-identified] [--sample N]';

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = { apply: false, includeIdentified: false, limit: Infinity, sample: 8 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--include-identified') {
      options.includeIdentified = true;
    } else if (arg === '--limit') {
      options.limit = positiveInteger(argv[++index], '--limit');
    } else if (arg.startsWith('--limit=')) {
      options.limit = positiveInteger(arg.slice('--limit='.length), '--limit');
    } else if (arg === '--sample') {
      options.sample = positiveInteger(argv[++index], '--sample');
    } else if (arg.startsWith('--sample=')) {
      options.sample = positiveInteger(arg.slice('--sample='.length), '--sample');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option ${JSON.stringify(arg)}; ${USAGE}`);
    }
  }
  return options;
}

// Connection strings carry passwords; report only host/database.
export function describeDatabase(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

// The catalog identity is `(lower(name), identifiers)`; compare identifier bags
// as a set so order inside the JSON array does not matter.
export function identityKey(name, identifiers) {
  const bag = Array.isArray(identifiers)
    ? identifiers
        .map((identifier) => `${identifier?.issuer ?? ''}\u0000${identifier?.value ?? ''}`)
        .sort()
        .join('\u0001')
    : '';
  return `${name.trim().toLowerCase()}\u0000${bag}`;
}

function preview(value) {
  return JSON.stringify(value);
}

function sampleInto(samples, limit, value) {
  if (samples.length < limit) samples.push(value);
}

/**
 * Scan comma-name contributors and (optionally) rewrite them.
 *
 * Exported so the backfill can be exercised against a scratch database without
 * spawning the CLI. `client` may be a `pg.Client` or a pooled client.
 *
 * @param {object} client
 * Exported so the backfill can be exercised against a scratch database without
 * spawning the CLI.
 *
 * @param {import('pg').Client} client a single connection; `--apply` runs in
 *   one transaction, so a pooled `query` helper would not be safe here.
 * @param {object} [options]
 * @param {boolean} [options.apply]
 * @param {boolean} [options.includeIdentified]
 * @param {number} [options.limit]
 * @param {number} [options.sample]
 */
export async function normalizeAuthors(client, options = {}) {
  const apply = options.apply === true;
  const includeIdentified = options.includeIdentified === true;
  const limit = options.limit ?? Infinity;
  const sample = options.sample ?? 8;

  const selection = includeIdentified
    ? ''
    : "AND (name_inverted IS NULL OR name_inverted = '')";
  const limitClause = Number.isFinite(limit) ? `LIMIT ${Math.trunc(limit)}` : '';
  const rows = await client.query(
    `SELECT id, name, name_inverted, identifiers, at_uri
       FROM contributors
      WHERE strpos(name, ',') > 0
        ${selection}
      ORDER BY id
      ${limitClause}`
  );

  // Conflict detection is in-memory: the catalog is small enough and this keeps
  // the whole pass read-only until the single apply transaction.
  const all = await client.query('SELECT id, name, identifiers FROM contributors');
  const identities = new Map();
  for (const row of all.rows) {
    const key = identityKey(row.name, row.identifiers);
    const ids = identities.get(key);
    if (ids) ids.push(row.id);
    else identities.set(key, [row.id]);
  }

  const samples = { candidates: [], conflicts: [], skipped: [], identified: [] };
  const candidates = [];
  let skipped = 0;
  let conflicts = 0;
  let identified = 0;
  let unchanged = 0;

  for (const row of rows.rows) {
    const parsed = parseIsbndbAuthor(row.name);
    if (!parsed) {
      skipped += 1;
      sampleInto(samples.skipped, sample, row.name);
      continue;
    }

    if (typeof row.name_inverted === 'string' && row.name_inverted !== '') {
      // A human (or an earlier run) set this. Never overwrite it.
      identified += 1;
      if (parsed.name === row.name && parsed.nameInverted === row.name_inverted) unchanged += 1;
      sampleInto(samples.identified, sample, {
        id: row.id,
        name: row.name,
        nameInverted: row.name_inverted
      });
      continue;
    }

    if (row.name === parsed.name && row.name_inverted === parsed.nameInverted) {
      unchanged += 1;
      continue;
    }

    const colliding = (identities.get(identityKey(parsed.name, row.identifiers)) ?? []).filter(
      (id) => id !== row.id
    );
    if (colliding.length > 0) {
      conflicts += 1;
      sampleInto(samples.conflicts, sample, {
        id: row.id,
        name: row.name,
        target: parsed.name,
        otherIds: colliding
      });
      continue;
    }

    candidates.push({
      id: row.id,
      name: row.name,
      nameInverted: parsed.nameInverted,
      target: parsed.name,
      published: row.at_uri !== null && row.at_uri !== undefined
    });
    sampleInto(samples.candidates, sample, {
      id: row.id,
      before: row.name,
      after: parsed.name
    });
  }

  const summary = {
    apply,
    includeIdentified,
    selected: rows.rowCount,
    candidates,
    unchanged,
    skipped,
    conflicts,
    identified,
    // `at_uri` is untouched; the count only states how many rewritten rows are
    // already published and will therefore be republished by the triggers.
    published: candidates.filter((candidate) => candidate.published).length,
    samples,
    applied: 0,
    changedSinceScan: 0,
    failures: []
  };

  if (!apply || candidates.length === 0) return summary;

  // One transaction, one savepoint per row: a unique violation (or any other
  // per-row failure) is reported and skipped without losing the rest.
  await client.query('BEGIN');
  try {
    for (const candidate of candidates) {
      await client.query('SAVEPOINT normalize_author');
      try {
        const updated = await client.query(
          `UPDATE contributors
              SET name = $2, name_inverted = $3
            WHERE id = $1
              AND name = $4
              AND (name_inverted IS NULL OR name_inverted = '')`,
          [candidate.id, candidate.target, candidate.nameInverted, candidate.name]
        );
        if (updated.rowCount === 0) summary.changedSinceScan += 1;
        else summary.applied += updated.rowCount;
        await client.query('RELEASE SAVEPOINT normalize_author');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT normalize_author');
        summary.failures.push({ id: candidate.id, name: candidate.name, error: error.message });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return summary;
}

function report(summary, database) {
  const mode = summary.apply ? 'APPLY' : 'dry run';
  console.log(`normalize-isbndb-author-names: ${mode} on ${database}`);
  console.log(
    `  selected ${summary.selected} comma-name row(s)` +
      (summary.includeIdentified ? ' (including identified rows)' : ' without name_inverted')
  );
  console.log(
    `  candidates ${summary.candidates.length}, unchanged ${summary.unchanged}, ` +
      `skipped ${summary.skipped}, conflicts ${summary.conflicts}, ` +
      `already identified ${summary.identified}`
  );
  console.log(
    `  ${summary.published} candidate(s) already have an at_uri; each applied row queues ` +
      'its contributor record and every linked edition for pds-publish'
  );

  for (const item of summary.samples.candidates) {
    console.log(`  candidate  [${item.id}] ${preview(item.before)} -> ${preview(item.after)}`);
  }
  for (const item of summary.samples.conflicts) {
    console.log(
      `  conflict   [${item.id}] ${preview(item.name)} -> ${preview(item.target)} ` +
        `(identity already held by id ${item.otherIds.join(', ')})`
    );
  }
  for (const item of summary.samples.identified) {
    console.log(
      `  identified [${item.id}] ${preview(item.name)} keeps ${preview(item.nameInverted)}`
    );
  }
  for (const item of summary.samples.skipped) {
    console.log(`  skipped    ${preview(item)} (left unchanged)`);
  }
  for (const [key, total] of [
    ['candidates', summary.candidates.length],
    ['conflicts', summary.conflicts],
    ['identified', summary.identified],
    ['skipped', summary.skipped]
  ]) {
    if (total > summary.samples[key].length) {
      console.log(`  ... ${total - summary.samples[key].length} more ${key}`);
    }
  }

  if (!summary.apply) {
    console.log('Dry run: no rows written. Re-run with --apply to update the catalog.');
    return;
  }
  if (summary.candidates.length === 0) {
    console.log('Nothing to apply.');
    return;
  }
  for (const failure of summary.failures) {
    console.error(`  failed     [${failure.id}] ${preview(failure.name)}: ${failure.error}`);
  }
  console.log(
    `Applied ${summary.applied} contributor name(s); ${summary.changedSinceScan} changed ` +
      `since the scan, ${summary.failures.length} failed. pds-publish now drains the ` +
      'queued entity and edition updates.'
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`normalize-isbndb-author-names: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'normalize-isbndb-author-names: DATABASE_URL is required (e.g. ' +
        'postgres://bibliograph:…@localhost:5432/bibliograph)'
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const summary = await normalizeAuthors(client, options);
    report(summary, describeDatabase(connectionString));
    if (summary.failures.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error('normalize-isbndb-author-names failed:', error);
    process.exitCode = 1;
  });
}
