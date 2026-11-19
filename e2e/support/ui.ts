import type { Locator, Page } from '@playwright/test';

/**
 * Wait until a Web Awesome element has been upgraded.
 *
 * The pages are server-rendered, so `wa-button` exists in the markup before the
 * component module defines it. A click dispatched into an unupgraded element
 * does nothing and is never replayed — waiting for `customElements.whenDefined`
 * is what a person's click after hydration amounts to.
 */
export async function waitForUpgrade(locator: Locator): Promise<void> {
  await locator.evaluate(async (el) => {
    await customElements.whenDefined(el.localName);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

/**
 * Sign in to the operator area.
 *
 * The token is the same one `/admin/api/*` requires; the cookie it sets is what
 * every page below the layout checks.
 */
export async function adminSignIn(
  page: Page,
  { edgeUrl, token }: { edgeUrl: string; token: string }
): Promise<void> {
  await page.goto(`${edgeUrl}/admin/login`);
  await page.locator('input[name="token"]').fill(token);
  const button = page.locator('wa-button', { hasText: 'Sign in' });
  await waitForUpgrade(button);
  await button.click();
  await page.waitForURL(`${edgeUrl}/admin`);
}
