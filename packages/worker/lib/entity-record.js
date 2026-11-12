/**
 * Build the `net.olamaelcu.livtet.biblio.contributor` and `.publisher` record
 * values from catalog rows.
 *
 * Like the edition builder, this is the only place an entity row becomes a
 * lexicon value. The record types are catalog-publisher records: the fields
 * mirror `community.lexicon.media.book.defs#contributor` / `#publisher` with the
 * extra descriptive metadata, and `createdAt` is the catalog row's creation
 * time. `$type` is not emitted: `com.atproto.repo.applyWrites` receives the
 * collection separately and the PDS stamps it, which is what the 2,313 already
 * published edition records do.
 *
 * Validation is strict on purpose. A bad value parks the outbox row with a
 * reason an operator can read, instead of publishing a record no conforming
 * client can use.
 */

import {
  canonicalIdentifiers,
  createdAtIso,
  httpUrl,
  isoCalendarDate,
  nonEmptyString
} from './record-fields.js';

export const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
export const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

export const ENTITY_COLLECTIONS = Object.freeze([
  CONTRIBUTOR_COLLECTION,
  PUBLISHER_COLLECTION
]);

export class EntityRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EntityRecordError';
  }
}

function optionalDate(row, field, label) {
  const raw = row[field];
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = isoCalendarDate(raw);
  if (!value) {
    throw new EntityRecordError(
      `${label} has an invalid ${field} date ${JSON.stringify(raw)}; ` +
        'expected a real calendar date in YYYY-MM-DD format'
    );
  }
  return value;
}

function optionalImage(row, label) {
  const raw = row.image_url;
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = httpUrl(raw);
  if (!value) {
    throw new EntityRecordError(
      `${label} has an invalid image_url ${JSON.stringify(raw)}; expected an http(s) URL`
    );
  }
  return value;
}

/**
 * @param {object} input
 * @param {object} input.contributor row from `contributors`
 */
export function buildContributorRecord({ contributor }) {
  if (!contributor) throw new EntityRecordError('contributor row is missing');

  const displayName = nonEmptyString(contributor.name);
  if (!displayName) {
    throw new EntityRecordError(
      `contributor ${contributor.at_uri ?? contributor.id ?? ''} has no display name`
    );
  }
  const createdAt = createdAtIso(contributor.created_at);
  if (!createdAt) {
    throw new EntityRecordError(
      `contributor ${contributor.at_uri ?? contributor.id ?? ''} has no usable created_at`
    );
  }

  const label = `contributor ${contributor.at_uri ?? contributor.id ?? ''}`.trim();
  const record = { displayName, createdAt };

  const nameInverted = nonEmptyString(contributor.name_inverted);
  if (nameInverted) record.nameInverted = nameInverted;
  const description = nonEmptyString(contributor.description);
  if (description) record.description = description;
  const imageUrl = optionalImage(contributor, label);
  if (imageUrl) record.imageUrl = imageUrl;
  const identifiers = canonicalIdentifiers(contributor.identifiers);
  if (identifiers.length > 0) record.identifiers = identifiers;
  const born = optionalDate(contributor, 'born', label);
  if (born) record.born = born;
  const died = optionalDate(contributor, 'died', label);
  if (died) record.died = died;

  return record;
}

/**
 * @param {object} input
 * @param {object} input.publisher row from `publishers`
 */
export function buildPublisherRecord({ publisher }) {
  if (!publisher) throw new EntityRecordError('publisher row is missing');

  const name = nonEmptyString(publisher.name);
  if (!name) {
    throw new EntityRecordError(
      `publisher ${publisher.at_uri ?? publisher.id ?? ''} has no name`
    );
  }
  const createdAt = createdAtIso(publisher.created_at);
  if (!createdAt) {
    throw new EntityRecordError(
      `publisher ${publisher.at_uri ?? publisher.id ?? ''} has no usable created_at`
    );
  }

  const label = `publisher ${publisher.at_uri ?? publisher.id ?? ''}`.trim();
  const record = { name, createdAt };

  const description = nonEmptyString(publisher.description);
  if (description) record.description = description;
  const imageUrl = optionalImage(publisher, label);
  if (imageUrl) record.imageUrl = imageUrl;
  const identifiers = canonicalIdentifiers(publisher.identifiers);
  if (identifiers.length > 0) record.identifiers = identifiers;
  const started = optionalDate(publisher, 'started', label);
  if (started) record.started = started;
  const ended = optionalDate(publisher, 'ended', label);
  if (ended) record.ended = ended;

  return record;
}

/** Build by outbox collection; unknown collections throw. */
export function buildEntityRecord(collection, row) {
  if (collection === CONTRIBUTOR_COLLECTION) return buildContributorRecord({ contributor: row });
  if (collection === PUBLISHER_COLLECTION) return buildPublisherRecord({ publisher: row });
  throw new EntityRecordError(`not an entity collection: ${collection}`);
}
