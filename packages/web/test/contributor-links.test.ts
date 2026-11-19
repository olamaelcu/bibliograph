import { expect, test } from 'vitest';

import {
  GET_CONTRIBUTOR_LINK,
  getContributorLink,
  type ContributorClaimView
} from '../src/lib/server/catalog/contributor-links.ts';
import {
  CONTRIBUTOR_COLLECTION,
  EntityUriError,
  type EntityQueryable
} from '../src/lib/server/catalog/entities.ts';
import { ENTITY_QUERIES } from '../src/lib/server/catalog/entity-methods.ts';

/**
 * `getContributorLink` answers two readers with one method: the contributor page
 * asks who is verified as a person, and the reader's own panel asks what their
 * account has claimed. These pin the dispatch branch, the parameter validation,
 * and the two states a claim can be in before and after a decision.
 */

const AUTHORITY = 'did:plc:linktest';
const CONTRIBUTOR_URI = `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/3abc`;
const RECORD_URI = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.knownContributor/3xyz`;
const CLAIM_URI = 'at://did:plc:reader/net.olamaelcu.livtet.biblio.contributorClaim/self';
const SUBJECT = 'did:plc:reader';
const CREATED = new Date('2026-11-12T10:20:30.000Z');

function fakePool(answer: (sql: string) => unknown[]): EntityQueryable {
  return {
    query: async (sql: string) => {
      const rows = answer(sql);
      return { rows, rowCount: rows.length };
    }
  } as unknown as EntityQueryable;
}

function identityRow() {
  return { uri: RECORD_URI, did: SUBJECT, contributor: CONTRIBUTOR_URI, created_at: CREATED };
}

function claimRow(state: string | null) {
  return {
    uri: CLAIM_URI,
    contributor: CONTRIBUTOR_URI,
    message: 'I wrote the books in question.',
    claimed_at: '2026-11-10T09:00:00.000Z',
    created_at: CREATED,
    state,
    decided_at: state === null ? null : CREATED
  };
}

test('the method is registered as an edge-served entity query', () => {
  expect(ENTITY_QUERIES.has(GET_CONTRIBUTOR_LINK)).toBe(true);
  expect(GET_CONTRIBUTOR_LINK).toBe('net.olamaelcu.livtet.biblio.getContributorLink');
});

test('answering neither parameter is InvalidRequest, not an empty page', async () => {
  const pool = fakePool(() => []);
  await expect(getContributorLink(pool, {})).rejects.toBeInstanceOf(EntityUriError);
});

test('a malformed contributor or did is refused before any query runs', async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    }
  } as unknown as EntityQueryable;

  await expect(
    getContributorLink(pool, { contributor: 'at://did:plc:x/net.olamaelcu.livtet.biblio.book/1' })
  ).rejects.toBeInstanceOf(EntityUriError);
  await expect(getContributorLink(pool, { did: 'alice.example.com' })).rejects.toBeInstanceOf(
    EntityUriError
  );
  expect(calls).toEqual([]);
});

test('a contributor answers its verified accounts', async () => {
  const pool = fakePool((sql) => (sql.includes('c.at_uri = $1') ? [identityRow()] : []));

  const link = await getContributorLink(pool, { contributor: CONTRIBUTOR_URI });
  expect(link.identities).toEqual([
    {
      uri: RECORD_URI,
      did: SUBJECT,
      contributor: CONTRIBUTOR_URI,
      createdAt: '2026-11-12T10:20:30.000Z'
    }
  ]);
  // The `did` half was not asked, so it is not answered.
  expect(link.identity).toBeUndefined();
  expect(link.claim).toBeUndefined();
});

test('a DID answers its binding and an undecided claim as pending', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('k.did = $1')) return [identityRow()];
    if (sql.includes('happyview_records')) return [claimRow(null)];
    return [];
  });

  const link = await getContributorLink(pool, { did: SUBJECT });
  expect(link.identity?.did).toBe(SUBJECT);
  expect(link.identities).toEqual([]);
  expect(link.claim?.state).toBe('pending');
  expect(link.claim?.message).toBe('I wrote the books in question.');
  expect(link.claim?.decidedAt).toBeUndefined();
});

test('a decision row turns the same record rejected', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('k.did = $1')) return [];
    if (sql.includes('happyview_records')) return [claimRow('rejected')];
    return [];
  });

  const link = await getContributorLink(pool, { did: SUBJECT });
  expect(link.identity).toBeUndefined();
  expect(link.claim?.state).toBe('rejected');
  expect(link.claim?.decidedAt).toBe('2026-11-12T10:20:30.000Z');
});

test('a withdrawn claim falls back to its decision', async () => {
  // The record is gone (the reader deleted it), so the newest decision for the
  // account is all that is left to report.
  const pool = fakePool((sql) => {
    if (sql.includes('happyview_records')) return [];
    if (sql.includes('FROM contributor_claims')) {
      return [
        {
          claim_uri: CLAIM_URI,
          contributor_uri: CONTRIBUTOR_URI,
          state: 'revoked',
          decided_at: CREATED
        }
      ];
    }
    return [];
  });

  const link = await getContributorLink(pool, { did: SUBJECT });
  const claim: ContributorClaimView | undefined = link.claim;
  expect(claim?.state).toBe('revoked');
  expect(claim?.uri).toBe(CLAIM_URI);
});
