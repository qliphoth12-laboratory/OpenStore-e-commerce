const { test } = require('@playwright/test');
const {
  addProductToCart,
  cleanupAllCheckoutFixtures,
  cleanupFixture,
  clearBrowserState,
  closeSwal,
  expectValidationAlert,
  fillCheckoutForm,
  openCheckout,
  openStorefront,
  prepareFixture,
  submitCheckout
} = require('../helpers/storefront');

// Area 4 — checkout form validation.
// Each test fills every required field with valid defaults EXCEPT the one under test,
// then asserts the storefront blocks submission with the Thai validation popup that
// names the offending field. No order ever reaches the backend in these cases.

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

test.describe('checkout form validation in Chromium', () => {
  async function reachCheckout(page) {
    const fixture = await prepareFixture(page, 'happy-path');
    currentRunId = fixture.runId;
    await addProductToCart(page, fixture.product.title, 1);
    await openCheckout(page);
    return fixture;
  }

  test('missing customer name blocks checkout and names the field', async ({ page }) => {
    await reachCheckout(page);
    await fillCheckoutForm(page, { ocmCustomerName: null });
    await submitCheckout(page);
    await expectValidationAlert(page, /ชื่อ-นามสกุลผู้สั่งซื้อ/);
  });

  test('invalid phone format blocks checkout and names the phone field', async ({ page }) => {
    await reachCheckout(page);
    await fillCheckoutForm(page, { ocmPhone: 'abc' });
    await submitCheckout(page);
    await expectValidationAlert(page, /เบอร์โทรศัพท์/);
  });

  test('missing shipping address blocks checkout and names the field', async ({ page }) => {
    await reachCheckout(page);
    await fillCheckoutForm(page, { ocmAddress: null });
    await submitCheckout(page);
    await expectValidationAlert(page, /ที่อยู่จัดส่ง/);
  });

  test('missing province blocks checkout and names the field', async ({ page }) => {
    await reachCheckout(page);
    await fillCheckoutForm(page, { ocmProvince: null });
    await submitCheckout(page);
    await expectValidationAlert(page, /จังหวัด/);
  });

  test('missing postal code blocks checkout and names the field', async ({ page }) => {
    await reachCheckout(page);
    await fillCheckoutForm(page, { ocmPostalCode: null });
    await submitCheckout(page);
    await expectValidationAlert(page, /รหัสไปรษณีย์/);
  });

  test('unaccepted terms blocks checkout with a clear message', async ({ page }) => {
    await reachCheckout(page);
    await fillCheckoutForm(page, { terms: false });
    await submitCheckout(page);
    await expectValidationAlert(page, /เงื่อนไข|ยอมรับ/);
  });
});
