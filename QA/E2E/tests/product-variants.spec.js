const { test, expect } = require('@playwright/test');
const {
  addProductToCart,
  appLocator,
  cleanupAllCheckoutFixtures,
  cleanupFixture,
  clearBrowserState,
  closeSwal,
  openCart,
  openProductDetails,
  openStorefront,
  prepareFixture,
  selectVariant
} = require('../helpers/storefront');

// Area 2/3 — product variant selection.
// The storefront auto-selects the first in-stock option, so a required option is always
// chosen; these tests verify that real behavior: the chosen variant carries into the cart,
// and switching options re-prices the detail view.

let currentRunId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await openStorefront(page);
    await cleanupAllCheckoutFixtures(page);
  } finally {
    await page.close();
  }
});

test.beforeEach(async ({ page }) => {
  currentRunId = '';
  await clearBrowserState(page);
  await openStorefront(page);
});

test.afterEach(async ({ page }) => {
  await closeSwal(page);
  if (currentRunId) await cleanupFixture(page, currentRunId);
});

test.describe('product variant selection in Chromium', () => {
  test('default option is preselected and carried into the cart', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path-variants');
    currentRunId = fixture.runId;

    // No explicit option click — relies on the auto-selected first in-stock option (S).
    await addProductToCart(page, fixture.product.title, 1);
    await openCart(page);
    await expect(await appLocator(page, '#cartBody')).toContainText(/ขนาด:\s*S/);
  });

  test('switching the option re-prices the detail view', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path-variants');
    currentRunId = fixture.runId;

    await openProductDetails(page, fixture.product.title);
    const priceEl = await appLocator(page, '#productDetailPrice');
    await expect(priceEl).toHaveText('฿500'); // option S = base price

    await selectVariant(page, 'M');
    await expect(priceEl).toHaveText('฿550'); // option M = base + 50
  });
});
