/**
 * The operator surface: the token gate, and the three merge workbenches.
 *
 * Each scenario starts signed out on a fresh browser context, walks the real
 * form (including the operator token), and then asserts the catalog, because a
 * merge that renders "Merged 2 editions" while leaving the source row behind is
 * exactly the failure this suite exists to catch.
 *
 * The order is deliberate and serial: the book merge moves the seeded credit
 * onto the base edition, the contributor merge then has to move that same credit
 * and the verified identity to the surviving contributor, and the publisher
 * merge absorbs the identifiers. Splitting them would need more fixtures for
 * less coverage.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import pg from 'pg';

import { readState } from './harness.ts';
import { waitForUpgrade } from './support/ui.ts';

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

  async function adminSignIn(page: Page): Promise<void> {
    await page.goto(`${state.edgeUrl}/admin/login`);
    await page.locator('input[name="token"]').fill(state.adminToken);
    const button = page.locator('wa-button', { hasText: 'Sign in' });
    await waitForUpgrade(button);
    await button.click();
    await page.waitForURL(`${state.edgeUrl}/admin`);
  }

  test('the admin area is closed without the token and opens with it', async ({ page }) => {
    await page.goto(`${state.edgeUrl}/admin`);
    await expect(page).toHaveURL(`${state.edgeUrl}/admin/login`);
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();

    await page.locator('input[name="token"]').fill('not-the-token');
    const button = page.locator('wa-button', { hasText: 'Sign in' });
    await waitForUpgrade(button);
    await button.click();

    await expect(page.locator('wa-callout')).toContainText('That token is not valid.');
    await expect(page).toHaveURL(`${state.edgeUrl}/admin/login`);

    await page.locator('input[name="token"]').fill(state.adminToken);
    await button.click();
    await expect(page).toHaveURL(`${state.edgeUrl}/admin`);
    await expect(page.getByRole('heading', { name: 'Catalog curation' })).toBeVisible();
  });

  test('merging editions keeps the base URI and absorbs identifiers and credits', async ({ page }) => {
    await adminSignIn(page);

    // The same request the workbench's "Merge editions" button sends: the base
    // keeps its URI, the others are absorbed with unioned contributors.
    const response = await page.request.post(`${state.edgeUrl}/admin/api/merge`, {
      data: {
        base: state.bookBaseUri,
        others: [state.bookOtherUri],
        sources: {},
        contributors: { mode: 'union' },
        publishers: { mode: 'union' }
      }
    });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { deleted: string[] };
    expect(body.deleted).toEqual([state.bookOtherUri]);

    const books = await pool.query<{ uri: string }>(
      'SELECT uri FROM books WHERE uri = ANY($1) ORDER BY uri',
      [[state.bookBaseUri, state.bookOtherUri]]
    );
    expect(books.rows.map((row) => row.uri)).toEqual([state.bookBaseUri]);

    const identifiers = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM edition_identifiers WHERE edition_uri = $1',
      [state.bookBaseUri]
    );
    expect(identifiers.rows[0]?.n).toBe(2);

    // The credit lived on the absorbed edition and follows it onto the base.
    const credits = await pool.query<{ contributor_id: string }>(
      'SELECT contributor_id FROM edition_contributors WHERE edition_uri = $1',
      [state.bookBaseUri]
    );
    expect(credits.rows.map((row) => String(row.contributor_id))).toContain(
      state.contributorSourceId
    );
  });

  test('merging contributors moves credits and the verified identity, then deletes the source', async ({
    page
  }) => {
    await adminSignIn(page);

    await page.goto(
      `${state.edgeUrl}/admin/contributor/${state.contributorSourceId}/merge?into=${state.contributorTargetId}`
    );
    await expect(page.getByRole('heading', { name: 'Merge contributor' })).toBeVisible();
    const main = page.locator('main');
    await expect(main).toContainText('E2E Merge Source');
    await expect(main).toContainText('E2E Merge Target');

    const confirm = page.locator('wa-button', { hasText: 'Merge and delete' });
    await waitForUpgrade(confirm);
    await confirm.click();
    await expect(page).toHaveURL(
      `${state.edgeUrl}/admin/contributor/${state.contributorTargetId}/edit`
    );

    const source = await pool.query('SELECT 1 FROM contributors WHERE id = $1', [
      state.contributorSourceId
    ]);
    expect(source.rowCount).toBe(0);

    const credits = await pool.query<{ edition_uri: string }>(
      'SELECT edition_uri FROM edition_contributors WHERE contributor_id = $1',
      [state.contributorTargetId]
    );
    expect(credits.rows.map((row) => row.edition_uri)).toEqual([state.bookBaseUri]);

    const identity = await pool.query<{ did: string }>(
      'SELECT did FROM contributor_identities WHERE contributor_id = $1',
      [state.contributorTargetId]
    );
    expect(identity.rows.map((row) => row.did)).toEqual(['did:plc:e2emergesource']);
  });

  test('merging publishers absorbs identifiers and deletes the source', async ({ page }) => {
    await adminSignIn(page);

    await page.goto(
      `${state.edgeUrl}/admin/publisher/${state.publisherSourceId}/merge?into=${state.publisherTargetId}`
    );
    await expect(page.locator('main')).toContainText('E2E Merge Press');

    const confirm = page.locator('wa-button', { hasText: 'Merge and delete' });
    await waitForUpgrade(confirm);
    await confirm.click();
    await expect(page).toHaveURL(
      `${state.edgeUrl}/admin/publisher/${state.publisherTargetId}/edit`
    );

    const source = await pool.query('SELECT 1 FROM publishers WHERE id = $1', [
      state.publisherSourceId
    ]);
    expect(source.rowCount).toBe(0);

    const target = await pool.query<{ identifiers: unknown[] }>(
      'SELECT identifiers FROM publishers WHERE id = $1',
      [state.publisherTargetId]
    );
    expect(target.rows[0]?.identifiers).toHaveLength(2);
  });
}
