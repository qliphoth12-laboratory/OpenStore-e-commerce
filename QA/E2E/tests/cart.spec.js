const { test, expect } = require('@playwright/test');
const {
  addProductToCart,
  appLocator,
  cleanupAllCheckoutFixtures,
  cleanupFixture,
  clearBrowserState,
  closeSwal,
  expectCartEmpty,
  getCartCount,
  incrementFirstCartItem,
  openCart,
  openStorefront,
  prepareFixture,
  removeFirstCartItem
} = require('../helpers/storefront');

// Area 3 — cart behavior (happy + recovery paths that surface visible UI state).

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

test.describe('cart behavior in Chromium', () => {
  test('adding a product increments the cart badge and lists the item', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    expect(await getCartCount(page)).toBe(1);

    await openCart(page);
    await expect(await appLocator(page, '#cartBody')).toContainText(fixture.product.title);
  });

  test('increasing quantity updates the cart total', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCart(page);

    const totalEl = await appLocator(page, '#cartTotal');
    const before = (await totalEl.innerText()).trim();

    await incrementFirstCartItem(page);

    // qty display becomes 2 and the total recalculates away from the single-item value
    await expect(await appLocator(page, '#cartBody')).toContainText(/\b2\b/);
    await expect(totalEl).not.toHaveText(before);
  });

  test('removing the only item empties the cart', async ({ page }) => {
    const fixture = await prepareFixture(page, 'happy-path');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCart(page);
    await removeFirstCartItem(page);

    await expectCartEmpty(page);
    await expect(await appLocator(page, '#cartEmpty')).toContainText(/ยังไม่มีสินค้าในตะกร้า/);
  });
});
