const { test, expect } = require('@playwright/test');
const {
  addProductToCart,
  clearBrowserState,
  closeSwal,
  expectOrderSuccess,
  fillCheckoutForm,
  getCartCount,
  inspectOrderTotalPromoFixture,
  cleanupOrderTotalPromoFixture,
  openCart,
  openStorefront,
  prepareOrderTotalPromoFixture,
  submitCheckout,
  waitForGoogleScriptRun
} = require('../helpers/storefront');

test.setTimeout(600_000);

let currentFixture = null;

// Parse "฿1,700" / "-฿300" into a signed number so assertions ignore formatting.
async function expectMoney(locator, expectedAmount) {
  await expect(locator).toBeVisible();
  await expect.poll(async () => {
    const text = (await locator.innerText()).replace(/,/g, '');
    const match = text.match(/\d+(?:\.\d+)?/);
    if (!match) return NaN;
    const sign = text.slice(0, match.index).includes('-') ? -1 : 1;
    return sign * Number(match[0]);
  }).toBe(expectedAmount);
}

test.beforeEach(async ({ page }) => {
  currentFixture = null;
  await clearBrowserState(page);
  await openStorefront(page);
});

test.afterEach(async ({ page }) => {
  await closeSwal(page);
  if (!currentFixture) return;
  await openStorefront(page).catch(() => {});
  await cleanupOrderTotalPromoFixture(page, currentFixture);
  currentFixture = null;
});

test.describe('order-total (whole-order) discount customer workflow in Chromium', () => {
  test('order-total discount is deducted once across cart, checkout, and order-view', async ({ page }) => {
    const prepared = await prepareOrderTotalPromoFixture(page);
    currentFixture = prepared.fixture;

    const { product, promotion, expected } = prepared;

    // qty 2 → subtotal 2000 ≥ 1500 threshold → order-total discount 300 applies once.
    await addProductToCart(page, product.title, expected.qty);
    expect(await getCartCount(page)).toBe(expected.qty);

    await openCart(page);
    const frame = await waitForGoogleScriptRun(page);

    // Cart shows the eligibility panel, the order-total discount row, and the net total.
    // The eligibility preview is async (debounced) → poll for the discount row.
    await expect(frame.locator('#cartPromoPreview')).toBeVisible();
    await expect(frame.locator('#cartPromoPreview')).toContainText(promotion.name);
    await expect(frame.locator('#cartOrderDiscountRow')).toBeVisible({ timeout: 30_000 });
    await expectMoney(frame.locator('#cartOrderDiscount'), -expected.order_discount);
    // Per-unit price is unchanged (order-total never edits the line price): 2 × 1000 − 300 = 1700.
    await expectMoney(frame.locator('#cartTotal'), expected.subtotal_after_order_discount);

    // Checkout confirm modal: subtotal, order-total discount line, and net-of-discount total.
    await frame.locator('#btnCheckout').click();
    await expect(frame.locator('#orderConfirmModal')).toBeVisible();
    await expect(frame.locator('#ocmSubtotal')).toBeVisible({ timeout: 30_000 });
    await expectMoney(frame.locator('#ocmSubtotal'), expected.subtotal);
    await expect(frame.locator('#ocmOrderDiscountLine')).toBeVisible();
    await expectMoney(frame.locator('#ocmOrderDiscount'), -expected.order_discount);
    await expectMoney(frame.locator('#ocmShippingFeeDisplay'), expected.shipping_fee);
    await expectMoney(frame.locator('#ocmTotal'), expected.total);

    await fillCheckoutForm(page);
    await submitCheckout(page);
    await expectOrderSuccess(page);

    const successPopup = frame.locator('.swal2-popup');
    const orderLinks = successPopup.locator('a[href*="page=order-view"]');
    await expect(orderLinks).toHaveCount(1);
    const orderViewUrl = await orderLinks.first().getAttribute('href');
    expect(orderViewUrl).toBeTruthy();

    // Admin inspection: exactly one order committed, stock reduced by the ordered qty.
    const inspection = await inspectOrderTotalPromoFixture(page, prepared.fixture);
    expect(inspection.order_ids).toHaveLength(1);

    // Customer order-view page renders the persisted order-total discount and net total.
    await page.goto(orderViewUrl);
    await page.waitForLoadState('domcontentloaded');
    const orderFrame = await waitForGoogleScriptRun(page);
    await expect(orderFrame.locator('#mainContent')).toBeVisible({ timeout: 120_000 });
    await expectMoney(orderFrame.locator('#subtotalVal'), expected.subtotal);
    await expect(orderFrame.locator('#orderDiscountRow')).toBeVisible();
    await expectMoney(orderFrame.locator('#orderDiscountVal'), -expected.order_discount);
    await expectMoney(orderFrame.locator('#shippingFeeVal'), expected.shipping_fee);
    await expectMoney(orderFrame.locator('#totalVal'), expected.total);
  });
});
