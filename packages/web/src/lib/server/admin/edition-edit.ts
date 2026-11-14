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
  type EditionEditIdentifierInfo,
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

async function findEditionUri(client: Pool, ref: string): Promise<string | null> {
  const result = await client.query<{ uri: string }>(
    'SELECT uri FROM editions WHERE uri = $1 OR rkey = $1 LIMIT 1',
    [normalizeRef(ref)]
  );
  return result.rows[0]?.uri ?? null;
}

/** The editor's read path: rkey or at-URI to the full editable record. */
export async function loadEditionForEdit(
  pool: Pool,
  ref: string
): Promise<AdminEdition | null> {
  const uri = await findEditionUri(pool, ref);
  if (uri === null) return null;
  const records = await loadAdminEditionsFrom(pool, [uri]);
  return records[0] ?? null;
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
         title = $2, subtitle = $3, duration_seconds = $4, chapters = $5,
         series = $6::jsonb, book_edition = $7, cover_url = $8
       WHERE uri = $1`,
      [
        uri,
        input.title,
        input.subtitle,
        input.durationSeconds,
        input.chapters,
        input.series ? JSON.stringify(input.series) : null,
        input.bookEdition,
        input.coverUrl
      ]
    );

    // Diff, never delete-all/insert-all: untouched pairs keep their own shape
    // claim (`edition_identifier_info` cascades on delete).
    const pairKey = (identifier: { issuer: string; value: string }): string =>
      `${identifier.issuer}\u0000${identifier.value}`;
    const currentPairs = new Set(current.identifiers.map(pairKey));
    const nextPairs = new Set(input.identifiers.map(pairKey));
    const removed = current.identifiers.filter(
      (identifier) => !nextPairs.has(pairKey(identifier))
    );
    const added = input.identifiers.filter((identifier) => !currentPairs.has(pairKey(identifier)));

    if (removed.length > 0) {
      await client.query(
        `DELETE FROM edition_identifiers
          WHERE edition_uri = $1
            AND (issuer, value) IN (
                  SELECT t.issuer, t.value
                    FROM unnest($2::text[], $3::text[]) AS t(issuer, value)
                )`,
        [uri, removed.map((identifier) => identifier.issuer), removed.map((i) => i.value)]
      );
    }
    if (added.length > 0) {
      await client.query(
        `INSERT INTO edition_identifiers (edition_uri, issuer, value)
         SELECT $1, t.issuer, t.value
           FROM unnest($2::text[], $3::text[]) AS t(issuer, value)
         ON CONFLICT DO NOTHING`,
        [uri, added.map((identifier) => identifier.issuer), added.map((i) => i.value)]
      );
    }

    // Claims: absent `info` leaves the stored row alone, null (or an all-empty
    // object) clears it, and an object replaces every field.
    const claims: Array<EditionEditIdentifier & { info: EditionEditIdentifierInfo }> = [];
    const cleared: EditionEditIdentifier[] = [];
    for (const identifier of input.identifiers) {
      const info = identifier.info;
      if (info === undefined) continue;
      if (
        info === null ||
        (info.format === null &&
          info.language === null &&
          info.publishedDate === null &&
          info.pages === null &&
          info.description === null)
      ) {
        cleared.push({ issuer: identifier.issuer, value: identifier.value });
        continue;
      }
      claims.push({ issuer: identifier.issuer, value: identifier.value, info });
    }

    if (cleared.length > 0) {
      await client.query(
        `DELETE FROM edition_identifier_info
          WHERE edition_uri = $1
            AND (issuer, value) IN (
                  SELECT t.issuer, t.value
                    FROM unnest($2::text[], $3::text[]) AS t(issuer, value)
                )`,
        [uri, cleared.map((identifier) => identifier.issuer), cleared.map((i) => i.value)]
      );
    }
    if (claims.length > 0) {
      await client.query(
        `INSERT INTO edition_identifier_info (
           edition_uri, issuer, value, format, language,
           published_date, pages, description
         )
         SELECT $1, t.issuer, t.value, t.format, t.language,
                t.published_date, t.pages::int, t.description
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[],
                       $6::text[], $7::text[], $8::text[])
                AS t(issuer, value, format, language, published_date,
                     pages, description)
         ON CONFLICT (edition_uri, issuer, value) DO UPDATE SET
           format = EXCLUDED.format,
           language = EXCLUDED.language,
           published_date = EXCLUDED.published_date,
           pages = EXCLUDED.pages,
           description = EXCLUDED.description,
          updated_at = now()
         WHERE edition_identifier_info.format IS DISTINCT FROM EXCLUDED.format
            OR edition_identifier_info.language IS DISTINCT FROM EXCLUDED.language
            OR edition_identifier_info.published_date IS DISTINCT FROM EXCLUDED.published_date
            OR edition_identifier_info.pages IS DISTINCT FROM EXCLUDED.pages
            OR edition_identifier_info.description IS DISTINCT FROM EXCLUDED.description`,
        [
          uri,
          claims.map((claim) => claim.issuer),
          claims.map((claim) => claim.value),
          claims.map((claim) => claim.info.format),
          claims.map((claim) => claim.info.language),
          claims.map((claim) => claim.info.publishedDate),
          claims.map((claim) => (claim.info.pages === null ? null : String(claim.info.pages))),
          claims.map((claim) => claim.info.description)
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

    // Publisher links are per identifier: `publishers` omitted keeps the stored
    // links, an array replaces that identifier's list (positions follow order).
    for (const identifier of input.identifiers) {
      if (identifier.publishers === undefined) continue;
      const publisherIds: number[] = [];
      for (const publisher of identifier.publishers) {
        publisherIds.push(await resolveEntity(client, 'publisher', publisher, authority));
      }
      await client.query(
        `DELETE FROM edition_identifier_publishers
          WHERE edition_uri = $1 AND issuer = $2 AND value = $3`,
        [uri, identifier.issuer, identifier.value]
      );
      if (publisherIds.length > 0) {
        await client.query(
          `INSERT INTO edition_identifier_publishers
             (edition_uri, issuer, value, publisher_id, position)
           SELECT $1, $2, $3, t.publisher_id, t.position::int
             FROM unnest($4::bigint[])
                  WITH ORDINALITY AS t(publisher_id, position)`,
          [uri, identifier.issuer, identifier.value, publisherIds]
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

