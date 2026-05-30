const { test, expect } = require('@playwright/test');
const {
  addProductToCart,
  appLocator,
  cleanupAllCheckoutFixtures,
  cleanupFixture,
  clearBrowserState,
  closeSwal,
  expectSwal,
  fillCheckoutForm,
  mutateFixture,
  openCart,
  openCheckout,
  openStorefront,
  prepareFixture,
  submitCheckout
} = require('../helpers/storefront');

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

test.describe('checkout warning UI in Chromium', () => {
  test('product-stock-zero-after-cart shows out-of-stock warning', async ({ page }) => {
    const fixture = await prepareFixture(page, 'product-stock-zero-after-cart');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    await fillCheckoutForm(page);
    await mutateFixture(page, fixture.runId, 'product-stock-zero');
    await submitCheckout(page);

    await expectSwal(page, /สินค้ามีไม่พอ/, /ขายหมด|หมด|เหลือ.*0/);
    await expect(await appLocator(page, '.swal2-confirm')).toContainText(/ลบ|ออกจากตะกร้า/);
  });

  test('product-stock-partial-after-cart offers to reduce quantity', async ({ page }) => {
    const fixture = await prepareFixture(page, 'product-stock-partial-after-cart');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 3);
    await openCheckout(page);
    await fillCheckoutForm(page);
    await mutateFixture(page, fixture.runId, 'product-stock-one');
    await submitCheckout(page);

    await expectSwal(page, /สินค้ามีไม่พอ/, /เหลือ.*1|1.*ชิ้น/);
    const reduceButton = await appLocator(page, '.swal2-confirm');
    await expect(reduceButton).toContainText(/ลด.*1|เหลือ.*1/);
    await expect(reduceButton).toBeEnabled({ timeout: 30000 });
    await reduceButton.click();
    await expect(await appLocator(page, '#orderConfirmModal')).toBeVisible();
  });

  test('gift-already-out-of-stock is visible before and after successful order', async ({ page }) => {
    const fixture = await prepareFixture(page, 'gift-already-out-of-stock');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCart(page);
    await expect(await appLocator(page, '#cartGiftPreview')).toContainText(/ของแถม|หมดสต็อก|สต็อกไม่พอ|ไม่สามารถ/);
    await (await appLocator(page, '#btnCheckout')).click();
    await expect(await appLocator(page, '#orderConfirmModal')).toBeVisible();
    await fillCheckoutForm(page);
    await submitCheckout(page);

    await expect(await appLocator(page, '.swal2-html-container')).toContainText(/สั่งซื้อสำเร็จ|ของแถมบางรายการหมดสต็อก|หมดสต็อก/);
  });

  test('gift-stock-depleted-after-preview blocks with gift warning', async ({ page }) => {
    const fixture = await prepareFixture(page, 'gift-stock-depleted-after-preview');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCart(page);
    await expect(await appLocator(page, '#cartGiftPreview')).toContainText(/ของแถม|ได้รับแล้ว|เหลือ 1/);
    await (await appLocator(page, '#btnCheckout')).click();
    await expect(await appLocator(page, '#orderConfirmModal')).toBeVisible();
    await fillCheckoutForm(page);
    await mutateFixture(page, fixture.runId, 'gift-stock-zero');
    await submitCheckout(page);

    await expectSwal(page, /ของแถมหมดสต็อก/, /หมดสต็อก|สต็อกไม่เพียงพอ/);
  });

  test('price-changed-after-cart shows price changed warning', async ({ page }) => {
    const fixture = await prepareFixture(page, 'price-changed-after-cart');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    await fillCheckoutForm(page);
    await mutateFixture(page, fixture.runId, 'price-change');
    await submitCheckout(page);

    await expectSwal(page, /ราคามีการเปลี่ยนแปลง/, /ยอดเดิม|ยอดใหม่|ราคา|โปรโมชั่น/);
  });

  test('promotion-ended-after-cart shows price changed warning', async ({ page }) => {
    const fixture = await prepareFixture(page, 'promotion-ended-after-cart');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    await fillCheckoutForm(page);
    await mutateFixture(page, fixture.runId, 'promotion-disable');
    await submitCheckout(page);

    await expectSwal(page, /ราคามีการเปลี่ยนแปลง/, /ยอดเดิม|ยอดใหม่|ราคา|โปรโมชั่น/);
  });

  test('sale-not-active-after-cart shows unavailable product warning', async ({ page }) => {
    const fixture = await prepareFixture(page, 'sale-not-active-after-cart');
    currentRunId = fixture.runId;

    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    await fillCheckoutForm(page);
    await mutateFixture(page, fixture.runId, 'sale-disable');
    await submitCheckout(page);

    await expectSwal(page, /สินค้านี้ไม่พร้อมจำหน่าย/, /ยังไม่เปิดขาย|สิ้นสุดการขาย|ไม่พร้อมจำหน่าย/);
    await expect(await appLocator(page, '.swal2-confirm')).toContainText(/ลบ|ออกจากตะกร้า/);
  });
});
