const { expect } = require('@playwright/test');
const { loadE2eConfig } = require('../config');

function requiredConfig(name, value) {
  if (!value) throw new Error(`Missing ${name}. Set it in QA/e2e/e2e.config.local.json or E2E_BASE_URL.`);
  return value;
}

function indexUrl() {
  const baseUrl = requiredConfig('baseUrl', loadE2eConfig().baseUrl).replace(/\/+$/, '');
  return `${baseUrl}?page=index`;
}

function adminToken() {
  return requiredConfig('adminToken', loadE2eConfig().adminToken);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearBrowserState(page) {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('SHOP_CART_V1');
      localStorage.removeItem('SHOP_ORDER_TOKENS_V1');
      localStorage.removeItem('SHOP_LAST_ORDER_TOKEN');
    } catch (_) {}
  });
}

async function appLocator(page, selector) {
  const frame = await waitForGoogleScriptRun(page);
  return frame.locator(selector);
}

async function openStorefront(page) {
  await page.goto(indexUrl());
  await page.waitForLoadState('domcontentloaded');
  await page.locator('body').waitFor({ state: 'visible' });
  await expect(page.locator('body')).not.toContainText('404 Not Found');
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('body').waitFor({ state: 'visible' });
}

async function waitForGoogleScriptRun(page) {
  const timeoutMs = loadE2eConfig().googleScriptTimeoutMs;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const ready = await frame.evaluate(
        () => !!(window.google && window.google.script && window.google.script.run)
      ).catch(() => false);
      if (ready) return frame;
    }
    await sleep(500);
  }

  const url = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const frameUrls = page.frames().map((frame) => frame.url()).join(' | ');
  throw new Error(
    `google.script.run was not available after ${timeoutMs}ms. `
    + `Current URL: ${url}. Frame URLs: ${frameUrls}. Page text: ${bodyText.slice(0, 700)}`
  );
}

async function gasRun(page, functionName, args = []) {
  const timeoutMs = loadE2eConfig().gasRpcTimeoutMs;
  const frame = await waitForGoogleScriptRun(page);
  return frame.evaluate(
    ({ functionName, args, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${functionName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (!window.google || !google.script || !google.script.run) {
          clearTimeout(timer);
          reject(new Error('google.script.run is not available; open the deployed Apps Script Web App URL'));
          return;
        }
        google.script.run
          .withSuccessHandler((value) => {
            clearTimeout(timer);
            resolve(value);
          })
          .withFailureHandler((err) => {
            clearTimeout(timer);
            reject(new Error(err && err.message ? err.message : String(err)));
          })
          [functionName](...args);
      }),
    { functionName, args, timeoutMs }
  );
}

async function prepareFixture(page, scenario) {
  const result = await gasRun(page, 'e2ePrepareCheckoutWarningFixtureRpc', [adminToken(), scenario]);
  if (!result || !result.ok) throw new Error(`prepare ${scenario} failed: ${result && result.error}`);
  try {
    await waitForPreparedProduct(page, result.product.title, result.runId);
  } catch (err) {
    await cleanupFixture(page, result.runId).catch(() => {});
    throw err;
  }
  return result;
}

async function cleanupAllCheckoutFixtures(page) {
  const result = await gasRun(page, 'e2eCleanupAllCheckoutWarningFixturesRpc', [adminToken()]);
  if (!result || !result.ok) throw new Error(`cleanup all E2E fixtures failed: ${result && result.error}`);
  return result;
}

async function mutateFixture(page, runId, mutation) {
  const result = await gasRun(page, 'e2eMutateCheckoutWarningFixtureRpc', [adminToken(), runId, mutation]);
  if (!result || !result.ok) throw new Error(`mutate ${mutation} failed: ${result && result.error}`);
  return result;
}

async function cleanupFixture(page, runId) {
  if (!runId) return;
  const result = await gasRun(page, 'e2eCleanupCheckoutWarningFixtureRpc', [adminToken(), runId]);
  if (!result || !result.ok) throw new Error(`cleanup ${runId} failed: ${result && result.error}`);
}

async function waitForPreparedProduct(page, productTitle, runId) {
  const cfg = loadE2eConfig();
  const deadline = Date.now() + cfg.fixtureVisibleTimeoutMs;
  let lastBodyText = '';
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    await page.goto(`${indexUrl()}&e2eRun=${encodeURIComponent(runId)}&e2eTs=${Date.now()}`);
    await page.waitForLoadState('domcontentloaded');
    const frame = await waitForGoogleScriptRun(page);
    await frame.locator('body').waitFor({ state: 'visible' });

    const productCard = frame.locator('.product-card').filter({ hasText: productTitle }).first();
    if (await productCard.isVisible().catch(() => false)) return productCard;

    lastBodyText = await frame.locator('body').innerText().catch(() => '');
    await sleep(cfg.fixturePollMs);
  }

  throw new Error(
    `Prepared product did not appear in storefront after ${cfg.fixtureVisibleTimeoutMs}ms: ${productTitle}. `
    + `Attempts: ${attempts}. Last page text: ${lastBodyText.slice(0, 500)}`
  );
}

async function openProductDetails(page, productTitle) {
  const frame = await waitForGoogleScriptRun(page);
  const productCard = frame.locator('.product-card').filter({ hasText: productTitle }).first();
  await expect(productCard, `product card for "${productTitle}"`).toBeVisible();
  await productCard.locator('[data-details]').click();
  await expect(frame.locator('#productDetailsModal')).toBeVisible();
  return productCard;
}

async function addProductToCart(page, productTitle, qty = 1) {
  await openProductDetails(page, productTitle);
  const frame = await waitForGoogleScriptRun(page);
  const qtyInput = frame.locator('#productQty');
  await expect(qtyInput).toBeVisible();
  await qtyInput.fill(String(qty));
  await frame.locator('#addToCartFromDetail').click();
  await expect(frame.locator('#cartCount')).not.toHaveText(/^0$/, { timeout: 45000 });

  const detailModal = frame.locator('#productDetailsModal');
  if (await detailModal.isVisible().catch(() => false)) {
    const closeButton = frame
      .locator('#productDetailsModal .pdm-close, #productDetailsModal [data-bs-dismiss="modal"]')
      .first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ force: true }).catch(() => {});
    }
    await expect(detailModal).toBeHidden({ timeout: 10000 }).catch(() => {});
  }
}

async function openCart(page) {
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('button[data-bs-target="#cartModal"]').click();
  await expect(frame.locator('#cartModal')).toBeVisible();
}

async function openCheckout(page) {
  const frame = await waitForGoogleScriptRun(page);
  await openCart(page);
  await frame.locator('#btnCheckout').click();
  await expect(frame.locator('#orderConfirmModal')).toBeVisible();
}

const CHECKOUT_DEFAULTS = {
  ocmCustomerName: 'E2E Test Buyer',
  ocmPhone: '0812345678',
  ocmContactUrl: 'e2e-test',
  ocmShippingName: 'E2E Test Receiver',
  ocmAddress: '99/9 E2E Test Road',
  ocmDistrict: 'Test District',
  ocmAmphoe: 'Test Amphoe',
  ocmProvince: 'Bangkok',
  ocmPostalCode: '10110'
};

// Fills every required checkout field with valid defaults, then accepts the terms.
// `overrides` lets a test target a single failure:
//   - { ocmProvince: null }    → leave that field blank (omit it)
//   - { ocmPhone: 'abc' }      → set an invalid value
//   - { terms: false }         → do NOT tick the terms checkbox
// Existing callers using fillCheckoutForm(page) keep the previous all-valid behavior.
async function fillCheckoutForm(page, overrides = {}) {
  const frame = await waitForGoogleScriptRun(page);
  for (const [id, def] of Object.entries(CHECKOUT_DEFAULTS)) {
    const value = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : def;
    if (value === null || value === undefined) continue; // omit → field stays empty
    await frame.locator(`#${id}`).fill(String(value));
  }
  if (overrides.terms !== false) {
    await frame.locator('#ocmTermsAccepted').check();
  }
}

async function selectVariant(page, optionLabel) {
  const frame = await waitForGoogleScriptRun(page);
  const option = frame.locator(
    `#productDetailsModal .variant-option[data-option-label="${optionLabel}"]`
  );
  await expect(option, `variant option "${optionLabel}"`).toBeVisible();
  await option.click();
}

async function getCartCount(page) {
  const frame = await waitForGoogleScriptRun(page);
  const raw = (await frame.locator('#cartCount').innerText().catch(() => '0')).trim();
  return Number(raw || '0');
}

async function incrementFirstCartItem(page) {
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('#cartBody [data-inc]').first().click();
}

async function decrementFirstCartItem(page) {
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('#cartBody [data-dec]').first().click();
}

async function removeFirstCartItem(page) {
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('#cartBody [data-del]').first().click();
}

async function expectCartEmpty(page) {
  const frame = await waitForGoogleScriptRun(page);
  await expect(frame.locator('#cartEmpty')).toBeVisible();
  await expect(frame.locator('#cartCount')).toHaveText(/^0$/);
}

// Just clicks the confirm-order button without waiting for any popup — used when a
// test needs to assert intermediate state (e.g. the button becoming disabled).
async function clickCheckoutSubmit(page) {
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('#ocmBtnSubmit').click();
}

async function expectValidationAlert(page, fieldPattern) {
  const frame = await waitForGoogleScriptRun(page);
  await expect(frame.locator('.swal2-popup')).toBeVisible({ timeout: loadE2eConfig().swalTimeoutMs });
  await expect(frame.locator('.swal2-title')).toContainText(/กรุณาตรวจสอบข้อมูลคำสั่งซื้อ/);
  if (fieldPattern) await expect(frame.locator('.swal2-html-container')).toContainText(fieldPattern);
}

async function expectOrderSuccess(page) {
  const frame = await waitForGoogleScriptRun(page);
  await expect(frame.locator('.swal2-popup')).toBeVisible({ timeout: loadE2eConfig().swalTimeoutMs });
  await expect(frame.locator('.swal2-html-container')).toContainText(/สั่งซื้อสำเร็จ/);
}

async function submitCheckout(page) {
  const frame = await waitForGoogleScriptRun(page);
  await frame.locator('#ocmBtnSubmit').click();
  await expect(frame.locator('.swal2-popup')).toBeVisible({ timeout: loadE2eConfig().swalTimeoutMs });
}

async function expectSwal(page, titlePattern, bodyPattern) {
  const frame = await waitForGoogleScriptRun(page);
  await expect(frame.locator('.swal2-popup')).toBeVisible({ timeout: loadE2eConfig().swalTimeoutMs });
  if (titlePattern) await expect(frame.locator('.swal2-title')).toContainText(titlePattern);
  if (bodyPattern) await expect(frame.locator('.swal2-html-container')).toContainText(bodyPattern);
}

async function closeSwal(page) {
  const frame = await waitForGoogleScriptRun(page).catch(() => null);
  if (!frame) return;
  const popup = frame.locator('.swal2-popup');
  if (await popup.isVisible().catch(() => false)) {
    await frame.evaluate(() => {
      try {
        if (window.Swal && typeof window.Swal.close === 'function') window.Swal.close();
      } catch (_) {}
    }).catch(() => {});
    await popup.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

module.exports = {
  addProductToCart,
  appLocator,
  cleanupAllCheckoutFixtures,
  cleanupFixture,
  clearBrowserState,
  clickCheckoutSubmit,
  closeSwal,
  decrementFirstCartItem,
  expectCartEmpty,
  expectOrderSuccess,
  expectSwal,
  expectValidationAlert,
  fillCheckoutForm,
  getCartCount,
  incrementFirstCartItem,
  mutateFixture,
  openCart,
  openCheckout,
  openProductDetails,
  openStorefront,
  prepareFixture,
  removeFirstCartItem,
  selectVariant,
  submitCheckout
};
