import type { Locator } from '@playwright/test';

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
