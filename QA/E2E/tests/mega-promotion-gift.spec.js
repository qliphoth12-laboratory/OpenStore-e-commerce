const { test, expect } = require('@playwright/test');
const {
  addProductToCart,
  addProductVariantToCart,
  cleanupMegaPromotionGiftFixture,
  clearBrowserState,
  closeSwal,
  expectOrderSuccess,
  fillCheckoutForm,
  getCartCount,
  inspectMegaPromotionGiftFixture,
  openCart,
  openStorefront,
  prepareMegaPromotionGiftFixture,
  submitCheckout,
  waitForGoogleScriptRun
} = require('../helpers/storefront');

test.setTimeout(600_000);

let currentFixture = null;

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

function cartRow(frame, title, variantLabel = '') {
  let row = frame.locator('#cartBody .cart-order-row').filter({ hasText: title });
  if (variantLabel) row = row.filter({ hasText: new RegExp(`Size:\\s*${variantLabel}`) });
  return row.first();
}

function checkoutRow(frame, title, variantLabel = '') {
  let row = frame.locator('#ocmItems .ocm-item').filter({ hasText: title });
  if (variantLabel) row = row.filter({ hasText: new RegExp(`Size:\\s*${variantLabel}`) });
  return row.first();
}

function orderViewRow(frame, title, variantLabel = '') {
  let row = frame.locator('#itemsBody tr').filter({ hasText: title });
  if (variantLabel) row = row.filter({ hasText: new RegExp(`Size:\\s*${variantLabel}`) });
  return row.first();
}

test.beforeEach(async ({ page }) => {
  currentFixture = null;
  await clearBrowserState(page);
  await openStorefront(page);
});

test.afterEach(async ({ page }) => {
  await closeSwal(page);
  if (!currentFixture) return;
  // Return to a known Apps Script frame before cleanup. Cleanup identifies an order by
  // fixture product/gift IDs, so it still removes a committed order if an assertion failed
  // immediately after the submit click.
  await openStorefront(page).catch(() => {});
  await cleanupMegaPromotionGiftFixture(page, currentFixture);
  currentFixture = null;
});

test.describe('mega promotion and gift customer workflow in Chromium', () => {
  test('one order shows every winning promotion and all conditional gifts correctly', async ({ page }) => {
    const prepared = await prepareMegaPromotionGiftFixture(page);
    currentFixture = prepared.fixture;

    const { products, promotions, gifts, expected } = prepared;
    const expectedLines = [
      { title: products.a.title, variant: '', qty: 3, base: 1000, final: 980, subtotal: 2940, promo: promotions.subtotal_all },
      { title: products.b.title, variant: '', qty: 4, base: 600, final: 420, subtotal: 1680, promo: promotions.product_any },
      { title: products.variant.title, variant: 'M', qty: 2, base: 800, final: 480, subtotal: 960, promo: promotions.variant_any },
      { title: products.variant.title, variant: 'S', qty: 3, base: 400, final: 380, subtotal: 1140, promo: promotions.subtotal_all },
      { title: products.d.title, variant: '', qty: 5, base: 250, final: 230, subtotal: 1150, promo: promotions.subtotal_all },
      { title: products.e.title, variant: '', qty: 2, base: 300, final: 270, subtotal: 540, promo: promotions.direct_be }
    ];

    // Build exactly six cart lines (five products, with M/S as separate variant lines).
    await addProductToCart(page, products.a.title, 3);
    await addProductToCart(page, products.b.title, 4);
    await addProductVariantToCart(page, products.variant.title, 'M', 2);
    await addProductVariantToCart(page, products.variant.title, 'S', 3);
    await addProductToCart(page, products.d.title, 5);
    await addProductToCart(page, products.e.title, 2);
    expect(await getCartCount(page)).toBe(19);

    await openCart(page);
    const frame = await waitForGoogleScriptRun(page);
    await expect(frame.locator('#cartBody .cart-order-row')).toHaveCount(6);
    await expect(frame.locator('#cartPromoPreview')).toBeVisible({ timeout: 120_000 });
    await expect(frame.locator('#cartPromoPreview .cart-gift-section.is-earned .cart-promo-row'))
      .toHaveCount(5, { timeout: 120_000 });
    await expect(frame.locator('#cartGiftPreview')).toBeVisible({ timeout: 120_000 });
    await expect(frame.locator('#cartGiftPreview .cart-gift-section.is-earned .cart-promo-row'))
      .toHaveCount(5, { timeout: 120_000 });

    // Every visible cart line must show the best-price winner, not a stacked price.
    for (const line of expectedLines) {
      const row = cartRow(frame, line.title, line.variant);
      await expect(row).toBeVisible();
      await expect(row.locator('.cart-qty-value')).toHaveText(String(line.qty));
      await expectMoney(row.locator('.clp-orig'), line.base);
      await expectMoney(row.locator('.clp-now'), line.final);
      await expectMoney(row.locator('.cart-price-sub strong'), line.subtotal);
      await expect(row.locator('.cart-promo-badge')).toContainText(line.promo.name);
    }
    await expectMoney(frame.locator('#cartTotal'), expected.subtotal);

    // Five conditional promotions qualify. Two are visibly marked as outpriced while
    // their stronger competitors remain the winners on B and Variant M.
    const promoRows = frame.locator('#cartPromoPreview .cart-gift-section.is-earned .cart-promo-row');
    const promotionCases = [
      { promo: promotions.subtotal_all, outpriced: false },
      { promo: promotions.product_all, outpriced: true },
      { promo: promotions.product_any, outpriced: false },
      { promo: promotions.variant_all, outpriced: true },
      { promo: promotions.variant_any, outpriced: false }
    ];
    for (const item of promotionCases) {
      const row = promoRows.filter({ hasText: item.promo.name });
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      if (item.outpriced) {
        await expect(row).toHaveClass(/\bis-outpriced\b/);
        await expect(row).toContainText('ไม่ถูกใช้');
        await expect(row).toContainText('มีส่วนลดอื่นที่คุ้มกว่า');
      } else {
        await expect(row).not.toHaveClass(/\bis-outpriced\b/);
      }
    }

    // All five gift conditions and their multiplied quantities are visible in the cart.
    const giftRows = frame.locator('#cartGiftPreview .cart-gift-section.is-earned .cart-promo-row');
    for (const gift of gifts) {
      const row = giftRows.filter({ hasText: gift.name });
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      await expect(row).toContainText(`รับฟรี ×${gift.qty}`);
    }

    // Correlate the rendered previews with the exact calculation bases returned to the UI.
    const previewState = await frame.evaluate(({ promotionIds, ruleIds }) => {
      const promo = window._promoPreviewLastResult || {};
      const gift = window._giftPreviewLastResult || {};
      return {
        promoOk: promo.ok === true,
        rawSubtotal: (promo.lines || []).reduce(
          (sum, line) => sum + Number(line.unit_base_price || 0) * Number(line.qty || 0), 0
        ),
        directSubtotal: Number(promo.subtotal_after_promo),
        finalSubtotal: Number(promo.subtotal),
        eligiblePromotionIds: (promo.eligible || [])
          .map((item) => String(item.promotion_id))
          .filter((id) => promotionIds.includes(id)),
        giftOk: gift.ok === true,
        giftDirectSubtotal: Number(gift.subtotal_after_promo),
        eligibleGifts: (gift.eligible || [])
          .filter((item) => ruleIds.includes(String(item.rule_id)))
          .map((item) => ({ ruleId: String(item.rule_id), qty: Number(item.gift && item.gift.qty) }))
      };
    }, {
      promotionIds: promotionCases.map((item) => String(item.promo.id)),
      ruleIds: gifts.map((gift) => String(gift.rule_id))
    });
    expect(previewState.promoOk).toBe(true);
    expect(previewState.rawSubtotal).toBe(expected.raw_subtotal);
    expect(previewState.directSubtotal).toBe(expected.direct_subtotal);
    expect(previewState.finalSubtotal).toBe(expected.subtotal);
    expect(previewState.eligiblePromotionIds).toHaveLength(5);
    expect(previewState.giftOk).toBe(true);
    expect(previewState.giftDirectSubtotal).toBe(expected.direct_subtotal);
    expect(previewState.eligibleGifts.map((gift) => gift.qty)).toEqual(gifts.map((gift) => gift.qty));

    // Checkout confirmation must carry the same six line prices, five gifts and totals.
    await frame.locator('#btnCheckout').click();
    await expect(frame.locator('#orderConfirmModal')).toBeVisible();
    await expect(frame.locator('#ocmItems .ocm-item')).toHaveCount(6);
    for (const line of expectedLines) {
      const row = checkoutRow(frame, line.title, line.variant);
      await expect(row).toBeVisible();
      await expect(row.locator('.ocm-item-qty')).toHaveText(`×${line.qty}`);
      await expectMoney(row.locator('.ocm-item-price .text-danger'), line.final);
      await expectMoney(row.locator('.ocm-item-sub'), line.subtotal);
    }
    await expect(frame.locator('#ocmGiftSection')).toBeVisible();
    await expect(frame.locator('#ocmGiftList .ocm-gift-row')).toHaveCount(5);
    for (const gift of gifts) {
      const row = frame.locator('#ocmGiftList .ocm-gift-row').filter({ hasText: gift.name });
      await expect(row).toBeVisible();
      await expect(row).toContainText(`×${gift.qty}`);
    }
    await expectMoney(frame.locator('#ocmSubtotal'), expected.subtotal);
    await expectMoney(frame.locator('#ocmShippingFeeDisplay'), expected.shipping_fee);
    await expectMoney(frame.locator('#ocmTotal'), expected.total);

    await fillCheckoutForm(page);
    await submitCheckout(page); // The only submit click in this workflow.
    await expectOrderSuccess(page);

    const successPopup = frame.locator('.swal2-popup');
    const orderLinks = successPopup.locator('a[href*="page=order-view"]');
    await expect(orderLinks).toHaveCount(1);
    const orderViewUrl = await orderLinks.first().getAttribute('href');
    expect(orderViewUrl).toBeTruthy();
    await expect(successPopup).toContainText('ของแถมที่ได้รับ');
    await expect(successPopup).not.toContainText('ของแถมบางรายการหมดสต็อก');
    for (const gift of gifts) {
      const giftName = successPopup.getByText(gift.name, { exact: true });
      await expect(giftName).toBeVisible();
      await expect(giftName.locator('..').locator('..')).toContainText(new RegExp(`×\\s*${gift.qty}`));
    }

    // Admin-side inspection is limited to the single-order/stock invariant; the price and
    // gift snapshots themselves are verified below through the customer token page.
    const inspection = await inspectMegaPromotionGiftFixture(page, prepared.fixture);
    expect(inspection.order_ids).toHaveLength(1);
    expect(inspection.product_stock).toEqual(expected.product_stock);
    expect(inspection.gift_stock).toEqual(expected.gift_stock);

    // Open the exact link shown to the customer and verify the persisted snapshots render.
    await page.goto(orderViewUrl);
    await page.waitForLoadState('domcontentloaded');
    const orderFrame = await waitForGoogleScriptRun(page);
    await expect(orderFrame.locator('#mainContent')).toBeVisible({ timeout: 120_000 });
    await expect(orderFrame.locator('#itemsBody tr')).toHaveCount(6);
    for (const line of expectedLines) {
      const row = orderViewRow(orderFrame, line.title, line.variant);
      await expect(row).toBeVisible();
      const cells = row.locator('td');
      await expect(cells.nth(2)).toHaveText(String(line.qty));
      await expectMoney(cells.nth(3).locator('div').first(), line.final);
      await expectMoney(cells.nth(3).locator('div').nth(1), line.base);
      await expectMoney(cells.nth(4), line.subtotal);
      await expect(row).toContainText(line.promo.name);
    }

    await expectMoney(orderFrame.locator('#subtotalBaseVal'), expected.raw_subtotal);
    await expectMoney(orderFrame.locator('#discountVal'), -(expected.raw_subtotal - expected.subtotal));
    await expectMoney(orderFrame.locator('#subtotalVal'), expected.subtotal);
    await expectMoney(orderFrame.locator('#shippingFeeVal'), expected.shipping_fee);
    await expectMoney(orderFrame.locator('#totalVal'), expected.total);
    await expect(orderFrame.locator('#customerGiftsSection')).toBeVisible();
    await expect(orderFrame.locator('#customerGiftsList > div')).toHaveCount(5);
    for (const gift of gifts) {
      const row = orderFrame.locator('#customerGiftsList > div').filter({ hasText: gift.name });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(new RegExp(`×\\s*${gift.qty}`));
    }
  });
});
