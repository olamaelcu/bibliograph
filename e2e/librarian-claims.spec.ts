/**
 * A librarian decides a reader's request to become an author, and the result is
 * verified through every store it touches.
 *
 * Approving has to produce, in order: a binding row, a queued `knownContributor`
 * record, and a queued `known-author` label. The worker then publishes the
 * record into the fixture PDS and signs the label with the labeler key, so this
 * spec follows the decision out of Postgres, into the PDS, and back through the
 * edge query the reader's page uses. Rejecting has to produce the decision and
 * nothing else.
 *
 * The worker's own crons are per-minute; the test enqueues the same two jobs
 * through graphile rather than waiting, so a failure is a failure, not a slow
 * machine.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import pg from 'pg';
import { parseMultikey, verifySignature } from '@atproto/crypto';

import { labelSigningPayload } from '../packages/worker/lib/labels.js';
import { readState } from './harness.ts';

const state = readState();
test.skip(!state?.ready, state?.reason ?? 'the E2E harness did not start');

if (state?.ready) {
  test.describe.configure({ mode: 'serial' });

  let pool: pg.Pool;
  let accessToken = '';

  const KNOWN_CONTRIBUTOR = 'net.olamaelcu.livtet.biblio.knownContributor';
  const CLAIM_COLLECTION = 'net.olamaelcu.livtet.biblio.contributorClaim';

  async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    return pool.query<T>(text, values);
  }

  /** Poll until `fn` returns a non-null value; the error names the last miss. */
  async function eventually<T>(
    label: string,
    fn: () => Promise<T | null | undefined>,
    timeoutMs = 120_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = 'nothing yet';
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (value !== null && value !== undefined) return value;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`timed out waiting for ${label}: ${last}`);
  }

  async function pdsToken(): Promise<string> {
    if (accessToken) return accessToken;
    const response = await fetch(`${state!.pdsUrl}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: state!.publisherDid,
        password: process.env.PDS_ACCOUNT_PASSWORD
      })
    });
    if (!response.ok) {
      throw new Error(`createSession failed: ${response.status} ${await response.text()}`);
    }
    accessToken = ((await response.json()) as { accessJwt: string }).accessJwt;
    return accessToken;
  }

  /** Read a record from the fixture PDS, authenticating when it is not public. */
  async function getRecord(collection: string, rkey: string): Promise<Record<string, unknown> | null> {
    const url = new URL(`${state!.pdsUrl}/xrpc/com.atproto.repo.getRecord`);
    url.searchParams.set('repo', state!.publisherDid);
    url.searchParams.set('collection', collection);
    url.searchParams.set('rkey', rkey);
    const anonymous = await fetch(url);
    if (anonymous.ok) return ((await anonymous.json()) as { value: Record<string, unknown> }).value;
    if (anonymous.status !== 401 && anonymous.status !== 403) {
      throw new Error(`getRecord ${rkey}: ${anonymous.status} ${await anonymous.text()}`);
    }
    const authed = await fetch(url, { headers: { authorization: `Bearer ${await pdsToken()}` } });
    if (!authed.ok) {
      throw new Error(`getRecord ${rkey} (authed): ${authed.status} ${await authed.text()}`);
    }
    return ((await authed.json()) as { value: Record<string, unknown> }).value;
  }

  async function edgeLink(params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(
      `${state!.edgeUrl}/xrpc/net.olamaelcu.livtet.biblio.getContributorLink`
    );
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url);
    expect(response.status, `getContributorLink ${params}`).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Enqueue the two jobs the decision feeds.
   *
   * graphile reads its table directly; using `add_job` keeps the row shape
   * graphile's own migrations expect.
   */
  async function runQueuedWork(): Promise<void> {
    for (const task of ['pds-publish', 'labels.emit']) {
      try {
        await query('SELECT graphile_worker.add_job($1)', [task]);
      } catch {
        await query('INSERT INTO graphile_worker.jobs (task_identifier, payload) VALUES ($1, $2)', [
          task,
          JSON.stringify({})
        ]);
      }
    }
  }

  test.beforeAll(async () => {
    pool = new pg.Pool({ connectionString: state!.databaseUrl, max: 2 });
  });

  test.afterAll(async () => {
    // The fixture PDS is shared with the development stack: remove the records
    // this run published rather than leaving them in the publisher's repo.
    try {
      const rows = await query<{ at_uri: string }>(
        'SELECT at_uri FROM contributor_identities WHERE did = ANY($1)',
        [[state!.approvedDid, state!.rejectedDid]]
      );
      for (const row of rows.rows) {
        const rkey = row.at_uri.split('/').pop();
        if (!rkey) continue;
        await fetch(`${state!.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await pdsToken()}`
          },
          body: JSON.stringify({
            repo: state!.publisherDid,
            collection: KNOWN_CONTRIBUTOR,
            rkey
          })
        });
      }
    } catch (error) {
      console.warn('[e2e] could not clean up published records:', error);
    }
    await pool?.end();
  });

  test.beforeEach(async ({ context }) => {
    // The queue is behind a signed cookie; minting it is the only step of
    // sign-in that does not need the PDS's own login form.
    await context.addCookies([
      {
        name: 'bib_librarian',
        value: state!.cookie,
        domain: '127.0.0.1',
        path: '/librarian',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax'
      }
    ]);
  });

  function claimRow(page: Page, did: string) {
    return page.locator('li', {
      has: page.locator(`input[name="subjectDid"][value="${did}"]`)
    });
  }

  /**
   * Click a decision button once the custom element has upgraded.
   *
   * The page is server-rendered, so the buttons exist before `wa-button` is
   * defined; a click dispatched into an unupgraded element does nothing and is
   * not replayed. Waiting for the upgrade (and for `type="submit"`) is what a
   * person's click after hydration amounts to.
   */
  async function clickDecision(row: Locator, label: 'Approve' | 'Reject'): Promise<void> {
    const button = row.locator('wa-button', { hasText: label });
    await button.evaluate(async (el) => {
      await customElements.whenDefined('wa-button');
      const typed = el as unknown as { type?: string };
      for (let attempt = 0; attempt < 400 && !typed.type; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    await expect(button).toHaveJSProperty('type', 'submit');
    await button.click();
  }

  test('approving a claim publishes the link and signs the label', async ({ page }) => {
    await page.goto(`${state!.edgeUrl}/librarian/claims`);

    const row = claimRow(page, state!.approvedDid);
    await expect(row).toContainText(state!.approvedDid);
    await expect(row).toContainText(state!.contributorName);
    await expect(row).toContainText('I wrote the book.');

    await clickDecision(row, 'Approve');
    await page.waitForURL(`${state!.edgeUrl}/librarian/claims`);

    // The pending list is empty and the account is now listed as verified.
    await expect(claimRow(page, state!.approvedDid)).toHaveCount(0);
    const verified = page.locator('section', { has: page.locator('#verified-heading') });
    await expect(verified).toContainText(state!.approvedDid);

    const identity = await query<{ at_uri: string; did: string; contributor: string }>(
      `SELECT k.at_uri, k.did, c.at_uri AS contributor
         FROM contributor_identities k JOIN contributors c ON c.id = k.contributor_id
        WHERE k.did = $1`,
      [state!.approvedDid]
    );
    expect(identity.rowCount).toBe(1);
    expect(identity.rows[0].contributor).toBe(state!.contributorUri);

    const decision = await query<{ state: string; decided_by: string }>(
      'SELECT state, decided_by FROM contributor_claims WHERE subject_did = $1',
      [state!.approvedDid]
    );
    expect(decision.rows[0]?.state).toBe('approved');
    expect(decision.rows[0]?.decided_by).toBe(state!.librarianDid);

    await expect
      .poll(
        async () =>
          (await query('SELECT 1 FROM label_outbox WHERE uri = $1', [state!.approvedDid])).rowCount,
        { timeout: 15_000 }
      )
      .toBe(1);

    await runQueuedWork();

    // 1. The record reaches the fixture PDS, naming the contributor and the DID.
    const rkey = identity.rows[0].at_uri.split('/').pop()!;
    const record = await eventually('knownContributor on the PDS', () =>
      getRecord(KNOWN_CONTRIBUTOR, rkey)
    );
    expect(record).toMatchObject({
      contributor: state!.contributorUri,
      subject: state!.approvedDid,
      issuedBy: state!.librarianDid
    });

    // 2. The label is signed by the labeler key and verifies under its public half.
    const signed = await eventually('labels.emit to sign the label', async () => {
      const rows = await query<{ val: string; src: string }>(
        'SELECT val, src FROM labeler_labels WHERE uri = $1 ORDER BY seq DESC LIMIT 1',
        [state!.approvedDid]
      );
      return rows.rows[0] ?? null;
    });
    expect(signed.val).toBe('known-author');

    const labelsResponse = await fetch(
      `${state!.labelerUrl}/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(state!.approvedDid)}`
    );
    expect(labelsResponse.status).toBe(200);
    const labels = (await labelsResponse.json()) as {
      labels: Array<{ src: string; uri: string; val: string; cts: string; sig: { $bytes: string } }>;
    };
    const served = labels.labels.find((entry) => entry.val === 'known-author');
    expect(served, 'queryLabels returns the signed label').toBeTruthy();

    // The signature covers `src`, `uri`, `val` and the label's own `cts`, so the
    // payload is rebuilt from what the endpoint served, not from the clock.
    expect(served!.src).toBe(signed.src);
    const publicKey = parseMultikey(state!.labelerPublic);
    expect(publicKey.jwtAlg).toBe('ES256K');
    expect(
      await verifySignature(
        `did:key:${state!.labelerPublic}`,
        labelSigningPayload({
          src: served!.src,
          uri: served!.uri,
          val: served!.val,
          cts: served!.cts
        }),
        Buffer.from(served!.sig.$bytes, 'base64')
      )
    ).toBe(true);

    // 3. The reader-facing query answers with the verified account.
    const byContributor = await edgeLink({ contributor: state!.contributorUri });
    expect(
      (byContributor.identities as Array<{ did: string }>).map((entry) => entry.did)
    ).toContain(state!.approvedDid);

    const byDid = await edgeLink({ did: state!.approvedDid });
    expect(byDid.identity).toMatchObject({ did: state!.approvedDid });
    expect((byDid.claim as { state: string }).state).toBe('approved');
  });

  test('rejecting a claim records the decision and leaves no link', async ({ page }) => {
    await page.goto(`${state!.edgeUrl}/librarian/claims`);

    const row = claimRow(page, state!.rejectedDid);
    await expect(row).toContainText('Please let me in.');
    await row.locator('input[name="note"]').fill('Could not confirm the identity.');
    await clickDecision(row, 'Reject');
    await page.waitForURL(`${state!.edgeUrl}/librarian/claims`);

    await expect(claimRow(page, state!.rejectedDid)).toHaveCount(0);

    const decision = await query<{ state: string; note: string | null }>(
      'SELECT state, note FROM contributor_claims WHERE subject_did = $1',
      [state!.rejectedDid]
    );
    expect(decision.rows[0]?.state).toBe('rejected');
    expect(decision.rows[0]?.note).toBe('Could not confirm the identity.');

    const identity = await query('SELECT 1 FROM contributor_identities WHERE did = $1', [
      state!.rejectedDid
    ]);
    expect(identity.rowCount).toBe(0);

    const byContributor = await edgeLink({ contributor: state!.contributorUri });
    expect(
      (byContributor.identities as Array<{ did: string }>).map((entry) => entry.did)
    ).not.toContain(state!.rejectedDid);

    const byDid = await edgeLink({ did: state!.rejectedDid });
    expect((byDid.claim as { state: string }).state).toBe('rejected');
    // Claim URIs are `at://<did>/<collection>/self`; keep the fixture honest.
    expect((byDid.claim as { uri: string }).uri).toContain(CLAIM_COLLECTION);
  });
}
