// The record type is `community.lexicon.media.book.edition`: the same
// collection the outbox and `pds-publish` write to, so a catalog URI is
// resolvable through `com.atproto.repo.getRecord`.
import { DEFAULT_CONTRIBUTOR_ROLE, normalizeContributorRole } from './contributor-roles.js';
import { CONTRIBUTOR_COLLECTION, PUBLISHER_COLLECTION } from './entity-record.js';
import { clippedText } from './record-fields.js';

const COLLECTION = 'community.lexicon.media.book.edition';

// Lexicon bounds for the contributor record's description (8192 bytes / 1024 graphemes).
const DESCRIPTION_LIMITS = { maxGraphemes: 1024, maxBytes: 8192 };

function editionUri(publisherDid, rkey) {
  return `at://${publisherDid}/${COLLECTION}/${rkey}`;
}

function normalizedIdentifiers(candidate) {
  const seen = new Set();
  return candidate.identifiers.filter((identifier) => {
    if (typeof identifier?.issuer !== 'string' || typeof identifier?.value !== 'string') {
      return false;
    }
    if (identifier.issuer === '' || identifier.value === '') return false;
    const key = `${identifier.issuer}\u0000${identifier.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function existingByIdentifiers(client, identifiers) {
  if (identifiers.length === 0) return undefined;
  const tuples = identifiers.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ');
  const params = identifiers.flatMap((identifier) => [identifier.issuer, identifier.value]);
  const result = await client.query(
    `SELECT e.uri
       FROM edition_identifiers i
       JOIN editions e ON e.uri = i.edition_uri
      WHERE (i.issuer, i.value) IN (${tuples})
      LIMIT 1`,
    params
  );
  return result.rows[0]?.uri;
}

async function nextTid(client) {
  const result = await client.query('SELECT editions_next_tid() AS rkey');
  return result.rows[0].rkey;
}

async function insertEdition(client, uri, rkey, candidate) {
  const title = candidate.title;
  const series = candidate.series ? JSON.stringify(candidate.series) : null;
  const inserted = await client.query(
    `INSERT INTO editions (
       uri, rkey, title, subtitle, duration_seconds, chapters, series,
       book_edition, cover_url, created_at, indexed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now(), now())
     ON CONFLICT (uri) DO NOTHING
     RETURNING uri`,
    [
      uri,
      rkey,
      title,
      candidate.subtitle ?? null,
      candidate.durationSeconds ?? null,
      candidate.chapters ?? null,
      series,
      candidate.bookEdition ?? null,
      candidate.coverUrl ?? null
    ]
  );
  return inserted.rowCount > 0;
}

async function fillMissingFields(client, uri, candidate) {
  const values = {
    subtitle: candidate.subtitle ?? null,
    durationSeconds: candidate.durationSeconds ?? null,
    chapters: candidate.chapters ?? null,
    series: candidate.series ? JSON.stringify(candidate.series) : null,
    bookEdition: candidate.bookEdition ?? null,
    coverUrl: candidate.coverUrl ?? null
  };

  await client.query(
    `UPDATE editions SET
       subtitle = COALESCE(subtitle, $2),
       duration_seconds = COALESCE(duration_seconds, $3),
       chapters = COALESCE(chapters, $4),
       series = COALESCE(series, $5::jsonb),
       book_edition = COALESCE(book_edition, $6),
       cover_url = COALESCE(cover_url, $7)
     WHERE uri = $1
       AND (
         (subtitle IS NULL AND $2::text IS NOT NULL)
         OR (duration_seconds IS NULL AND $3::int IS NOT NULL)
         OR (chapters IS NULL AND $4::int IS NOT NULL)
         OR (series IS NULL AND $5::jsonb IS NOT NULL)
         OR (book_edition IS NULL AND $6::text IS NOT NULL)
         OR (cover_url IS NULL AND $7::text IS NOT NULL)
       )`,
    [
      uri,
      values.subtitle,
      values.durationSeconds,
      values.chapters,
      values.series,
      values.bookEdition,
      values.coverUrl
    ]
  );
}

// Provider data fills gaps only: an existing claim field is a curator edit or a
// more specific record, and the `WHERE` keeps a re-ingest from rewriting the row
// (which would re-queue the edition for no change).
async function fillIdentifierClaims(client, uri, identifier, claims) {
  await client.query(
    `INSERT INTO edition_identifier_info
           (edition_uri, issuer, value, format, language, published_date, pages, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (edition_uri, issuer, value) DO UPDATE SET
       format = COALESCE(edition_identifier_info.format, EXCLUDED.format),
       language = COALESCE(edition_identifier_info.language, EXCLUDED.language),
       published_date = COALESCE(edition_identifier_info.published_date, EXCLUDED.published_date),
       pages = COALESCE(edition_identifier_info.pages, EXCLUDED.pages),
       description = COALESCE(edition_identifier_info.description, EXCLUDED.description),
       updated_at = now()
     WHERE (edition_identifier_info.format IS NULL AND EXCLUDED.format IS NOT NULL)
        OR (edition_identifier_info.language IS NULL AND EXCLUDED.language IS NOT NULL)
        OR (edition_identifier_info.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL)
        OR (edition_identifier_info.pages IS NULL AND EXCLUDED.pages IS NOT NULL)
        OR (edition_identifier_info.description IS NULL AND EXCLUDED.description IS NOT NULL)`,
    [
      uri,
      identifier.issuer,
      identifier.value,
      claims.format,
      claims.language,
      claims.publishedDate,
      claims.pages,
      claims.description
    ]
  );
}

async function linkContributors(client, uri, contributors, authority) {
  let position = 1;
  for (const contributor of contributors ?? []) {
    // Lexicon-shaped callers send `displayName`; provider candidates and the
    // internal admin transport use `name`. Accept both so old and new clients
    // ingest the same rows.
    const displayName =
      typeof contributor?.displayName === 'string' && contributor.displayName.trim() !== ''
        ? contributor.displayName
        : typeof contributor?.name === 'string' && contributor.name.trim() !== ''
          ? contributor.name
          : undefined;
    if (!displayName) continue;
    // `nameInverted` is provider metadata, not identity: an ISBNdb name owns
    // it, but the manual editor also writes it. Fill it only when the row does
    // not already have one so a curation edit is never overwritten.
    const nameInverted =
      typeof contributor?.nameInverted === 'string' && contributor.nameInverted.trim() !== ''
        ? contributor.nameInverted
        : null;
    const description = clippedText(contributor.description, DESCRIPTION_LIMITS) ?? null;
    const identifiers = JSON.stringify(
      Array.isArray(contributor.identifiers) ? contributor.identifiers : []
    );
    const inserted = await client.query(
      `INSERT INTO contributors (name, name_inverted, description, identifiers, at_uri)
       VALUES ($1, $2, $3, $4::jsonb, 'at://' || $5 || '/' || $6 || '/' || editions_next_tid())
       ON CONFLICT (lower(name), identifiers) DO UPDATE SET
         name = EXCLUDED.name,
         name_inverted = COALESCE(NULLIF(contributors.name_inverted, ''), EXCLUDED.name_inverted),
         description = COALESCE(NULLIF(btrim(contributors.description), ''), EXCLUDED.description),
         at_uri = COALESCE(contributors.at_uri, EXCLUDED.at_uri)
       RETURNING id, at_uri`,
      [displayName, nameInverted, description, identifiers, authority, CONTRIBUTOR_COLLECTION]
    );
    const contributorId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (edition_uri, position) DO UPDATE SET
         contributor_id = EXCLUDED.contributor_id,
         role = EXCLUDED.role,
         ref = EXCLUDED.ref`,
      [
        uri,
        contributorId,
        position,
        normalizeContributorRole(contributor.role ?? DEFAULT_CONTRIBUTOR_ROLE),
        contributor.ref ?? null
      ]
    );
    position += 1;
  }
}

// The publisher is credited by the identifiers the candidate supplied, not by
// the edition: two ISBNs may come from different imprints, and the ordered
// per-edition list (`edition_publishers_shape`) is what the record publishes.
async function linkPublisher(client, uri, publisher, identifiers, authority) {
  if (typeof publisher?.name !== 'string' || publisher.name.trim() === '') return;
  const identifiersJson = JSON.stringify(
    Array.isArray(publisher.identifiers) ? publisher.identifiers : []
  );
  const inserted = await client.query(
    `INSERT INTO publishers (name, identifiers, at_uri)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid())
     ON CONFLICT (lower(name), identifiers) DO UPDATE SET
       name = EXCLUDED.name,
       at_uri = COALESCE(publishers.at_uri, EXCLUDED.at_uri)
     RETURNING id, at_uri`,
    [publisher.name, identifiersJson, authority, PUBLISHER_COLLECTION]
  );
  await client.query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     SELECT $1, t.issuer, t.value, $2, 1
       FROM unnest($3::text[], $4::text[]) AS t(issuer, value)
     ON CONFLICT (edition_uri, issuer, value, position) DO UPDATE
       SET publisher_id = EXCLUDED.publisher_id`,
    [
      uri,
      inserted.rows[0].id,
      identifiers.map((identifier) => identifier.issuer),
      identifiers.map((identifier) => identifier.value)
    ]
  );
}

export function createIngest({ pool, publisherDid, publisherHost }) {
  // The URI authority is the publisher identity, not necessarily a did:web
  // host: a did:plc deployment must mint records into the same repo it
  // publishes to. `publisherHost` remains for callers that only know the host.
  const authority = publisherDid || (publisherHost ? `did:web:${publisherHost}` : undefined);
  if (!authority) {
    throw new Error(
      'publisherDid is required to mint edition URIs (or publisherHost for a did:web authority)'
    );
  }

  return async function ingest(candidate) {
    const identifiers = normalizedIdentifiers(candidate);
    if (identifiers.length === 0) return undefined;

    // Each identifier carries its own shape claim: the edition's public shape is
    // their union, so a provider fill must never overwrite another identifier's
    // claim (or a curator's edit).
    const claims = {
      format: candidate.format ?? null,
      language: candidate.language ?? null,
      publishedDate: candidate.publishedDate ?? null,
      pages: candidate.pages ?? null,
      description: candidate.description ?? null
    };
    const hasClaims = Object.values(claims).some((value) => value !== null && value !== '');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let uri = await existingByIdentifiers(client, identifiers);
      let created = false;

      if (!uri) {
        // Identity is the identifier bag, never the rkey: every new edition
        // mints a TID. A retry only covers the astronomically unlikely TID
        // collision, where the microsecond/sequence pair is already taken.
        for (let attempt = 0; !uri && attempt < 5; attempt += 1) {
          const rkey = await nextTid(client);
          uri = editionUri(authority, rkey);
          created = await insertEdition(client, uri, rkey, candidate);
          if (!created) uri = undefined;
        }
        if (!uri) throw new Error('could not mint a unique edition rkey (TID collision)');
      }

      if (!created) await fillMissingFields(client, uri, candidate);

      for (const identifier of identifiers) {
        await client.query(
          `INSERT INTO edition_identifiers (edition_uri, issuer, value)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [uri, identifier.issuer, identifier.value]
        );
        if (hasClaims) await fillIdentifierClaims(client, uri, identifier, claims);
      }

      await linkContributors(client, uri, candidate.contributors, authority);
      await linkPublisher(client, uri, candidate.publisher, identifiers, authority);

      await client.query('COMMIT');
      return { uri, created };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}
