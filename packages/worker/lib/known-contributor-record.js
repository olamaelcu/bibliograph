/**
 * Build the `net.olamaelcu.livtet.biblio.knownContributor` record value from a
 * `contributor_identities` row joined to its contributor.
 *
 * This is the published half of a librarian's approval: the contributor record
 * says who the person is, this record says which account proved it. It is a
 * catalog-publisher record like the entity records, so `$type` is not emitted —
 * `com.atproto.repo.applyWrites` receives the collection separately and the PDS
 * stamps it.
 *
 * Strict on purpose, like the other builders: a bad row parks the outbox row
 * with a reason an operator can read, instead of publishing a link that would
 * point at a record of the wrong kind.
 */

import { CONTRIBUTOR_COLLECTION } from './entity-record.js';
import { atUriOf, createdAtIso, nonEmptyString } from './record-fields.js';

export const KNOWN_CONTRIBUTOR_COLLECTION =
  'net.olamaelcu.livtet.biblio.knownContributor';

export class KnownContributorRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KnownContributorRecordError';
  }
}

/** A `did:` string, as the lexicon's `format: did` requires. */
function didOf(value, field) {
  const text = nonEmptyString(value);
  if (!text || !text.startsWith('did:')) {
    throw new KnownContributorRecordError(
      `known contributor link has an invalid ${field} ${JSON.stringify(value)}; expected a DID`
    );
  }
  return text;
}

/**
 * @param {object} row
 * @param {string} row.did              the verified account
 * @param {string} row.contributor     the contributor record's at-uri
 * @param {string} [row.issued_by]     the librarian account that approved it
 * @param {Date|string} row.created_at the binding's creation time
 */
export function buildKnownContributorRecord(row) {
  if (!row) throw new KnownContributorRecordError('contributor identity row is missing');

  const contributor = atUriOf(row.contributor, CONTRIBUTOR_COLLECTION);
  if (!contributor) {
    throw new KnownContributorRecordError(
      `contributor identity ${row.did ?? ''} does not name a ${CONTRIBUTOR_COLLECTION} record ` +
        `(${JSON.stringify(row.contributor)})`
    );
  }
  const subject = didOf(row.did, 'subject');
  const createdAt = createdAtIso(row.created_at);
  if (!createdAt) {
    throw new KnownContributorRecordError(
      `contributor identity ${subject} has no usable created_at`
    );
  }

  const record = { contributor, subject, createdAt };
  // A row written before the librarian sign-in existed, or by a migration, has
  // no issuer; the link is still true, so the field is simply absent.
  if (row.issued_by !== null && row.issued_by !== undefined && row.issued_by !== '') {
    record.issuedBy = didOf(row.issued_by, 'issuedBy');
  }
  return record;
}
