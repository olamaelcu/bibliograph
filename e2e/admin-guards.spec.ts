/**
 * The admin flow's refusals and its read paths.
 *
 * The happy-path merges live in `admin.spec.ts`; this file covers what must
 * *not* happen, because each of these guards protects data that a wrong answer
 * destroys or silently rewrites: deleting a credited contributor, deleting a
 * publisher an edition depends on, deleting an edition from a stale page, or
 * merging two rows that each carry a published identity.
 *
 * The dashboard's search is exercised, but not its merge button: the base
 * record is a `wa-select`, and driving a shadow-DOM select is more fragile than
 * the value it adds over the API test that already covers the merge itself. The
 * search wiring — the only part the API test does not touch — is asserted.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import pg from 'pg';

import { readState } from './harness.ts';
import { adminSignIn, waitForUpgrade } from './support/ui.ts';

const state = readState();
test.skip(!state?.ready, state?.reason ?? 'the E2E harness did not start');

if (state?.ready) {
  test.describe.configure({ mode: 'serial' });

  let pool: pg.Pool;

  test.beforeAll(async () => {
    pool = new pg.Pool({ connectionString: state.databaseUrl, max: 2 });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  const signIn = (page: Page) =>
    adminSignIn(page, { edgeUrl: state.edgeUrl, token: state.adminToken });

  test('the admin JSON APIs answer 401 without the operator cookie', async ({ page }) => {
    const merge = await page.request.post(`${state.edgeUrl}/admin/api/merge`, {
      data: { base: 'at://x/community.lexicon.media.book.edition/1', others: [] }
    });
    expect(merge.status()).toBe(401);

    const reports = await page.request.get(`${state.edgeUrl}/admin/api/reports`);
    expect(reports.status()).toBe(401);
  });

  test('malformed admin requests are refused before a provider is contacted', async ({ page }) => {
    await signIn(page);

    const search = await page.request.post(`${state.edgeUrl}/admin/api/provider-search`, {
      data: {}
    });
    expect(search.status()).toBe(400);
    expect((await search.json()) as { error: string }).toMatchObject({ error: 'BadRequest' });

    const importResponse = await page.request.post(
      `${state.edgeUrl}/admin/api/publisher-import`,
      { data: {} }
    );
    expect(importResponse.status()).toBe(400);
    expect(((await importResponse.json()) as { message: string }).message).toContain('name');
  });

  test('a contributor credited on an edition cannot be deleted', async ({ page }) => {
    await signIn(page);
    const editUrl = `${state.edgeUrl}/admin/contributor/${state.guardContributorId}/edit`;
    await page.goto(editUrl);

    const response = await page.request.post(`${editUrl}?/delete`, {
      form: {},
      // SvelteKit refuses a form POST whose Origin is not this app's origin.
      headers: { origin: state.edgeUrl }
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain('credited on');

    const row = await pool.query('SELECT 1 FROM contributors WHERE id = $1', [
      state.guardContributorId
    ]);
    expect(row.rowCount).toBe(1);
  });

  test('a publisher an edition depends on cannot be deleted', async ({ page }) => {
    await signIn(page);
    const editUrl = `${state.edgeUrl}/admin/publisher/${state.guardPublisherId}/edit`;
    await page.goto(editUrl);

    const response = await page.request.post(`${editUrl}?/delete`, {
      form: {},
      headers: { origin: state.edgeUrl }
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toMatch(/edition/i);

    const row = await pool.query('SELECT 1 FROM publishers WHERE id = $1', [
      state.guardPublisherId
    ]);
    expect(row.rowCount).toBe(1);
  });

  test('deleting an edition needs the revision it was loaded with, then queues the record deletion', async ({
    page
  }) => {
    await signIn(page);
    const editUrl = `${state.edgeUrl}/admin/edition/${encodeURIComponent(state.deleteEditionUri)}/edit`;
    await page.goto(editUrl);

    // The revision ships only once the operator asks to delete; the button is
    // the confirm gate, not just a second click.
    const reveal = page.locator('wa-button', { hasText: 'Delete edition' });
    await waitForUpgrade(reveal);
    await reveal.click();
    const revision = await page.locator('input[name="revision"]').inputValue();
    expect(revision).not.toBe('');

    const stale = await page.request.post(`${editUrl}?/delete`, {
      form: { revision: `${revision}stale` },
      headers: { origin: state.edgeUrl }
    });
    expect(stale.status()).toBe(409);
    expect(await stale.text()).toContain('reload before deleting');
    expect(
      (await pool.query('SELECT 1 FROM books WHERE uri = $1', [state.deleteEditionUri])).rowCount
    ).toBe(1);

    const deleted = await page.request.post(`${editUrl}?/delete`, {
      form: { revision },
      headers: { origin: state.edgeUrl }
    });
    expect(deleted.status()).toBeLessThan(400);

    expect(
      (await pool.query('SELECT 1 FROM books WHERE uri = $1', [state.deleteEditionUri])).rowCount
    ).toBe(0);
    // The row carried an at-URI, so the catalog trigger queued its record removal.
    expect(
      (await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [state.deleteEditionUri]))
        .rowCount
    ).toBeGreaterThan(0);
  });

  test('the merge preview refuses an unknown or identical target', async ({ page }) => {
    await signIn(page);
    const preview = `${state.edgeUrl}/admin/contributor/${state.bothIdentitySourceId}/merge`;

    await page.goto(`${preview}?into=999999`);
    await expect(page.locator('wa-callout').first()).toBeVisible();
    await expect(page.getByText('Merge and delete')).toHaveCount(0);

    await page.goto(`${preview}?into=${state.bothIdentitySourceId}`);
    await expect(page.locator('wa-callout').first()).toBeVisible();
    await expect(page.getByText('Merge and delete')).toHaveCount(0);
  });

  test('when both rows carry an identity, the survivor keeps its own', async ({ page }) => {
    await signIn(page);
    await page.goto(
      `${state.edgeUrl}/admin/contributor/${state.bothIdentitySourceId}/merge?into=${state.bothIdentityTargetId}`
    );

    const confirm = page.locator('wa-button', { hasText: 'Merge and delete' });
    await waitForUpgrade(confirm);
    await confirm.click();
    await page.waitForURL(
      `${state.edgeUrl}/admin/contributor/${state.bothIdentityTargetId}/edit`
    );

    const identities = await pool.query<{ contributor_id: string; did: string }>(
      'SELECT contributor_id, did FROM contributor_identities WHERE contributor_id = ANY($1)',
      [[state.bothIdentitySourceId, state.bothIdentityTargetId]]
    );
    expect(identities.rows.map((row) => [String(row.contributor_id), row.did])).toEqual([
      [state.bothIdentityTargetId, 'did:plc:e2ebothb']
    ]);
  });

  test('the dashboard search finds the seeded editions for a merge', async ({ page }) => {
    await signIn(page);
    // Tabs are selected by hash (`onMount` mirrors the location), not by query.
    await page.goto(`${state.edgeUrl}/admin#merge`);

    // These are form-associated custom elements, not `<input>`s: `getByLabel`
    // does not treat them as labelable, and `fill` refuses them. Click the host
    // (which focuses the inner field) and type through the keyboard.
    const search = page.locator('wa-input[aria-label="Title or identifier"]');
    await search.waitFor({ state: 'visible', timeout: 30_000 });
    await waitForUpgrade(search);
    await search.click();
    await page.keyboard.type('E2E Workbench');

    const searchButton = page.locator('wa-button', { hasText: 'Search catalog' });
    await waitForUpgrade(searchButton);
    await searchButton.click();

    const base = page.locator('wa-checkbox[aria-label="Select E2E Workbench Base"]');
    await base.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(
      page.locator('wa-checkbox[aria-label="Select E2E Workbench Other"]')
    ).toBeVisible();

    await waitForUpgrade(base);
    await base.click();
    await expect(page.getByText('selected', { exact: true })).toBeVisible();
  });

  test('signing out clears the operator cookie', async ({ page }) => {
    await signIn(page);

    const response = await page.request.post(`${state.edgeUrl}/admin?/logout`, {
      // A form action needs a form-encoded body; an empty POST is a 415.
      form: {},
      headers: { origin: state.edgeUrl }
    });
    expect(response.status()).toBeLessThan(400);

    await page.goto(`${state.edgeUrl}/admin`);
    await expect(page).toHaveURL(`${state.edgeUrl}/admin/login`);

    // The JSON API is closed again too.
    const reports = await page.request.get(`${state.edgeUrl}/admin/api/reports`);
    expect(reports.status()).toBe(401);
  });
}
