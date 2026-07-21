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
  removeFirstCartItem,
  waitForGoogleScriptRun
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

  test('direct discount remains after promotion preview returns no applied promotion', async ({ page }) => {
    const fixture = await prepareFixture(page, 'active-promotion-stable');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCart(page);
    const frame = await waitForGoogleScriptRun(page);
    await frame.waitForFunction(() => _promoLineMapForCurrentCart() !== null);

    await expect(frame.locator('#cartBody .clp-orig')).toContainText('฿150');
    await expect(frame.locator('#cartBody .clp-now')).toContainText('฿135');
    await expect(frame.locator('#cartTotal')).toContainText('฿135');

    const pricing = await frame.evaluate(() => {
      const payload = _buildGiftPreviewPayload();
      const item = payload.items[0];
      const variantKey = _buildVariantKey(item.selected_variants || {});
      const key = JSON.stringify(payload);
      _promoLineMap = Object.create(null);
      _promoLineMap[_promoLineKey(item.product_id, variantKey)] = {
        unit_final_price: 150,
        unit_base_price: 150,
        promotion: null
      };
      _promoLineMapKey = key;
      updateCartUI();
      const built = _buildCartItems();
      const client = _buildClientPricingSnapshot(built.items);
      return {
        cartUnit: built.items[0].unit_price,
        subtotal: built.subtotal,
        clientUnit: client.items[0].unit_final_price,
        promotionId: client.items[0].promotion_id
      };
    });

    await expect(frame.locator('#cartBody .clp-now')).toContainText('฿135');
    await expect(frame.locator('#cartTotal')).toContainText('฿135');
    expect(pricing).toEqual({
      cartUnit: 135,
      subtotal: 135,
      clientUnit: 135,
      promotionId: fixture.promotion.id
    });
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
