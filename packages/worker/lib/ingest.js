// The record type is `community.lexicon.media.book.edition`: the same
// collection the outbox and `pds-publish` write to, so a catalog URI is
// resolvable through `com.atproto.repo.getRecord`.
import { DEFAULT_CONTRIBUTOR_ROLE, normalizeContributorRole } from './contributor-roles.js';
import { CONTRIBUTOR_COLLECTION, PUBLISHER_COLLECTION } from './entity-record.js';

const COLLECTION = 'community.lexicon.media.book.edition';

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
       uri, rkey, title, subtitle, language, published_date, format, pages,
       duration_seconds, chapters, series, book_edition, description, cover_url,
       created_at, indexed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, now(), now())
     ON CONFLICT (uri) DO NOTHING
     RETURNING uri`,
    [
      uri,
      rkey,
      title,
      candidate.subtitle ?? null,
      candidate.language ?? null,
      candidate.publishedDate ?? null,
      candidate.format ?? null,
      candidate.pages ?? null,
      candidate.durationSeconds ?? null,
      candidate.chapters ?? null,
      series,
      candidate.bookEdition ?? null,
      candidate.description ?? null,
      candidate.coverUrl ?? null
    ]
  );
  return inserted.rowCount > 0;
}

async function fillMissingFields(client, uri, candidate) {
  const values = {
    subtitle: candidate.subtitle ?? null,
    language: candidate.language ?? null,
    publishedDate: candidate.publishedDate ?? null,
    format: candidate.format ?? null,
    pages: candidate.pages ?? null,
    durationSeconds: candidate.durationSeconds ?? null,
    chapters: candidate.chapters ?? null,
    series: candidate.series ? JSON.stringify(candidate.series) : null,
    bookEdition: candidate.bookEdition ?? null,
    description: candidate.description ?? null,
    coverUrl: candidate.coverUrl ?? null
  };

  await client.query(
    `UPDATE editions SET
       subtitle = COALESCE(subtitle, $2),
       language = COALESCE(language, $3),
       published_date = COALESCE(published_date, $4),
       format = COALESCE(format, $5),
       pages = COALESCE(pages, $6),
       duration_seconds = COALESCE(duration_seconds, $7),
       chapters = COALESCE(chapters, $8),
       series = COALESCE(series, $9::jsonb),
       book_edition = COALESCE(book_edition, $10),
       description = COALESCE(description, $11),
       cover_url = COALESCE(cover_url, $12)
     WHERE uri = $1
       AND (
         (subtitle IS NULL AND $2::text IS NOT NULL)
         OR (language IS NULL AND $3::text IS NOT NULL)
         OR (published_date IS NULL AND $4::text IS NOT NULL)
         OR (format IS NULL AND $5::text IS NOT NULL)
         OR (pages IS NULL AND $6::int IS NOT NULL)
         OR (duration_seconds IS NULL AND $7::int IS NOT NULL)
         OR (chapters IS NULL AND $8::int IS NOT NULL)
         OR (series IS NULL AND $9::jsonb IS NOT NULL)
         OR (book_edition IS NULL AND $10::text IS NOT NULL)
         OR (description IS NULL AND $11::text IS NOT NULL)
         OR (cover_url IS NULL AND $12::text IS NOT NULL)
       )`,
    [
      uri,
      values.subtitle,
      values.language,
      values.publishedDate,
      values.format,
      values.pages,
      values.durationSeconds,
      values.chapters,
      values.series,
      values.bookEdition,
      values.description,
      values.coverUrl
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
    const identifiers = JSON.stringify(
      Array.isArray(contributor.identifiers) ? contributor.identifiers : []
    );
    const inserted = await client.query(
      `INSERT INTO contributors (name, name_inverted, identifiers, at_uri)
       VALUES ($1, $2, $3::jsonb, 'at://' || $4 || '/' || $5 || '/' || editions_next_tid())
       ON CONFLICT (lower(name), identifiers) DO UPDATE SET
         name = EXCLUDED.name,
         name_inverted = COALESCE(NULLIF(contributors.name_inverted, ''), EXCLUDED.name_inverted),
         at_uri = COALESCE(contributors.at_uri, EXCLUDED.at_uri)
       RETURNING id, at_uri`,
      [displayName, nameInverted, identifiers, authority, CONTRIBUTOR_COLLECTION]
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

async function linkPublisher(client, uri, publisher, authority) {
  if (typeof publisher?.name !== 'string' || publisher.name.trim() === '') return;
  const identifiers = JSON.stringify(Array.isArray(publisher.identifiers) ? publisher.identifiers : []);
  const inserted = await client.query(
    `INSERT INTO publishers (name, identifiers, at_uri)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid())
     ON CONFLICT (lower(name), identifiers) DO UPDATE SET
       name = EXCLUDED.name,
       at_uri = COALESCE(publishers.at_uri, EXCLUDED.at_uri)
     RETURNING id, at_uri`,
    [publisher.name, identifiers, authority, PUBLISHER_COLLECTION]
  );
  await client.query(
    `INSERT INTO edition_publishers (edition_uri, publisher_id, position)
     VALUES ($1, $2, 1)
     ON CONFLICT (edition_uri, position) DO UPDATE SET publisher_id = EXCLUDED.publisher_id`,
    [uri, inserted.rows[0].id]
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
      }

      await linkContributors(client, uri, candidate.contributors, authority);
      await linkPublisher(client, uri, candidate.publisher, authority);

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
