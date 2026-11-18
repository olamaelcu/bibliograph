// The record type is `community.lexicon.media.book.edition`: the same
// collection the outbox and `pds-publish` write to, so a catalog URI is
// resolvable through `com.atproto.repo.getRecord`.
import { DEFAULT_CONTRIBUTOR_ROLE, normalizeContributorRole } from './contributor-roles.js';
import { CONTRIBUTOR_COLLECTION, PUBLISHER_COLLECTION } from './entity-record.js';
import { canonicalIdentifiersJson, clippedText } from './record-fields.js';

const COLLECTION = 'community.lexicon.media.book.edition';

/**
 * Postgres deadlocks and serialization failures are safe to re-run here: one
 * candidate is one transaction, and every statement it runs is an upsert or an
 * `ON CONFLICT DO NOTHING`, so a rolled-back attempt leaves nothing behind.
 * `40P01` is a deadlock, `40001` a serialization failure; nothing else retries.
 */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const TRANSACTION_ATTEMPTS = 3;

// Lexicon bounds for the contributor record's description (8192 bytes / 1024 graphemes).
const DESCRIPTION_LIMITS = { maxGraphemes: 1024, maxBytes: 8192 };

/**
 * The names a feed uses as a placeholder for "nobody is credited".
 *
 * Goodreads and ISBNdb both answer `Unknown Author` for a volume they cannot
 * attribute, and before this list it travelled the ordinary path: the upsert
 * minted a contributor row, gave it an `at_uri` and published it as an entity
 * record that thousands of editions credited. It must not become an entity, so
 * it is dropped at preparation time — before it takes a position on the
 * edition.
 */
const PLACEHOLDER_CONTRIBUTOR_NAMES = new Set(['unknown author']);

/**
 * The form a name is compared in for the placeholder list above: trimmed,
 * internal whitespace collapsed, lower-cased. Feeds vary the case and the
 * spacing of the same placeholder.
 *
 * This is not the identity rule — the `(lower(name), identifiers)` arbiter is
 * (see `contributorKey`), and two genuinely different spellings stay different
 * contributors.
 */
function normalizedContributorName(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

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
       JOIN books e ON e.uri = i.edition_uri
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
    `INSERT INTO books (
       uri, rkey, title, subtitle, chapters, series,
       book_edition, cover_url, created_at, indexed_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now(), now())
     ON CONFLICT (uri) DO NOTHING
     RETURNING uri`,
    [
      uri,
      rkey,
      title,
      candidate.subtitle ?? null,
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
    chapters: candidate.chapters ?? null,
    series: candidate.series ? JSON.stringify(candidate.series) : null,
    bookEdition: candidate.bookEdition ?? null,
    coverUrl: candidate.coverUrl ?? null
  };

  await client.query(
    `UPDATE books SET
       subtitle = COALESCE(subtitle, $2),
       chapters = COALESCE(chapters, $3),
       series = COALESCE(series, $4::jsonb),
       book_edition = COALESCE(book_edition, $5),
       cover_url = COALESCE(cover_url, $6)
     WHERE uri = $1
       AND (
         (subtitle IS NULL AND $2::text IS NOT NULL)
         OR (chapters IS NULL AND $3::int IS NOT NULL)
         OR (series IS NULL AND $4::jsonb IS NOT NULL)
         OR (book_edition IS NULL AND $5::text IS NOT NULL)
         OR (cover_url IS NULL AND $6::text IS NOT NULL)
       )`,
    [
      uri,
      values.subtitle,
      values.chapters,
      values.series,
      values.bookEdition,
      values.coverUrl
    ]
  );

  // A rejected URL is terminal for that URL alone: when a provider offers a new
  // cover, the ledger has to let the next sweep claim the edition again. An
  // outstanding claim (`outcome IS NULL`) is left alone — it is in flight.
  if (values.coverUrl !== null) {
    await client.query(
      `DELETE FROM edition_cover_fetches
        WHERE edition_uri = $1 AND outcome = 'rejected'`,
      [uri]
    );
  }
}

// Provider data fills gaps only: an existing claim field is a curator edit or a
// more specific record, and the `WHERE` keeps a re-ingest from rewriting the row
// (which would re-queue the edition for no change).
/** Bundle the row's shape claim into the format-sensitive `extent` object. */
function claimExtent(claims) {
  const extent = {};
  if (claims.format !== null && claims.format !== undefined) {
    const format = String(claims.format).trim();
    if (format !== '') extent.format = format;
  }
  const pages = claims.pages === null || claims.pages === undefined ? NaN : Number(claims.pages);
  if (Number.isInteger(pages) && pages >= 0) extent.pages = pages;
  const duration =
    claims.durationSeconds === null || claims.durationSeconds === undefined
      ? NaN
      : Number(claims.durationSeconds);
  if (Number.isInteger(duration) && duration >= 0) extent.durationSeconds = duration;
  return Object.keys(extent).length === 0 ? null : extent;
}

/**
 * Every identifier row of the candidate in one statement.
 *
 * The loop this replaces paid one round trip per identifier, and identity is
 * the identifier bag: a candidate that arrives with eight pairs cost sixteen
 * statements before any work was done. `unnest` carries the whole bag, and the
 * arbiter stays bare `ON CONFLICT DO NOTHING` — an existing pair is left as it
 * is, exactly as the per-row insert did.
 */
async function insertIdentifiers(client, uri, identifiers) {
  await client.query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     SELECT $1, t.issuer, t.value
       FROM unnest($2::text[], $3::text[]) AS t(issuer, value)
     ON CONFLICT DO NOTHING`,
    [
      uri,
      identifiers.map((identifier) => identifier.issuer),
      identifiers.map((identifier) => identifier.value)
    ]
  );
}

/**
 * The identifier rows' shape claims in one statement.
 *
 * Each scoped identifier gets the candidate's own claims, which are the same
 * for all of them, so the arrays repeat one value: what differs per row is only
 * the `(issuer, value)` it attributes. The `DO UPDATE … WHERE` is unchanged — a
 * stored claim is never overwritten, and a re-ingest that would fill nothing
 * leaves the row (and its `updated_at`, and the outbox row it triggers) alone.
 */
async function fillIdentifierClaims(client, uri, identifiers, claims) {
  const extent = claimExtent(claims);
  const extentJson = extent === null ? null : JSON.stringify(extent);
  await client.query(
    `INSERT INTO edition_identifier_info
           (edition_uri, issuer, value, language, published_date, description, extent)
     SELECT $1, t.issuer, t.value, t.language, t.published_date, t.description, t.extent::jsonb
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS t(issuer, value, language, published_date, description, extent)
     ON CONFLICT (edition_uri, issuer, value) DO UPDATE SET
       language = COALESCE(edition_identifier_info.language, EXCLUDED.language),
       published_date = COALESCE(edition_identifier_info.published_date, EXCLUDED.published_date),
       description = COALESCE(edition_identifier_info.description, EXCLUDED.description),
       extent = normalize_identifier_extent(
         COALESCE(EXCLUDED.extent, '{}'::jsonb) || COALESCE(edition_identifier_info.extent, '{}'::jsonb)
       ),
       updated_at = now()
     WHERE (edition_identifier_info.language IS NULL AND EXCLUDED.language IS NOT NULL)
        OR (edition_identifier_info.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL)
        OR (edition_identifier_info.description IS NULL AND EXCLUDED.description IS NOT NULL)
        OR normalize_identifier_extent(
             COALESCE(EXCLUDED.extent, '{}'::jsonb) || COALESCE(edition_identifier_info.extent, '{}'::jsonb)
           ) IS DISTINCT FROM edition_identifier_info.extent`,
    [
      uri,
      identifiers.map((identifier) => identifier.issuer),
      identifiers.map((identifier) => identifier.value),
      identifiers.map(() => claims.language ?? null),
      identifiers.map(() => claims.publishedDate ?? null),
      identifiers.map(() => claims.description ?? null),
      identifiers.map(() => extentJson)
    ]
  );
}

/**
 * The key a returned contributor row is matched back to its credits by.
 *
 * `(lower(name), identifiers)` is the identity the arbiter uses, so it is the
 * identity the mapping uses too: two case variants of one name are one row, and
 * two identifier bags are two. `jsonb` normalises key order but not array
 * order, and `canonicalIdentifiersJson` already put the array in canonical
 * order, so re-canonicalising the value Postgres hands back reproduces the
 * string that was sent.
 */
function contributorKey(name, identifiers) {
  return `${String(name).toLowerCase()}\u0000${canonicalIdentifiersJson(identifiers)}`;
}

async function linkContributors(client, uri, contributors, authority) {
  const credits = [];
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
    // A feed's placeholder is not a person: skip it before it becomes a row.
    // Positions are assigned from the accepted list below, so the next real
    // contributor takes the next position and an edition whose credits are all
    // placeholders simply carries none.
    if (PLACEHOLDER_CONTRIBUTOR_NAMES.has(normalizedContributorName(displayName))) continue;
    // `nameInverted` is provider metadata, not identity: an ISBNdb name owns
    // it, but the manual editor also writes it. Fill it only when the row does
    // not already have one so a curation edit is never overwritten.
    const nameInverted =
      typeof contributor?.nameInverted === 'string' && contributor.nameInverted.trim() !== ''
        ? contributor.nameInverted
        : null;
    const description = clippedText(contributor.description, DESCRIPTION_LIMITS) ?? null;
    const identifiers = canonicalIdentifiersJson(contributor.identifiers);
    credits.push({
      name: displayName,
      nameInverted,
      description,
      identifiers,
      // Positions count accepted contributors only, as the per-credit loop did.
      position: credits.length + 1,
      role: normalizeContributorRole(contributor.role ?? DEFAULT_CONTRIBUTOR_ROLE),
      ref: contributor.ref ?? null
    });
  }
  if (credits.length === 0) return;

  // Identity first, once for the edition: the per-credit loop paid two
  // statements per contributor, and the only column the credits need back is
  // the id.
  //
  // One person named twice in one statement would make the arbiter "affect a
  // row a second time", so the input is grouped by the same `(lower(name),
  // identifiers)` the arbiter keys on. Within a group the merge rules are the
  // ones the per-credit upserts applied in order: `name` was set by every
  // upsert, so the last occurrence wins; `name_inverted` and `description` were
  // only filled, so the first non-null occurrence wins.
  const identities = await client.query(
    `WITH input AS (
       SELECT t.name, t.name_inverted, t.description, t.identifiers, t.ord
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[])
                WITH ORDINALITY AS t(name, name_inverted, description, identifiers, ord)
     ), grouped AS (
       SELECT (array_agg(name ORDER BY ord DESC))[1] AS name,
              (array_agg(name_inverted ORDER BY ord)
                 FILTER (WHERE name_inverted IS NOT NULL))[1] AS name_inverted,
              (array_agg(description ORDER BY ord)
                 FILTER (WHERE description IS NOT NULL))[1] AS description,
              (array_agg(identifiers ORDER BY ord))[1] AS identifiers
         FROM input
        GROUP BY lower(name), identifiers
     )
     INSERT INTO contributors (name, name_inverted, description, identifiers, at_uri)
     SELECT g.name, g.name_inverted, g.description, g.identifiers::jsonb,
            'at://' || $1 || '/' || $2 || '/' || editions_next_tid()
       FROM grouped g
     ON CONFLICT (lower(name), identifiers) DO UPDATE SET
       name = EXCLUDED.name,
       name_inverted = COALESCE(NULLIF(contributors.name_inverted, ''), EXCLUDED.name_inverted),
       description = COALESCE(NULLIF(btrim(contributors.description), ''), EXCLUDED.description),
       at_uri = COALESCE(contributors.at_uri, EXCLUDED.at_uri)
     RETURNING id, name, identifiers`,
    [
      authority,
      CONTRIBUTOR_COLLECTION,
      credits.map((credit) => credit.name),
      credits.map((credit) => credit.nameInverted),
      credits.map((credit) => credit.description),
      credits.map((credit) => credit.identifiers)
    ]
  );

  const idByKey = new Map();
  for (const row of identities.rows) {
    idByKey.set(contributorKey(row.name, row.identifiers), row.id);
  }
  const rows = credits.map((credit) => {
    const contributorId = idByKey.get(contributorKey(credit.name, JSON.parse(credit.identifiers)));
    // The upsert returns every row it inserted or updated, so a miss means this
    // mapping and the arbiter disagree about identity — never a silent null
    // contributor on the edition.
    if (contributorId === undefined) {
      throw new Error(`contributor identity did not resolve for ${credit.name}`);
    }
    return { ...credit, contributorId };
  });

  await client.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
     SELECT $1, t.contributor_id, t.position, t.role, t.ref
       FROM unnest($2::bigint[], $3::int[], $4::text[], $5::text[])
              AS t(contributor_id, position, role, ref)
     ON CONFLICT (edition_uri, position) DO UPDATE SET
       contributor_id = EXCLUDED.contributor_id,
       role = EXCLUDED.role,
       ref = EXCLUDED.ref`,
    [
      uri,
      rows.map((row) => row.contributorId),
      rows.map((row) => row.position),
      rows.map((row) => row.role),
      rows.map((row) => row.ref)
    ]
  );
}

// The publisher is credited by the identifiers the candidate supplied, not by
// the edition: two ISBNs may come from different imprints, and the ordered
// per-edition list (`edition_publishers_shape`) is what the record publishes.
async function linkPublisher(client, uri, publisher, identifiers, authority) {
  if (typeof publisher?.name !== 'string' || publisher.name.trim() === '') return;
  const identifiersJson = canonicalIdentifiersJson(publisher.identifiers);
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

  /**
   * One candidate on a client the caller already owns.
   *
   * It opens no transaction of its own: the Bookhive import gives each record
   * its own transaction, so a candidate that throws is rolled back to the
   * caller's savepoint rather than taking the page's other records with it.
   *
   * The candidate's cost is a fixed number of statements, not one per identifier
   * and one per contributor: every loop here is an `unnest` over the whole list.
   */
  async function ingestOn(client, candidate, prepared) {
    const { identifiers, scoped, claims, hasClaims } = prepared;

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

    // Two statements for the whole bag instead of two per identifier. The
    // identifier rows go first because the claim rows carry a foreign key to
    // them.
    await insertIdentifiers(client, uri, identifiers);
    const claimed = hasClaims ? identifiers.filter(scoped) : [];
    if (claimed.length > 0) await fillIdentifierClaims(client, uri, claimed, claims);

    await linkContributors(client, uri, candidate.contributors, authority);
    await linkPublisher(client, uri, candidate.publisher, identifiers.filter(scoped), authority);

    return { uri, created };
  }

  /**
   * What one candidate resolves to, validated — no connection, no writes.
   *
   * Split out so a malformed candidate is rejected before a transaction is
   * opened: the scope check on `sourceIdentifier` is a candidate-shape rule, and
   * the import must be able to drop such a candidate without paying for a client.
   */
  function prepare(candidate) {
    const identifiers = normalizedIdentifiers(candidate);
    if (identifiers.length === 0) return null;

    // A candidate may name the identifier it came through: its claims and its
    // publisher credit then describe that identifier alone. A third-party
    // catalog (or a provider answering for one of several identifiers) knows
    // nothing about the other pairs in the bag, so attributing its data to them
    // would let one source's publisher overwrite another's on a shared edition.
    const source = candidate.sourceIdentifier ?? null;
    if (source !== null) {
      const known = identifiers.some(
        (identifier) => identifier.issuer === source.issuer && identifier.value === source.value
      );
      if (!known) {
        throw new Error(
          `sourceIdentifier ${source.issuer}:${source.value} is not one of the candidate's identifiers`
        );
      }
    }
    const scoped = (identifier) =>
      source === null ||
      (identifier.issuer === source.issuer && identifier.value === source.value);

    // Each identifier carries its own shape claim: the edition's public shape is
    // their union, so a provider fill must never overwrite another identifier's
    // claim (or a curator's edit).
    const claims = {
      format: candidate.format ?? null,
      language: candidate.language ?? null,
      publishedDate: candidate.publishedDate ?? null,
      pages: candidate.pages ?? null,
      description: candidate.description ?? null,
      durationSeconds: candidate.durationSeconds ?? null
    };
    const hasClaims = Object.values(claims).some((value) => value !== null && value !== '');
    return { identifiers, scoped, claims, hasClaims };
  }

  /**
   * One candidate on its own transaction, for the callers that write a single
   * edition (`admin.js`, `seed.js`).
   */
  return async function ingest(candidate, options = {}) {
    // Validated before a connection is taken, so a malformed candidate never
    // opens a transaction at all.
    const prepared = prepare(candidate);
    if (prepared === null) return undefined;
    if (options !== undefined && options !== null && options.client) {
      return ingestOn(options.client, candidate, prepared);
    }
    const client = await pool.connect();
    try {
      // `linkPublisher` and the contributor upserts take their row locks in
      // whatever order the candidate names them, so two candidates sharing a
      // publisher deadlock against each other (measured: `deadlock detected` in
      // linkPublisher, which crash-looped this worker until systemd gave up and
      // left the catalog unindexed). Retrying the transaction costs a few
      // statements and keeps one deadlock from failing the whole task.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.query('BEGIN');
          const result = await ingestOn(client, candidate, prepared);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (!RETRYABLE_SQLSTATES.has(error?.code) || attempt >= TRANSACTION_ATTEMPTS) {
            throw error;
          }
          // Jittered so two workers that deadlocked together do not retry in
          // step and deadlock again on the same rows.
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * attempt + Math.random() * 40)
          );
        }
      }
    } finally {
      client.release();
    }
  };
}
