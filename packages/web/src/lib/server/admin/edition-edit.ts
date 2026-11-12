/**
 * Atomic writes for the admin edition editor.
 *
 * The browser sends the whole editable record; this module validates it once,
 * locks the edition and applies scalars, identifiers, contributor credits and
 * publisher links in one transaction. Catalog triggers queue the edition and
 * the entity rows — the editor never writes `pds_outbox` itself.
 *
 * Entity creation reuses the ingest identity (`lower(name), identifiers`), so
 * two spellings of the same identifier bag resolve to one contributor or
 * publisher row. Removing a credit deletes only the join row; a shared entity
 * is never deleted.
 *
 * No SvelteKit or environment imports: the route passes `catalogPool()` and
 * the scratch-database tests pass their own pool.
 */

import type { Pool, PoolClient } from 'pg';
import type { AdminEdition } from '../../admin/types.ts';
import {
  parseEditionEdit,
  type EditionEditContributor,
  type EditionEditIdentifier,
  type EditionEditInput,
  type EditionEditPublisher
} from '../../admin/edition-edit.ts';
import { loadAdminEditionsFrom } from './edition-read.ts';

const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

export class EditionEditError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;

  constructor(status: number, message: string, code: string, field?: string) {
    super(message);
    this.name = 'EditionEditError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Accept an rkey, or a URL-encoded at-URI kept encoded by a proxy or client. */
function normalizeRef(raw: string): string {
  const ref = raw.trim();
  if (ref.startsWith('at://')) return ref;
  if (/%3A/i.test(ref)) {
    try {
      const decoded = decodeURIComponent(ref);
      if (decoded.startsWith('at://')) return decoded;
    } catch {
      // Keep the raw value; the lookup below turns it into a 404.
    }
  }
  return ref;
}

async function findEditionUri(
  client: Pool,
  ref: string,
  forUpdate: boolean
): Promise<string | null> {
  const result = await client.query<{ uri: string }>(
    `SELECT uri FROM editions WHERE uri = $1 OR rkey = $1 LIMIT 1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [normalizeRef(ref)]
  );
  return result.rows[0]?.uri ?? null;
}

/** The editor's read path: rkey or at-URI to the full editable record. */
export async function loadEditionForEdit(
  pool: Pool,
  ref: string
): Promise<AdminEdition | null> {
  const uri = await findEditionUri(pool, ref, false);
  if (uri === null) return null;
  const records = await loadAdminEditionsFrom(pool, [uri]);
  return records[0] ?? null;
}

function sameIdentifierBag(
  current: Array<{ issuer: string; value: string }>,
  next: EditionEditIdentifier[]
): boolean {
  if (current.length !== next.length) return false;
  const stored = new Set(current.map((identifier) => `${identifier.issuer}\u0000${identifier.value}`));
  return next.every((identifier) => stored.has(`${identifier.issuer}\u0000${identifier.value}`));
}

function sameCredits(
  current: AdminEdition['contributors'],
  next: EditionEditContributor[]
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (contributor, index) =>
        contributor.id === next[index]?.id &&
        contributor.role === next[index]?.role &&
        contributor.ref === next[index]?.ref
    )
  );
}

function samePublishers(
  current: AdminEdition['publishers'],
  next: EditionEditPublisher[]
): boolean {
  return (
    current.length === next.length &&
    current.every((publisher, index) => publisher.id === next[index]?.id)
  );
}

/**
 * Resolve one contributor/publisher credit to an entity row. A supplied id is
 * verified and never renamed; otherwise the ingest upsert dedupes by normalized
 * name plus the identifier bag and mints `at_uri` for a new row. The authority
 * is the edition's own repo, which is the same authority ingest mints under.
 */
async function resolveEntity(
  client: PoolClient,
  kind: 'contributor' | 'publisher',
  entry: { id: number | null; name: string | null; identifiers: EditionEditIdentifier[] },
  authority: string
): Promise<number> {
  const table = kind === 'contributor' ? 'contributors' : 'publishers';
  if (entry.id !== null) {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE id = $1`,
      [entry.id]
    );
    if (found.rowCount === 0) {
      throw new EditionEditError(
        400,
        `unknown ${kind} id ${entry.id}`,
        kind === 'contributor' ? 'UnknownContributor' : 'UnknownPublisher'
      );
    }
    return Number(found.rows[0]?.id);
  }

  if (entry.name === null) {
    throw new EditionEditError(
      400,
      `a new ${kind} needs a display name`,
      kind === 'contributor' ? 'UnknownContributor' : 'UnknownPublisher'
    );
  }

  const collection = kind === 'contributor' ? CONTRIBUTOR_COLLECTION : PUBLISHER_COLLECTION;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ${table} (name, identifiers, at_uri)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid())
     ON CONFLICT (lower(name), identifiers) DO NOTHING
     RETURNING id`,
    [entry.name, JSON.stringify(entry.identifiers), authority, collection]
  );
  if (inserted.rows[0]) return Number(inserted.rows[0].id);

  // The identity already exists. Read it without touching its metadata; the
  // only permitted write is minting a missing address, which the entity
  // trigger then queues. This deliberately does not `UPDATE ... SET name`, so
  // credits on unrelated editions are not republished.
  const existing = await client.query<{ id: string; at_uri: string | null }>(
    `SELECT id, at_uri FROM ${table}
      WHERE lower(name) = lower($1) AND identifiers = $2::jsonb`,
    [entry.name, JSON.stringify(entry.identifiers)]
  );
  const row = existing.rows[0];
  if (!row) {
    throw new EditionEditError(
      409,
      `${kind} changed while saving; reload and retry`,
      'Conflict'
    );
  }
  if (row.at_uri === null) {
    await client.query(
      `UPDATE ${table}
          SET at_uri = 'at://' || $2 || '/' || $3 || '/' || editions_next_tid()
        WHERE id = $1 AND at_uri IS NULL`,
      [row.id, authority, collection]
    );
  }
  return Number(row.id);
}

export async function updateAdminEdition(
  pool: Pool,
  ref: string,
  body: unknown
): Promise<AdminEdition> {
  const parsed = parseEditionEdit(body);
  if (parsed.value === null) {
    const first = parsed.errors[0];
    throw new EditionEditError(
      400,
      first?.path ? `${first.path}: ${first.message}` : (first?.message ?? 'invalid edition'),
      'InvalidEdition',
      first?.path
    );
  }
  const input: EditionEditInput = parsed.value;

  const client = await pool.connect();
  let uri: string;
  try {
    await client.query('BEGIN');

    const found = await client.query<{ uri: string }>(
      `SELECT uri FROM editions WHERE uri = $1 OR rkey = $1 LIMIT 1 FOR UPDATE`,
      [normalizeRef(ref)]
    );
    const foundUri = found.rows[0]?.uri;
    if (!foundUri) {
      throw new EditionEditError(404, 'edition not found', 'NotFound');
    }
    uri = foundUri;

    const current = (await loadAdminEditionsFrom(client, [uri], { forUpdate: true }))[0];
    if (!current) throw new EditionEditError(404, 'edition not found', 'NotFound');

    if (input.expectedRevision !== null && input.expectedRevision !== current.revision) {
      throw new EditionEditError(
        409,
        'this edition changed since it was loaded; reload before saving',
        'EditionChanged'
      );
    }

    const authority = /^at:\/\/([^/]+)\//.exec(uri)?.[1];
    if (!authority) {
      throw new EditionEditError(409, 'edition URI has no repo authority', 'InvalidEditionUri');
    }

    await client.query(
      `UPDATE editions SET
         title = $2, subtitle = $3, language = $4, published_date = $5,
         format = $6, pages = $7, duration_seconds = $8, chapters = $9,
         series = $10::jsonb, book_edition = $11, description = $12,
         cover_url = $13
       WHERE uri = $1`,
      [
        uri,
        input.title,
        input.subtitle,
        input.language,
        input.publishedDate,
        input.format,
        input.pages,
        input.durationSeconds,
        input.chapters,
        input.series ? JSON.stringify(input.series) : null,
        input.bookEdition,
        input.description,
        input.coverUrl
      ]
    );

    if (!sameIdentifierBag(current.identifiers, input.identifiers)) {
      await client.query('DELETE FROM edition_identifiers WHERE edition_uri = $1', [uri]);
      await client.query(
        `INSERT INTO edition_identifiers (edition_uri, issuer, value)
         SELECT $1, t.issuer, t.value
           FROM unnest($2::text[], $3::text[]) AS t(issuer, value)`,
        [
          uri,
          input.identifiers.map((identifier) => identifier.issuer),
          input.identifiers.map((identifier) => identifier.value)
        ]
      );
    }

    const contributorIds: number[] = [];
    for (const contributor of input.contributors) {
      contributorIds.push(await resolveEntity(client, 'contributor', contributor, authority));
    }

    if (!sameCredits(current.contributors, input.contributors)) {
      await client.query('DELETE FROM edition_contributors WHERE edition_uri = $1', [uri]);
      await client.query(
        `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
         SELECT $1, t.contributor_id, t.position::int, t.role, t.ref
           FROM unnest($2::bigint[], $3::text[], $4::text[])
                WITH ORDINALITY AS t(contributor_id, role, ref, position)`,
        [
          uri,
          contributorIds,
          input.contributors.map((contributor) => contributor.role),
          input.contributors.map((contributor) => contributor.ref)
        ]
      );
    }

    const publisherIds: number[] = [];
    for (const publisher of input.publishers) {
      publisherIds.push(await resolveEntity(client, 'publisher', publisher, authority));
    }

    if (!samePublishers(current.publishers, input.publishers)) {
      await client.query('DELETE FROM edition_publishers WHERE edition_uri = $1', [uri]);
      if (publisherIds.length > 0) {
        await client.query(
          `INSERT INTO edition_publishers (edition_uri, publisher_id, position)
           SELECT $1, t.publisher_id, t.position::int
             FROM unnest($2::bigint[])
                  WITH ORDINALITY AS t(publisher_id, position)`,
          [uri, publisherIds]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === '23505' || error.code === '23503')
    ) {
      throw new EditionEditError(
        error.code === '23505' ? 409 : 400,
        error.code === '23505'
          ? 'a conflicting catalog row exists; reload and retry'
          : 'a referenced catalog row is invalid',
        'Conflict'
      );
    }
    throw error;
  } finally {
    client.release();
  }

  const records = await loadAdminEditionsFrom(pool, [uri]);
  const saved = records[0];
  if (!saved) throw new EditionEditError(404, 'edition not found after saving', 'NotFound');
  return saved;
}

