/**
 * Build the `community.lexicon.media.book.edition` record value from catalog
 * rows. The catalog stores contributors, publishers and identifiers as entities
 * linked through join tables; the record inlines them, so this is the only place
 * that stitches those rows back into the lexicon shape.
 *
 * The vendored lexicon is the contract: `edition.json` (record) plus
 * `defs.json` (`#identifier`, `#contributor`, `#publisher`). `coverUrl` is a URL
 * only — catalog editions never embed blobs, because the publisher repo would
 * otherwise have to own every cover byte.
 */

import { normalizeContributorRole } from './contributor-roles.js';
import { httpUrl, identifier, identifierArray, nonEmptyString } from './record-fields.js';

export class EditionRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditionRecordError';
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function seriesValue(value) {
  const series = value;
  if (series === null || typeof series !== 'object') return undefined;
  const name = nonEmptyString(series.name);
  if (!name) return undefined;
  return {
    name,
    ...(nonEmptyString(series.position) ? { position: series.position } : {}),
    ...(nonEmptyString(series.display) ? { display: series.display } : {})
  };
}

function contributorValue(row) {
  const displayName = nonEmptyString(row.name);
  if (!displayName) return undefined;
  const nameInverted = nonEmptyString(row.name_inverted);
  const identifiers = identifierArray(row.identifiers);
  return {
    displayName,
    ...(nameInverted ? { nameInverted } : {}),
    role: normalizeContributorRole(row.role),
    ...(identifiers.length > 0 ? { identifiers } : {}),
    ...(nonEmptyString(row.ref) ? { ref: row.ref } : {})
  };
}

function publisherValue(row) {
  if (!row) return undefined;
  const name = nonEmptyString(row.name);
  if (!name) return undefined;
  const identifiers = identifierArray(row.identifiers);
  return {
    name,
    ...(identifiers.length > 0 ? { identifiers } : {}),
    // `defs#publisher.ref` is the catalog's local mirror of
    // `defs#contributor.ref`: optional enrichment, a plain at-uri, and never a
    // strongRef (a CID would force an edition republish on every entity edit).
    ...(nonEmptyString(row.ref) ? { ref: row.ref } : {})
  };
}

function createdAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EditionRecordError('edition has no usable created_at');
  }
  return date.toISOString();
}

/**
 * @param {object} input
 * @param {object} input.edition        row from `editions`
 * @param {object[]} input.identifiers  rows from `edition_identifiers` (ordered)
 * @param {object[]} input.contributors rows joined to `contributors` (position order)
 * @param {object} [input.publisher]    row joined to `publishers` (lowest position)
 */
export function buildEditionRecord({ edition, identifiers = [], contributors = [], publisher }) {
  if (!edition) throw new EditionRecordError('edition row is missing');

  const title = nonEmptyString(edition.title);
  if (!title) throw new EditionRecordError(`edition ${edition.uri ?? ''} has no title`);

  const bag = [];
  const seen = new Set();
  for (const row of identifiers) {
    const value = identifier({ issuer: row.issuer, value: row.value });
    if (!value) continue;
    const key = `${value.issuer}\u0000${value.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bag.push(value);
  }
  if (bag.length === 0) {
    // `identifiers` has minLength 1 in the lexicon; publishing without one
    // produces a record no conforming client can read.
    throw new EditionRecordError(
      `edition ${edition.uri ?? ''} has no identifiers; refusing to publish an invalid record`
    );
  }

  const record = {
    title,
    identifiers: bag,
    contributors: contributors.map(contributorValue).filter(Boolean),
    createdAt: createdAt(edition.created_at)
  };

  const subtitle = nonEmptyString(edition.subtitle);
  if (subtitle) record.subtitle = subtitle;
  const language = nonEmptyString(edition.language);
  if (language) record.language = language;
  const publishedDate = nonEmptyString(edition.published_date);
  if (publishedDate) record.publishedDate = publishedDate;

  const publisherRecord = publisherValue(publisher);
  if (publisherRecord) record.publisher = publisherRecord;

  const format = nonEmptyString(edition.format);
  if (format) record.format = format;
  const pages = positiveInteger(edition.pages);
  if (pages !== undefined) record.pages = pages;
  const durationSeconds = positiveInteger(edition.duration_seconds);
  if (durationSeconds !== undefined) record.durationSeconds = durationSeconds;
  const chapters = positiveInteger(edition.chapters);
  if (chapters !== undefined) record.chapters = chapters;

  const series = seriesValue(edition.series);
  if (series) record.series = series;

  const bookEdition = nonEmptyString(edition.book_edition);
  if (bookEdition) record.bookEdition = bookEdition;
  const description = nonEmptyString(edition.description);
  if (description) record.description = description;
  const coverUrl = httpUrl(edition.cover_url);
  if (coverUrl) record.coverUrl = coverUrl;

  return record;
}
