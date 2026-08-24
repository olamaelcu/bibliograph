#!/usr/bin/env tsx
// End-to-end verification of the PDS introspection endpoints:
//   com.atproto.server.describeServer
//   com.atproto.sync.getLatestCommit
//   com.atproto.sync.getRepoStatus
//
// Usage:
//   pnpm exec tsx scripts/verify-server.ts
//   BIBLIO_BASE=https://biblio.livtet.olamaelcu.net tsx scripts/verify-server.ts
//
// Env:
//   BIBLIO_BASE            (default: https://biblio.livtet.olamaelcu.net)
//   LEX_PUBLISHER_DID      (default: did:web:biblio.livtet.olamaelcu.net)
//   LEX_PUBLISHER_HOSTNAME (default: biblio.livtet.olamaelcu.net)
//
// Exits 1 if any assertion fails.

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.BIBLIO_BASE ?? 'https://biblio.livtet.olamaelcu.net').replace(/\/$/, '');
const DID = process.env.LEX_PUBLISHER_DID ?? 'did:web:biblio.livtet.olamaelcu.net';
const HOSTNAME = process.env.LEX_PUBLISHER_HOSTNAME ?? 'biblio.livtet.olamaelcu.net';

interface DescribeServerResponse {
  did: string;
  availableUserDomains: string[];
  inviteCodeRequired?: boolean;
  links?: { privacyPolicy?: string; termsOfService?: string };
}

interface CommitResponse {
  cid: string;
  rev: string;
}

interface RepoStatusResponse {
  did: string;
  rev: string;
}

async function get<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${url} -> ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

test('describeServer exposes publisher DID, hostname, and policy links', async () => {
  const r = await get<DescribeServerResponse>('/xrpc/com.atproto.server.describeServer');
  assert.equal(r.did, DID);
  assert.ok(Array.isArray(r.availableUserDomains), 'availableUserDomains must be an array');
  assert.ok(
    r.availableUserDomains.includes(HOSTNAME),
    `availableUserDomains should include ${HOSTNAME}, got ${JSON.stringify(r.availableUserDomains)}`,
  );
  assert.equal(r.inviteCodeRequired, true);
  assert.ok(r.links?.privacyPolicy, 'privacyPolicy link required');
  assert.ok(r.links?.termsOfService, 'termsOfService link required');
});

test('getLatestCommit returns the repo commit CID and TID rev', async () => {
  const r = await get<CommitResponse>(
    `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(DID)}`,
  );
  assert.match(r.cid, /^b[a-z2-7]+$/, `cid must be a CIDv1 base32 string, got ${r.cid}`);
  assert.match(
    r.rev,
    /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/,
    `rev must be a 13-char base32-sortable TID, got ${r.rev}`,
  );
});

test('getRepoStatus rev matches getLatestCommit rev', async () => {
  const [status, latest] = await Promise.all([
    get<RepoStatusResponse>(
      `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(DID)}`,
    ),
    get<CommitResponse>(
      `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(DID)}`,
    ),
  ]);
  assert.equal(status.did, DID);
  assert.equal(status.rev, latest.rev, `status.rev=${status.rev} but latest.rev=${latest.rev}`);
});
