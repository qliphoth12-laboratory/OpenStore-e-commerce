'use strict';
// Dependency-free Node parity tests: assert that System/Frontend/index.html (the
// real storefront, authoritative) and System/Frontend/edit-store.html (the admin
// preview, which hand-mirrors index.html's pricing/promotion/cart logic) compute
// identical results from the same generic fixtures. This is what would have
// caught the missing order-total-discount code path in edit-store.html.
//
// Run: node pricing-parity.test.js   (or `npm test` from this folder)

const assert = require('assert');
const path = require('path');
const { loadFunctionsFromHtml } = require('./lib/extractFns');
const { createDomStub } = require('./lib/domStub');
const fixtures = require('./fixtures');

const INDEX_HTML = path.join(__dirname, '..', '..', 'System', 'Frontend', 'index.html');
const EDIT_STORE_HTML = path.join(__dirname, '..', '..', 'System', 'Frontend', 'edit-store.html');

// The pricing/promotion/cart-total functions under test. Kept to the
// calculation surface (not DOM re-render pipelines like updateCartUI/
// renderProducts, which belong to QA/E2E browser tests instead).
const FN_NAMES = [
  'money',
  'normalizeVariant',
  'calcVariantPrice',
  '_buildVariantKey',
  '_resolveProductPromotion',
  '_resolveCartDisplayPricing',
  '_bestCardPromo',
  '_resolveCardDeadline',
  'formatCountdownRemaining',
  'formatPromotionRemaining',
  '_calcShippingFee',
  '_isProductOutOfStock',
  '_getEffectiveStock',
  '_promoLineKey',
  '_cartOrderDiscountAmount',
  '_updateOcmTotals',
  '_buildClientPricingSnapshot'
];

let passed = 0, failed = 0;
const failures = [];

// Values returned from two different vm.createContext sandboxes have different
// realms, so plain objects built inside each (e.g. `{ promotion: {...}, ... }`)
// carry different Object/Array prototypes even when structurally identical —
// assert.deepStrictEqual's prototype check trips on that alone. Round-tripping
// through JSON compares by value only, which is what parity actually means here.
function assertValueEqual(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL - ' + name);
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : String(err)));
  }
}

// Builds a fresh sandbox for one file with a fresh DOM stub. `_promoLineMapForCurrentCart`
// and `_promoPreviewLastResult` are the conditional/order-total preview
// freshness gate both files implement around these functions; the test injects
// them directly (test-controlled) rather than re-deriving the whole cart/RPC
// preview pipeline, which is out of scope for a calculation-parity unit test.
function loadPage(filePath, opts) {
  opts = opts || {};
  const dom = createDomStub();
  const extraGlobals = {
    document: dom,
    _promoLineMapForCurrentCart: opts.promoLineMapForCurrentCart || function () { return null; },
    _promoPreviewLastResult: opts.promoPreviewLastResult !== undefined ? opts.promoPreviewLastResult : null
  };
  const ctx = loadFunctionsFromHtml(filePath, FN_NAMES, extraGlobals);
  ctx.__dom = dom;
  return ctx;
}

function loadBoth(opts) {
  return {
    index: loadPage(INDEX_HTML, opts),
    editStore: loadPage(EDIT_STORE_HTML, opts)
  };
}

console.log('index.html vs edit-store.html pricing/promotion parity\n');

// 1. Base price, no variants, no promotion.
test('base price: no variants, no promotion', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productNoPromo;
  const iPrice = index.calcVariantPrice(p, {});
  const ePrice = editStore.calcVariantPrice(p, {});
  assert.strictEqual(iPrice, 100);
  assert.strictEqual(ePrice, 100);
  assert.strictEqual(iPrice, ePrice);
});

// 2. Variant price resolution: explicit `price` option and `delta` option.
test('variant price: explicit price option', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productVariants;
  const sel = { Size: 'Small' };
  assert.strictEqual(index.calcVariantPrice(p, sel), 100);
  assert.strictEqual(editStore.calcVariantPrice(p, sel), 100);
});
test('variant price: delta option', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productVariants;
  const sel = { Size: 'Large' };
  assert.strictEqual(index.calcVariantPrice(p, sel), 150);
  assert.strictEqual(editStore.calcVariantPrice(p, sel), 150);
});

// 3. Direct fixed promo at root level (no variants).
test('direct fixed promo: root-level resolution', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productRootFixedPromo;
  const iEntry = index._resolveProductPromotion(p, {});
  const eEntry = editStore._resolveProductPromotion(p, {});
  assertValueEqual(iEntry, eEntry);
  assert.strictEqual(iEntry.unit_final_price, 84);
  assert.strictEqual(iEntry.unit_discount_amount, 15);
});

// 4. Direct percent promo resolved via variant_promotions, including a rounding
//    boundary (150 * 0.67 = 100.5 -> Math.round -> 101).
test('percent promo via variant_promotions: rounding boundary (.5)', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productVariants;
  const selLarge = { Size: 'Large' };
  const iEntry = index._resolveProductPromotion(p, selLarge);
  const eEntry = editStore._resolveProductPromotion(p, selLarge);
  assertValueEqual(iEntry, eEntry);
  assert.strictEqual(iEntry.unit_final_price, 101);
});

// 5. Multiple competing promotions on the same product -> best (cheapest) wins
//    for card display.
test('multiple competing promotions: _bestCardPromo picks cheapest', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productCompetingPromos;
  const iBest = index._bestCardPromo(p);
  const eBest = editStore._bestCardPromo(p);
  assertValueEqual(iBest, eBest);
  assert.strictEqual(iBest.unit_final_price, 140);
});

test('countdown formatter: stable duration text and invalid-date safety', () => {
  const { index, editStore } = loadBoth();
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const sameDay = new Date(now + (5 * 3600000) + (4 * 60000) + 3000).toISOString();
  const nextDay = new Date(now + 86400000 + 2000).toISOString();
  assert.strictEqual(index.formatCountdownRemaining(sameDay, now), '05:04:03');
  assert.strictEqual(editStore.formatCountdownRemaining(sameDay, now), '05:04:03');
  assert.strictEqual(index.formatCountdownRemaining(nextDay, now), '1 วัน 00:00:02');
  assert.strictEqual(editStore.formatCountdownRemaining(nextDay, now), '1 วัน 00:00:02');
  assert.strictEqual(index.formatCountdownRemaining('invalid', now), '');
  assert.strictEqual(editStore.formatCountdownRemaining(new Date(now - 1).toISOString(), now), '');
});

test('card deadline: nearest promotion/sale event wins with explicit label', () => {
  const { index, editStore } = loadBoth();
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const promoEnd = new Date(now + 3600000).toISOString();
  const saleEnd = new Date(now + 7200000).toISOString();
  const product = { sale_status:'active', sale_mode:'scheduled', sale_ends_at:saleEnd };
  const cardPromo = { promotion:{ ends_at:promoEnd, no_end_date:false } };
  const expectedPromo = index._resolveCardDeadline(product, cardPromo, now);
  assertValueEqual(expectedPromo, editStore._resolveCardDeadline(product, cardPromo, now));
  assert.strictEqual(expectedPromo.kind, 'promotion');
  assert.strictEqual(expectedPromo.label, 'โปรสิ้นสุดใน');

  product.sale_ends_at = new Date(now + 1800000).toISOString();
  const expectedSale = index._resolveCardDeadline(product, cardPromo, now);
  assertValueEqual(expectedSale, editStore._resolveCardDeadline(product, cardPromo, now));
  assert.strictEqual(expectedSale.kind, 'sale');
  assert.strictEqual(expectedSale.label, 'ปิดขายใน');
});

test('card deadline: no-end/invalid promotion falls back to sale or nothing', () => {
  const { index, editStore } = loadBoth();
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const product = { sale_status:'active', sale_mode:'scheduled', sale_ends_at:new Date(now + 60000).toISOString() };
  const noEndPromo = { promotion:{ ends_at:'', no_end_date:true } };
  const fallback = index._resolveCardDeadline(product, noEndPromo, now);
  assertValueEqual(fallback, editStore._resolveCardDeadline(product, noEndPromo, now));
  assert.strictEqual(fallback.kind, 'sale');
  assert.strictEqual(index._resolveCardDeadline({ sale_status:'active', sale_mode:'always' }, noEndPromo, now), null);
  assert.strictEqual(editStore._resolveCardDeadline({ sale_status:'active', sale_mode:'always' }, { promotion:{ ends_at:'bad', no_end_date:false } }, now), null);
});

// 6. Order-total discount, end-to-end across all three real call sites — the
//    actual regression this fix addresses.
test('order-total discount: _cartOrderDiscountAmount nets correctly', () => {
  const opts = {
    promoLineMapForCurrentCart: () => ({}),
    promoPreviewLastResult: { ok: true, order_discount: { promotion: fixtures.makePromoSummary({ discount_scope: 'order_total' }), amount: 25 } }
  };
  const { index, editStore } = loadBoth(opts);
  assert.strictEqual(index._cartOrderDiscountAmount(), 25);
  assert.strictEqual(editStore._cartOrderDiscountAmount(), 25);
});

test('order-total discount: _updateOcmTotals shows and nets the discount', () => {
  const opts = {
    promoLineMapForCurrentCart: () => ({}),
    promoPreviewLastResult: { ok: true, order_discount: { promotion: fixtures.makePromoSummary({ discount_scope: 'order_total' }), amount: 25 } }
  };
  const { index, editStore } = loadBoth(opts);

  index._updateOcmTotals(200, 30);
  editStore._updateOcmTotals(200, 30);

  const expectedTotal = '฿' + (200 - 25 + 30).toLocaleString();
  const iDom = index.__dom, eDom = editStore.__dom;
  assert.strictEqual(iDom.getElementById('ocmTotal').textContent, expectedTotal);
  assert.strictEqual(eDom.getElementById('ocmTotal').textContent, expectedTotal);
  assert.strictEqual(iDom.getElementById('ocmOrderDiscountLine').style.display, '');
  assert.strictEqual(eDom.getElementById('ocmOrderDiscountLine').style.display, '');
});

test('order-total discount: _buildClientPricingSnapshot nets subtotal and reports order_discount', () => {
  const opts = {
    promoLineMapForCurrentCart: () => ({}),
    promoPreviewLastResult: { ok: true, order_discount: { promotion: fixtures.makePromoSummary({ discount_scope: 'order_total' }), amount: 25 } }
  };
  const { index, editStore } = loadBoth(opts);

  const items = [{
    product_id: fixtures.productNoPromo.id,
    _p: fixtures.productNoPromo,
    _selectedVariants: {},
    qty: 2,
    unit_price: 100
  }];

  const iSnap = index._buildClientPricingSnapshot(items);
  const eSnap = editStore._buildClientPricingSnapshot(items);

  assertValueEqual(iSnap, eSnap);
  assert.strictEqual(iSnap.subtotal, 200);
  assert.strictEqual(iSnap.order_discount, 25);
  assert.strictEqual(iSnap.total, 200 - 25);
});

// 7. Expired/disabled promotion -> no discount; money() must not throw on
//    null/undefined.
test('expired/disabled promotion: no discount applied', () => {
  const { index, editStore } = loadBoth();
  const p = fixtures.productNoPromo; // promotion: null simulates an expired/disabled snapshot entry
  assert.strictEqual(index._resolveProductPromotion(p, {}), null);
  assert.strictEqual(editStore._resolveProductPromotion(p, {}), null);
});
test('money(): null/undefined safety', () => {
  const { index, editStore } = loadBoth();
  assert.strictEqual(index.money(null), '฿0');
  assert.strictEqual(index.money(undefined), '฿0');
  assert.strictEqual(editStore.money(null), '฿0');       // pre-fix this threw TypeError
  assert.strictEqual(editStore.money(undefined), '฿0');  // pre-fix this threw TypeError
});

// 8. Cart with zero promotions at all -> plain sum, no order-discount line shown.
test('cart without promotions: totals are a plain sum', () => {
  const { index, editStore } = loadBoth({ promoLineMapForCurrentCart: () => null, promoPreviewLastResult: null });
  index._updateOcmTotals(150, 40);
  editStore._updateOcmTotals(150, 40);
  const expectedTotal = '฿' + (190).toLocaleString();
  assert.strictEqual(index.__dom.getElementById('ocmTotal').textContent, expectedTotal);
  assert.strictEqual(editStore.__dom.getElementById('ocmTotal').textContent, expectedTotal);
  assert.strictEqual(index.__dom.getElementById('ocmOrderDiscountLine').style.display, 'none');
  assert.strictEqual(editStore.__dom.getElementById('ocmOrderDiscountLine').style.display, 'none');
});

// 9. Quantity > 1 scaling on a discounted line.
test('quantity scaling on a discounted line', () => {
  const { index, editStore } = loadBoth();
  const items = [{
    product_id: fixtures.productRootFixedPromo.id,
    _p: fixtures.productRootFixedPromo,
    _selectedVariants: {},
    qty: 3,
    unit_price: 84
  }];
  const iSnap = index._buildClientPricingSnapshot(items);
  const eSnap = editStore._buildClientPricingSnapshot(items);
  assertValueEqual(iSnap, eSnap);
  assert.strictEqual(iSnap.subtotal, 84 * 3);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
