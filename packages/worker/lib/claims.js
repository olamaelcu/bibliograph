/**
 * Contributor claims: the librarian's decisions, and the writes they imply.
 *
 * The claim itself never lives here. A reader writes
 * `net.olamaelcu.livtet.biblio.contributorClaim` (rkey `self`) into their own
 * repo, HappyView indexes it, and this module records what a librarian decided
 * about it. That split is what makes an approval unforgeable: the record proves
 * the account asked, the decision row proves a librarian answered, and only this
 * side can create a binding or issue a label.
 *
 * Every write is one transaction with the queues it feeds:
 *
 *   approve → contributor_identities row (its trigger queues the published
 *             `knownContributor` record) + contributor_claims row +
 *             label_outbox row (`known-author` on the account)
 *   reject  → contributor_claims row only
 *   revoke  → delete the binding (trigger queues the record delete) +
 *             `contributor_claims` row marked `revoked` + negated label
 *
 * The tables are created by `sql/0031-contributor-identity.sql`.
 */

import { KNOWN_CONTRIBUTOR_COLLECTION } from './known-contributor-record.js';
import { LABEL_VALUE_KNOWN_AUTHOR } from './labels.js';

export const CLAIM_COLLECTION = 'net.olamaelcu.livtet.biblio.contributorClaim';
export const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';

/** A claim or a lookup the caller got wrong. `status` is the HTTP status to answer. */
export class ClaimError extends Error {
  constructor(status, message, code = 'InvalidRequest') {
    super(message);
    this.name = 'ClaimError';
    this.status = status;
    this.code = code;
  }
}

const AT_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

function atUriIn(value, collection, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = AT_URI.exec(text);
  if (!match || match[2] !== collection) {
    throw new ClaimError(400, `${field} must be an ${collection} record at-uri`);
  }
  return text;
}

function didValue(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!DID.test(text)) throw new ClaimError(400, `${field} must be a DID`);
  return text;
}

function optionalText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function uniqueViolation(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === '23505';
}

/**
 * Claims no librarian has decided yet, newest first, with the contributor row
 * they name (when the catalog has one). A claim about a contributor that no
 * longer exists still appears, so it can be rejected rather than lingering.
 */
export async function listPendingClaims(pool, { limit = 100 } = {}) {
  const result = await pool.query(
    `SELECT r.uri,
            r.did,
            r.record::jsonb->>'contributor' AS contributor_uri,
            r.record::jsonb->>'message' AS message,
            r.record::jsonb->>'createdAt' AS claimed_at,
            r.created_at,
            c.id AS contributor_id,
            c.name,
            c.at_uri AS contributor_at_uri
       FROM happyview.happyview_records r
       LEFT JOIN contributors c ON c.at_uri = r.record::jsonb->>'contributor'
       LEFT JOIN contributor_claims d ON d.claim_uri = r.uri
      WHERE r.collection = $1
        AND d.claim_uri IS NULL
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [CLAIM_COLLECTION, limit]
  );
  return result.rows.map((row) => ({
    uri: row.uri,
    did: row.did,
    contributorUri: row.contributor_uri,
    message: row.message,
    createdAt: row.claimed_at ?? row.created_at,
    contributorId: row.contributor_id === null ? null : Number(row.contributor_id),
    name: row.name,
    contributorAtUri: row.contributor_at_uri
  }));
}

/** The current bindings, newest first. */
export async function listIdentities(pool, { limit = 200 } = {}) {
  const result = await pool.query(
    `SELECT k.did, k.at_uri, k.issued_by, k.created_at, c.name, c.at_uri AS contributor
       FROM contributor_identities k
       JOIN contributors c ON c.id = k.contributor_id
      ORDER BY k.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    did: row.did,
    uri: row.at_uri,
    issuedBy: row.issued_by,
    createdAt: row.created_at,
    name: row.name,
    contributor: row.contributor
  }));
}

/**
 * Record a librarian's decision about one claim.
 *
 * `authority` is the publisher DID the `knownContributor` record is minted
 * under; the worker passes the same value its outbox trigger expects, so a row
 * queued here is publishable by the running `pds-publish`.
 *
 * Approving is the only path that creates a binding. It refuses a second
 * decision for the same claim (`AlreadyDecided`) and a contributor or account
 * that is already bound (`AlreadyLinked`), and writes nothing in either case.
 */
export async function decideClaim(
  pool,
  { claimUri, subjectDid, contributorUri, action, note, issuedBy, authority }
) {
  const claim = atUriIn(claimUri, CLAIM_COLLECTION, 'claimUri');
  const did = didValue(subjectDid, 'subjectDid');
  const contributor = atUriIn(contributorUri, CONTRIBUTOR_COLLECTION, 'contributorUri');
  const decision = typeof action === 'string' ? action.trim().toLowerCase() : '';
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ClaimError(400, 'action must be approve or reject');
  }
  const decidedBy = didValue(issuedBy, 'issuedBy');
  const publisher = didValue(authority, 'authority');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT claim_uri FROM contributor_claims WHERE claim_uri = $1',
      [claim]
    );
    if (existing.rowCount > 0) {
      throw new ClaimError(409, `claim ${claim} was already decided`, 'AlreadyDecided');
    }

    if (decision === 'approve') {
      const resolved = await client.query('SELECT id FROM contributors WHERE at_uri = $1', [
        contributor
      ]);
      if (resolved.rowCount === 0) {
        throw new ClaimError(
          404,
          `no catalog contributor has the URI ${contributor}`,
          'ContributorNotFound'
        );
      }
      const contributorId = resolved.rows[0].id;

      try {
        await client.query(
          `INSERT INTO contributor_identities (contributor_id, did, at_uri, issued_by)
           VALUES ($1, $2,
                   'at://' || $3 || '/' || $4 || '/' || (SELECT editions_next_tid()),
                   $5)`,
          [contributorId, did, publisher, KNOWN_CONTRIBUTOR_COLLECTION, decidedBy]
        );
      } catch (error) {
        if (uniqueViolation(error)) {
          throw new ClaimError(
            409,
            'this account is already linked to a contributor, or this contributor already has one',
            'AlreadyLinked'
          );
        }
        throw error;
      }
    }

    await client.query(
      `INSERT INTO contributor_claims (claim_uri, subject_did, contributor_uri, state, note, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [claim, did, contributor, decision === 'approve' ? 'approved' : 'rejected', optionalText(note), decidedBy]
    );

    if (decision === 'approve') {
      await client.query('INSERT INTO label_outbox (uri, val) VALUES ($1, $2)', [
        did,
        LABEL_VALUE_KNOWN_AUTHOR
      ]);
    }

    await client.query('COMMIT');
    return { claimUri: claim, subjectDid: did, contributorUri: contributor, state: decision === 'approve' ? 'approved' : 'rejected' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Withdraw a binding.
 *
 * The row is deleted and the trigger queues the published record's delete; a
 * `revoked` decision is recorded against the account's current claim record when
 * one still exists (so the reader sees the outcome on the contributor page), and
 * a negated `known-author` label is queued so consumers drop the label.
 */
export async function revokeIdentity(pool, { did, issuedBy }) {
  const account = didValue(did, 'did');
  const decidedBy = didValue(issuedBy, 'issuedBy');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bound = await client.query(
      `SELECT k.id, c.at_uri AS contributor
         FROM contributor_identities k
         JOIN contributors c ON c.id = k.contributor_id
        WHERE k.did = $1
        FOR UPDATE`,
      [account]
    );
    if (bound.rowCount === 0) {
      throw new ClaimError(404, `no contributor is linked to ${account}`, 'NotFound');
    }
    const contributor = bound.rows[0].contributor;

    await client.query('DELETE FROM contributor_identities WHERE id = $1', [bound.rows[0].id]);

    const claim = await client.query(
      `SELECT uri FROM happyview.happyview_records
        WHERE collection = $1 AND did = $2 AND rkey = 'self'`,
      [CLAIM_COLLECTION, account]
    );
    if (claim.rowCount > 0) {
      // The approval decision for this claim is already recorded; the revocation
      // replaces it, because one claim has one outcome.
      await client.query(
        `INSERT INTO contributor_claims
           (claim_uri, subject_did, contributor_uri, state, decided_by)
         VALUES ($1, $2, $3, 'revoked', $4)
         ON CONFLICT (claim_uri) DO UPDATE
            SET state = 'revoked',
                decided_by = EXCLUDED.decided_by,
                decided_at = now()`,
        [claim.rows[0].uri, account, contributor, decidedBy]
      );
    }

    await client.query('INSERT INTO label_outbox (uri, val, neg) VALUES ($1, $2, true)', [
      account,
      LABEL_VALUE_KNOWN_AUTHOR
    ]);

    await client.query('COMMIT');
    return { did: account, contributor };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
