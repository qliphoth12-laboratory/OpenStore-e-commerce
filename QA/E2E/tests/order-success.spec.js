const { test, expect } = require('@playwright/test');
const {
  addProductToCart,
  appLocator,
  cleanupAllCheckoutFixtures,
  cleanupFixture,
  clearBrowserState,
  clickCheckoutSubmit,
  closeSwal,
  expectOrderSuccess,
  fillCheckoutForm,
  openCheckout,
  openStorefront,
  prepareFixture,
  submitCheckout
} = require('../helpers/storefront');

// Areas 9/10 — successful order submission + the success page the customer sees.
// These create a real order on the test deployment; afterEach cleanup removes it.
// (The storefront success view shows a link to order-view and generates NO QR — the
// payment QR / incomplete-config handling lives in order-view.html, not index.html.)

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

test.describe('order submission success in Chromium', () => {
  test('happy-path checkout shows the success card with a pay link', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    await fillCheckoutForm(page);
    await submitCheckout(page);

    await expectOrderSuccess(page);
    await expect(await appLocator(page, '.swal2-html-container'))
      .toContainText(/ชำระเงินและอัปโหลดสลิป/);
  });

  test('submit button is disabled while the order is in flight (double-click guard)', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    await fillCheckoutForm(page);

    await clickCheckoutSubmit(page);
    // Disabled synchronously when the handler starts, stays disabled for the whole RPC.
    await expect(await appLocator(page, '#ocmBtnSubmit')).toBeDisabled();

    // Let the order finish so afterEach cleanup removes a committed row, not a racing one.
    await expectOrderSuccess(page);
  });
});
