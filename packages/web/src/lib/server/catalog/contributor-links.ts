/**
 * `net.olamaelcu.livtet.biblio.getContributorLink`
 *
 * Two questions with one answer shape:
 *
 *   contributor=<at-uri>  who is verified as this person?  (`identities`)
 *   did=<did>             what is this account?            (`identity`, `claim`)
 *
 * The contributor page asks the first, the reader's own claim panel asks the
 * second, and both arrive in one call so a page render is one round trip. Edge-
 * served like the other entity reads: the catalog tables are the source of the
 * links, and HappyView's `happyview_records` is the source of the claim the reader
 * wrote (its collection is indexed there).
 *
 * Answers are `no-store`: the `did` half is per-viewer.
 */

import {
  CONTRIBUTOR_COLLECTION,
  EntityUriError,
  parseEntityUri,
  type EntityQueryable
} from './entities.ts';

export const GET_CONTRIBUTOR_LINK = 'net.olamaelcu.livtet.biblio.getContributorLink';
export const CONTRIBUTOR_CLAIM_COLLECTION = 'net.olamaelcu.livtet.biblio.contributorClaim';

export type ContributorIdentity = {
  /** AT-URI of the `knownContributor` record this link was published as. */
  uri: string;
  did: string;
  contributor: string;
  createdAt: string;
};

export type ContributorClaimState = 'pending' | 'approved' | 'rejected' | 'revoked';

export type ContributorClaimView = {
  uri: string;
  contributor: string;
  state: ContributorClaimState;
  message?: string;
  createdAt: string;
  decidedAt?: string;
};

export type ContributorLink = {
  identities: ContributorIdentity[];
  identity?: ContributorIdentity;
  claim?: ContributorClaimView;
};

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function identityOf(row: {
  uri: string;
  did: string;
  contributor: string;
  created_at: unknown;
}): ContributorIdentity | null {
  const createdAt = iso(row.created_at);
  if (createdAt === undefined) return null;
  return { uri: row.uri, did: row.did, contributor: row.contributor, createdAt };
}

const IDENTITY_SELECT = `SELECT k.at_uri AS uri, k.did, c.at_uri AS contributor, k.created_at
       FROM contributor_identities k
       JOIN contributors c ON c.id = k.contributor_id`;

/**
 * Answer one or both halves.
 *
 * Throws {@link EntityUriError} for a malformed value or when neither parameter
 * is supplied, which the XRPC layer answers as `InvalidRequest`.
 */
export async function getContributorLink(
  pool: EntityQueryable,
  params: { contributor?: unknown; did?: unknown }
): Promise<ContributorLink> {
  const contributor =
    typeof params.contributor === 'string' ? params.contributor.trim() : '';
  const did = typeof params.did === 'string' ? params.did.trim() : '';

  if (contributor === '' && did === '') {
    throw new EntityUriError('`contributor` or `did` is required');
  }
  if (contributor !== '' && parseEntityUri(contributor, CONTRIBUTOR_COLLECTION) === null) {
    throw new EntityUriError('`contributor` must be a contributor record at-uri');
  }
  if (did !== '' && !DID.test(did)) {
    throw new EntityUriError('`did` must be a DID');
  }

  // Both halves in one round trip; each is skipped when its parameter is absent.
  const [identitiesResult, identityResult] = await Promise.all([
    contributor === ''
      ? null
      : pool.query(`${IDENTITY_SELECT} WHERE c.at_uri = $1 ORDER BY k.created_at`, [
          contributor
        ]),
    did === '' ? null : pool.query(`${IDENTITY_SELECT} WHERE k.did = $1`, [did])
  ]);

  const identities = (identitiesResult?.rows ?? [])
    .map(identityOf)
    .filter((row): row is ContributorIdentity => row !== null);
  const firstIdentity = identityResult?.rows[0];
  const identity = firstIdentity === undefined ? null : identityOf(firstIdentity);

  const answer: ContributorLink = { identities };
  if (identity) answer.identity = identity;
  if (did !== '') {
    const claim = await claimFor(pool, did);
    if (claim) answer.claim = claim;
  }
  return answer;
}

/**
 * The account's own claim, crossed with its decision.
 *
 * The record in the claimant's repo says what was asked; the decision row says how
 * it ended. A decision outlives the record (withdrawn after approval), so an empty
 * record read falls back to the newest decision for that account — otherwise a
 * reader who withdraws would see nothing at all, and a revoked link would look
 * like it never existed.
 */
async function claimFor(pool: EntityQueryable, did: string): Promise<ContributorClaimView | null> {
  const record = await pool.query(
    `SELECT r.uri,
            r.record::jsonb->>'contributor' AS contributor,
            r.record::jsonb->>'message' AS message,
            r.record::jsonb->>'createdAt' AS claimed_at,
            r.created_at,
            d.state,
            d.decided_at
       FROM happyview.happyview_records r
       LEFT JOIN contributor_claims d ON d.claim_uri = r.uri
      WHERE r.collection = $1 AND r.did = $2 AND r.rkey = 'self'`,
    [CONTRIBUTOR_CLAIM_COLLECTION, did]
  );

  if (record.rows.length > 0) {
    const row = record.rows[0];
    const createdAt = iso(row.claimed_at) ?? iso(row.created_at);
    if (createdAt === undefined) return null;
    const view: ContributorClaimView = {
      uri: row.uri,
      contributor: String(row.contributor ?? ''),
      // No decision row means no librarian has answered yet.
      state: (row.state ?? 'pending') as ContributorClaimState,
      createdAt
    };
    if (typeof row.message === 'string' && row.message !== '') view.message = row.message;
    const decidedAt = iso(row.decided_at);
    if (decidedAt) view.decidedAt = decidedAt;
    return view;
  }

  const decision = await pool.query(
    `SELECT claim_uri, contributor_uri, state, decided_at
       FROM contributor_claims
      WHERE subject_did = $1
      ORDER BY decided_at DESC
      LIMIT 1`,
    [did]
  );
  if (decision.rows.length === 0) return null;
  const row = decision.rows[0];
  const decidedAt = iso(row.decided_at);
  if (decidedAt === undefined) return null;
  return {
    uri: row.claim_uri,
    contributor: row.contributor_uri,
    state: row.state as ContributorClaimState,
    createdAt: decidedAt,
    decidedAt
  };
}
