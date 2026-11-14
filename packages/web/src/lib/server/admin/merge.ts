// Explicit extension: node's test runner loads this module without Vite.
import { normalizeContributorRole } from '../../contributor-roles.ts';
import { loadAdminEditionsFrom } from './edition-read.ts';
import type { Pool, PoolClient } from 'pg';
import {
  MERGE_FIELDS,
  type AdminContributor,
  type AdminEdition,
  type LinkMode,
  type MergeField,
  type MergeResponse
} from '../../admin/types.ts';

const COLLECTION = 'community.lexicon.media.book.edition';

export class MergeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MergeError';
    this.status = status;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((entry): entry is string => entry !== undefined)
    : [];
}

function linkChoice(value: unknown): { mode: LinkMode; source?: string } {
  if (value === 'union') return { mode: 'union' };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MergeError(400, 'contributors and publishers must be a link choice');
  }
  const choice = value as { mode?: unknown; source?: unknown };
  const mode = choice.mode === 'union' ? 'union' : 'source';
  const source = stringValue(choice.source);
  if (mode === 'source' && !source) {
    throw new MergeError(400, 'a source record is required for a link choice');
  }
  return { mode, source };
}

/** Read one scalar field from a loaded edition, without dropping null values. */
function fieldValue(record: AdminEdition, field: MergeField): string | number | object | null {
  return record[field] as string | number | object | null;
}

function uniqueContributors(records: AdminEdition[]): AdminContributor[] {
  const seen = new Set<string>();
  const contributors: AdminContributor[] = [];
  for (const record of records) {
    for (const contributor of record.contributors) {
      const role = normalizeContributorRole(contributor.role);
      const key = `${contributor.id}\u0000${role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contributors.push({ ...contributor, role });
    }
  }
  return contributors;
}

/** One record's publisher links in published order, first occurrence wins. */
function publisherIdsOf(record: AdminEdition): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const identifier of record.identifiers) {
    for (const publisher of identifier.publishers) {
      if (seen.has(publisher.id)) continue;
      seen.add(publisher.id);
      ids.push(publisher.id);
    }
  }
  return ids;
}

async function replaceContributors(
  client: PoolClient,
  base: string,
  contributors: AdminContributor[]
): Promise<void> {
  await client.query('DELETE FROM edition_contributors WHERE edition_uri = $1', [base]);
  if (contributors.length === 0) return;
  await client.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
     SELECT $1, t.contributor_id, t.position::int, t.role, t.ref
       FROM unnest($2::bigint[], $3::text[], $4::text[])
            WITH ORDINALITY AS t(contributor_id, role, ref, position)`,
    [
      base,
      contributors.map((contributor) => contributor.id),
      contributors.map((contributor) => contributor.role),
      contributors.map((contributor) => contributor.ref)
    ]
  );
}

/** Replace the base's per-identifier publisher links with the merge plan. */
async function replacePublisherLinks(
  client: PoolClient,
  base: string,
  plan: Map<string, { issuer: string; value: string; ids: number[] }>
): Promise<void> {
  await client.query('DELETE FROM edition_identifier_publishers WHERE edition_uri = $1', [base]);
  for (const entry of plan.values()) {
    if (entry.ids.length === 0) continue;
    await client.query(
      `INSERT INTO edition_identifier_publishers
         (edition_uri, issuer, value, publisher_id, position)
       SELECT $1, $2, $3, t.publisher_id, t.position::int
         FROM unnest($4::bigint[]) WITH ORDINALITY AS t(publisher_id, position)`,
      [base, entry.issuer, entry.value, entry.ids]
    );
  }
}

/**
 * Merge two or more catalog editions into one base.
 *
 * The base keeps its URI (and therefore its published record identity). Every
 * selected edition's identifiers are unioned into the base; scalar fields and
 * contributor/publisher links are copied from the operator's chosen records.
 * Duplicate editions are deleted last so their edit history stays available
 * while the base is rebuilt. Deleting them fires the existing outbox trigger,
 * which queues `delete` rows for the PDS publisher.
 *
 * The pool is injected rather than read from the environment so a node test can
 * drive the whole transaction against a scratch database.
 */
export async function mergeEditions(pool: Pool, input: unknown): Promise<MergeResponse> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MergeError(400, 'merge body must be an object');
  }
  const body = input as Record<string, unknown>;
  const base = stringValue(body.base);
  if (!base) throw new MergeError(400, 'base edition URI is required');
  const others = [...new Set(stringArray(body.others))].sort();
  if (others.length === 0) {
    throw new MergeError(400, 'select at least two editions to merge');
  }
  const all = [base, ...others];
  if (new Set(all).size !== all.length) {
    throw new MergeError(400, 'base and duplicate editions must be distinct');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock in a stable order so two overlapping merges cannot deadlock; keep
    // the operator's order for contributor/publisher unions.
    const records = await loadAdminEditionsFrom(client, [...all].sort(), { forUpdate: true });
    const byUri = new Map(records.map((record) => [record.uri, record]));
    if (records.length !== all.length) {
      const missing = all.filter((uri) => !byUri.has(uri));
      throw new MergeError(404, `edition not found: ${missing.join(', ')}`);
    }
    const ordered = all.map((uri) => byUri.get(uri) as AdminEdition);

    const sources = body.sources;
    if (sources !== undefined && (sources === null || typeof sources !== 'object' || Array.isArray(sources))) {
      throw new MergeError(400, 'sources must be an object');
    }
    const chosen = {} as Record<MergeField, AdminEdition>;
    for (const { key } of MERGE_FIELDS) {
      const raw = sources ? (sources as Record<string, unknown>)[key] : undefined;
      const sourceUri = raw === undefined ? base : stringValue(raw);
      if (!sourceUri || !byUri.has(sourceUri)) {
        throw new MergeError(400, `field ${key} names a record outside the selection`);
      }
      chosen[key] = byUri.get(sourceUri) as AdminEdition;
    }
    if (chosen.title.title.trim() === '') {
      throw new MergeError(400, 'the chosen title source is empty');
    }

    const contributorChoice = linkChoice(body.contributors);
    const publisherChoice = linkChoice(body.publishers);
    for (const choice of [contributorChoice, publisherChoice]) {
      if (choice.mode === 'source' && (!choice.source || !byUri.has(choice.source))) {
        throw new MergeError(400, 'a link source names a record outside the selection');
      }
    }

    const values = MERGE_FIELDS.map(({ key }) => {
      const value = fieldValue(chosen[key], key);
      return key === 'series' && value !== null ? JSON.stringify(value) : value;
    });
    await client.query(
      `UPDATE editions SET
         title = $2, subtitle = $3, duration_seconds = $4, chapters = $5,
         series = $6::jsonb, book_edition = $7, cover_url = $8
       WHERE uri = $1`,
      [base, ...values]
    );

    const identifierBag = new Map<string, { issuer: string; value: string }>();
    for (const record of ordered) {
      for (const identifier of record.identifiers) {
        identifierBag.set(`${identifier.issuer}\u0000${identifier.value}`, identifier);
      }
    }
    const identifiers = [...identifierBag.values()];
    if (identifiers.length > 0) {
      await client.query(
        `INSERT INTO edition_identifiers (edition_uri, issuer, value)
         SELECT $1, t.issuer, t.value
           FROM unnest($2::text[], $3::text[]) AS t(issuer, value)
         ON CONFLICT DO NOTHING`,
        [base, identifiers.map((identifier) => identifier.issuer), identifiers.map((identifier) => identifier.value)]
      );
    }

    // Claims travel with their identifier. The base's own claim wins (it was
    // curated there), and the newest source claim wins among sources; both fall
    // out of inserting newest-first with DO NOTHING.
    if (others.length > 0) {
      await client.query(
        `INSERT INTO edition_identifier_info (
           edition_uri, issuer, value, format, language,
           published_date, pages, description
         )
         SELECT $1, s.issuer, s.value, s.format, s.language,
                s.published_date, s.pages, s.description
           FROM edition_identifier_info s
          WHERE s.edition_uri = ANY($2::text[])
          ORDER BY s.updated_at DESC
         ON CONFLICT (edition_uri, issuer, value) DO NOTHING`,
        [base, others]
      );
    }

    const contributorRecords =
      contributorChoice.mode === 'union'
        ? uniqueContributors(ordered)
        : (byUri.get(contributorChoice.source as string) as AdminEdition).contributors;

    await replaceContributors(client, base, contributorRecords);

    // Publisher links follow their identifier. `source` applies the chosen
    // record's ordered publisher set to every identifier; `union` merges the
    // per-pair lists in operator order, base first.
    const sourcePublishers =
      publisherChoice.mode === 'source'
        ? publisherIdsOf(byUri.get(publisherChoice.source as string) as AdminEdition)
        : null;
    const publisherPlan = new Map<string, { issuer: string; value: string; ids: number[] }>();
    for (const pair of identifiers) {
      if (sourcePublishers !== null) {
        publisherPlan.set(`${pair.issuer}\u0000${pair.value}`, { ...pair, ids: sourcePublishers });
        continue;
      }
      const seen = new Set<number>();
      const ids: number[] = [];
      for (const record of ordered) {
        const identifier = record.identifiers.find(
          (candidate) => candidate.issuer === pair.issuer && candidate.value === pair.value
        );
        for (const publisher of identifier?.publishers ?? []) {
          if (seen.has(publisher.id)) continue;
          seen.add(publisher.id);
          ids.push(publisher.id);
        }
      }
      publisherPlan.set(`${pair.issuer}\u0000${pair.value}`, { ...pair, ids });
    }
    await replacePublisherLinks(client, base, publisherPlan);

    const deletedResult = await client.query<{ uri: string }>(
      'DELETE FROM editions WHERE uri = ANY($1::text[]) RETURNING uri',
      [others]
    );
    if (deletedResult.rowCount !== others.length) {
      throw new MergeError(409, 'a selected edition changed while merging; nothing was written');
    }

    // The base must always be republished as an edit, never as a deletion, even
    // if an earlier failed publish had parked a delete row for it.
    await client.query(
      `INSERT INTO pds_outbox (uri, collection, rkey, op)
       SELECT e.uri, $2, e.rkey, 'update' FROM editions e WHERE e.uri = $1
       ON CONFLICT (uri) DO UPDATE SET
         op = CASE WHEN pds_outbox.op = 'create' THEN 'create' ELSE 'update' END,
         value = NULL,
         updated_at = now()`,
      [base, COLLECTION]
    );

    await client.query('COMMIT');
    return {
      uri: base,
      deleted: deletedResult.rows.map((row) => row.uri),
      identifiers: identifiers.length,
      contributors: contributorRecords.length,
      publishers: [...publisherPlan.values()].reduce(
        (total, entry) => total + entry.ids.length,
        0
      )
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
