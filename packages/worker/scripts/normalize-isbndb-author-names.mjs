#!/usr/bin/env node
// One-off backfill for ISBNdb authors stored as `"Le Guin, Ursula K."`.
//
// Dry run (default): reports how many rows the parser would rewrite, plus
// samples of renames, merges, conflicts and skipped values. Nothing is written.
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
//   --include-identified   also scan rows that already have a name_inverted;
//                          those rows are reported but never overwritten
//   --merge-conflicts      resolve name collisions by merging the inverted row
//                          into the existing display-order contributor
//   --limit N              inspect at most N comma-name rows
//   --sample N             examples printed per bucket (default 8)
//
// Conflicts: if another contributor already has the target name, the row is
// skipped by default and reported. With `--merge-conflicts` (and `--apply`) the
// inverted row is merged into one existing display-order contributor: its
// identifiers are unioned into the target, every edition link is repointed
// (positions/roles/refs preserved), and only then is the source row deleted.
// An ambiguous target (more than one display-order row and no exact identifier
// match) is reported and skipped rather than guessed. Merges preserve the
// target's id, at_uri and created_at.
//
// Renames touch `name` and `name_inverted` only. Merges additionally update the
// target's `identifiers`/`name_inverted` and move edition links; the target's
// `id`, `at_uri` and `created_at` never change. The script never merges when
// the source has a published record and the target does not.
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { parseIsbndbAuthor } from '../lib/isbndb-names.js';

const USAGE =
  'Usage: normalize-isbndb-author-names.mjs [--apply] [--limit N] ' +
  '[--include-identified] [--merge-conflicts] [--sample N]';

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    includeIdentified: false,
    mergeConflicts: false,
    limit: Infinity,
    sample: 8
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--include-identified') {
      options.includeIdentified = true;
    } else if (arg === '--merge-conflicts') {
      options.mergeConflicts = true;
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

function lowerNameKey(name) {
  return name.trim().toLowerCase();
}

/**
 * Union identifier bags by `(issuer, value)`, preserving extra metadata such as
 * `url`. The target's entry wins; missing optional fields are filled from the
 * source entry. Invalid entries are dropped rather than merged blindly.
 */
export function mergeIdentifiers(targetIdentifiers, sourceIdentifiers) {
  const merged = [];
  const byKey = new Map();
  for (const entry of [...(targetIdentifiers ?? []), ...(sourceIdentifiers ?? [])]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.issuer !== 'string' || entry.issuer === '') continue;
    if (typeof entry.value !== 'string' || entry.value === '') continue;
    const key = `${entry.issuer}\u0000${entry.value}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const [field, value] of Object.entries(entry)) {
        if (existing[field] === undefined && value !== undefined) existing[field] = value;
      }
      continue;
    }
    const copy = { ...entry };
    byKey.set(key, copy);
    merged.push(copy);
  }
  return merged;
}

/**
 * Pick the display-order contributor a conflict row merges into.
 *
 * Candidates are rows sharing `lower(name)` with the parsed display name. The
 * exact identifier-bag match wins; otherwise a single candidate is used. More
 * than one remaining candidate is ambiguous and is reported, not guessed at.
 * Candidates that themselves parse as inverted names, or whose missing at_uri
 * would orphan a published source record, are excluded.
 *
 * @param {{id: number, parsedName: string, identifiers?: object[], atUri?: string|null}} source
 * @param {object[]} candidates
 */
export function chooseMergeTarget(source, candidates) {
  const display = candidates
    .filter((row) => row.id !== source.id)
    .filter((row) => parseIsbndbAuthor(row.name) === null)
    .sort((left, right) => Number(left.id) - Number(right.id));
  const usable = (target, exact) => {
    if (
      (target.at_uri === null || target.at_uri === undefined) &&
      source.atUri !== null &&
      source.atUri !== undefined
    ) {
      return { unsafe: target };
    }
    return { target, exact };
  };
  const wanted = identityKey(source.parsedName, source.identifiers);
  const exact = display.filter((row) => identityKey(row.name, row.identifiers) === wanted);
  if (exact.length === 1) return usable(exact[0], true);
  if (exact.length > 1) return { ambiguous: exact };
  if (display.length === 1) return usable(display[0], false);
  if (display.length === 0) return { none: true };
  return { ambiguous: display };
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
 * @param {boolean} [options.mergeConflicts]
 * @param {number} [options.limit]
 * @param {number} [options.sample]
 */
export async function normalizeAuthors(client, options = {}) {
  const apply = options.apply === true;
  const includeIdentified = options.includeIdentified === true;
  const mergeConflicts = options.mergeConflicts === true;
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
  const all = await client.query(
    'SELECT id, name, name_inverted, identifiers, at_uri FROM contributors ORDER BY id'
  );
  const identities = new Map();
  const byName = new Map();
  for (const row of all.rows) {
    const key = identityKey(row.name, row.identifiers);
    const ids = identities.get(key);
    if (ids) ids.push(row.id);
    else identities.set(key, [row.id]);

    const nameKey = lowerNameKey(row.name);
    const named = byName.get(nameKey);
    if (named) named.push(row);
    else byName.set(nameKey, [row]);
  }

  // Edition-link counts make a merge sample explain what it moves.
  const editionCounts = new Map();
  if (mergeConflicts) {
    const counts = await client.query(
      'SELECT contributor_id, count(*)::int AS links FROM edition_contributors GROUP BY contributor_id'
    );
    for (const row of counts.rows) editionCounts.set(row.contributor_id, row.links);
  }

  const samples = {
    candidates: [],
    conflicts: [],
    merges: [],
    skipped: [],
    identified: []
  };
  const candidates = [];
  const merges = [];
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

    if (mergeConflicts) {
      const sameName = byName.get(lowerNameKey(parsed.name)) ?? [];
      if (sameName.length > 0) {
        const selection = chooseMergeTarget(
          {
            id: row.id,
            parsedName: parsed.name,
            identifiers: row.identifiers,
            atUri: row.at_uri
          },
          sameName
        );
        if (selection.target) {
          const target = selection.target;
          const mergedIdentifiers = mergeIdentifiers(target.identifiers, row.identifiers);
          const merge = {
            id: row.id,
            name: row.name,
            nameInverted: parsed.nameInverted,
            targetId: target.id,
            targetName: target.name,
            identifiers: mergedIdentifiers,
            identifiersAdded: Math.max(
              0,
              mergedIdentifiers.length - (target.identifiers?.length ?? 0)
            ),
            editionLinks: editionCounts.get(row.id) ?? 0,
            exact: selection.exact === true,
            published: row.at_uri !== null && row.at_uri !== undefined
          };
          merges.push(merge);
          sampleInto(samples.merges, sample, {
            id: merge.id,
            before: merge.name,
            targetId: merge.targetId,
            target: merge.targetName,
            editionLinks: merge.editionLinks,
            identifiersAdded: merge.identifiersAdded
          });
          continue;
        }

        conflicts += 1;
        sampleInto(samples.conflicts, sample, {
          id: row.id,
          name: row.name,
          target: parsed.name,
          reason: selection.ambiguous
            ? `ambiguous target (ids ${selection.ambiguous.map((entry) => entry.id).join(', ')})`
            : selection.unsafe
              ? `target ${selection.unsafe.id} has no at_uri`
              : 'no display-order target'
        });
        continue;
      }
    } else {
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
    mergeConflicts,
    selected: rows.rowCount,
    candidates,
    merges,
    unchanged,
    skipped,
    conflicts,
    identified,
    // `at_uri` is untouched; the count only states how many rewritten or merged
    // sources are already published and will therefore be republished.
    published:
      candidates.filter((candidate) => candidate.published).length +
      merges.filter((merge) => merge.published).length,
    samples,
    applied: 0,
    merged: 0,
    editionsRepointed: 0,
    changedSinceScan: 0,
    mergeSkipped: [],
    failures: []
  };

  if (!apply || (candidates.length === 0 && merges.length === 0)) return summary;

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

    for (const merge of merges) {
      await client.query('SAVEPOINT merge_author');
      try {
        // Recompute every decision under row locks; the scan snapshot is only a
        // prediction and may be stale by the time the transaction runs.
        const sourceResult = await client.query(
    `SELECT id, name, name_inverted, identifiers, at_uri
             FROM contributors WHERE id = $1 FOR UPDATE`,
          [merge.id]
        );
        const source = sourceResult.rows[0];
        const parsed = source ? parseIsbndbAuthor(source.name) : null;
        if (
          !source ||
          !parsed ||
          source.name !== merge.name ||
          (typeof source.name_inverted === 'string' && source.name_inverted !== '')
        ) {
          summary.changedSinceScan += 1;
          summary.mergeSkipped.push({
            id: merge.id,
            name: merge.name,
            reason: 'changed since scan'
    });
          await client.query('RELEASE SAVEPOINT merge_author');
      continue;
    }

        const targetCandidates = await client.query(
    `SELECT id, name, name_inverted, identifiers, at_uri
       FROM contributors
            WHERE lower(name) = lower($1) AND id <> $2
      ORDER BY id
            FOR UPDATE`,
          [parsed.name, source.id]
        );
        const selection = chooseMergeTarget(
          {
            id: source.id,
            parsedName: parsed.name,
            identifiers: source.identifiers,
            atUri: source.at_uri
          },
          targetCandidates.rows
        );
        if (
          !selection.target ||
          Number(selection.target.id) !== Number(merge.targetId)
        ) {
          summary.changedSinceScan += 1;
          summary.mergeSkipped.push({
            id: merge.id,
            name: merge.name,
            reason: selection.ambiguous
              ? 'ambiguous target under lock'
              : selection.unsafe
                ? 'target has no at_uri under lock'
                : 'target changed since scan'
          });
          await client.query('RELEASE SAVEPOINT merge_author');
          continue;
    }

        const target = selection.target;
        const identifiers = mergeIdentifiers(target.identifiers, source.identifiers);
        // Update the target before repointing. The contributor-editions
        // trigger expands a contributor's links in one INSERT ... SELECT; after
        // a repoint an edition may list the target twice, and that statement
        // cannot ON CONFLICT-update the same row twice. Updating now avoids the
        // duplicate expansion. The source's name is inverted, so its identity
        // cannot collide with the display-name target.
        if (JSON.stringify(target.identifiers ?? []) !== JSON.stringify(identifiers)) {
          await client.query('UPDATE contributors SET identifiers = $2::jsonb WHERE id = $1', [
            target.id,
            JSON.stringify(identifiers)
          ]);
        }
        // `name_inverted` alone is not in the editor trigger's column list, so
        // this cannot expand edition links.
        await client.query(
          `UPDATE contributors
              SET name_inverted = $2
            WHERE id = $1
              AND (name_inverted IS NULL OR name_inverted = '')`,
          [target.id, parsed.nameInverted]
        );
        // Repoint after the target update; positions, roles and refs stay put.
        const repointed = await client.query(
          'UPDATE edition_contributors SET contributor_id = $1 WHERE contributor_id = $2',
          [target.id, source.id]
        );
        await client.query('DELETE FROM contributors WHERE id = $1', [source.id]);
        summary.merged += 1;
        summary.editionsRepointed += repointed.rowCount;
        await client.query('RELEASE SAVEPOINT merge_author');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT merge_author');
        summary.failures.push({
          id: merge.id,
          name: merge.name,
          targetId: merge.targetId,
          error: error.message
        });
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
    `  renames ${summary.candidates.length}, merges ${summary.merges.length}, ` +
      `unresolved conflicts ${summary.conflicts}, unchanged ${summary.unchanged}, ` +
      `skipped ${summary.skipped}, ` +
      `already identified ${summary.identified}`
  );
  console.log(
    `  ${summary.published} rewrite/merge source(s) already have an at_uri; each queued ` +
      'contributor and linked edition is republished by pds-publish'
  );

  for (const item of summary.samples.candidates) {
    console.log(`  rename     [${item.id}] ${preview(item.before)} -> ${preview(item.after)}`);
  }
  for (const item of summary.samples.merges) {
    console.log(
      `  merge      [${item.id}] ${preview(item.before)} -> [${item.targetId}] ` +
        `${preview(item.target)} (${item.editionLinks} edition link(s), ` +
        `+${item.identifiersAdded} identifier(s))`
    );
  }
  for (const item of summary.samples.conflicts) {
    console.log(`  conflict   [${item.id}] ${preview(item.name)} -> ${preview(item.target)}`);
    console.log(
      `             ${item.reason ?? `identity already held by id ${item.otherIds.join(', ')}`} ` +
        '(left unchanged)'
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
  for (const [label, total, key] of [
    ['renames', summary.candidates.length, 'candidates'],
    ['merges', summary.merges.length, 'merges'],
    ['conflicts', summary.conflicts, 'conflicts'],
    ['identified', summary.identified, 'identified'],
    ['skipped', summary.skipped, 'skipped']
  ]) {
    if (total > summary.samples[key].length) {
      console.log(`  ... ${total - summary.samples[key].length} more ${label}`);
    }
  }

  if (!summary.apply) {
    console.log(
      'Dry run: no rows written. Re-run with --apply to update the catalog' +
        (summary.mergeConflicts ? '; merges are applied in the same transaction.' : '.')
    );
    return;
  }
  if (summary.candidates.length === 0 && summary.merges.length === 0) {
    console.log('Nothing to apply.');
    return;
  }
  for (const failure of summary.failures) {
    console.error(
      `  failed     [${failure.id}] ${preview(failure.name)}` +
        (failure.targetId ? ` -> [${failure.targetId}]` : '') +
        `: ${failure.error}`
    );
  }
  for (const item of summary.mergeSkipped) {
    console.error(
      `  merge-skip [${item.id}] ${preview(item.name)}: ${item.reason} (left unchanged)`
    );
  }
  console.log(
    `Applied ${summary.applied} rename(s); merged ${summary.merged} contributor(s) ` +
      `repointing ${summary.editionsRepointed} edition link(s); ` +
      `${summary.changedSinceScan} changed since the scan, ${summary.failures.length} failed. ` +
      'pds-publish now drains the queued entity and edition updates.'
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
