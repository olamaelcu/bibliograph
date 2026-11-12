import { catalogPool } from '../catalog/db';
import { loadAdminEditions } from './editions';
import type { PoolClient } from 'pg';
import {
  MERGE_FIELDS,
  type AdminContributor,
  type AdminEdition,
  type AdminPublisher,
  type LinkMode,
  type MergeField,
  type MergeResponse
} from '$lib/admin/types';

const COLLECTION = 'community.lexicon.media.book.edition';

const COLUMNS: Record<MergeField, string> = {
  title: 'title',
  subtitle: 'subtitle',
  language: 'language',
  publishedDate: 'published_date',
  format: 'format',
  pages: 'pages',
  durationSeconds: 'duration_seconds',
  chapters: 'chapters',
  series: 'series',
  bookEdition: 'book_edition',
  description: 'description',
  coverUrl: 'cover_url'
};

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
      const key = `${contributor.id}\u0000${contributor.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contributors.push(contributor);
    }
  }
  return contributors;
}

function uniquePublishers(records: AdminEdition[]): AdminPublisher[] {
  const seen = new Set<number>();
  const publishers: AdminPublisher[] = [];
  for (const record of records) {
    for (const publisher of record.publishers) {
      if (seen.has(publisher.id)) continue;
      seen.add(publisher.id);
      publishers.push(publisher);
    }
  }
  return publishers;
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

async function replacePublishers(
  client: PoolClient,
  base: string,
  publishers: AdminPublisher[]
): Promise<void> {
  await client.query('DELETE FROM edition_publishers WHERE edition_uri = $1', [base]);
  if (publishers.length === 0) return;
  await client.query(
    `INSERT INTO edition_publishers (edition_uri, publisher_id, position)
     SELECT $1, t.publisher_id, t.position::int
       FROM unnest($2::bigint[])
            WITH ORDINALITY AS t(publisher_id, position)`,
    [base, publishers.map((publisher) => publisher.id)]
  );
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
 */
export async function mergeEditions(input: unknown): Promise<MergeResponse> {
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

  const pool = catalogPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock in a stable order so two overlapping merges cannot deadlock; keep
    // the operator's order for contributor/publisher unions.
    const records = await loadAdminEditions([...all].sort(), {
      client,
      forUpdate: true
    });
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
         title = $2, subtitle = $3, language = $4, published_date = $5,
         format = $6, pages = $7, duration_seconds = $8, chapters = $9,
         series = $10::jsonb, book_edition = $11, description = $12,
         cover_url = $13
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

    const contributorRecords =
      contributorChoice.mode === 'union'
        ? uniqueContributors(ordered)
        : (byUri.get(contributorChoice.source as string) as AdminEdition).contributors;
    const publisherRecords =
      publisherChoice.mode === 'union'
        ? uniquePublishers(ordered)
        : (byUri.get(publisherChoice.source as string) as AdminEdition).publishers;

    await replaceContributors(client, base, contributorRecords);
    await replacePublishers(client, base, publisherRecords);

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
      publishers: publisherRecords.length
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
