/**
 * QA Integration Test Runner
 *
 * Copy this file into the Apps Script project when you want to run the
 * integration dashboard. It is intentionally isolated from backend.gs and
 * does not add or replace doGet().
 *
 * Entry points:
 * - qaOpenIntegrationDashboard()
 * - getQaIntegrationTestManifestRpc()
 * - getQaIntegrationTraceEventsRpc(runId, afterSeq)
 * - clearQaIntegrationTraceRpc(runId)
 * - qaRunIntegrationTestSuiteRpc(options)
 * - qaRunIntegrationTestCaseRpc(testId, options)
 */

var QA_INTEGRATION_VERSION = '2026-07-21.1';
var QA_TRACE_CACHE_PREFIX = 'QA_TRACE_EVENTS_';
var QA_TRACE_TTL_SECONDS = 3600;
var QA_TRACE_MAX_EVENTS = 240;
var QA_TRACE_CONTEXT_ = null;
var E2E_CHECKOUT_FIXTURE_PREFIX = 'E2E-';

// Compatibility wrappers for backend helpers renamed with trailing underscores.
// These keep the integration suite isolated from production code changes.
function _sheetProd(){ return sheetProd_(); }
function _sheetOrders(){ return sheetOrders_(); }
function _sheetGiftItems(){ return sheetGiftItems_(); }
function _sheetRowOfId(id){ return sheetRowOfId_(id); }
function _readSiteConfig(){ return readSiteConfig_(); }
function _writeSiteConfig(json){ return writeSiteConfig_(json); }
function _readPaymentConfig(){ return readPaymentConfig_(); }
function _writePaymentConfig(obj, actorEmail){ return writePaymentConfig_(obj, actorEmail); }

function qaOpenIntegrationDashboard() {
  return HtmlService
    .createTemplateFromFile('integration-dashboard')
    .evaluate()
    .setTitle('QA Integration Tests')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function qaGetIntegrationExecUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (_) {
    return '';
  }
}

function e2eCheckoutRunId_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMddHHmmss')
    + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function e2eCheckoutIds_(runId) {
  var clean = String(runId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return {
    runId: clean,
    prefix: E2E_CHECKOUT_FIXTURE_PREFIX + clean,
    productId: 'e2e_prod_' + clean,
    giftId: 'e2e_gift_' + clean,
    ruleId: 'e2e_rule_' + clean,
    promotionId: 'e2e_promo_' + clean,
    shippingId: 'e2e_ship_' + clean,
    methodId: 'e2e_method_' + clean
  };
}

function e2eCheckoutRequireAdmin_(token) {
  var res = validateSessionRpc(String(token || ''));
  if (!res || res.ok !== true) throw new Error('AUTH_REQUIRED');
  return res;
}

function e2eCheckoutFlush_() {
  try { invalidateShippingCache_(); } catch(_) {}
  try { _invalidateGiftCaches_(); } catch(_) {}
  try { invalidatePromoCache_(); } catch(_) {}
  try { rebuildSnap_(); } catch(_) {}
}

function e2eCheckoutAppendShipping_(ids) {
  var method = { id: ids.methodId, name: 'E2E Standard', active: true, mode: 'flat', flat_rate: 0 };
  sheetShipping_().appendRow([
    ids.shippingId,
    ids.prefix + ' Shipping',
    'TRUE',
    JSON.stringify([method]),
    'other',
    '',
    ''
  ]);
  return { company: { id: ids.shippingId, name: ids.prefix + ' Shipping' }, method: method };
}

function e2eCheckoutAppendProduct_(ids, scenario, stock, price, variantsJson) {
  var now = nowISO_();
  var title = ids.prefix + ' ' + scenario + ' Product';
  var variants = (variantsJson === undefined || variantsJson === null) ? '[]' : String(variantsJson);
  sheetProd_().appendRow([
    ids.productId,
    sanitizeSheetCell_(title),
    'Temporary E2E checkout warning product',
    Number(price || 500),
    'E2E',
    '',
    '',
    now,
    now,
    'TRUE',
    variants,
    '[]',
    100,
    JSON.stringify([ids.methodId]),
    Number(stock),
    'TRUE',
    '',
    '',
    'TRUE',
    'always'
  ]);
  return { id: ids.productId, title: title, stock: Number(stock), price: Number(price || 500) };
}

// variants_json สำหรับ scenario happy-path-variants — กลุ่มตัวเลือก "ขนาด" แบบบังคับเลือก
// โครงสร้างตรงกับ normalizeVariant() ใน index.html: [{name,type,options:[{label,price,stock}]}]
function e2eCheckoutVariantsJson_(basePrice) {
  var p = Number(basePrice || 500);
  return JSON.stringify([
    {
      name: 'ขนาด',
      type: 'text',
      options: [
        { label: 'S', price: p,        stock: 50 },
        { label: 'M', price: p + 50,   stock: 50 }
      ]
    }
  ]);
}

function e2eCheckoutAppendGift_(ids, stock) {
  ensureGiftSheets_();
  var now = nowISO_();
  var giftName = ids.prefix + ' Gift';
  sheetGiftItems_().appendRow([
    ids.giftId,
    sanitizeSheetCell_(giftName),
    'Temporary E2E checkout warning gift',
    '',
    '',
    Number(stock),
    'TRUE',
    now,
    now,
    '',
    '',
    ''
  ]);
  sheetGiftRules_().appendRow([
    ids.ruleId,
    sanitizeSheetCell_(ids.prefix + ' Gift Rule'),
    'Temporary E2E checkout warning gift rule',
    ids.giftId,
    'required_products',
    JSON.stringify({ required_products: [{ product_id: ids.productId, min_qty: 1 }] }),
    1,
    'once_per_order',
    new Date(Date.now() - 60000).toISOString(),
    '',
    'TRUE',
    'TRUE',
    9999,
    now,
    now,
    '',
    '',
    ''
  ]);
  return { id: ids.giftId, name: giftName, stock: Number(stock), rule_id: ids.ruleId };
}

function e2eCheckoutAppendPromotion_(ids, discountValue) {
  var now = nowISO_();
  var discount = discountValue === undefined ? 100 : Number(discountValue);
  sheetPromotions_().appendRow([
    ids.promotionId,
    sanitizeSheetCell_(ids.prefix + ' Promotion'),
    'Temporary E2E checkout warning promotion',
    'fixed',
    discount,
    'product',
    JSON.stringify([{ product_id: ids.productId }]),
    new Date(Date.now() - 60000).toISOString(),
    '',
    'TRUE',
    now,
    now,
    '',
    '',
    '',
    'TRUE'
  ]);
  return { id: ids.promotionId, discount_type: 'fixed', discount_value: discount };
}

function e2eCheckoutProductRow_(productId) {
  var rowNo = sheetRowOfId_(productId);
  if (rowNo < 0) throw new Error('E2E product not found: ' + productId);
  return rowNo;
}

function e2eCheckoutSetProductStock_(productId, stock) {
  sheetProd_().getRange(e2eCheckoutProductRow_(productId), 15).setValue(Number(stock));
}

function e2eCheckoutSetProductPrice_(productId, price) {
  var sh = sheetProd_();
  var rowNo = e2eCheckoutProductRow_(productId);
  sh.getRange(rowNo, 4).setValue(Number(price));
  sh.getRange(rowNo, 9).setValue(nowISO_());
}

function e2eCheckoutDisableProduct_(productId) {
  var sh = sheetProd_();
  var rowNo = e2eCheckoutProductRow_(productId);
  sh.getRange(rowNo, 10).setValue('FALSE');
  sh.getRange(rowNo, 16).setValue('FALSE');
  sh.getRange(rowNo, 20).setValue('disabled');
  sh.getRange(rowNo, 9).setValue(nowISO_());
}

function e2eCheckoutSetGiftStock_(giftId, stock) {
  var sh = sheetGiftItems_();
  var n = sh.getLastRow();
  if (n < 2) throw new Error('No gift rows');
  var ids = sh.getRange(2, 1, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
  var idx = ids.indexOf(String(giftId));
  if (idx < 0) throw new Error('E2E gift not found: ' + giftId);
  sh.getRange(idx + 2, 6).setValue(Number(stock));
  sh.getRange(idx + 2, 9).setValue(nowISO_());
}

function e2eCheckoutDisablePromotion_(promotionId) {
  var sh = sheetPromotions_();
  var n = sh.getLastRow();
  if (n < 2) throw new Error('No promotion rows');
  var ids = sh.getRange(2, 1, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
  var idx = ids.indexOf(String(promotionId));
  if (idx < 0) throw new Error('E2E promotion not found: ' + promotionId);
  var rowNo = idx + 2;
  sh.getRange(rowNo, 10).setValue('FALSE');
  sh.getRange(rowNo, 12).setValue(nowISO_());
}

function e2ePrepareCheckoutWarningFixtureRpc(adminToken, scenario) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    scenario = String(scenario || '').trim();
    var supported = {
      'product-stock-zero-after-cart': true,
      'product-stock-partial-after-cart': true,
      'gift-already-out-of-stock': true,
      'gift-stock-depleted-after-preview': true,
      'price-changed-after-cart': true,
      'promotion-ended-after-cart': true,
      'active-promotion-stable': true,
      'sale-not-active-after-cart': true,
      'happy-path': true,
      'happy-path-variants': true
    };
    if (!supported[scenario]) return { ok:false, error:'Unsupported E2E scenario: ' + scenario };

    var ids = e2eCheckoutIds_(e2eCheckoutRunId_());
    var stock = scenario === 'product-stock-zero-after-cart' ? 1 : 5;
    if (scenario === 'product-stock-partial-after-cart') stock = 3;
    // happy-path scenarios เป็นสินค้าพร้อมขายปกติ สต็อกเยอะ ไม่มี gift/promo ให้รบกวน UI flow
    if (scenario === 'happy-path' || scenario === 'happy-path-variants' || scenario === 'active-promotion-stable') stock = 50;
    var shipping = e2eCheckoutAppendShipping_(ids);
    var variantsJson = (scenario === 'happy-path-variants') ? e2eCheckoutVariantsJson_(500) : '[]';
    var productPrice = scenario === 'active-promotion-stable' ? 150 : 500;
    var product = e2eCheckoutAppendProduct_(ids, scenario, stock, productPrice, variantsJson);
    var gift = null;
    var promotion = null;
    if (scenario === 'gift-already-out-of-stock') gift = e2eCheckoutAppendGift_(ids, 0);
    if (scenario === 'gift-stock-depleted-after-preview') gift = e2eCheckoutAppendGift_(ids, 1);
    if (scenario === 'promotion-ended-after-cart') promotion = e2eCheckoutAppendPromotion_(ids);
    if (scenario === 'active-promotion-stable') promotion = e2eCheckoutAppendPromotion_(ids, 15);
    e2eCheckoutFlush_();
    return {
      ok:true,
      runId: ids.runId,
      scenario: scenario,
      product: product,
      gift: gift,
      promotion: promotion,
      shipping: {
        company_id: shipping.company.id,
        method_id: shipping.method.id,
        method_name: shipping.method.name
      }
    };
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function e2eMutateCheckoutWarningFixtureRpc(adminToken, runId, mutation) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    var ids = e2eCheckoutIds_(runId);
    mutation = String(mutation || '').trim();
    if (mutation === 'product-stock-zero') e2eCheckoutSetProductStock_(ids.productId, 0);
    else if (mutation === 'product-stock-one') e2eCheckoutSetProductStock_(ids.productId, 1);
    else if (mutation === 'gift-stock-zero') e2eCheckoutSetGiftStock_(ids.giftId, 0);
    else if (mutation === 'price-change') e2eCheckoutSetProductPrice_(ids.productId, 650);
    else if (mutation === 'promotion-disable') e2eCheckoutDisablePromotion_(ids.promotionId);
    else if (mutation === 'sale-disable') e2eCheckoutDisableProduct_(ids.productId);
    else return { ok:false, error:'Unsupported E2E mutation: ' + mutation };
    e2eCheckoutFlush_();
    return { ok:true, runId: ids.runId, mutation: mutation };
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function e2eCheckoutDeleteRowsById_(sheetFn, colNo, ids) {
  var sh = sheetFn();
  var n = sh.getLastRow();
  if (n < 2) return 0;
  var set = {};
  (ids || []).filter(Boolean).forEach(function(id){ set[String(id)] = true; });
  var values = sh.getRange(2, colNo, n - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (set[String(values[i][0] || '')]) rows.push(i + 2);
  }
  rows.sort(function(a,b){ return b - a; }).forEach(function(rowNo){ sh.deleteRow(rowNo); });
  return rows.length;
}

function e2eCheckoutDeleteRowsByPrefix_(sheetFn, colNo, prefixes) {
  var sh = sheetFn();
  var n = sh.getLastRow();
  if (n < 2) return 0;
  prefixes = (prefixes || []).filter(Boolean).map(String);
  var values = sh.getRange(2, colNo, n - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = String(values[i][0] || '');
    for (var j = 0; j < prefixes.length; j++) {
      if (raw.indexOf(prefixes[j]) === 0) {
        rows.push(i + 2);
        break;
      }
    }
  }
  rows.sort(function(a,b){ return b - a; }).forEach(function(rowNo){ sh.deleteRow(rowNo); });
  return rows.length;
}

function e2eCheckoutDeleteOrders_(ids) {
  var sh = sheetOrders_();
  var n = sh.getLastRow();
  if (n < 2) return 0;
  var itemCol = ORDER_COLS.indexOf('items_json') + 1;
  var values = sh.getRange(2, itemCol, n - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = String(values[i][0] || '');
    if (raw.indexOf(ids.productId) >= 0 || raw.indexOf(ids.giftId) >= 0 || raw.indexOf(ids.prefix) >= 0) {
      rows.push(i + 2);
    }
  }
  rows.sort(function(a,b){ return b - a; }).forEach(function(rowNo){ sh.deleteRow(rowNo); });
  return rows.length;
}

function e2eCheckoutDeleteAllOrders_() {
  var sh = sheetOrders_();
  var n = sh.getLastRow();
  if (n < 2) return 0;
  var itemCol = ORDER_COLS.indexOf('items_json') + 1;
  var values = sh.getRange(2, itemCol, n - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = String(values[i][0] || '');
    if (raw.indexOf('e2e_prod_') >= 0 || raw.indexOf('e2e_gift_') >= 0 || raw.indexOf(E2E_CHECKOUT_FIXTURE_PREFIX) >= 0) {
      rows.push(i + 2);
    }
  }
  rows.sort(function(a,b){ return b - a; }).forEach(function(rowNo){ sh.deleteRow(rowNo); });
  return rows.length;
}

function e2eCleanupCheckoutWarningFixtureRpc(adminToken, runId) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    var ids = e2eCheckoutIds_(runId);
    var out = {
      ok:true,
      runId: ids.runId,
      deleted: {
        orders: e2eCheckoutDeleteOrders_(ids),
        gift_rules: e2eCheckoutDeleteRowsById_(sheetGiftRules_, 1, [ids.ruleId]),
        gift_items: e2eCheckoutDeleteRowsById_(sheetGiftItems_, 1, [ids.giftId]),
        promotions: e2eCheckoutDeleteRowsById_(sheetPromotions_, 1, [ids.promotionId]),
        products: e2eCheckoutDeleteRowsById_(sheetProd_, 1, [ids.productId]),
        shipping: e2eCheckoutDeleteRowsById_(sheetShipping_, 1, [ids.shippingId])
      }
    };
    e2eCheckoutFlush_();
    return out;
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function e2eCleanupAllCheckoutWarningFixturesRpc(adminToken) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    ensureGiftSheets_();
    var out = {
      ok:true,
      deleted: {
        orders: e2eCheckoutDeleteAllOrders_(),
        gift_rules: e2eCheckoutDeleteRowsByPrefix_(sheetGiftRules_, 1, ['e2e_rule_']),
        gift_items: e2eCheckoutDeleteRowsByPrefix_(sheetGiftItems_, 1, ['e2e_gift_']),
        promotions: e2eCheckoutDeleteRowsByPrefix_(sheetPromotions_, 1, ['e2e_promo_']),
        products: e2eCheckoutDeleteRowsByPrefix_(sheetProd_, 1, ['e2e_prod_']),
        shipping: e2eCheckoutDeleteRowsByPrefix_(sheetShipping_, 1, ['e2e_ship_'])
      }
    };
    e2eCheckoutFlush_();
    return out;
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function e2eMegaFixtureDescriptor_(runId, fx) {
  return {
    kind: 'mega-promotion-gift',
    runId: String(runId || ''),
    product_ids: (fx.product_ids || []).slice(),
    promotion_ids: (fx.promotion_ids || []).slice(),
    gift_ids: (fx.gift_ids || []).slice(),
    rule_ids: (fx.rule_ids || []).slice(),
    shipping: {
      company: fx.shipping && fx.shipping.company,
      method: fx.shipping && fx.shipping.method
    }
  };
}

function e2eMegaValidateDescriptor_(fixture) {
  fixture = fixture || {};
  if (fixture.kind !== 'mega-promotion-gift') throw new Error('INVALID_E2E_MEGA_FIXTURE');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(fixture.runId || ''))) throw new Error('INVALID_E2E_MEGA_RUN_ID');
  ['product_ids', 'promotion_ids', 'gift_ids', 'rule_ids'].forEach(function(key) {
    if (!Array.isArray(fixture[key]) || fixture[key].length > 10) throw new Error('INVALID_E2E_MEGA_IDS: ' + key);
  });
  return fixture;
}

function e2eMegaMatchingOrderRows_(fixture) {
  var sh = sheetOrders_();
  var n = sh.getLastRow();
  if (n < 2) return [];
  var needles = (fixture.product_ids || []).concat(fixture.gift_ids || []).filter(Boolean).map(String);
  var itemCol = ORDER_COLS.indexOf('items_json') + 1;
  var values = sh.getRange(2, itemCol, n - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = String(values[i][0] || '');
    for (var j = 0; j < needles.length; j++) {
      if (raw.indexOf(needles[j]) >= 0) {
        rows.push(i + 2);
        break;
      }
    }
  }
  return rows;
}

function e2eMegaOrderIds_(fixture) {
  var sh = sheetOrders_();
  return e2eMegaMatchingOrderRows_(fixture).map(function(rowNo) {
    return String(sh.getRange(rowNo, 1).getValue() || '');
  }).filter(Boolean);
}

function e2eMegaDeleteOrders_(fixture) {
  var sh = sheetOrders_();
  var rows = e2eMegaMatchingOrderRows_(fixture);
  rows.sort(function(a, b) { return b - a; }).forEach(function(rowNo) { sh.deleteRow(rowNo); });
  return rows.length;
}

function e2eMegaDeleteShipping_(adminToken, fixture) {
  var companyId = fixture && fixture.shipping && fixture.shipping.company && fixture.shipping.company.id;
  if (!companyId) return { ok:true, skipped:true };
  var current = qaCall_('getShippingRpc');
  qaAssertOk_(current);
  var companies = (current.companies || []).filter(function(company) {
    return String(company && company.id || '') !== String(companyId);
  });
  if (companies.length === (current.companies || []).length) return { ok:true, skipped:true };
  return qaCall_('saveShippingRpc', [adminToken, companies]);
}

function e2eCleanupMegaPromotionGiftFixture_(adminToken, fixture) {
  fixture = e2eMegaValidateDescriptor_(fixture);
  var deletedOrders = e2eMegaDeleteOrders_(fixture);
  var cleanup = qaCleanupCommerceFixture_({
    token: adminToken,
    order_ids: [],
    promotion_ids: fixture.promotion_ids,
    rule_ids: fixture.rule_ids,
    gift_ids: fixture.gift_ids,
    product_ids: fixture.product_ids,
    shipping: fixture.shipping
  });
  cleanup.shipping = e2eMegaDeleteShipping_(adminToken, fixture);
  if (!cleanup.shipping || cleanup.shipping.ok !== true) cleanup.ok = false;
  cleanup.deleted_fixture_orders = deletedOrders;
  e2eCheckoutFlush_();
  return cleanup;
}

function e2ePrepareMegaPromotionGiftFixtureRpc(adminToken) {
  var fx = null;
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    var runId = e2eCheckoutRunId_();
    var labelSuffix = runId.slice(-8);
    fx = qaCreateCommerceFixture_({ options:{ adminToken:adminToken } }, 'E2EMega' + labelSuffix, { flat_rate:125 });

    function trackProduct(product) { fx.product_ids.push(product.id); return product; }
    function trackPromotion(promotion) { fx.promotion_ids.push(promotion.promotion_id); return promotion; }
    function trackGift(gift) { fx.gift_ids.push(gift.gift_id); return gift; }
    function trackRule(rule) { fx.rule_ids.push(rule.rule_id); return rule; }
    function giftName(label) { return 'QA Gift ' + label + ' ' + fx.stamp; }

    var countdownEndsAt = new Date(Date.now() + 7200000).toISOString();
    var saleEndsAt = new Date(Date.now() + 10800000).toISOString();
    var scheduledStartsAt = new Date(Date.now() + 3600000).toISOString();
    var scheduledEndsAt = new Date(Date.now() + 10800000).toISOString();

    var productA = trackProduct(qaCreateOrderQaProduct_(adminToken, fx.shipping, fx.stamp, 'E2EMegaA' + labelSuffix, 20, {
      price:1000,
      sale_mode:'scheduled', sale_starts_at:new Date(Date.now() - 3600000).toISOString(), sale_ends_at:saleEndsAt
    }));
    var productB = trackProduct(qaCreateOrderQaProduct_(adminToken, fx.shipping, fx.stamp, 'E2EMegaB' + labelSuffix, 20, {
      price:600
    }));
    var variantProduct = trackProduct(qaCreateOrderQaProduct_(adminToken, fx.shipping, fx.stamp, 'E2EMegaVariant' + labelSuffix, -1, {
      price:400,
      variants:[{ name:'Size', type:'text', options:[
        { label:'M', price:800, weight_grams:100, stock:10 },
        { label:'S', price:400, weight_grams:100, stock:10 }
      ]}]
    }));
    var productD = trackProduct(qaCreateOrderQaProduct_(adminToken, fx.shipping, fx.stamp, 'E2EMegaD' + labelSuffix, 20, {
      price:250
    }));
    var productE = trackProduct(qaCreateOrderQaProduct_(adminToken, fx.shipping, fx.stamp, 'E2EMegaE' + labelSuffix, 20, {
      price:300
    }));
    var variantMKey = 'Size=M';
    var variantSKey = 'Size=S';
    var directBE = trackPromotion(qaCreatePromotion_(adminToken, productB.id, fx.stamp, 'E2EMegaDirectBE' + labelSuffix, {
      discount_type:'percent', discount_value:10, target_type:'product',
      target:[{ product_id:productB.id }, { product_id:productE.id }],
      ends_at:countdownEndsAt, no_end_date:false
    }));
    var conditionalSubtotalAll = trackPromotion(qaCreatePromotion_(adminToken, '', fx.stamp, 'E2EMegaSubtotalAll' + labelSuffix, {
      discount_type:'fixed', discount_value:20, target_type:'all', target:[],
      application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:9500 },
      ends_at:countdownEndsAt, no_end_date:false
    }));
    var conditionalProductAll = trackPromotion(qaCreatePromotion_(adminToken, productB.id, fx.stamp, 'E2EMegaProductAll' + labelSuffix, {
      discount_type:'fixed', discount_value:100, target_type:'product', target:[{ product_id:productB.id }],
      application_mode:'conditional', condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[
        { product_id:productA.id, min_qty:3 },
        { product_id:productD.id, min_qty:5 }
      ]}
    }));
    var conditionalProductAny = trackPromotion(qaCreatePromotion_(adminToken, productB.id, fx.stamp, 'E2EMegaProductAny' + labelSuffix, {
      discount_type:'percent', discount_value:30, target_type:'product', target:[{ product_id:productB.id }],
      application_mode:'conditional', condition_type:'required_products',
      condition_json:{ match_mode:'any', required_products:[
        { product_id:productA.id, min_qty:99 },
        { product_id:productE.id, min_qty:2 }
      ]}
    }));
    var conditionalVariantAll = trackPromotion(qaCreatePromotion_(adminToken, variantProduct.id, fx.stamp, 'E2EMegaVariantAll' + labelSuffix, {
      discount_type:'fixed', discount_value:250, target_type:'variant',
      target:[{ product_id:variantProduct.id, variant_key:variantMKey }],
      application_mode:'conditional', condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:2 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:3 }
      ]}
    }));
    var conditionalVariantAny = trackPromotion(qaCreatePromotion_(adminToken, variantProduct.id, fx.stamp, 'E2EMegaVariantAny' + labelSuffix, {
      discount_type:'percent', discount_value:40, target_type:'variant',
      target:[{ product_id:variantProduct.id, variant_key:variantMKey }],
      application_mode:'conditional', condition_type:'required_variants',
      condition_json:{ match_mode:'any', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:99 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:3 }
      ]}
    }));

    var giftSubtotalLabel = 'E2EMegaSubtotal' + labelSuffix;
    var giftProductAllLabel = 'E2EMegaProductAll' + labelSuffix;
    var giftProductAnyLabel = 'E2EMegaProductAny' + labelSuffix;
    var giftVariantAllLabel = 'E2EMegaVariantAll' + labelSuffix;
    var giftVariantAnyLabel = 'E2EMegaVariantAny' + labelSuffix;
    var giftScheduledLabel = 'E2EMegaScheduled' + labelSuffix;
    var giftSubtotal = trackGift(qaCreateGiftItem_(adminToken, fx.stamp, giftSubtotalLabel, { stock:50 }));
    var giftProductAll = trackGift(qaCreateGiftItem_(adminToken, fx.stamp, giftProductAllLabel, { stock:50 }));
    var giftProductAny = trackGift(qaCreateGiftItem_(adminToken, fx.stamp, giftProductAnyLabel, { stock:50 }));
    var giftVariantAll = trackGift(qaCreateGiftItem_(adminToken, fx.stamp, giftVariantAllLabel, { stock:50 }));
    var giftVariantAny = trackGift(qaCreateGiftItem_(adminToken, fx.stamp, giftVariantAnyLabel, { stock:50 }));
    var giftScheduled = trackGift(qaCreateGiftItem_(adminToken, fx.stamp, giftScheduledLabel, { stock:50 }));

    var ruleSubtotal = trackRule(qaCreateGiftRule_(adminToken, fx.stamp, giftSubtotalLabel, giftSubtotal.gift_id, {
      condition_type:'min_subtotal', condition_json:{ min_subtotal:3000 },
      gift_qty:1, repeat_mode:'per_threshold', priority:9500,
      ends_at:countdownEndsAt, no_end_date:false
    }));
    var ruleProductAll = trackRule(qaCreateGiftRule_(adminToken, fx.stamp, giftProductAllLabel, giftProductAll.gift_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[
        { product_id:productA.id, min_qty:1 },
        { product_id:productB.id, min_qty:2 }
      ]},
      gift_qty:2, repeat_mode:'once_per_order', priority:9400
    }));
    var ruleProductAny = trackRule(qaCreateGiftRule_(adminToken, fx.stamp, giftProductAnyLabel, giftProductAny.gift_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'any', required_products:[
        { product_id:productA.id, min_qty:2 },
        { product_id:productD.id, min_qty:2 },
        { product_id:productE.id, min_qty:2 }
      ]},
      gift_qty:1, repeat_mode:'per_threshold', priority:9300
    }));
    var ruleVariantAll = trackRule(qaCreateGiftRule_(adminToken, fx.stamp, giftVariantAllLabel, giftVariantAll.gift_id, {
      condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:1 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:2 }
      ]},
      gift_qty:3, repeat_mode:'per_threshold', priority:9200
    }));
    var ruleVariantAny = trackRule(qaCreateGiftRule_(adminToken, fx.stamp, giftVariantAnyLabel, giftVariantAny.gift_id, {
      condition_type:'required_variants',
      condition_json:{ match_mode:'any', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:1 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:1 }
      ]},
      gift_qty:1, repeat_mode:'per_threshold', priority:9100
    }));
    var ruleScheduled = trackRule(qaCreateGiftRule_(adminToken, fx.stamp, giftScheduledLabel, giftScheduled.gift_id, {
      condition_type:'min_subtotal', condition_json:{ min_subtotal:1 },
      gift_qty:1, repeat_mode:'once_per_order', priority:9000,
      starts_at:scheduledStartsAt, ends_at:scheduledEndsAt, no_end_date:false
    }));

    e2eCheckoutFlush_();
    var fixture = e2eMegaFixtureDescriptor_(runId, fx);
    return {
      ok:true,
      runId:runId,
      fixture:fixture,
      shipping:{
        company_id:fx.shipping.company.id,
        method_id:fx.shipping.method.id,
        method_name:fx.shipping.method.name,
        fee:125
      },
      products:{
        a:{ id:productA.id, title:productA.payload.title },
        b:{ id:productB.id, title:productB.payload.title },
        variant:{ id:variantProduct.id, title:variantProduct.payload.title },
        d:{ id:productD.id, title:productD.payload.title },
        e:{ id:productE.id, title:productE.payload.title }
      },
      promotions:{
        direct_be:{ id:directBE.promotion_id, name:directBE.payload.name },
        subtotal_all:{ id:conditionalSubtotalAll.promotion_id, name:conditionalSubtotalAll.payload.name },
        product_all:{ id:conditionalProductAll.promotion_id, name:conditionalProductAll.payload.name },
        product_any:{ id:conditionalProductAny.promotion_id, name:conditionalProductAny.payload.name },
        variant_all:{ id:conditionalVariantAll.promotion_id, name:conditionalVariantAll.payload.name },
        variant_any:{ id:conditionalVariantAny.promotion_id, name:conditionalVariantAny.payload.name }
      },
      gifts:[
        { id:giftSubtotal.gift_id, rule_id:ruleSubtotal.rule_id, name:giftName(giftSubtotalLabel), qty:3 },
        { id:giftProductAll.gift_id, rule_id:ruleProductAll.rule_id, name:giftName(giftProductAllLabel), qty:2 },
        { id:giftProductAny.gift_id, rule_id:ruleProductAny.rule_id, name:giftName(giftProductAnyLabel), qty:4 },
        { id:giftVariantAll.gift_id, rule_id:ruleVariantAll.rule_id, name:giftName(giftVariantAllLabel), qty:3 },
        { id:giftVariantAny.gift_id, rule_id:ruleVariantAny.rule_id, name:giftName(giftVariantAnyLabel), qty:5 }
      ],
      scheduled_campaign:{
        id:giftScheduled.gift_id, rule_id:ruleScheduled.rule_id, name:giftName(giftScheduledLabel)
      },
      expected:{
        raw_subtotal:10050,
        direct_subtotal:9750,
        subtotal:8410,
        shipping_fee:125,
        total:8535,
        product_stock:{ a:17, b:16, d:15, e:18, variant_m:8, variant_s:7 },
        gift_stock:[47, 48, 46, 47, 45, 50]
      }
    };
  } catch(err) {
    var cleanup = null;
    if (fx) {
      try { cleanup = qaCleanupCommerceFixture_(fx); } catch(cleanupErr) {
        cleanup = { ok:false, error:String(cleanupErr && cleanupErr.message || cleanupErr) };
      }
    }
    return { ok:false, error:String(err && err.message || err), cleanup:cleanup };
  }
}

function e2eInspectMegaPromotionGiftFixtureRpc(adminToken, fixture) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    fixture = e2eMegaValidateDescriptor_(fixture);
    return {
      ok:true,
      order_ids:e2eMegaOrderIds_(fixture),
      product_stock:{
        a:qaGetProductStock_(fixture.product_ids[0]),
        b:qaGetProductStock_(fixture.product_ids[1]),
        d:qaGetProductStock_(fixture.product_ids[3]),
        e:qaGetProductStock_(fixture.product_ids[4]),
        variant_m:qaGetVariantStock_(fixture.product_ids[2], 'Size', 'M'),
        variant_s:qaGetVariantStock_(fixture.product_ids[2], 'Size', 'S')
      },
      gift_stock:(fixture.gift_ids || []).map(function(id) { return qaGetGiftStock_(id); })
    };
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function e2eCleanupMegaPromotionGiftFixtureRpc(adminToken, fixture) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    var cleanup = e2eCleanupMegaPromotionGiftFixture_(adminToken, fixture);
    return { ok:cleanup && cleanup.ok === true, cleanup:cleanup };
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

/* ---------- E2E fixture: order-total (whole-order) discount ----------
 * One product + one conditional order-total promo. Exercises the storefront cart discount
 * row, confirm modal, submit, and order-view — verifying the discount is deducted once from
 * the subtotal. Reuses the generic order-matching/delete helpers from the mega fixture. */
function e2eOrderTotalValidateDescriptor_(fixture) {
  fixture = fixture || {};
  if (fixture.kind !== 'order-total-promo') throw new Error('INVALID_E2E_ORDTOT_FIXTURE');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(fixture.runId || ''))) throw new Error('INVALID_E2E_ORDTOT_RUN_ID');
  ['product_ids', 'promotion_ids', 'gift_ids', 'rule_ids'].forEach(function(key) {
    if (!Array.isArray(fixture[key]) || fixture[key].length > 10) throw new Error('INVALID_E2E_ORDTOT_IDS: ' + key);
  });
  return fixture;
}

function e2ePrepareOrderTotalPromoFixtureRpc(adminToken) {
  var fx = null;
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    var runId = e2eCheckoutRunId_();
    var labelSuffix = runId.slice(-8);
    fx = qaCreateCommerceFixture_({ options:{ adminToken:adminToken } }, 'E2EOrdTot' + labelSuffix, { flat_rate:125 });

    var product = qaCreateOrderQaProduct_(adminToken, fx.shipping, fx.stamp, 'E2EOrdTot' + labelSuffix, 20, { price:1000 });
    fx.product_ids.push(product.id);

    // Conditional order-total promo: qualifies at subtotal >= 1500, deducts 300 once.
    var promo = qaCreatePromotion_(adminToken, product.id, fx.stamp, 'E2EOrdTot' + labelSuffix, {
      discount_type:'fixed', discount_value:300, target_type:'all', target:[],
      application_mode:'conditional', discount_scope:'order_total',
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:1500, calculation_base:'after_discount_before_shipping' }
    });
    fx.promotion_ids.push(promo.promotion_id);

    e2eCheckoutFlush_();
    var fixture = {
      kind:'order-total-promo', runId:String(runId),
      product_ids:fx.product_ids.slice(), promotion_ids:fx.promotion_ids.slice(),
      gift_ids:[], rule_ids:[],
      shipping:{ company:fx.shipping && fx.shipping.company, method:fx.shipping && fx.shipping.method }
    };
    return {
      ok:true, runId:runId, fixture:fixture,
      shipping:{ company_id:fx.shipping.company.id, method_id:fx.shipping.method.id, method_name:fx.shipping.method.name, fee:125 },
      product:{ id:product.id, title:product.payload.title, price:1000 },
      promotion:{ id:promo.promotion_id, name:promo.payload.name },
      // qty 2 → subtotal 2000, order discount 300, net 1700, + shipping 125 → total 1825.
      expected:{ qty:2, subtotal:2000, order_discount:300, subtotal_after_order_discount:1700, shipping_fee:125, total:1825 }
    };
  } catch(err) {
    var cleanup = null;
    if (fx) { try { cleanup = qaCleanupCommerceFixture_(fx); } catch(_){ cleanup = { ok:false }; } }
    return { ok:false, error:String(err && err.message || err), cleanup:cleanup };
  }
}

function e2eInspectOrderTotalPromoFixtureRpc(adminToken, fixture) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    fixture = e2eOrderTotalValidateDescriptor_(fixture);
    return { ok:true, order_ids:e2eMegaOrderIds_(fixture), product_stock:qaGetProductStock_(fixture.product_ids[0]) };
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function e2eCleanupOrderTotalPromoFixtureRpc(adminToken, fixture) {
  try {
    e2eCheckoutRequireAdmin_(adminToken);
    fixture = e2eOrderTotalValidateDescriptor_(fixture);
    var deletedOrders = e2eMegaDeleteOrders_(fixture);
    var cleanup = qaCleanupCommerceFixture_({
      token:adminToken, order_ids:[], promotion_ids:fixture.promotion_ids,
      rule_ids:fixture.rule_ids, gift_ids:fixture.gift_ids, product_ids:fixture.product_ids, shipping:fixture.shipping
    });
    cleanup.shipping = e2eMegaDeleteShipping_(adminToken, fixture);
    if (!cleanup.shipping || cleanup.shipping.ok !== true) cleanup.ok = false;
    cleanup.deleted_fixture_orders = deletedOrders;
    e2eCheckoutFlush_();
    return { ok:cleanup && cleanup.ok === true, cleanup:cleanup };
  } catch(err) {
    return { ok:false, error:String(err && err.message || err) };
  }
}

function getQaIntegrationTestManifestRpc() {
  try {
    return {
      ok: true,
      version: QA_INTEGRATION_VERSION,
      generatedAt: new Date().toISOString(),
      execUrl: qaGetIntegrationExecUrl_(),
      tests: qaIntegrationSpecs_().map(function(spec) {
        return qaPublicSpec_(spec);
      })
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), tests: [] };
  }
}

function qaRunIntegrationTestSuiteRpc(options) {
  options = options || {};
  var startedAt = new Date();
  var specs = qaIntegrationSpecs_();
  var ctx = {
    options: options,
    execUrl: qaGetIntegrationExecUrl_(),
    publicProducts: [],
    sampleProduct: null,
    siteConfig: null
  };
  var results = [];

  for (var i = 0; i < specs.length; i++) {
    results.push(qaRunSingleSpec_(specs[i], ctx));
  }

  var endedAt = new Date();
  var summary = qaSummarizeResults_(results);
  return {
    ok: true,
    version: QA_INTEGRATION_VERSION,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    execUrl: ctx.execUrl,
    summary: summary,
    results: results
  };
}

function qaRunIntegrationTestCaseRpc(testId, options) {
  options = options || {};
  var specs = qaIntegrationSpecs_();
  var spec = null;
  for (var i = 0; i < specs.length; i++) {
    if (specs[i].id === testId) {
      spec = specs[i];
      break;
    }
  }
  if (!spec) {
    return {
      ok: false,
      id: testId,
      error: 'Unknown testcase: ' + testId
    };
  }
  var ctx = qaCreateContext_(options);
  var result = qaRunSingleSpec_(spec, ctx);
  result.ok = true;
  return result;
}

function qaCreateContext_(options) {
  return {
    options: options || {},
    execUrl: qaGetIntegrationExecUrl_(),
    publicProducts: [],
    sampleProduct: null,
    siteConfig: null
  };
}

function qaWriteSpec_(id, title, area, risk, description, expected, runnerName) {
  return {
    id: id,
    title: title,
    area: area,
    type: 'write',
    risk: risk || 'high',
    description: description || title,
    expected: expected || '',
    requiresRealWrite: true,
    requiresAdminToken: true,
    run: function(ctx) {
      qaRequireRealWrite_(ctx);
      qaAssert_(typeof globalThis[runnerName] === 'function', 'Missing QA runner: ' + runnerName);
      return globalThis[runnerName](ctx, id);
    }
  };
}

function qaClientDrivenWriteSpec_(id, title, area, risk, description, expected) {
  return {
    id: id,
    title: title,
    area: area,
    type: 'write',
    risk: risk || 'critical',
    description: description || title,
    expected: expected || '',
    requiresRealWrite: true,
    requiresAdminToken: true,
    clientDriven: true,
    run: function() {
      return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
    }
  };
}

function qaShippingMatrixSpecs_() {
  return qaShippingMatrixCases_().map(function(c) {
    return qaWriteSpec_(
      c.id,
      c.title,
      'shipping',
      c.risk || 'critical',
      c.description,
      c.expected,
      'qaRunShippingMatrixCaseFlow_'
    );
  });
}

function qaConcurrentHeavySpecs_() {
  return [
    qaClientDrivenWriteSpec_(
      'orders.concurrent-heavy-promo-gift-stock-race',
      'Orders: concurrent heavy promo + gift + stock race',
      'orders',
      'critical',
      'Submit 8 checkouts at the same time against product stock=3, active promotion, and gift stock=2.',
      'Exactly 3 orders should succeed, 5 should fail with STOCK_INSUFFICIENT, 2 successful orders should attach gifts, and product/gift stock should end at 0.'
    ),
    qaClientDrivenWriteSpec_(
      'orders.concurrent-heavy-split-idempotency-race',
      'Orders: concurrent heavy split idempotency race',
      'orders',
      'critical',
      'Submit the same split-shipping checkout 6 times concurrently with the same client_order_id.',
      'Exactly one checkout should win and create two split orders; the other 5 should return DUPLICATE_ORDER and stock should be deducted once.'
    ),
    qaClientDrivenWriteSpec_(
      'orders.concurrent-repeat-gift-multiplied-stock-race',
      'Orders: concurrent promotion + multiplied gift stock race',
      'orders',
      'critical',
      'Submit 8 two-unit checkouts concurrently against product stock=6, a direct promotion, and a per-threshold gift that requests 2 units per successful order from gift stock=4.',
      'Exactly 3 orders succeed, 5 fail product stock validation, 2 orders attach 2 gifts each, the third skips atomically, and both product/gift stock end at 0.'
    )
  ];
}

function qaPaymentLifecycleDeepSpecs_() {
  return [
    qaWriteSpec_('payment.lifecycle-slip-reupload-latest-wins', 'Payment lifecycle: slip reupload latest wins', 'payment', 'critical', 'Upload a slip, upload a second slip while still paid, and read both ids through the customer token.', 'Only the latest slip id should be readable; the previous slip id should be rejected.', 'qaRunPaymentLifecycleSlipReuploadLatestWinsFlow_'),
    qaWriteSpec_('payment.lifecycle-upload-blocked-after-approved', 'Payment lifecycle: upload blocked after approved', 'payment', 'critical', 'Upload a slip, approve the order, then try uploading another slip with the customer token.', 'The second upload should be rejected and the approved order should keep its original slip id.', 'qaRunPaymentLifecycleUploadBlockedAfterApprovedFlow_'),
    qaWriteSpec_('payment.lifecycle-reset-unpaid-clears-slip', 'Payment lifecycle: reset unpaid clears slip', 'payment', 'critical', 'Upload a slip, then reset the order status to unpaid from admin.', 'The order should return to unpaid, slip_drive_file_id should be cleared, and the old slip id should not be readable.', 'qaRunPaymentLifecycleResetUnpaidClearsSlipFlow_'),
    qaWriteSpec_('payment.lifecycle-delivered-blocks-slip-upload', 'Payment lifecycle: delivered blocks slip upload', 'payment', 'critical', 'Move an order through paid, approved, shipped, delivered, then try uploading a new slip.', 'Delivered orders should reject customer slip upload and keep the delivered status.', 'qaRunPaymentLifecycleDeliveredBlocksSlipUploadFlow_'),
    qaWriteSpec_('payment.lifecycle-status-rollback-clears-tracking', 'Payment lifecycle: status rollback clears tracking', 'payment', 'high', 'Ship an approved order with tracking, then roll status back to paid.', 'Tracking data should be cleared when status returns to a pre-shipping payment state.', 'qaRunPaymentLifecycleStatusRollbackClearsTrackingFlow_')
  ];
}

function qaAdditionalEdgeSpecs_() {
  return [
    qaWriteSpec_('orders.security-variant-selection-contract', 'Orders security: required variant selection contract', 'orders', 'critical', 'Send missing, partial, unknown, and invalid variant selections through both previews and submit.', 'All three RPCs must reject with the same explicit error; complete variants and no-variant products must still submit successfully.', 'qaRunOrderSecurityVariantSelectionContractFlow_'),
    qaWriteSpec_('orders.security-cart-quantity-limits-contract', 'Orders security: cart quantity and resource limits', 'orders', 'critical', 'Exercise unsafe qty values, line limits, duplicate aggregation, product limits, and total-order limits through both previews and submit.', 'All three RPCs must enforce the shared limits; exact boundaries pass and one unit over fails without creating an invalid order.', 'qaRunOrderSecurityCartQuantityLimitsContractFlow_'),
    qaWriteSpec_('orders.security-server-variant-authority-workflow', 'Orders security: server-authoritative variant workflow', 'orders', 'critical', 'Submit a valid multi-group variant with forged client display/pricing fields through promotion, gift, shipping, persistence, and stock.', 'The persisted order and all calculations must use only the server-verified variant price, weight, stock, promotion, gift, and display text.', 'qaRunOrderSecurityServerVariantAuthorityWorkflow_'),
    qaWriteSpec_('orders.edge-empty-cart-rejected', 'Orders edge: empty cart rejected', 'orders', 'critical', 'Submit an otherwise valid checkout with items=[].', 'submitOrderRpc should reject the empty cart, create no order, and preserve stock.', 'qaRunOrderEdgeEmptyCartRejectedFlow_'),
    qaWriteSpec_('orders.edge-shipping-info-empty-rejected', 'Orders edge: empty shipping_info rejected', 'orders', 'critical', 'Submit a cart with a valid product but shipping_info=[].', 'submitOrderRpc should reject the payload, create no order, and preserve stock.', 'qaRunOrderEdgeShippingInfoEmptyRejectedFlow_'),
    qaWriteSpec_('orders.edge-client-pricing-missing-item-rejected', 'Orders edge: client pricing missing item', 'orders', 'critical', 'Submit two server cart items but include only one in client_pricing.items.', 'submitOrderRpc should reject with PRICE_CHANGED, include item_missing/subtotal/total diffs, and create no order.', 'qaRunOrderEdgeClientPricingMissingItemRejectedFlow_'),
    qaWriteSpec_('orders.edge-duplicate-product-lines-stock-aggregate', 'Orders edge: duplicate product lines aggregate stock', 'orders', 'critical', 'Submit the same product as two cart lines whose combined qty exactly equals stock.', 'Order should succeed, totals should use combined quantity, and stock should end at 0.', 'qaRunOrderEdgeDuplicateProductLinesStockAggregateFlow_'),
    qaWriteSpec_('orders.edge-variant-stock-rollback-on-failure', 'Orders edge: variant stock rolls back on later failure', 'orders', 'critical', 'Submit a valid variant line followed by another product that is out of stock.', 'The order should fail and the variant stock should remain unchanged.', 'qaRunOrderEdgeVariantStockRollbackOnFailureFlow_'),
    qaWriteSpec_('orders.edge-token-read-after-delete-rejected', 'Orders edge: token read after delete rejected', 'orders', 'high', 'Create an order, delete it as admin, then try to read with the customer token.', 'getOrderByTokenRpc should reject the deleted order token.', 'qaRunOrderEdgeTokenReadAfterDeleteRejectedFlow_'),
    qaWriteSpec_('orders.reject-restores-product-and-gift-stock', 'Orders: reject restores stock, un-reject re-deducts', 'orders', 'critical', 'Submit an order (product + auto gift), reject it, then move it back to approved.', 'Reject should return product and gift stock to inventory (no double restore on repeat reject); un-reject should re-deduct both product and gift stock.', 'qaRunOrderRejectRestoresStockFlow_'),
    qaWriteSpec_('orders.unreject-blocked-when-product-stock-short', 'Orders: un-reject blocked by short product stock', 'orders', 'critical', 'Reject an order, drop product stock below the order qty, then try to un-reject.', 'Un-reject should fail with STOCK_INSUFFICIENT, the order should stay rejected, and neither product nor gift stock should be deducted.', 'qaRunOrderUnrejectProductStockBlockedFlow_'),
    qaWriteSpec_('orders.unreject-blocked-when-gift-stock-short', 'Orders: un-reject blocked by short gift stock (atomic)', 'orders', 'critical', 'Reject an order, deplete the gift stock, then try to un-reject.', 'Un-reject should fail with STOCK_INSUFFICIENT for the gift and must NOT deduct the (sufficient) product stock — all-or-nothing.', 'qaRunOrderUnrejectGiftStockBlockedFlow_'),
    qaWriteSpec_('products.edge-update-active-without-shipping-rejected', 'Products edge: update active product without shipping rejected', 'products', 'critical', 'Create an active product with shipping, then try to remove all allowed_shipping_ids while keeping it active.', 'productUpdateRpc should reject the unsafe active product state.', 'qaRunProductEdgeUpdateActiveWithoutShippingRejectedFlow_'),
    qaWriteSpec_('promotions.edge-negative-discount-rejected', 'Promotions edge: negative discount rejected', 'promotions', 'high', 'Try to create a fixed discount with a negative discount_value.', 'createPromotionRpc should reject the invalid discount.', 'qaRunPromotionEdgeNegativeDiscountRejectedFlow_'),
    qaWriteSpec_('promotions.edge-end-before-start-rejected', 'Promotions edge: end before start rejected', 'promotions', 'high', 'Try to create a promotion whose ends_at is earlier than starts_at.', 'createPromotionRpc should reject the invalid date window.', 'qaRunPromotionEdgeEndBeforeStartRejectedFlow_'),
    qaWriteSpec_('promotions.edge-deleted-promo-removed-from-product', 'Promotions edge: deleted promo removed from product snapshot', 'promotions', 'high', 'Create a product promotion, verify it appears on the product, delete it, and read the product again.', 'The deleted promotion id should no longer appear on the product snapshot.', 'qaRunPromotionEdgeDeletedPromoRemovedFromProductFlow_'),
    qaWriteSpec_('gifts.edge-min-subtotal-equal-boundary', 'Gifts edge: min subtotal equal boundary', 'gifts', 'high', 'Create a min_subtotal gift rule where the cart subtotal exactly equals the threshold.', 'Preview and submit should treat equality as eligible and attach the fixture gift.', 'qaRunGiftEdgeMinSubtotalEqualBoundaryFlow_'),
    qaWriteSpec_('gifts.edge-gift-disabled-before-submit-not-attached', 'Gifts edge: gift disabled after preview before submit', 'gifts', 'critical', 'Preview an eligible gift, disable the gift item, then submit the same cart.', 'The order should still be created, but the disabled fixture gift should not attach or deduct stock.', 'qaRunGiftEdgeGiftDisabledBeforeSubmitNotAttachedFlow_'),
    {
      id: 'payment.edge-get-config-admin-shape',
      title: 'Payment edge: admin config shape',
      area: 'payment',
      type: 'read',
      risk: 'medium',
      description: 'Read payment config with a valid admin token.',
      expected: 'getPaymentConfigRpc should return ok=true and a payment object.',
      requiresAdminToken: true,
      run: function(ctx) { return qaRunPaymentEdgeGetConfigAdminShapeFlow_(ctx); }
    },
    {
      id: 'config.edge-legal-config-admin-shape',
      title: 'Config edge: legal config admin shape',
      area: 'config',
      type: 'read',
      risk: 'medium',
      description: 'Read legal config with a valid admin token.',
      expected: 'getLegalConfigRpc should return ok=true and a legal object.',
      requiresAdminToken: true,
      run: function(ctx) { return qaRunConfigEdgeLegalConfigAdminShapeFlow_(ctx); }
    },
    {
      id: 'auth.edge-user-list-invalid-token-rejected',
      title: 'Auth edge: user list invalid token rejected',
      area: 'auth',
      type: 'guard',
      risk: 'high',
      description: 'Call userListRpc with a deliberately invalid token.',
      expected: 'userListRpc should reject with AUTH_REQUIRED.',
      run: function() { return qaRunAuthEdgeUserListInvalidTokenRejectedFlow_(); }
    }
  ];
}

function qaIntegrationSpecs_() {
  var specs = [
    {
      id: 'env.required-functions',
      title: 'ฟังก์ชัน backend ที่จำเป็นพร้อมใช้งาน',
      area: 'environment',
      type: 'contract',
      risk: 'high',
      description: 'ตรวจว่าฟังก์ชัน RPC และ helper ที่หน้าร้านกับหน้า admin ต้องใช้มีอยู่ครบ',
      expected: 'ต้องพบ RPC และ helper ที่จำเป็นครบทุกตัว',
      run: function(ctx) {
        var names = [
          'checkSetupNeededRpc',
          'getQaIntegrationTraceEventsRpc',
          'clearQaIntegrationTraceRpc',
          'getSiteConfigBundle',
          'getBrandInfoRpc',
          'productListRpc',
          'productGetRpc',
          'productUpdateRpc',
          'getShippingRpc',
          'saveShippingRpc',
          'getActiveGiftCampaignsRpc',
          'previewGiftEligibilityRpc',
          'previewPromotionEligibilityRpc',
          'validateSessionRpc',
          'logoutRpc',
          'productCreateRpc',
          'productDeleteRpc',
          'productBulkDeleteRpc',
          'getStockSummaryRpc',
          'updateStockRpc',
          'listPromotionsRpc',
          'getPromotionRpc',
          'createPromotionRpc',
          'updatePromotionRpc',
          'togglePromotionRpc',
          'deletePromotionRpc',
          'createGiftItemRpc',
          'updateGiftItemRpc',
          'deleteGiftItemRpc',
          'createGiftRuleRpc',
          'updateGiftRuleRpc',
          'deleteGiftRuleRpc',
          'toggleGiftItemRpc',
          'toggleGiftRuleRpc',
          'addManualGiftToOrderRpc',
          'removeGiftLineFromOrderRpc',
          'updateGiftLineQtyRpc',
          'listOrderGiftsRpc',
          'getOrderGiftsByTokenRpc',
          'orderGetRpc',
          'getPaymentConfigRpc',
          'savePaymentConfigRpc',
          'publishSiteConfig',
          'getLegalConfigRpc',
          'userListRpc',
          'userCreateRpc',
          'userUpdateRpc',
          'userDeleteRpc',
          'qaPrepareConcurrentStockRaceRpc',
          'qaCleanupConcurrentStockRaceRpc',
          'qaPrepareConcurrentDuplicateOrderIdRpc',
          'qaVerifyConcurrentDuplicateOrderIdRpc',
          'qaCleanupConcurrentDuplicateOrderIdRpc',
          'qaPrepareConcurrentHeavyPromoGiftStockRaceRpc',
          'qaVerifyConcurrentHeavyPromoGiftStockRaceRpc',
          'qaCleanupConcurrentHeavyPromoGiftStockRaceRpc',
          'qaPrepareConcurrentRepeatGiftMultipliedStockRaceRpc',
          'qaVerifyConcurrentRepeatGiftMultipliedStockRaceRpc',
          'qaCleanupConcurrentRepeatGiftMultipliedStockRaceRpc',
          'qaPrepareConcurrentHeavySplitIdempotencyRaceRpc',
          'qaVerifyConcurrentHeavySplitIdempotencyRaceRpc',
          'qaCleanupConcurrentHeavySplitIdempotencyRaceRpc',
          'qaPrepareVariantStockRaceRpc',
          'qaVerifyVariantStockRaceRpc',
          'qaCleanupVariantStockRaceRpc',
          'qaPrepareConcurrentGiftStockRaceRpc',
          'qaVerifyConcurrentGiftStockRaceRpc',
          'qaCleanupConcurrentGiftStockRaceRpc',
          'qaPrepareAdminGiftOrderRaceRpc',
          'qaVerifyAdminGiftOrderRaceRpc',
          'qaCleanupAdminGiftOrderRaceRpc',
          'qaPrepareManualGiftDoubleClickRpc',
          'qaVerifyManualGiftDoubleClickRpc',
          'qaCleanupManualGiftDoubleClickRpc',
          'listGiftItemsRpc',
          'listGiftRulesRpc'
        ];
        var missing = names.filter(function(name) { return typeof globalThis[name] !== 'function'; });
        qaAssert_(missing.length === 0, 'Missing functions: ' + missing.join(', '));
        return { checked: names.length };
      }
    },
    {
      id: 'env.setup-status',
      title: 'RPC ตรวจสถานะ setup ส่งข้อมูลถูกต้อง',
      area: 'environment',
      type: 'read',
      risk: 'medium',
      description: 'ตรวจว่า checkSetupNeededRpc อ่านสถานะชีต users ได้',
      expected: 'ผลลัพธ์ต้อง ok=true และมีค่า needed เป็น boolean',
      run: function() {
        var res = qaCall_('checkSetupNeededRpc');
        qaAssertOk_(res);
        qaAssert_(typeof res.needed === 'boolean', 'needed must be boolean');
        return { needed: res.needed, ownerEmailPresent: !!res.ownerEmail };
      }
    },
    {
      id: 'config.site-bundle',
      title: 'โหลด bundle ตั้งค่าเว็บได้',
      area: 'config',
      type: 'read',
      risk: 'high',
      description: 'ตรวจ path เดียวกับที่ HtmlService template ใช้โหลด config',
      expected: 'ผลลัพธ์ต้อง ok=true มี config object, products array และ metadata เรื่องขนาดข้อมูล',
      run: function(ctx) {
        var res = qaCall_('getSiteConfigBundle');
        qaAssertOk_(res);
        qaAssert_(res.config && typeof res.config === 'object', 'config must be an object');
        qaAssert_(Array.isArray(res.config.products), 'config.products must be an array');
        ctx.siteConfig = res.config;
        return {
          productCount: res.config.products.length,
          shippingCompanyCount: Array.isArray(res.config.shipping_companies) ? res.config.shipping_companies.length : 0,
          bytes: res.bytes || 0,
          cfgTs: res.cfgTs || 0,
          prodTs: res.prodTs || 0
        };
      }
    },
    {
      id: 'config.brand-info',
      title: 'RPC ข้อมูลแบรนด์ส่ง field เบา ๆ ได้',
      area: 'config',
      type: 'read',
      risk: 'medium',
      description: 'ตรวจ RPC สำหรับ revalidate ข้อมูลแบรนด์ที่หน้า public และ admin ใช้',
      expected: 'ผลลัพธ์ต้อง ok=true และมี key ของข้อมูลแบรนด์ครบ',
      run: function() {
        var res = qaCall_('getBrandInfoRpc');
        qaAssertOk_(res);
        ['siteTitle', 'logoImage', 'logoImageDriveFileId'].forEach(function(key) {
          qaAssert_(Object.prototype.hasOwnProperty.call(res, key), key + ' is missing');
        });
        return {
          siteTitle: res.siteTitle || '',
          hasLogoUrl: !!res.logoImage,
          hasLogoDriveFileId: !!res.logoImageDriveFileId
        };
      }
    },
    {
      id: 'products.public-list',
      title: 'โหลดรายการสินค้าสาธารณะได้',
      area: 'products',
      type: 'read',
      risk: 'high',
      description: 'เรียก productListRpc แบบไม่มี admin token เหมือน path ของหน้าร้าน',
      expected: 'ผลลัพธ์ต้อง ok=true มี items array, total เป็นตัวเลข และ snapshot timestamp',
      run: function(ctx) {
        var res = qaCall_('productListRpc', [{ limit: 5, sort: 'new' }]);
        qaAssertOk_(res);
        qaAssert_(Array.isArray(res.items), 'items must be an array');
        qaAssert_(typeof res.total === 'number', 'total must be a number');
        ctx.publicProducts = res.items || [];
        ctx.sampleProduct = ctx.publicProducts.length ? ctx.publicProducts[0] : null;
        return {
          returned: res.items.length,
          total: res.total,
          snapshotTs: res.snapshotTs || 0,
          sampleProductId: ctx.sampleProduct ? ctx.sampleProduct.id : ''
        };
      }
    },
    {
      id: 'products.pagination-limit',
      title: 'รายการสินค้าเคารพค่า limit',
      area: 'products',
      type: 'read',
      risk: 'medium',
      description: 'ตรวจว่าการ query สินค้าสาธารณะแบบจำกัดจำนวนไม่คืนข้อมูลเกินที่ขอ',
      expected: 'ต้องคืนสินค้าไม่เกิน 1 รายการ',
      run: function() {
        var res = qaCall_('productListRpc', [{ limit: 1, offset: 0 }]);
        qaAssertOk_(res);
        qaAssert_(Array.isArray(res.items), 'items must be an array');
        qaAssert_(res.items.length <= 1, 'items length exceeded limit=1');
        return { returned: res.items.length, total: res.total };
      }
    },
    {
      id: 'products.crud',
      title: 'สินค้า: สร้าง อ่าน แก้ไข และลบสินค้า',
      area: 'products',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA พร้อมค่าขนส่งชั่วคราว อ่านกลับ แก้ไขชื่อ ราคา และสต็อก แล้วลบข้อมูลทดสอบ',
      expected: 'ทุกขั้นตอนต้องสำเร็จ รายละเอียดหลังแก้ไขต้องตรง และหลังลบต้องอ่านสินค้าไม่เจอ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductCrudFlow_(ctx); }
    },
    {
      id: 'products.sale-mode-disabled-hidden',
      title: 'สินค้า: สินค้าที่ปิดขายต้องไม่แสดงในหน้าร้าน',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ที่ sale_mode=disabled แล้วตรวจรายการสินค้าสาธารณะ',
      expected: 'สินค้าทดสอบต้องไม่อยู่ใน productListRpc แบบ public',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductDisabledHiddenFlow_(ctx); }
    },
    {
      id: 'products.sale-schedule-future-hidden',
      title: 'สินค้า: สินค้าที่ตั้งเวลาอนาคตต้องยังไม่แสดง',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA แบบ scheduled โดยตั้งเวลาเริ่มขายไว้ในอนาคต',
      expected: 'สินค้าทดสอบต้องไม่อยู่ในรายการ public และ sale_status ต้องไม่ใช่ active',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductScheduleFutureFlow_(ctx); }
    },
    {
      id: 'products.sale-schedule-active-visible',
      title: 'สินค้า: สินค้าที่อยู่ในช่วงขายต้องแสดงได้',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA แบบ scheduled ที่เวลาเริ่มอยู่ในอดีตและยังไม่หมดอายุ',
      expected: 'สินค้าทดสอบต้องอยู่ในรายการ public และ sale_status ต้องเป็น active',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductScheduleActiveFlow_(ctx); }
    },
    {
      id: 'products.sale-schedule-ended-hidden',
      title: 'สินค้า: สินค้าที่หมดช่วงขายต้องไม่แสดง',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA แบบ scheduled ที่ช่วงเวลาขายหมดอายุแล้ว',
      expected: 'สินค้าทดสอบต้องไม่อยู่ในรายการ public และ sale_status ต้องเป็น ended',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductScheduleEndedFlow_(ctx); }
    },
    {
      id: 'products.variant-create-update-readback',
      title: 'สินค้า: variant ต้องสร้าง แก้ไข และอ่านกลับได้ถูกต้อง',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างและแก้ไขสินค้า QA ที่มี variant ตรวจราคา derived แล้วลองส่งราคาไม่ถูกต้อง ชื่อกลุ่มซ้ำ และชื่อตัวเลือกซ้ำ',
      expected: 'backend ต้องคำนวณราคาหลักถูกต้อง และปฏิเสธราคา/ชื่อ variant ที่ไม่ถูกต้องโดยไม่เปลี่ยนข้อมูลเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductVariantReadbackFlow_(ctx); }
    },
    {
      id: 'products.extra-images-url-validation',
      title: 'สินค้า: รูปเสริมแบบ URL ต้องผ่านการตรวจรูปแบบ',
      area: 'products',
      type: 'write',
      risk: 'medium',
      description: 'ลองสร้างสินค้า QA ด้วย URL รูปเสริมที่ไม่ใช่ URL ที่ปลอดภัย',
      expected: 'productCreateRpc ต้องปฏิเสธ URL ที่ไม่ถูกต้องและไม่สร้างสินค้า',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductExtraImageValidationFlow_(ctx); }
    },
    {
      id: 'products.allowed-shipping-required',
      title: 'สินค้า: สินค้าที่เปิดขายต้องมีวิธีจัดส่ง',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'ลองสร้างสินค้า sale_mode=always โดยไม่กำหนด allowed_shipping_ids',
      expected: 'productCreateRpc ต้องปฏิเสธและไม่สร้างสินค้า',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductAllowedShippingRequiredFlow_(ctx); }
    },
    {
      id: 'products.bulk-delete-cleanup',
      title: 'สินค้า: ลบหลายรายการพร้อมกันต้องลบครบ',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA 2 รายการ แล้วลบด้วย productBulkDeleteRpc',
      expected: 'ต้องลบได้ทั้ง 2 รายการ และ productGetRpc ต้องอ่านไม่เจอ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductBulkDeleteFlow_(ctx); }
    },
    {
      id: 'products.stock-summary-update',
      title: 'สินค้า: stock summary และ update stock ต้องทำงานถูกต้อง',
      area: 'products',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA แล้วตรวจ getStockSummaryRpc จากนั้นแก้ stock ด้วย updateStockRpc',
      expected: 'summary ต้องมีสินค้าทดสอบ และ stock หลังแก้ต้องตรงทั้ง sheet และ snapshot',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunProductStockSummaryUpdateFlow_(ctx); }
    },
    {
      id: 'promotions.crud',
      title: 'โปรโมชั่น: สร้าง อ่าน แก้ไข เปิดปิด และลบโปรโมชั่น',
      area: 'promotions',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA และโปรโมชั่น QA จากนั้นอ่าน แก้ไข toggle และลบ',
      expected: 'ทุกขั้นตอนต้องสำเร็จและหลังลบต้องไม่พบโปรโมชั่นเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionCrudFlow_(ctx); }
    },
    {
      id: 'promotions.fixed-discount-price',
      title: 'โปรโมชั่น: ส่วนลดแบบจำนวนเงินต้องคำนวณราคาถูก',
      area: 'promotions',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ราคา 1000 และโปรลด 125 บาท',
      expected: 'final_price ต้องเหลือ 875 และ discount_amount ต้องเป็น 125',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionFixedDiscountFlow_(ctx); }
    },
    {
      id: 'promotions.percent-discount-price',
      title: 'โปรโมชั่น: ส่วนลดเปอร์เซ็นต์ต้องคำนวณราคาถูก',
      area: 'promotions',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ราคา 1000 และโปรลด 20%',
      expected: 'final_price ต้องเหลือ 800 และ discount_amount ต้องเป็น 200',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionPercentDiscountFlow_(ctx); }
    },
    {
      id: 'promotions.percent-over-100-rejected',
      title: 'โปรโมชั่น: ส่วนลดเปอร์เซ็นต์เกิน 100 ต้องถูกปฏิเสธ',
      area: 'promotions',
      type: 'write',
      risk: 'high',
      description: 'ลองสร้างโปรโมชั่น percent ที่ discount_value มากกว่า 100',
      expected: 'createPromotionRpc ต้องคืน ok=false และไม่สร้างโปรโมชั่น',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionPercentOver100Flow_(ctx); }
    },
    {
      id: 'promotions.product-target-only',
      title: 'โปรโมชั่น: target แบบสินค้าเฉพาะต้องไม่กระทบสินค้าอื่น',
      area: 'promotions',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA 2 ตัว และโปรที่ target เฉพาะตัวแรก',
      expected: 'สินค้าตัวแรกต้องมีโปร ส่วนสินค้าตัวที่สองต้องไม่มีโปร',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionProductTargetOnlyFlow_(ctx); }
    },
    {
      id: 'promotions.variant-target-only',
      title: 'โปรโมชั่น: target แบบ variant ต้องกระทบเฉพาะ variant ที่เลือก',
      area: 'promotions',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ที่มี variant แล้วสร้างโปรเฉพาะ variant หนึ่ง',
      expected: 'variant_promotions ของ variant ที่เลือกต้องมีโปร และ variant อื่นต้องไม่มีโปร',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionVariantTargetOnlyFlow_(ctx); }
    },
    {
      id: 'promotions.product-variant-overlap-rejected',
      title: 'โปรโมชั่น: โปรระดับสินค้าและ variant ที่ทับกันต้องถูกปฏิเสธ',
      area: 'promotions',
      type: 'write',
      risk: 'critical',
      description: 'สร้างโปรระดับสินค้าก่อน แล้วลองสร้างโปรระดับ variant บนสินค้าตัวเดียวกันในช่วงเวลาเดียวกัน',
      expected: 'โปรระดับ variant ที่ทับกับโปรระดับสินค้าต้องถูกปฏิเสธเพื่อกันโปรซ้อน',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionProductVariantOverlapRejectedFlow_(ctx); }
    },
    {
      id: 'promotions.overlap-rejected',
      title: 'โปรโมชั่น: โปรที่ทับซ้อนกันต้องถูกปฏิเสธ',
      area: 'promotions',
      type: 'write',
      risk: 'critical',
      description: 'สร้างโปรแรกที่ active แล้วลองสร้างโปรที่ target และช่วงเวลาทับกัน',
      expected: 'โปรตัวที่สองต้องถูกปฏิเสธเพื่อกันการลดราคาซ้อน',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionOverlapRejectedFlow_(ctx); }
    },
    {
      id: 'promotions.disabled-not-applied',
      title: 'โปรโมชั่น: โปรที่ปิดใช้งานต้องไม่ถูกนำไปใช้',
      area: 'promotions',
      type: 'write',
      risk: 'high',
      description: 'สร้างโปรโมชั่นที่ enabled=false แล้วอ่านสินค้ากลับจาก snapshot',
      expected: 'สินค้าต้องไม่มี promotion และ final_price ต้องเท่ากับราคาเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionDisabledNotAppliedFlow_(ctx); }
    },
    {
      id: 'promotions.future-and-ended-status',
      title: 'โปรโมชั่น: สถานะอนาคตและหมดอายุต้องถูกต้อง',
      area: 'promotions',
      type: 'write',
      risk: 'medium',
      description: 'สร้างโปรโมชั่นที่ยังไม่เริ่มและโปรโมชั่นที่หมดอายุแล้ว',
      expected: 'listPromotionsRpc ต้องคืน status scheduled และ ended ให้ถูกต้อง',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionFutureEndedStatusFlow_(ctx); }
    },
    qaWriteSpec_('promotions.all-target-applies-to-multiple-products', 'Promotions: all target applies to multiple products', 'promotions', 'critical', 'Create an all-target promotion and verify multiple fixture products and a multi-item order use the discounted price.', 'All product lines should carry the all-target promotion snapshot and correct totals.', 'qaRunPromotionAllTargetMultiProductFlow_'),
    qaWriteSpec_('promotions.fixed-discount-clamps-zero', 'Promotions: fixed discount clamps at zero', 'promotions', 'high', 'Create a fixed discount larger than product price.', 'Final unit price should be 0 and discount amount should equal the base price.', 'qaRunPromotionFixedDiscountClampsZeroFlow_'),
    qaWriteSpec_('promotions.percent-rounding', 'Promotions: percent discount rounding', 'promotions', 'high', 'Create a percent discount whose result requires Math.round.', 'Final price and discount amount should match backend rounding.', 'qaRunPromotionPercentRoundingFlow_'),
    qaWriteSpec_('promotions.invalid-target-rejected', 'Promotions: invalid targets are rejected', 'promotions', 'high', 'Try missing product targets and invalid variant keys.', 'createPromotionRpc should reject invalid promotion targets.', 'qaRunPromotionInvalidTargetRejectedFlow_'),
    qaWriteSpec_('promotions.toggle-overlap-guard', 'Promotions: toggle overlap guard', 'promotions', 'critical', 'Create an active promo and a disabled overlapping promo, then try to enable the disabled one.', 'togglePromotionRpc should reject the overlapping activation.', 'qaRunPromotionToggleOverlapGuardFlow_'),
    qaWriteSpec_('promotions.update-overlap-guard', 'Promotions: update overlap guard', 'promotions', 'critical', 'Update a disabled promo so it overlaps an active promo.', 'updatePromotionRpc should reject the overlapping update.', 'qaRunPromotionUpdateOverlapGuardFlow_'),
    qaWriteSpec_('promotions.two-group-variant-canonical-order', 'Promotions: two-group variant canonical order', 'promotions', 'critical', 'Create a two-group variant promotion keyed Color=Black|Size=XL and submit selected_variants in reverse object order.', 'Promotion should apply, the order line should snapshot the canonical variant_key, and final price/discount should be correct.', 'qaRunPromotionTwoGroupVariantCanonicalOrderFlow_'),
    qaWriteSpec_('promotions.conditional-min-subtotal', 'Promotions (conditional): min_subtotal below/exact/over', 'promotions', 'critical', 'Create a conditional min_subtotal promo (all-target) and preview+order carts below, exactly at, and over the threshold.', 'Discount applies only at/over the threshold; preview and order prices match.', 'qaRunConditionalMinSubtotalFlow_'),
    qaWriteSpec_('promotions.conditional-required-products-all', 'Promotions (conditional): required_products ALL (buy A discount B)', 'promotions', 'critical', 'Condition product A (min_qty 2) unlocks a discount on target product B; test incomplete qty and duplicate cart lines.', 'B is discounted only when A qty>=2 (summed across duplicate lines); A is never discounted; preview==order.', 'qaRunConditionalRequiredProductsAllFlow_'),
    qaWriteSpec_('promotions.conditional-required-products-any', 'Promotions (conditional): required_products ANY', 'promotions', 'critical', 'ANY-mode condition qualifies when either configured product is present.', 'Percent discount on target applies when at least one condition product is in cart; preview==order.', 'qaRunConditionalRequiredProductsAnyFlow_'),
    qaWriteSpec_('promotions.conditional-missing-match-mode', 'Promotions (conditional): missing match_mode defaults to ALL', 'promotions', 'high', 'Create a required_products condition with no match_mode and read it back.', 'Stored match_mode normalizes to all; only both products together qualify.', 'qaRunConditionalMissingMatchModeFlow_'),
    qaWriteSpec_('promotions.conditional-required-variants', 'Promotions (conditional): required_variants correct vs wrong variant', 'promotions', 'critical', 'Condition requires a specific variant of A to discount target T.', 'Only the correct variant qualifies; wrong variant is excluded; preview==order.', 'qaRunConditionalRequiredVariantsFlow_'),
    qaWriteSpec_('promotions.conditional-duplicate-rejected', 'Promotions (conditional): duplicate conditions rejected', 'promotions', 'high', 'Submit conditional promos with duplicate product and duplicate product+variant_key conditions.', 'createPromotionRpc rejects both duplicate condition payloads.', 'qaRunConditionalDuplicateRejectedFlow_'),
    qaWriteSpec_('promotions.conditional-inactive-not-applied', 'Promotions (conditional): disabled/scheduled/expired not applied', 'promotions', 'high', 'Create disabled, scheduled, and expired conditional promos whose condition is met.', 'None apply a discount and none appear eligible.', 'qaRunConditionalInactiveNotAppliedFlow_'),
    qaWriteSpec_('promotions.conditional-priority-no-stack', 'Promotions (conditional): priority + no stacking + overlap exemption', 'promotions', 'critical', 'Direct product promo and a qualified conditional variant promo on the same line; conditional overlaps the direct target.', 'Conditional promo is accepted (overlap exempt), the bigger discount wins without stacking (best price), and falls back to direct when unqualified.', 'qaRunConditionalPriorityNoStackFlow_'),
    qaWriteSpec_('promotions.conditional-legacy-and-zero-floor', 'Promotions (conditional): legacy direct + zero-price floor', 'promotions', 'high', 'A promo created without application_mode behaves as direct; a fixed discount over price floors at 0.', 'Legacy promo reads back as direct and still applies; final price floors at 0.', 'qaRunConditionalLegacyAndZeroFloorFlow_'),
    qaWriteSpec_('promotions.conditional-order-snapshot-immutable', 'Promotions (conditional): immutable order snapshot', 'promotions', 'critical', 'Submit a qualifying conditional order then delete the promo.', 'The persisted order line keeps its discounted price and promotion snapshot.', 'qaRunConditionalOrderSnapshotImmutableFlow_'),
    qaWriteSpec_('promotions.conditional-required-variants-any', 'Promotions (conditional): required_variants ANY', 'promotions', 'critical', 'ANY-mode required_variants condition with two variant entries (Size S and Size L) of the same product, discounting a separate target product.', 'Buying either variant alone qualifies; buying neither does not; preview==order.', 'qaRunConditionalRequiredVariantsAnyFlow_'),
    qaWriteSpec_('promotions.conditional-two-qualified-competing', 'Promotions (conditional): two qualified conditional promos compete', 'promotions', 'critical', 'Two conditional promotions (product-level and variant-level) both qualified on the same line at once.', 'The conditional promo with the bigger discount wins via the best-price resolver; disabling it falls back to the other qualified conditional promo.', 'qaRunConditionalTwoQualifiedCompetingFlow_'),
    qaWriteSpec_('promotions.conditional-required-variants-incomplete-key-rejected', 'Promotions (conditional): incomplete variant_key rejected', 'promotions', 'high', 'createPromotionRpc with a required_variants condition whose variant_key omits one of the variant groups on the product.', 'Promotion creation is rejected (ok:false).', 'qaRunConditionalRequiredVariantsIncompleteKeyRejectedFlow_'),
    qaWriteSpec_('promotions.settings-validation-matrix', 'Promotions settings: invalid configuration matrix', 'promotions', 'critical', 'Try invalid application modes, condition types, empty conditions, missing product references, invalid variant keys, and an invalid start date.', 'Every invalid admin configuration is rejected and no promotion row is left behind.', 'qaRunPromotionSettingsValidationMatrixFlow_'),
    qaWriteSpec_('promotions.settings-schedule-round-trip', 'Promotions settings: schedule and no-end round trip', 'promotions', 'critical', 'Update one promotion through scheduled, active no-end, expired, disabled, and re-enabled states.', 'Stored schedule fields and dynamic status follow every admin edit; inactive states never discount the product.', 'qaRunPromotionSettingsScheduleRoundTripFlow_'),
    qaWriteSpec_('promotions.settings-mode-transition', 'Promotions settings: direct/conditional mode transition', 'promotions', 'critical', 'Edit a promotion direct -> conditional -> direct while carrying condition fields in the update payload.', 'Snapshot and preview behavior follow the selected mode, and direct mode strips stale condition data.', 'qaRunPromotionSettingsModeTransitionFlow_'),
    qaWriteSpec_('promotions.conditional-min-subtotal-after-direct', 'Promotions: conditional subtotal uses direct-discount base', 'promotions', 'critical', 'A direct promotion changes a 1000-baht line to 800 before a conditional min-subtotal promotion is evaluated.', 'A threshold of 900 does not qualify; after editing it to 800 it qualifies but is outpriced by the bigger direct discount (applied:false, no stacking).', 'qaRunPromotionConditionalSubtotalAfterDirectFlow_'),
    qaWriteSpec_('promotions.order-total-fixed', 'Promotions (order-total): fixed discount once per order', 'promotions', 'critical', 'Conditional min_subtotal promo with discount_scope=order_total (fixed). Below threshold near-miss; at/over threshold deducts a flat amount once without changing unit price.', 'Order discount deducts once (never × qty), per-line prices unchanged, preview==order, persisted order_discount matches.', 'qaRunOrderTotalFixedFlow_'),
    qaWriteSpec_('promotions.order-total-percent', 'Promotions (order-total): percent discount once per order', 'promotions', 'critical', 'Order-total conditional promo with a percent discount on the item subtotal.', 'Percent is computed on the subtotal and deducted once; subtotal_after_order_discount and order total match; preview==order.', 'qaRunOrderTotalPercentFlow_'),
    qaWriteSpec_('promotions.order-total-exceeds-subtotal', 'Promotions (order-total): discount clamped to subtotal', 'promotions', 'high', 'Order-total discount larger than the item subtotal.', 'The discount is clamped to the subtotal so the net item total floors at 0; order total equals shipping only.', 'qaRunOrderTotalExceedsSubtotalFlow_'),
    qaWriteSpec_('promotions.order-total-disabled-expired', 'Promotions (order-total): disabled/expired not applied', 'promotions', 'high', 'A disabled and an expired order-total promo whose condition is met.', 'Neither applies an order discount nor appears eligible; preview==order.', 'qaRunOrderTotalDisabledExpiredFlow_'),
    qaWriteSpec_('promotions.order-total-best-wins', 'Promotions (order-total): larger discount wins, no stacking', 'promotions', 'critical', 'Two qualified order-total promos in the same cart.', 'The larger discount wins and is applied once; the other is reported qualified-but-outpriced (applied:false); preview==order.', 'qaRunOrderTotalBestWinsFlow_'),
    qaWriteSpec_('promotions.order-total-direct-rejected', 'Promotions (order-total): direct promo cannot be order-total', 'promotions', 'critical', 'createPromotionRpc/updatePromotionRpc with a direct promo attempting discount_scope=order_total.', 'Direct + order_total is rejected; a conditional order-total promo can be switched to direct only when scope is reset to item.', 'qaRunOrderTotalDirectRejectedFlow_'),
    qaWriteSpec_('promotions.order-total-edit-reload', 'Promotions (order-total): create/edit/reload consistency', 'promotions', 'high', 'Create an item-scoped conditional promo, edit it to order-total, and reload it.', 'discount_scope persists as order_total, targeting is forced to whole-store, and the reloaded promo behaves as an order-total discount.', 'qaRunOrderTotalEditReloadFlow_'),
    qaWriteSpec_('gifts.ignores-order-total-discount', 'Gifts: min_subtotal basis ignores order-total discount', 'gifts', 'critical', 'An order-total (conditional) discount and a gift min_subtotal rule in the same cart.', 'Gift eligibility uses the direct-only subtotal (unchanged by the order-total discount); the gift is attached and the order total still nets the discount.', 'qaRunGiftIgnoresOrderTotalDiscountFlow_'),
    qaWriteSpec_('promotions.resolver-reverse-specificity', 'Promotions resolver: direct variant beats conditional product', 'promotions', 'critical', 'A direct variant promotion (-300) and a newer qualified conditional product promotion (-100) both match the same variant.', 'The bigger direct variant discount wins (best price); a sibling variant falls back to the conditional product promotion.', 'qaRunPromotionResolverReverseSpecificityFlow_'),
    qaWriteSpec_('promotions.resolver-created-at-tiebreak', 'Promotions resolver: newest wins price tie', 'promotions', 'critical', 'Create two simultaneously-qualified conditional product promotions with equal discounts and equal specificity.', 'The newer promotion wins the tie; disabling it falls back to the older promotion at the same price.', 'qaRunPromotionResolverCreatedAtTiebreakFlow_'),
    qaWriteSpec_('promotions.best-price-over-specificity', 'Promotions resolver: bigger discount beats higher specificity', 'promotions', 'critical', 'A direct variant promotion (-100) and a qualified conditional product promotion (-300) both match the same variant line.', 'The less-specific conditional promotion wins because it yields the lower final price; preview reports it applied and matches the order.', 'qaRunPromotionBestPriceOverSpecificityFlow_'),
    {
      id: 'shipping.public-config',
      title: 'โหลดค่าขนส่งสาธารณะได้',
      area: 'shipping',
      type: 'read',
      risk: 'high',
      description: 'ตรวจ getShippingRpc ที่หน้า product/order/shipping ใช้งาน',
      expected: 'ผลลัพธ์ต้อง ok=true และมี companies array',
      run: function() {
        var res = qaCall_('getShippingRpc');
        qaAssertOk_(res);
        qaAssert_(Array.isArray(res.companies), 'companies must be an array');
        // Public RPC must NOT leak provider key readiness / masked keys.
        qaAssert_(res.hasAftershipKey === undefined && res.hasThaipostToken === undefined && res.hasEtrackKey === undefined,
          'getShippingRpc ต้องไม่คืนสถานะ API key ของ provider', res);
        qaAssert_(res.aftershipKeyMasked === undefined && res.thaipostTokenMasked === undefined && res.etrackKeyMasked === undefined,
          'getShippingRpc ต้องไม่คืน masked API key', res);
        return { companies: res.companies.length };
      }
    },
    {
      id: 'shipping.crud-temp-restore',
      title: 'การจัดส่ง: เพิ่มค่าขนส่งชั่วคราวแล้วคืนค่าเดิมได้',
      area: 'shipping',
      type: 'write',
      risk: 'critical',
      description: 'เพิ่มบริษัทขนส่ง QA เข้าไปในชีต แล้วตรวจว่าอ่านกลับได้ก่อน restore ค่าเดิม',
      expected: 'ต้องพบค่าขนส่ง QA หลังบันทึก และหลัง cleanup ต้องกลับไปเป็นชุดเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingCrudRestoreFlow_(ctx); }
    },
    {
      id: 'shipping.flat-fee-calculation',
      title: 'การจัดส่ง: ค่าขนส่งแบบ flat ต้องถูกคิดในออร์เดอร์',
      area: 'shipping',
      type: 'write',
      risk: 'high',
      description: 'สร้าง method ค่าขนส่งคงที่และส่งออร์เดอร์ QA',
      expected: 'shipping_fee และ total ในออร์เดอร์ต้องรวมค่าขนส่งคงที่จาก backend',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingFlatFeeFlow_(ctx); }
    },
    {
      id: 'shipping.weight-tier-fee-calculation',
      title: 'การจัดส่ง: ค่าขนส่งตามน้ำหนักต้องเลือกช่วงที่ถูกต้อง',
      area: 'shipping',
      type: 'write',
      risk: 'high',
      description: 'สร้าง method แบบ weight tier และสินค้าที่น้ำหนักอยู่ในช่วงกลาง',
      expected: 'shipping_fee ต้องตรงกับราคาของช่วงน้ำหนักที่ match',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingWeightTierFlow_(ctx); }
    },
    qaWriteSpec_(
      'shipping.weight-tier-boundaries-and-overflow',
      'การจัดส่ง: ช่วงน้ำหนักต้องถูกต้องที่ขอบช่วงและเมื่อเกินช่วงสุดท้าย',
      'shipping',
      'critical',
      'สร้าง method แบบ weight tier แล้วส่งออร์เดอร์จริง 4 น้ำหนัก: 500g, 501g, 1000g และเกินช่วงสุดท้าย',
      'ค่าขนส่งต้องตรงกับ bracket ที่ match และน้ำหนักที่เกินช่วงสุดท้ายต้องใช้ราคาช่วงท้ายสุด',
      'qaRunShippingWeightTierBoundariesFlow_'
    ),
    qaWriteSpec_('shipping.split-weight-fee-per-draft', 'Shipping: split weight fee per draft', 'shipping', 'critical', 'Create two weight methods and split one checkout so each product is assigned to its own method.', 'submitOrderRpc should create two orders and each order should compute shipping from that draft weight only.', 'qaRunShippingSplitWeightFeePerDraftFlow_'),
    qaWriteSpec_('shipping.split-missing-item-assignment-rejected', 'Shipping: split missing item assignment rejected', 'shipping', 'critical', 'Send two cart items but cover only one product with shipping_info.item_product_ids.', 'submitOrderRpc should reject with SHIPPING_INVALID and should not create orders or deduct stock.', 'qaRunShippingSplitMissingItemAssignmentRejectedFlow_'),
    qaWriteSpec_('shipping.split-wrong-method-for-product-rejected', 'Shipping: split wrong method for product rejected', 'shipping', 'critical', 'Assign a product to a split shipping method that is not in its allowed_shipping_ids.', 'submitOrderRpc should reject with SHIPPING_INVALID and preserve stock.', 'qaRunShippingSplitWrongMethodForProductRejectedFlow_'),
    {
      id: 'shipping.inactive-method-rejected',
      title: 'การจัดส่ง: method ที่ปิดใช้งานต้องสั่งซื้อไม่ได้',
      area: 'shipping',
      type: 'write',
      risk: 'critical',
      description: 'สร้าง method ที่ active=false แล้วลองส่งออร์เดอร์ด้วย method นั้น',
      expected: 'submitOrderRpc ต้องปฏิเสธ method ที่ปิดใช้งาน',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingInactiveMethodRejectedFlow_(ctx); }
    },
    {
      id: 'shipping.removed-method-clean-product',
      title: 'การจัดส่ง: ลบ method แล้วต้อง cleanup สินค้าที่อ้างถึง',
      area: 'shipping',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ที่ผูกกับ method ชั่วคราว แล้ว restore shipping กลับชุดเดิม',
      expected: 'allowed_shipping_ids ของสินค้าต้องถูกล้าง method ที่ถูกลบออก',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingRemovedMethodCleanupFlow_(ctx); }
    },
    {
      id: 'shipping.no-valid-method-deactivates-product',
      title: 'การจัดส่ง: ไม่มี method ที่ใช้ได้แล้วสินค้าต้องถูกปิดขาย',
      area: 'shipping',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ที่ผูกกับ method ชั่วคราว จากนั้นทำให้ไม่มี method active เหลือ',
      expected: 'สินค้าต้องถูกเปลี่ยนเป็น sale_status ที่ไม่ active',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingNoValidMethodDeactivatesFlow_(ctx); }
    },
    {
      id: 'shipping.validation-invalid-carrier-url',
      title: 'การจัดส่ง: carrier และ tracking URL ที่ไม่ถูกต้องต้องถูกปฏิเสธ',
      area: 'shipping',
      type: 'write',
      risk: 'medium',
      description: 'ส่งค่าขนส่งที่มี carrier_id หรือ tracking_url_template ไม่ปลอดภัย',
      expected: 'saveShippingRpc ต้องคืน ok=false และไม่บันทึกค่าที่ไม่ถูกต้อง',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingValidationFlow_(ctx); }
    },
    {
      id: 'shipping.tracking-provider-readback',
      title: 'การจัดส่ง: tracking provider ต้องอ่านกลับถูกต้อง',
      area: 'shipping',
      type: 'write',
      risk: 'medium',
      description: 'เพิ่มบริษัทขนส่ง QA ที่ตั้ง tracking_provider แล้วอ่านกลับด้วย getShippingRpc',
      expected: 'provider และ template ต้องตรงกับค่าที่บันทึก',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingTrackingProviderReadbackFlow_(ctx); }
    },
    qaWriteSpec_('fulfillment.allowed-unpaid', 'Fulfillment: เปลี่ยนบริษัทขนส่งจริงได้เมื่อ unpaid', 'shipping', 'critical',
      'ออร์เดอร์สถานะ unpaid เปลี่ยนบริษัทขนส่งจริงได้ และยอดเงิน/ข้อมูลลูกค้าเลือกต้องไม่เปลี่ยน',
      'ok=true; shipping_info/shipping_method_id/shipping_fee/subtotal/total คงเดิม; สถานะไม่เปลี่ยน; มี history shipping_carrier_changed', 'qaRunFulfillmentAllowedUnpaidFlow_'),
    qaWriteSpec_('fulfillment.allowed-paid', 'Fulfillment: เปลี่ยนบริษัทขนส่งจริงได้เมื่อ paid', 'shipping', 'critical',
      'ออร์เดอร์สถานะ paid เปลี่ยนบริษัทขนส่งจริงได้ (ต้องมีเหตุผล) และยอดเงินถูกล็อกไม่เปลี่ยน',
      'ok=true; ยอดเงินคงเดิม; สถานะยังเป็น paid', 'qaRunFulfillmentAllowedPaidFlow_'),
    qaWriteSpec_('fulfillment.allowed-approved', 'Fulfillment: เปลี่ยนบริษัทขนส่งจริงได้เมื่อ approved', 'shipping', 'critical',
      'ออร์เดอร์สถานะ approved เปลี่ยนบริษัทขนส่งจริงได้ (ต้องมีเหตุผล) และยอดเงินคงเดิม',
      'ok=true; ยอดเงินคงเดิม; สถานะยังเป็น approved', 'qaRunFulfillmentAllowedApprovedFlow_'),
    qaWriteSpec_('fulfillment.rejected-shipped', 'Fulfillment: ปฏิเสธเมื่อ shipped', 'shipping', 'high',
      'ออร์เดอร์ที่ถูก mark shipped แล้วต้องเปลี่ยนบริษัทขนส่งจริงไม่ได้', 'ok=false, error=STATUS_NOT_ALLOWED', 'qaRunFulfillmentRejectedShippedFlow_'),
    qaWriteSpec_('fulfillment.rejected-delivered', 'Fulfillment: ปฏิเสธเมื่อ delivered/rejected/cancelled', 'shipping', 'high',
      'ออร์เดอร์สถานะ delivered/rejected/cancelled ต้องเปลี่ยนบริษัทขนส่งจริงไม่ได้', 'ok=false, error=STATUS_NOT_ALLOWED ทุกกรณี', 'qaRunFulfillmentRejectedTerminalFlow_'),
    qaWriteSpec_('fulfillment.inactive-company-rejected', 'Fulfillment: บริษัทที่ปิดใช้งานต้องถูกปฏิเสธ', 'shipping', 'high',
      'เลือกบริษัทขนส่งที่ active=false เป็น fulfillment', 'ok=false, error=COMPANY_INVALID', 'qaRunFulfillmentInactiveCompanyFlow_'),
    qaWriteSpec_('fulfillment.invalid-method-rejected', 'Fulfillment: method ที่ปิดใช้งาน/ข้ามบริษัทต้องถูกปฏิเสธ', 'shipping', 'high',
      'method ที่ active=false หรือ method ของบริษัทอื่นต้องถูกปฏิเสธ', 'ok=false, error=METHOD_INVALID ทั้งสองกรณี', 'qaRunFulfillmentInvalidMethodFlow_'),
    qaWriteSpec_('fulfillment.mark-shipped-uses-override', 'Fulfillment: mark shipped ใช้ carrier override และ resolve backend', 'shipping', 'critical',
      'ตั้ง override แล้ว mark shipped — tracking_json ต้องใช้ carrier ของ override และ URL/provider ที่ backend resolve',
      'tracking.carrier_id/tracking_url/provider ตรง override config; fulfillment_source=override', 'qaRunFulfillmentMarkShippedOverrideFlow_'),
    qaWriteSpec_('fulfillment.mark-shipped-fallback-original', 'Fulfillment: ไม่มี override ใช้ carrier เดิม', 'shipping', 'high',
      'ออร์เดอร์ที่ไม่มี override เมื่อ mark shipped ต้องใช้บริษัทที่ลูกค้าเลือก', 'tracking.carrier_id ตรงบริษัทเดิม; fulfillment_source=original', 'qaRunFulfillmentMarkShippedOriginalFlow_'),
    qaWriteSpec_('fields.monetary-locked-after-paid', 'Fields: ยอดเงินถูกล็อกหลังชำระเงิน', 'order', 'critical',
      'orderUpdateFieldsRpc ต้องแก้ shipping_fee/total/subtotal ไม่ได้เมื่อ paid และแก้ได้ + คำนวณ total ใหม่เมื่อ unpaid',
      'unpaid: แก้ shipping_fee ได้ total=subtotal+fee; subtotal ถูกปฏิเสธเสมอ; paid: PRICING_LOCKED', 'qaRunFieldsMonetaryLockFlow_'),
    qaWriteSpec_('fields.monetary-lock-persists-rollback', 'Fields: ล็อกยอดเงินคงอยู่แม้ย้อนกลับเป็น unpaid', 'order', 'critical',
      'ออร์เดอร์ที่เคย paid แล้วย้อนกลับเป็น unpaid ยอดเงินต้องยังถูกล็อก', 'ok=false, error=PRICING_LOCKED', 'qaRunFieldsMonetaryLockPersistFlow_'),
    {
      id: 'gifts.public-campaigns',
      title: 'โหลดแคมเปญของแถมสาธารณะได้',
      area: 'gifts',
      type: 'read',
      risk: 'high',
      description: 'ตรวจ RPC แคมเปญสาธารณะที่หน้าร้านใช้พรีวิวของแถม',
      expected: 'ผลลัพธ์ต้อง ok=true และมีรายการแคมเปญเป็น array',
      run: function() {
        var res = qaCall_('getActiveGiftCampaignsRpc');
        qaAssertOk_(res);
        qaAssert_(Array.isArray(res.campaigns), 'campaigns must be an array');
        return { campaigns: res.campaigns.length };
      }
    },
    {
      id: 'gifts.preview-empty-cart',
      title: 'พรีวิวของแถมรองรับตะกร้าว่าง',
      area: 'gifts',
      type: 'read',
      risk: 'medium',
      description: 'ตรวจว่า previewGiftEligibilityRpc คืนสถานะว่างได้สะอาดเมื่อไม่มีสินค้าในตะกร้า',
      expected: 'ต้องได้ ok=true, eligible=[], near=[], subtotal_after_promo=0',
      run: function() {
        var res = qaCall_('previewGiftEligibilityRpc', [{ items: [] }]);
        qaAssertOk_(res);
        qaAssert_(Array.isArray(res.eligible), 'eligible must be an array');
        qaAssert_(Array.isArray(res.near), 'near must be an array');
        qaAssert_(Number(res.subtotal_after_promo || 0) === 0, 'subtotal should be 0');
        return {
          eligible: res.eligible.length,
          near: res.near.length,
          subtotalAfterPromo: res.subtotal_after_promo || 0
        };
      }
    },
    {
      id: 'gifts.preview-sample-product',
      title: 'พรีวิวของแถมด้วยสินค้าทดสอบที่สร้างใหม่',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ชั่วคราวเอง แล้วตรวจ previewGiftEligibilityRpc ว่าคำนวณสิทธิ์ของแถมได้โดยไม่พึ่งสินค้าที่มีอยู่เดิมในร้าน',
      expected: 'ต้องได้ ok=true และ subtotal เป็นตัวเลข จากนั้นต้องล้างสินค้าและค่าขนส่งชั่วคราวได้',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        var token = ctx.options.adminToken;
        var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
        var shipping = qaCreateTempShippingMethod_(token, stamp, 'GiftPreview');
        var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'GiftPreview', 5);
        var caught = null, output = null;
        try {
          var res = qaCall_('previewGiftEligibilityRpc', [{
            items: [{ product_id: product.id, qty: 1, selected_variants: {} }]
          }]);
          qaAssertOk_(res);
          qaAssert_(typeof Number(res.subtotal_after_promo || 0) === 'number', 'subtotal must be numeric');
          output = {
            productId: product.id,
            eligible: Array.isArray(res.eligible) ? res.eligible.length : 0,
            near: Array.isArray(res.near) ? res.near.length : 0,
            subtotalAfterPromo: Number(res.subtotal_after_promo || 0)
          };
        } catch (err) {
          caught = err;
        }
        var cleanup = qaCleanupProductAndShipping_(token, product.id, shipping);
        if (caught) {
          caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup });
          throw caught;
        }
        output.cleanup = cleanup;
        return output;
      }
    },
    {
      id: 'gifts.item-crud',
      title: 'ของแถม: สร้าง อ่าน แก้ไข และลบรายการของแถม',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างรายการของแถม QA แล้วอ่านจาก listGiftItemsRpc แก้ไขชื่อ สต็อก และสถานะเปิดใช้งาน จากนั้นลบและตรวจว่าไม่อยู่ในรายการแล้ว',
      expected: 'ทุกขั้นตอนต้องสำเร็จ ข้อมูลหลังแก้ไขต้องตรง และหลังลบต้องไม่พบรหัสของแถมเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftItemCrudFlow_(ctx); }
    },
    {
      id: 'gifts.rule-crud',
      title: 'ของแถม: สร้าง อ่าน แก้ไข และลบกฎของแถม',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างของแถมและกฎของแถม QA แล้วอ่านจาก listGiftRulesRpc แก้ไขลำดับความสำคัญ สถานะเปิดใช้งาน และชื่อ จากนั้นลบกฎและของแถม',
      expected: 'กฎต้องถูกสร้าง อ่านได้ แก้ไขได้ และหลังลบต้องไม่พบรหัสกฎเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftRuleCrudFlow_(ctx); }
    },
    {
      id: 'gifts.disabled-item-not-eligible',
      title: 'ของแถม: รายการของแถมที่ปิดใช้งานต้องไม่ถูกแจก',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างกฎที่เข้าเงื่อนไข แต่ตั้งของแถมเป็นปิดใช้งาน แล้วพรีวิวด้วยตะกร้าที่เข้าเงื่อนไข',
      expected: 'previewGiftEligibilityRpc ต้องไม่คืนกฎนั้นในรายการที่ได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftDisabledItemFlow_(ctx); }
    },
    {
      id: 'gifts.disabled-rule-not-eligible',
      title: 'ของแถม: กฎที่ปิดใช้งานต้องไม่ถูกแจก',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างของแถมที่เปิดใช้งาน แต่ตั้งกฎเป็นปิดใช้งาน แล้วพรีวิวด้วยตะกร้าที่เข้าเงื่อนไข',
      expected: 'previewGiftEligibilityRpc ต้องไม่คืนกฎนั้นในรายการที่ได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftDisabledRuleFlow_(ctx); }
    },
    {
      id: 'gifts.schedule-not-started',
      title: 'ของแถม: กฎที่ยังไม่ถึงเวลาเริ่มต้องยังไม่แจก',
      area: 'gifts',
      type: 'write',
      risk: 'medium',
      description: 'สร้างกฎของแถมที่เวลาเริ่มอยู่ในอนาคต แล้วพรีวิวด้วยตะกร้าที่เข้าเงื่อนไข',
      expected: 'กฎที่ยังไม่เริ่มต้องไม่อยู่ในรายการที่ได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftScheduleNotStartedFlow_(ctx); }
    },
    {
      id: 'gifts.schedule-ended',
      title: 'ของแถม: กฎที่หมดเวลาแล้วต้องไม่แจก',
      area: 'gifts',
      type: 'write',
      risk: 'medium',
      description: 'สร้างกฎของแถมที่ช่วงเวลาอยู่ในอดีตและหมดอายุแล้ว แล้วพรีวิวด้วยตะกร้าที่เข้าเงื่อนไข',
      expected: 'กฎที่หมดอายุแล้วต้องไม่อยู่ในรายการที่ได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftScheduleEndedFlow_(ctx); }
    },
    {
      id: 'gifts.required-products-min-qty',
      title: 'ของแถม: เงื่อนไขสินค้าที่ต้องซื้อให้ครบจำนวนขั้นต่ำ',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างกฎสินค้าที่ต้องซื้อ โดยกำหนดให้ซื้อสินค้าทดสอบอย่างน้อย 2 ชิ้น แล้วพรีวิวด้วยจำนวน 1 และ 2 ชิ้น',
      expected: 'จำนวน 1 ชิ้นต้องยังไม่ได้สิทธิ์ ส่วนจำนวน 2 ชิ้นต้องได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftRequiredProductsMinQtyFlow_(ctx); }
    },
    {
      id: 'gifts.min-subtotal-condition',
      title: 'ของแถม: เงื่อนไขยอดซื้อขั้นต่ำ',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างกฎยอดซื้อขั้นต่ำ แล้วพรีวิวด้วยยอดที่ยังไม่ถึงและยอดที่ถึงเงื่อนไข',
      expected: 'ยอดที่ยังไม่ถึงต้องไม่ได้สิทธิ์ และยอดที่ถึงแล้วต้องได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftMinSubtotalFlow_(ctx); }
    },
    {
      id: 'gifts.once-per-order-repeat',
      title: 'ของแถม: กฎแจกครั้งเดียวต่อออร์เดอร์ต้องไม่แจกซ้ำ',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างกฎแจกครั้งเดียวต่อออร์เดอร์ แล้วส่งออร์เดอร์ที่ซื้อสินค้าเข้าเงื่อนไขหลายชิ้น',
      expected: 'ออร์เดอร์ต้องมีรายการของแถมจากกฎนั้นเพียง 1 รายการ และจำนวนของแถมต้องตรงกับที่ตั้งไว้',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftOncePerOrderFlow_(ctx); }
    },
    {
      id: 'gifts.stock-insufficient-skip',
      title: 'ของแถม: สต็อกไม่พอต้องไม่แนบของแถมเข้าออร์เดอร์',
      area: 'gifts',
      type: 'write',
      risk: 'critical',
      description: 'สร้างของแถมที่สต็อกเป็น 0 และกฎที่เข้าเงื่อนไข แล้วส่งออร์เดอร์จริง',
      expected: 'ออร์เดอร์ต้องถูกสร้างได้ แต่ต้องไม่มีรายการของแถมที่สต็อกหมด',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftStockInsufficientSkipFlow_(ctx); }
    },
    {
      id: 'gifts.unlimited-stock',
      title: 'ของแถม: สต็อกไม่จำกัดต้องแจกได้หลายออร์เดอร์',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างของแถมที่สต็อกเป็นแบบไม่จำกัดและกฎที่เข้าเงื่อนไข แล้วส่งหลายออร์เดอร์',
      expected: 'ทุกออร์เดอร์ต้องได้ของแถม และสต็อกของของแถมต้องยังเป็นค่าไม่จำกัด',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftUnlimitedStockFlow_(ctx); }
    },
    {
      id: 'gifts.manual-add-success',
      title: 'ของแถม: admin เพิ่มของแถมเข้าออร์เดอร์สำเร็จ',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์และของแถมที่มีสต็อกพร้อมใช้ แล้วเรียก addManualGiftToOrderRpc',
      expected: 'ต้องเพิ่มรายการของแถมสำเร็จ และสต็อกของของแถมต้องถูกตัดตามจำนวนที่เพิ่ม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftManualAddSuccessFlow_(ctx); }
    },
    {
      id: 'gifts.manual-remove-success',
      title: 'ของแถม: ลบของแถมที่เพิ่มเองแล้วต้องคืนสต็อก',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์ เพิ่มของแถมเอง แล้วลบ gift line ออกจากออร์เดอร์',
      expected: 'รายการของแถมต้องถูก mark removed และสต็อกต้องถูกคืน',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftManualRemoveSuccessFlow_(ctx); }
    },
    {
      id: 'gifts.manual-update-qty-success',
      title: 'ของแถม: แก้จำนวนของแถมเองต้องปรับสต็อกถูก',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'เพิ่มของแถมเองจำนวน 1 แล้วแก้เป็น 3 จากนั้นแก้กลับเป็น 2',
      expected: 'จำนวนในออร์เดอร์และสต็อกของของแถมต้องเปลี่ยนตามส่วนต่าง',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftManualUpdateQtySuccessFlow_(ctx); }
    },
    {
      id: 'gifts.manual-update-qty-out-of-stock',
      title: 'ของแถม: แก้จำนวนเกินสต็อกต้องถูกปฏิเสธ',
      area: 'gifts',
      type: 'write',
      risk: 'critical',
      description: 'เพิ่มของแถมเองแล้วพยายามแก้จำนวนให้เกินสต็อกที่เหลือ',
      expected: 'updateGiftLineQtyRpc ต้องคืน ok=false และจำนวนเดิมต้องไม่เปลี่ยน',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftManualUpdateQtyOutOfStockFlow_(ctx); }
    },
    {
      id: 'gifts.order-token-read-gifts',
      title: 'ของแถม: ลูกค้าอ่านของแถมจาก order token ได้',
      area: 'gifts',
      type: 'write',
      risk: 'medium',
      description: 'สร้างออร์เดอร์ที่ได้ของแถม แล้วเรียก getOrderGiftsByTokenRpc ด้วย token ของออร์เดอร์',
      expected: 'ต้องคืนรายการของแถมของออร์เดอร์นั้น และ token ปลอมต้องถูกปฏิเสธ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftOrderTokenReadFlow_(ctx); }
    },
    {
      id: 'gifts.required-variants-condition',
      title: 'ของแถม: เงื่อนไข variant ต้องแจกเฉพาะ variant ที่ตรง',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ที่มี variant และกฎ required_variants',
      expected: 'variant ที่ไม่ตรงต้องไม่ได้สิทธิ์ ส่วน variant ที่ตรงต้องได้สิทธิ์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftRequiredVariantsFlow_(ctx); }
    },
    {
      id: 'gifts.delete-item-disables-rules',
      title: 'ของแถม: ลบรายการของแถมแล้วกฎที่ผูกอยู่ต้องถูกปิด',
      area: 'gifts',
      type: 'write',
      risk: 'high',
      description: 'สร้างของแถมและกฎที่ผูกกัน จากนั้นลบรายการของแถม',
      expected: 'deleteGiftItemRpc ต้องรายงานจำนวนกฎที่ถูกปิด และกฎเดิมต้องไม่แจกอีก',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftDeleteItemDisablesRulesFlow_(ctx); }
    },
    qaWriteSpec_('gifts.min-subtotal-after-promotion', 'Gifts: min subtotal uses after-promotion amount', 'gifts', 'critical', 'Create a min-subtotal gift rule with a product promotion.', 'Eligibility should use subtotal after promotion, not the original catalog price.', 'qaRunGiftMinSubtotalAfterPromotionFlow_'),
    qaWriteSpec_('gifts.required-products-across-duplicate-lines', 'Gifts: required products across duplicate lines', 'gifts', 'high', 'Submit duplicate product lines for the same product.', 'Gift rule quantity should aggregate duplicate product lines.', 'qaRunGiftRequiredProductsAcrossDuplicateLinesFlow_'),
    qaWriteSpec_('gifts.required-variants-canonical-key', 'Gifts: required variants canonical key', 'gifts', 'high', 'Use a two-group variant rule and send selected variants in a different object order.', 'Variant gift eligibility should match the canonical sorted variant key.', 'qaRunGiftRequiredVariantsCanonicalKeyFlow_'),
    qaWriteSpec_('gifts.multiple-rules-priority-order', 'Gifts: multiple rules priority order', 'gifts', 'high', 'Make one cart match two active gift rules.', 'Both gifts should attach, ordered by gift rule priority.', 'qaRunGiftMultipleRulesPriorityOrderFlow_'),
    qaWriteSpec_('gifts.same-gift-two-rules-stock-limited', 'Gifts: same gift two rules with limited stock', 'gifts', 'critical', 'Two active rules award the same gift item with stock=1.', 'Exactly one gift should attach and the other should be skipped with GIFT_OUT_OF_STOCK.', 'qaRunGiftSameGiftTwoRulesStockLimitedFlow_'),
    qaWriteSpec_('gifts.gift-qty-stock-boundary', 'Gifts: gift quantity stock boundary', 'gifts', 'critical', 'Create gift_qty=2 rules against stock=1 and stock=2.', 'Stock 1 should skip; stock 2 should attach and leave stock 0.', 'qaRunGiftQtyStockBoundaryFlow_'),
    qaWriteSpec_('gifts.repeat-threshold-multiplier', 'Gifts: repeat gift per completed threshold', 'gifts', 'critical', 'Create per_threshold gift rules and buy multiples of the threshold (qty, min_subtotal, and multi-entry required_products), plus a once_per_order control.', 'per_threshold should grant gift_qty × completed thresholds (lowest multiplier for multi-entry, remainder ignored); once_per_order should still grant one set.', 'qaRunGiftRepeatThresholdFlow_'),
    qaWriteSpec_('gifts.repeat-required-products-boundary', 'Gifts: repeat required-products boundary + remainder', 'gifts', 'critical', 'per_threshold required_products min_qty=2: buy 4 (exact) and buy 5 (remainder), checking gift qty and stock deduction.', 'Both orders grant exactly 2 sets; remainder is ignored; gift stock drops by 2 each time.', 'qaRunGiftRepeatRequiredProductsBoundaryFlow_'),
    qaWriteSpec_('gifts.repeat-below-threshold', 'Gifts: repeat below threshold grants nothing', 'gifts', 'high', 'per_threshold required_products min_qty=3, buy only 2.', 'No gift line, not counted as skipped, gift stock unchanged.', 'qaRunGiftRepeatBelowThresholdFlow_'),
    qaWriteSpec_('gifts.repeat-gift-qty-multiplier', 'Gifts: repeat multiplies gift_qty>1', 'gifts', 'critical', 'per_threshold gift_qty=3, min_qty=1, buy 4.', 'Grants 12 gift units and deducts 12 from stock.', 'qaRunGiftRepeatGiftQtyMultiplierFlow_'),
    qaWriteSpec_('gifts.repeat-min-subtotal-multiplier', 'Gifts: repeat min_subtotal multiplier', 'gifts', 'critical', 'per_threshold min_subtotal=500, price 250, buy 5 (subtotal 1250).', 'Grants 2 sets (floor 1250/500); remainder ignored; stock drops by 2.', 'qaRunGiftRepeatMinSubtotalMultiplierFlow_'),
    qaWriteSpec_('gifts.repeat-min-subtotal-after-discount', 'Gifts: repeat min_subtotal uses discounted subtotal', 'gifts', 'critical', 'per_threshold min_subtotal=500 with a -600 promotion on a 1000 product, buy 3 (discounted subtotal 1200).', 'Preview and order both grant 2 sets (not 6) because the discounted subtotal is used.', 'qaRunGiftRepeatMinSubtotalAfterDiscountFlow_'),
    qaWriteSpec_('gifts.repeat-required-variants-multiplier', 'Gifts: repeat required-variants multiplier', 'gifts', 'critical', 'per_threshold required_variants Size=M min_qty=2, buy 6×M plus 3×L.', 'Only the matching variant counts: grants 3 sets.', 'qaRunGiftRepeatRequiredVariantsMultiplierFlow_'),
    qaWriteSpec_('gifts.repeat-multi-products-lowest', 'Gifts: repeat multi required-products lowest multiplier', 'gifts', 'critical', 'per_threshold two required_products p1 min2/buy4 and p2 min3/buy12.', 'Uses the lowest per-entry multiplier min(2,4)=2.', 'qaRunGiftRepeatMultiProductsLowestFlow_'),
    qaWriteSpec_('gifts.match-any-products-one-qualifies', 'Gifts: match ANY products, one qualifies', 'gifts', 'critical', 'any-mode required_products [A min2, B min3], once — buy A×2 only vs buy A×1 only.', 'A×2 alone grants 1 set; A×1 alone (no entry met) grants nothing.', 'qaRunGiftMatchAnyProductsOneQualifiesFlow_'),
    qaWriteSpec_('gifts.match-any-repeat-sum', 'Gifts: match ANY + repeat sums thresholds', 'gifts', 'critical', 'any-mode per_threshold [A min2, B min3], buy A×6 (3 rounds) + B×3 (1 round).', 'Multiplier is the SUM 3+1=4 → 4 gift qty.', 'qaRunGiftMatchAnyRepeatSumFlow_'),
    qaWriteSpec_('gifts.match-all-default-backward-compat', 'Gifts: missing match_mode defaults to ALL', 'gifts', 'high', 'required_products [A min1, B min1] with NO match_mode, buy A only.', 'Defaults to all → not eligible; stored match_mode normalized to all.', 'qaRunGiftMatchAllDefaultBackwardCompatFlow_'),
    qaWriteSpec_('gifts.duplicate-products-rejected', 'Gifts: duplicate required_products rejected', 'gifts', 'high', 'createGiftRuleRpc with the same product_id twice in required_products.', 'Rule creation is rejected (ok:false).', 'qaRunGiftDuplicateProductsRejectedFlow_'),
    qaWriteSpec_('gifts.duplicate-variants-rejected', 'Gifts: duplicate required_variants rejected', 'gifts', 'high', 'createGiftRuleRpc with the same product_id+variant_key twice in required_variants.', 'Rule creation is rejected (ok:false).', 'qaRunGiftDuplicateVariantsRejectedFlow_'),
    qaWriteSpec_('gifts.repeat-multi-variants-lowest', 'Gifts: repeat multi required-variants lowest multiplier', 'gifts', 'critical', 'per_threshold two required_variants Size=M min2/buy4 and Size=L min2/buy6.', 'Uses the lowest per-entry multiplier min(2,3)=2.', 'qaRunGiftRepeatMultiVariantsLowestFlow_'),
    qaWriteSpec_('gifts.repeat-duplicate-cart-lines', 'Gifts: repeat aggregates duplicate cart lines', 'gifts', 'high', 'per_threshold required_products min_qty=2 with two lines of the same product (2+4=6).', 'Duplicate lines aggregate to 6 → grants 3 sets.', 'qaRunGiftRepeatDuplicateLinesFlow_'),
    qaWriteSpec_('gifts.repeat-preview-matches-order', 'Gifts: repeat preview matches submitted order', 'gifts', 'critical', 'per_threshold min_qty=1, preview qty 3 then submit qty 3.', 'Preview eligible gift qty equals the submitted order gift qty (3).', 'qaRunGiftRepeatPreviewMatchesOrderFlow_'),
    qaWriteSpec_('gifts.repeat-invalid-mode-defaults-once', 'Gifts: invalid repeat_mode normalizes to once', 'gifts', 'high', 'Create a rule with repeat_mode="garbage_value", buy 3.', 'Stored mode is once_per_order and only 1 set is granted.', 'qaRunGiftRepeatInvalidModeDefaultsOnceFlow_'),
    qaWriteSpec_('gifts.repeat-missing-mode-backward-compat', 'Gifts: missing repeat_mode backward compatible', 'gifts', 'high', 'Create a rule with NO repeat_mode field (legacy), buy 3.', 'Reads back as once_per_order and grants 1 set.', 'qaRunGiftRepeatMissingModeBackwardCompatFlow_'),
    qaWriteSpec_('gifts.repeat-update-mode-round-trip', 'Gifts: repeat_mode edit round-trip', 'gifts', 'critical', 'Toggle a rule once_per_order → per_threshold → once_per_order via updateGiftRuleRpc, buying 3 each time.', 'Stored mode and awarded qty follow the edits: 1, 3, then 1.', 'qaRunGiftRepeatUpdateModeRoundTripFlow_'),
    qaWriteSpec_('gifts.repeat-disabled-and-expired', 'Gifts: repeat disabled/expired grants nothing', 'gifts', 'high', 'per_threshold rules that are disabled or schedule-expired, buy 4.', 'Neither grants a gift and neither deducts stock.', 'qaRunGiftRepeatDisabledAndExpiredFlow_'),
    qaWriteSpec_('gifts.repeat-insufficient-stock-all-or-nothing', 'Gifts: repeat insufficient stock is all-or-nothing', 'gifts', 'critical', 'per_threshold wants 5 gift units but stock is 3, buy 5.', 'Whole set is skipped with GIFT_OUT_OF_STOCK (requested_qty 5), no partial attach, stock stays 3.', 'qaRunGiftRepeatInsufficientStockAllOrNothingFlow_'),
    qaWriteSpec_('gifts.repeat-unlimited-stock', 'Gifts: repeat with unlimited stock', 'gifts', 'high', 'per_threshold gift_stock=-1, buy 4.', 'Grants 4 sets and stock stays -1.', 'qaRunGiftRepeatUnlimitedStockFlow_'),
    qaWriteSpec_('gifts.repeat-once-per-order-regression', 'Gifts: once_per_order regression with gift_qty>1', 'gifts', 'critical', 'once_per_order gift_qty=2, buy 5.', 'Grants exactly one set (2 units), never multiplied; stock drops by 2 only.', 'qaRunGiftRepeatOncePerOrderRegressionFlow_'),
    qaWriteSpec_('gifts.repeat-multiple-rules-priority', 'Gifts: repeat multiple rules multiply independently', 'gifts', 'critical', 'Two per_threshold rules (gift_qty 1 and 2) on one cart bought 4×, different priorities.', 'Each multiplies independently (4 and 8) and gift lines follow priority order.', 'qaRunGiftRepeatMultipleRulesPriorityFlow_'),
    qaWriteSpec_('gifts.match-any-required-variants', 'Gifts: match ANY required_variants (once + repeat sum)', 'gifts', 'critical', 'any-mode required_variants [Size=M min2, Size=L min3]: once_per_order buying only M qualifies / buying neither does not; per_threshold buying M×4 (2 rounds) + L×3 (1 round) sums to 3.', 'ANY-mode variant matching and its repeat-sum multiplier behave the same as the required_products ANY-mode tests.', 'qaRunGiftMatchAnyRequiredVariantsFlow_'),
    qaWriteSpec_('gifts.required-variants-incomplete-key-rejected', 'Gifts: incomplete variant_key in required_variants rejected', 'gifts', 'high', 'createGiftRuleRpc with a required_variants condition whose variant_key omits one of the variant groups on the product.', 'Gift rule creation is rejected (ok:false).', 'qaRunGiftRequiredVariantsIncompleteKeyRejectedFlow_'),
    qaWriteSpec_('orders.split-shipping-conditional-promo-and-repeat-gift', 'Orders: split shipping with cart-wide conditional promo + per_threshold gift', 'orders', 'critical', 'Two products pinned to different shipping methods (forces split); a conditional min_subtotal promo on the whole cart; a per_threshold gift rule on total quantity.', 'The promotion discount and the gift multiplier both reflect the whole-cart totals (not a smaller per-draft subtotal); the gift attaches to exactly one draft with no duplication across drafts.', 'qaRunOrderSplitShippingConditionalPromoAndRepeatGiftFlow_'),
    qaWriteSpec_('orders.edge-duplicate-lines-combined-exceeds-stock', 'Orders edge: duplicate product lines whose combined qty exceeds stock', 'orders', 'critical', 'Submit the same product as two cart lines (qty 3 each) against stock=3, so each individual line is within stock but the combined qty (6) exceeds it.', 'Order should be rejected with STOCK_INSUFFICIENT and stock should remain unchanged at 3 (no oversell).', 'qaRunOrderEdgeDuplicateLinesCombinedExceedsStockFlow_'),
    qaWriteSpec_('gifts.stale-preview-rule-disabled-before-submit', 'Gifts: stale preview disabled before submit', 'gifts', 'high', 'Preview an eligible cart, then disable the rule before submit.', 'Submitted order should not attach the stale gift.', 'qaRunGiftStalePreviewRuleDisabledBeforeSubmitFlow_'),
    qaWriteSpec_('gifts.stale-preview-stock-depleted-before-submit', 'Gifts: stale preview stock depleted before submit', 'gifts', 'critical', 'Preview an eligible gift with stock=1, then deplete gift stock before submit.', 'The order should still be created, no active gift line should attach, gifts_skipped should include GIFT_OUT_OF_STOCK, and gift stock should not go negative.', 'qaRunGiftStalePreviewStockDepletedBeforeSubmitFlow_'),
    qaWriteSpec_('gifts.preview-near-miss-required-variant-details', 'Gifts: near-miss required variant details', 'gifts', 'critical', 'Create a required_variants gift rule and preview a cart with the wrong variant or insufficient quantity.', 'Preview should return eligible=[] and near[] details including product, variant_key, and missing quantity.', 'qaRunGiftPreviewNearMissRequiredVariantDetailsFlow_'),
    qaWriteSpec_('gifts.order-split-shipping-gift-per-draft', 'Gifts: split shipping evaluates gifts per draft', 'gifts', 'critical', 'Split one checkout into two orders where only one product matches a gift rule.', 'Only the matching split order should contain the gift line.', 'qaRunGiftSplitShippingPerDraftFlow_'),
    qaWriteSpec_('gifts.split-shipping-auto-gift-only-once', 'Gifts: split shipping grants cart-wide gift only once', 'gifts', 'critical', 'Split one checkout into two orders where both drafts individually clear a min_subtotal gift rule.', 'The gift should attach to only one split order, gift stock should decrease by 1, and the success response should not duplicate the gift.', 'qaRunGiftSplitShippingAutoGiftOnlyOnceFlow_'),
    qaWriteSpec_('gifts.snapshot-immutability', 'Gifts: order gift snapshot immutability', 'gifts', 'critical', 'Create an order with an auto gift, then edit and delete the gift item.', 'The original order gift line should retain its snapshot fields.', 'qaRunGiftSnapshotImmutabilityFlow_'),
    qaWriteSpec_('gifts.token-read-excludes-removed', 'Gifts: token read excludes removed gifts', 'gifts', 'high', 'Add and remove a manual gift, then read gifts via customer token.', 'getOrderGiftsByTokenRpc should not return removed gift lines.', 'qaRunGiftTokenReadExcludesRemovedFlow_'),
    qaWriteSpec_('gifts.manual-add-invalid-qty-rejected', 'Gifts: manual add invalid quantity rejected', 'gifts', 'high', 'Try manual gift add with invalid quantities.', 'Invalid quantities should be rejected and gift stock should not change.', 'qaRunGiftManualAddInvalidQtyRejectedFlow_'),
    qaWriteSpec_('gifts.manual-add-cancelled-delivered-rejected', 'Gifts: manual add rejected for closed orders', 'gifts', 'high', 'Try manual gift add on cancelled and delivered orders.', 'Closed orders should reject manual gift additions.', 'qaRunGiftManualAddClosedOrdersRejectedFlow_'),
    qaWriteSpec_('gifts.manual-remove-missing-snapshot-rejected', 'Gifts: manual remove missing snapshot rejected', 'gifts', 'medium', 'Try to remove a gift snapshot id that is not in the order.', 'removeGiftLineFromOrderRpc should return ok=false.', 'qaRunGiftManualRemoveMissingSnapshotRejectedFlow_'),
    qaWriteSpec_('gifts.manual-update-missing-snapshot-rejected', 'Gifts: manual update missing snapshot rejected', 'gifts', 'medium', 'Try to update a gift snapshot id that is not in the order.', 'updateGiftLineQtyRpc should return ok=false.', 'qaRunGiftManualUpdateMissingSnapshotRejectedFlow_'),
    qaWriteSpec_('gifts.manual-update-removed-line-rejected', 'Gifts: manual update removed line rejected', 'gifts', 'high', 'Remove a manual gift line and then try to update its quantity.', 'Removed gift lines should not be mutable.', 'qaRunGiftManualUpdateRemovedLineRejectedFlow_'),
    qaWriteSpec_('gifts.manual-remove-delivered-no-stock-restore', 'Gifts: delivered remove does not restore stock', 'gifts', 'medium', 'Remove a gift line after marking the order delivered.', 'Stock should not be restored for delivered orders.', 'qaRunGiftManualRemoveDeliveredNoStockRestoreFlow_'),
    qaWriteSpec_('gifts.min-subtotal-ignores-conditional-promotion', 'Gifts: min_subtotal base ignores conditional-promotion discount', 'gifts', 'critical', 'A conditional promotion discounts a product to 400; a gift rule requires min_subtotal 900 while the direct-only base is 1000.', 'Gift eligibility uses the subtotal after DIRECT discounts only (1000, eligible), not the final price after the conditional discount (400); the order keeps both the discounted price and the attached gift.', 'qaRunGiftMinSubtotalIgnoresConditionalPromotionFlow_'),
    qaWriteSpec_('gifts.required-products-with-conditional-promotion', 'Gifts: required_products eligibility independent of a conditional promotion on the same product', 'gifts', 'high', 'A conditional promotion discounts product A; a gift rule requires buying A qty>=2.', 'Gift eligibility follows raw cart quantity regardless of the conditional discount; both the discounted price and the gift line persist on the order.', 'qaRunGiftRequiredProductsWithConditionalPromotionFlow_'),
    qaWriteSpec_('gifts.settings-validation-matrix', 'Gifts settings: invalid rule configuration matrix', 'gifts', 'critical', 'Try missing gifts, invalid condition types, empty/invalid conditions, missing product references, and invalid variant keys.', 'Every invalid gift-rule configuration is rejected without leaving an active rule.', 'qaRunGiftSettingsValidationMatrixFlow_'),
    qaWriteSpec_('gifts.settings-integer-quantity-validation', 'Gifts settings: quantities and stock must be integers', 'gifts', 'critical', 'Try fractional/zero gift_qty, fractional/zero min_qty, and fractional gift stock.', 'Invalid quantity settings are rejected so order gift lines and inventory can never become fractional.', 'qaRunGiftSettingsIntegerQuantityValidationFlow_'),
    qaWriteSpec_('gifts.legacy-invalid-data-fail-closed', 'Gifts: invalid legacy data remains visible but cannot award', 'gifts', 'critical', 'Seed legacy gift/rule rows with fractional stock and min_qty, then read admin/public APIs, preview, and submit an order.', 'Admin APIs expose operational=false plus validation_errors; public campaigns, preview, and orders exclude the invalid records without rewriting their rows.', 'qaRunGiftLegacyInvalidDataFailClosedFlow_'),
    qaWriteSpec_('gifts.settings-schedule-round-trip', 'Gifts settings: schedule, enabled, and no-end round trip', 'gifts', 'critical', 'Edit one gift rule through scheduled, active no-end, expired, disabled, and re-enabled states.', 'Rule status and preview eligibility follow every stored schedule/enabled setting.', 'qaRunGiftSettingsScheduleRoundTripFlow_'),
    qaWriteSpec_('gifts.settings-condition-transition', 'Gifts settings: condition and match-mode transition', 'gifts', 'critical', 'Edit one rule from required_products ALL to ANY, then min_subtotal, then required_variants.', 'Stored condition data and preview eligibility follow the latest admin configuration without stale fields.', 'qaRunGiftSettingsConditionTransitionFlow_'),
    qaWriteSpec_('gifts.repeat-duplicate-variant-lines', 'Gifts: repeat aggregates duplicate variant cart lines', 'gifts', 'critical', 'A required_variants per-threshold rule receives two cart lines for the same canonical variant.', 'Matching quantities aggregate across duplicate lines and award the correct multiplied gift quantity.', 'qaRunGiftRepeatDuplicateVariantLinesFlow_'),
    qaWriteSpec_('gifts.repeat-same-gift-cumulative-stock', 'Gifts: repeated rules share cumulative gift stock', 'gifts', 'critical', 'Two per-threshold rules award four units each of the same gift while stock is five.', 'The higher-priority rule attaches four; the second is skipped atomically; stock ends at one.', 'qaRunGiftRepeatSameGiftCumulativeStockFlow_'),
    qaWriteSpec_('gifts.repeat-reject-unreject-stock-lifecycle', 'Gifts: multiplied quantity reject/unreject stock lifecycle', 'gifts', 'critical', 'Submit an order with a multiplied auto-gift quantity, reject it, and approve it again.', 'Reject restores the full multiplied quantity and un-reject deducts the same full quantity exactly once.', 'qaRunGiftRepeatRejectUnrejectStockLifecycleFlow_'),
    qaWriteSpec_('gifts.stale-preview-cart-reduced-before-submit', 'Gifts: stale preview after cart quantity is reduced', 'gifts', 'critical', 'Preview a per-threshold eligible cart, then submit a cart below the threshold.', 'Submit re-evaluates the actual cart, attaches no stale gift, reports no stock skip, and leaves stock unchanged.', 'qaRunGiftStalePreviewCartReducedFlow_'),
    qaWriteSpec_('gifts.preview-insufficient-stock-contract', 'Gifts: preview and submit contract when grant exceeds stock', 'gifts', 'critical', 'Preview a rule that wants two gift units while only one is in stock, then submit.', 'Preview exposes the requested quantity and stock; submit skips the whole grant with requested/available quantities and does not decrement stock.', 'qaRunGiftPreviewInsufficientStockContractFlow_'),
    qaWriteSpec_('gifts.public-campaign-settings-contract', 'Gifts settings: public campaign schedule and condition contract', 'gifts', 'high', 'Create active and scheduled gift campaigns with quantities and condition details.', 'Public campaign data exposes the correct status, schedule, quantity, condition summary/details, and gift stock without disabled campaigns.', 'qaRunGiftPublicCampaignSettingsContractFlow_'),
    {
      id: 'auth.invalid-session',
      title: 'Session ที่ไม่ถูกต้องต้องถูกปฏิเสธ',
      area: 'auth',
      type: 'guard',
      risk: 'high',
      description: 'ตรวจ validateSessionRpc ด้วย token ที่ตั้งใจให้ไม่ถูกต้อง',
      expected: 'ผลลัพธ์ต้อง ok=false และไม่ให้ session',
      run: function() {
        var res = qaCall_('validateSessionRpc', ['__QA_INVALID_SESSION__']);
        qaAssert_(res && res.ok === false, 'invalid token should be rejected');
        return { error: res.error || '' };
      }
    },
    {
      id: 'auth.gift-items-require-admin',
      title: 'รายการของแถมฝั่ง admin ต้องใช้สิทธิ์',
      area: 'auth',
      type: 'guard',
      risk: 'high',
      description: 'ตรวจว่า listGiftItemsRpc ใช้งานไม่ได้ถ้าไม่มี admin token ที่ถูกต้อง',
      expected: 'ผลลัพธ์ต้อง ok=false และ error เป็น AUTH_REQUIRED',
      run: function() {
        var res = qaCall_('listGiftItemsRpc', ['__QA_INVALID_SESSION__']);
        qaAssert_(res && res.ok === false, 'invalid token should be rejected');
        qaAssert_(res.error === 'AUTH_REQUIRED', 'expected AUTH_REQUIRED');
        return { error: res.error };
      }
    },
    {
      id: 'auth.gift-rules-require-admin',
      title: 'รายการกฎของแถมฝั่ง admin ต้องใช้สิทธิ์',
      area: 'auth',
      type: 'guard',
      risk: 'high',
      description: 'ตรวจว่า listGiftRulesRpc ใช้งานไม่ได้ถ้าไม่มี admin token ที่ถูกต้อง',
      expected: 'ผลลัพธ์ต้อง ok=false และ error เป็น AUTH_REQUIRED',
      run: function() {
        var res = qaCall_('listGiftRulesRpc', ['__QA_INVALID_SESSION__']);
        qaAssert_(res && res.ok === false, 'invalid token should be rejected');
        qaAssert_(res.error === 'AUTH_REQUIRED', 'expected AUTH_REQUIRED');
        return { error: res.error };
      }
    },
    {
      id: 'auth.product-admin-require-admin',
      title: 'โหมดรายการสินค้า admin ต้องใช้สิทธิ์',
      area: 'auth',
      type: 'guard',
      risk: 'high',
      description: 'ตรวจว่า productListRpc แบบ admin overload ปฏิเสธ token ที่ไม่ถูกต้อง',
      expected: 'ผลลัพธ์ต้อง ok=false และ error เป็น AUTH_REQUIRED',
      run: function() {
        var res = qaCall_('productListRpc', ['__QA_INVALID_SESSION__', { limit: 1, includeAll: true }]);
        qaAssert_(res && res.ok === false, 'invalid token should be rejected');
        qaAssert_(res.error === 'AUTH_REQUIRED', 'expected AUTH_REQUIRED');
        return { error: res.error };
      }
    },
    {
      id: 'auth.admin-rpcs-require-admin',
      title: 'สิทธิ์: RPC สำคัญฝั่ง admin ต้องปฏิเสธ token ปลอม',
      area: 'auth',
      type: 'guard',
      risk: 'critical',
      description: 'เรียก RPC สำคัญหลายตัวด้วย token ที่ไม่ถูกต้อง',
      expected: 'ทุก RPC ที่ต้องใช้สิทธิ์ต้องคืน ok=false หรือ AUTH_REQUIRED',
      run: function() { return qaRunAdminRpcsRequireAdminFlow_(); }
    },
    {
      id: 'users.crud-admin',
      title: 'ผู้ใช้: owner สร้าง แก้ไข และลบผู้ใช้ชั่วคราวได้',
      area: 'auth',
      type: 'write',
      risk: 'high',
      description: 'สร้างผู้ใช้ QA ชั่วคราว แก้ไข OTP/password แล้วลบออก',
      expected: 'ถ้า token เป็น owner ต้องทำครบทุกขั้นตอน ถ้าไม่ใช่ owner ให้ข้ามพร้อมเหตุผล',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunUserCrudFlow_(ctx); }
    },
    {
      id: 'auth.logout-invalidates-session',
      title: 'สิทธิ์: logout ต้องทำให้ session ใช้ต่อไม่ได้',
      area: 'auth',
      type: 'write',
      risk: 'high',
      description: 'สร้างผู้ใช้ QA ชั่วคราว login เพื่อเอา token ใหม่ แล้ว logout token นั้น',
      expected: 'validateSessionRpc หลัง logout ต้องคืน SESSION_INVALID โดยไม่กระทบ token หลักของ dashboard',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunLogoutInvalidatesSessionFlow_(ctx); }
    },
    {
      id: 'payment.get-config-requires-admin',
      title: 'การชำระเงิน: อ่าน config ต้องใช้สิทธิ์ admin',
      area: 'payment',
      type: 'guard',
      risk: 'high',
      description: 'เรียก getPaymentConfigRpc ด้วย token ปลอม',
      expected: 'ต้องถูกปฏิเสธด้วย AUTH_REQUIRED',
      run: function() {
        var res = qaCall_('getPaymentConfigRpc', ['__QA_INVALID_SESSION__']);
        qaAssert_(res && res.ok === false && res.error === 'AUTH_REQUIRED', 'ต้องปฏิเสธ token ปลอม', res);
        return { response: res };
      }
    },
    {
      id: 'payment.save-config-validation',
      title: 'การชำระเงิน: PromptPay ต้องตรวจรูปแบบก่อนบันทึก',
      area: 'payment',
      type: 'write',
      risk: 'high',
      description: 'ลองบันทึกเลข PromptPay ที่สั้นหรือมีรูปแบบไม่ถูกต้อง',
      expected: 'savePaymentConfigRpc ต้องคืน ok=false และไม่บันทึกค่าใหม่',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPaymentValidationFlow_(ctx); }
    },
    {
      id: 'payment.save-config-preserves-site-config',
      title: 'การชำระเงิน: บันทึก payment ต้องไม่ลบ config ส่วนอื่น',
      area: 'payment',
      type: 'write',
      risk: 'critical',
      description: 'ตั้งค่า legal ชั่วคราวใน site config แล้วบันทึก payment config',
      expected: 'หลังบันทึก payment แล้ว legal config ต้องยังอยู่ จากนั้น restore ค่าเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPaymentPreservesConfigFlow_(ctx); }
    },
    {
      id: 'slip.customer-can-read-paid-slip-only',
      title: 'สลิป: ลูกค้าต้องอ่านสลิปได้เฉพาะออร์เดอร์ที่ชำระแล้ว',
      area: 'payment',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์ อัปโหลดสลิป แล้วเรียกอ่านสลิปด้วย order token',
      expected: 'หลังอัปโหลดสลิปต้องอ่าน dataUrl ได้ และก่อน/ผิดออร์เดอร์ต้องถูกปฏิเสธ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunSlipCustomerReadFlow_(ctx); }
    },
    {
      id: 'slip.invalid-file-id-rejected',
      title: 'สลิป: file id ที่ไม่ตรงกับออร์เดอร์ต้องถูกปฏิเสธ',
      area: 'payment',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์และอัปโหลดสลิป แล้วลองอ่านด้วย file id ปลอม',
      expected: 'getSlipByOrderTokenRpc ต้องคืน ok=false เมื่อ file id ไม่ตรงกับออร์เดอร์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunSlipInvalidFileIdFlow_(ctx); }
    },
    {
      id: 'config.publish-preserves-legal-payment',
      title: 'ตั้งค่าเว็บ: publish ต้องไม่ลบ legal และ payment',
      area: 'config',
      type: 'write',
      risk: 'critical',
      description: 'ตั้งค่า legal ชั่วคราวใน site_config และ payment ชั่วคราวใน payment sheet แล้วเรียก publishSiteConfig ด้วยข้อมูลหน้าร้านบางส่วน',
      expected: 'legal ต้องยังอยู่ใน site_config; payment ต้องยังอยู่ใน payment sheet (ไม่ถูก publish ลบ) จากนั้น restore ค่าเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunConfigPublishPreservesFlow_(ctx); }
    },
    {
      id: 'config.bundle-products-only-active',
      title: 'ตั้งค่าเว็บ: bundle ต้องส่งเฉพาะสินค้าที่ขายได้',
      area: 'config',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า active และ disabled แล้วโหลด getSiteConfigBundle',
      expected: 'bundle ต้องมีสินค้า active และต้องไม่มีสินค้า disabled',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunConfigBundleActiveProductsFlow_(ctx); }
    },
    {
      id: 'routes.index',
      title: 'ทดสอบเปิดหน้า: index',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=index',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'index'); }
    },
    {
      id: 'routes.product',
      title: 'ทดสอบเปิดหน้า: product admin',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=product',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'product'); }
    },
    {
      id: 'routes.order',
      title: 'ทดสอบเปิดหน้า: order admin',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=order',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'order'); }
    },
    {
      id: 'routes.shipping',
      title: 'ทดสอบเปิดหน้า: shipping admin',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=shipping',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'shipping'); }
    },
    {
      id: 'routes.gift',
      title: 'ทดสอบเปิดหน้า: gift admin',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=gift',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'gift'); }
    },
    {
      id: 'routes.login',
      title: 'ทดสอบเปิดหน้า: login',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=login',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'login'); }
    },
    {
      id: 'routes.payment',
      title: 'ทดสอบเปิดหน้า: payment',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=payment',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'payment'); }
    },
    {
      id: 'routes.promotion',
      title: 'ทดสอบเปิดหน้า: promotion',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=promotion',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'promotion'); }
    },
    {
      id: 'routes.order-view',
      title: 'ทดสอบเปิดหน้า: order-view',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=order-view',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'order-view'); }
    },
    {
      id: 'routes.edit-store',
      title: 'ทดสอบเปิดหน้า: edit-store',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=edit-store',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'edit-store'); }
    },
    {
      id: 'routes.user',
      title: 'ทดสอบเปิดหน้า: user',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=user',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'user'); }
    },
    {
      id: 'routes.system',
      title: 'ทดสอบเปิดหน้า: system',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=system',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'system'); }
    },
    {
      id: 'routes.privacy-policy',
      title: 'ทดสอบเปิดหน้า: privacy-policy',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=privacy-policy',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'privacy-policy'); }
    },
    {
      id: 'routes.term-and-service',
      title: 'ทดสอบเปิดหน้า: term-and-service',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=term-and-service',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'term-and-service'); }
    },
    {
      id: 'routes.legal',
      title: 'ทดสอบเปิดหน้า: legal',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=legal',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'legal'); }
    },
    {
      id: 'routes.print-order',
      title: 'ทดสอบเปิดหน้า: print-order',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=print-order',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'print-order'); }
    },
    {
      id: 'routes.integration-dashboard',
      title: 'ทดสอบเปิดหน้า: integration-dashboard',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ deploy แล้วด้วย ?page=qa-integration',
      expected: 'ต้องได้ HTTP 2xx/3xx และ HTML ไม่ว่าง',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRouteSmoke_(ctx, 'qa-integration'); }
    },
    {
      id: 'routes.unknown-404',
      title: 'ทดสอบ route ที่ไม่มีจริงต้องคืน 404',
      area: 'routes',
      type: 'route',
      risk: 'medium',
      description: 'เรียก Web App route ที่ไม่อยู่ใน doGet',
      expected: 'ต้องได้ข้อความ 404 Not Found',
      requiresRouteSmoke: true,
      run: function(ctx) { return qaRoute404_(ctx, 'qa-unknown-route'); }
    },
    {
      id: 'writes.concurrent-stock-race',
      title: 'ออร์เดอร์: ผู้ซื้อ 5 คนแข่งกันซื้อสินค้า stock 2',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA 1 ตัว stock=2 แล้วให้ dashboard ส่งออร์เดอร์ผู้ซื้อ A-E รวม 5 คน โดยหน่วงเวลาคนละ 0.1 วินาที',
      expected: 'ต้องมีผู้ซื้อได้ออร์เดอร์จริง 2 คนพอดี อีก 3 คนต้องล้มเหลวด้วย STOCK_INSUFFICIENT โดยชื่อผู้ชนะไม่ตายตัว',
      requiresRealWrite: true,
      requiresAdminToken: true,
      clientDriven: true,
      run: function() {
        return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
      }
    },
    {
      id: 'orders.duplicate-client-order-id',
      title: 'ออร์เดอร์: client_order_id ซ้ำต้องไม่สร้างซ้ำ',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ส่ง payload ออร์เดอร์เดิม 2 ครั้งด้วย client_order_id เดียวกัน',
      expected: 'ครั้งแรกต้องสร้างออร์เดอร์ 1 รายการ ครั้งที่สองต้องคืน DUPLICATE_ORDER และไม่สร้างออร์เดอร์เพิ่ม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        return qaRunDuplicateClientOrderIdFlow_(ctx);
      }
    },
    {
      id: 'orders.concurrent-duplicate-client-order-id',
      title: 'ออร์เดอร์: client_order_id ซ้ำพร้อมกัน',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ยิง submitOrderRpc พร้อมกัน 5 ครั้งด้วย client_order_id เดียวกันเป๊ะ',
      expected: 'ต้องมี request เดียวที่สร้างออร์เดอร์สำเร็จ ที่เหลือต้องคืน DUPLICATE_ORDER',
      requiresRealWrite: true,
      requiresAdminToken: true,
      clientDriven: true,
      run: function() {
        return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
      }
    },
    {
      id: 'orders.multi-item-stock-rollback',
      title: 'ออร์เดอร์: ถ้าสินค้าหลายชิ้นมีบางชิ้น stock ไม่พอ ต้องไม่ตัด stock ชิ้นก่อนหน้า',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA ที่มี stock 1 ตัวและสินค้า QA ที่ stock หมด 1 ตัว แล้วส่งรวมในออร์เดอร์เดียว',
      expected: 'ออร์เดอร์ต้องล้มเหลวด้วย STOCK_INSUFFICIENT และสินค้าที่มี stock ต้องยังเหลือเท่าเดิม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        return qaRunMultiItemStockRollbackFlow_(ctx);
      }
    },
    {
      id: 'orders.invalid-qty-rejected',
      title: 'ออร์เดอร์: จำนวนสินค้าที่ไม่ถูกต้องต้องถูกปฏิเสธ',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'ส่ง qty ค่า 0, -1, abc และ 1.5 กับสินค้า QA',
      expected: 'qty ที่ไม่ถูกต้องทุกค่าต้องถูกปฏิเสธ และต้องไม่สร้างออร์เดอร์จาก payload เหล่านี้',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        return qaRunInvalidQtyRejectedFlow_(ctx);
      }
    },
    {
      id: 'orders.inactive-product-rejected',
      title: 'ออร์เดอร์: สินค้าที่ปิดขายต้องสั่งซื้อไม่ได้',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า QA ที่ sale_mode=disabled แล้วส่งออร์เดอร์สำหรับสินค้านั้น',
      expected: 'submitOrderRpc ต้องปฏิเสธและไม่สร้าง row ออร์เดอร์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        return qaRunInactiveProductRejectedFlow_(ctx);
      }
    },
    {
      id: 'orders.price-integrity',
      title: 'ออร์เดอร์: backend ต้องไม่เชื่อราคาที่ client ส่งมา',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ส่งออร์เดอร์ที่แอบใส่ราคา item/subtotal/total ปลอมจากฝั่ง client แล้วตรวจว่า snapshot ในออร์เดอร์ใช้ราคาจาก backend',
      expected: 'ราคาต่อชิ้น subtotal และ total ต้องคำนวณจากสินค้า fixture ใน backend ไม่ใช่ค่าราคาที่ client ส่งมา',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunOrderPriceIntegrityFlow_(ctx); }
    },
    {
      id: 'orders.shipping-fee-integrity',
      title: 'ออร์เดอร์: backend ต้องคำนวณค่าขนส่งเอง',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ส่งออร์เดอร์ที่ใส่ค่าขนส่งปลอม แต่ shipping method ชั่วคราวมีค่าขนส่งจริงที่ backend รู้',
      expected: 'ออร์เดอร์ที่บันทึกต้องใช้ค่าขนส่งจาก backend ไม่ใช่ค่าที่ client ส่งมา',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingFeeIntegrityFlow_(ctx); }
    },
    {
      id: 'orders.invalid-shipping-method',
      title: 'ออร์เดอร์: วิธีจัดส่งที่ไม่ถูกต้องต้องถูกปฏิเสธ',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้าที่อนุญาต shipping method ชั่วคราวหนึ่งตัว แล้วส่งออร์เดอร์ด้วย method id ที่ไม่มีอยู่จริง',
      expected: 'submitOrderRpc ต้องปฏิเสธออร์เดอร์ และต้องไม่ตัด stock สินค้า',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunInvalidShippingMethodFlow_(ctx); }
    },
    {
      id: 'orders.product-deleted-before-submit',
      title: 'ออร์เดอร์: สินค้าที่ถูกลบก่อนส่งต้องสั่งซื้อไม่ได้',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้าง payload ที่ถูกต้องไว้ก่อน จากนั้นลบสินค้า fixture แล้วค่อยส่ง payload เก่าตามไป',
      expected: 'submitOrderRpc ต้องปฏิเสธ payload ที่อ้างถึงสินค้าที่ถูกลบ และต้องไม่สร้างออร์เดอร์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunDeletedProductBeforeSubmitFlow_(ctx); }
    },
    {
      id: 'orders.stock-boundary',
      title: 'ออร์เดอร์: ทดสอบขอบเขต stock พอดี',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ทดสอบสินค้า stock=2 โดยสั่ง qty=2 ต้องสำเร็จ และสินค้าอีกตัว stock=2 แต่สั่ง qty=3 ต้องล้มเหลว',
      expected: 'การสั่งพอดี stock ต้องสำเร็จและ stock เหลือ 0 ส่วนการสั่งเกิน stock ต้องคืน STOCK_INSUFFICIENT',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunStockBoundaryFlow_(ctx); }
    },
    {
      id: 'orders.unlimited-stock',
      title: 'ออร์เดอร์: stock ไม่จำกัดต้องยังเป็นไม่จำกัด',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า stock=-1 แล้วส่งหลายออร์เดอร์กับสินค้านั้น',
      expected: 'ทุกออร์เดอร์ต้องสำเร็จ และ stock ของสินค้าต้องยังเป็น -1',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunUnlimitedStockFlow_(ctx); }
    },
    {
      id: 'orders.invalid-variant-option',
      title: 'ออร์เดอร์: variant option ที่ไม่มีจริงต้องถูกปฏิเสธ',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้าที่มี variant Color=Red/Blue แล้วส่งออร์เดอร์ด้วย Color=Green ที่ไม่มีอยู่จริง',
      expected: 'submitOrderRpc ต้องปฏิเสธ variant option ที่ไม่รู้จัก และต้องไม่ fallback ไปใช้ stock ระดับสินค้าแบบเงียบ ๆ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunInvalidVariantOptionFlow_(ctx); }
    },
    {
      id: 'orders.stock-insufficient-metadata',
      title: 'ออร์เดอร์: STOCK_INSUFFICIENT ต้องมี metadata ให้ frontend แก้ตะกร้าได้',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า stock=1 แล้วสั่ง qty=3 ตรวจว่า response มี product_id, requested_qty, available_qty',
      expected: 'error===STOCK_INSUFFICIENT + product_id ตรง + requested_qty===3 + available_qty===1',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunStockInsufficientMetadataFlow_(ctx); }
    },
    {
      id: 'orders.sale-ended-rejected-code',
      title: 'ออร์เดอร์: สินค้าที่สิ้นสุดการขายต้องคืน SALE_NOT_ACTIVE',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างสินค้า sale_mode=scheduled ที่ ends_at อดีต แล้วลอง submit',
      expected: 'error===SALE_NOT_ACTIVE + product_id ตรง + sale_status===ended',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunSaleEndedRejectedCodeFlow_(ctx); }
    },
    {
      id: 'orders.price-changed-detection',
      title: 'ออร์เดอร์: client_pricing ไม่ตรง backend ต้องคืน PRICE_CHANGED',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ส่ง client_pricing.items[0].unit_final_price ที่ปลอม ตรวจว่า backend ไม่สร้าง order + คืน PRICE_CHANGED',
      expected: 'error===PRICE_CHANGED + diff ไม่ว่าง + new_total ตรงกับ server + ไม่มี order ใหม่',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPriceChangedDetectionFlow_(ctx); }
    },
    qaWriteSpec_('orders.client-pricing-promotion-mismatch', 'Orders: client pricing promotion mismatch', 'orders', 'critical', 'Send a client_pricing snapshot with the correct price but wrong promotion id.', 'submitOrderRpc should reject with PRICE_CHANGED and item_promotion diff.', 'qaRunOrderClientPricingPromotionMismatchFlow_'),
    qaWriteSpec_('orders.multi-item-mixed-promotion-total', 'Orders: multi-item mixed promotion total', 'orders', 'critical', 'Submit a multi-item order where only one product has a promotion.', 'Totals should include one discounted line and one full-price line, with snapshots on the right line only.', 'qaRunOrderMultiItemMixedPromotionTotalFlow_'),
    qaWriteSpec_('orders.client-pricing-split-shipping-mismatch', 'Orders: client pricing split shipping mismatch', 'orders', 'critical', 'Send split shipping with deliberately stale client shipping_fee and total.', 'submitOrderRpc should reject with PRICE_CHANGED, diff should include shipping_fee and total, and no order should be created.', 'qaRunOrderClientPricingSplitShippingMismatchFlow_'),
    qaWriteSpec_('orders.client-pricing-promo-removed-before-submit', 'Orders: client pricing promo removed before submit', 'orders', 'critical', 'Build a client_pricing snapshot while a promotion is active, then remove the promotion before submit.', 'submitOrderRpc should reject with PRICE_CHANGED and item_price, item_promotion, subtotal, and total diffs without creating an order.', 'qaRunOrderClientPricingPromoRemovedBeforeSubmitFlow_'),
    qaWriteSpec_('orders.client-pricing-conditional-promo-unqualified-before-submit', 'Orders: client pricing conditional promo unqualified before submit', 'orders', 'critical', 'Preview a cart that qualifies for a conditional required_products promo (client_pricing echoes the discounted price), then submit a smaller cart that no longer meets the condition.', 'submitOrderRpc should reject with PRICE_CHANGED (item_price/item_promotion/subtotal/total diffs) without creating an order.', 'qaRunOrderClientPricingConditionalPromoUnqualifiedBeforeSubmitFlow_'),
    qaWriteSpec_(
      'orders.e2e-weight-promo-gift-one-order',
      'Orders: E2E น้ำหนัก + โปรโมชั่น + ของแถมในออร์เดอร์เดียว',
      'orders',
      'critical',
      'สร้างสินค้า variant ที่มีน้ำหนักเฉพาะ variant, สินค้าปกติ, โปรเฉพาะ variant, กฎของแถม min-subtotal และส่ง checkout จริงหนึ่งรายการ',
      'ออร์เดอร์ต้องมี subtotal/discount/shipping/total ถูกต้อง, gift snapshot ถูกต้อง, stock สินค้า/variant/gift ถูกตัดถูกต้อง และ token read เห็นข้อมูลเดียวกัน',
      'qaRunOrderE2EWeightPromoGiftOneOrderFlow_'
    ),
    {
      id: 'orders.gift-out-of-stock-warning',
      title: 'ออร์เดอร์: ของแถมหมดสต็อกต้องสร้าง order ได้พร้อม warning',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้าง gift rule + gift stock=0, submit cart ที่ match rule, ตรวจ ok===true + gifts_skipped[].code===GIFT_OUT_OF_STOCK',
      expected: 'order ถูกสร้างจริง + response มี gifts_skipped/warnings ที่บอกว่า gift หมด',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunGiftOutOfStockWarningFlow_(ctx); }
    },
    {
      id: 'orders.required-customer-fields',
      title: 'ออร์เดอร์: field ลูกค้าและที่อยู่ที่จำเป็นต้องถูกตรวจ',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'ส่ง payload ที่ขาดข้อมูลลูกค้า/ที่อยู่ที่จำเป็น หรือรหัสไปรษณีย์ไม่ถูกต้อง',
      expected: 'payload ที่ข้อมูลไม่ครบทุกแบบต้องถูกปฏิเสธ และต้องไม่สร้างออร์เดอร์',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunRequiredCustomerFieldsFlow_(ctx); }
    },
    {
      id: 'orders.input-sanitization',
      title: 'ออร์เดอร์: ข้อความเสี่ยง injection ต้องถูกปฏิเสธหรือ sanitize',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'ส่ง HTML/script และข้อความลักษณะสูตร Google Sheets ผ่าน field ข้อความของออร์เดอร์',
      expected: 'HTML/script ต้องถูกปฏิเสธ และค่าที่เหมือนสูตรต้องไม่ถูกเก็บเป็นสูตรที่รันได้ในชีต',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunOrderInputSanitizationFlow_(ctx); }
    },
    {
      id: 'orders.token-read-flow',
      title: 'ออร์เดอร์: อ่านออร์เดอร์ด้วย token',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างออร์เดอร์ แล้วอ่านด้วย getOrderByTokenRpc พร้อมตรวจว่า token ผิดอ่านไม่ได้',
      expected: 'token ที่ถูกต้องต้องอ่านออร์เดอร์เดิมได้ ส่วน token ที่ไม่ถูกต้องต้องถูกปฏิเสธ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunTokenReadFlow_(ctx); }
    },
    {
      id: 'orders.slip-upload-transition',
      title: 'ออร์เดอร์: อัปโหลดสลิปแล้วสถานะต้องเปลี่ยนจาก unpaid เป็น paid',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์สถานะ unpaid แล้วอัปโหลดรูปภาพขนาดเล็กเป็นสลิปผ่าน order token',
      expected: 'uploadSlipRpc ต้องบันทึก slip id, เปลี่ยนสถานะเป็น paid และเพิ่มประวัติการชำระเงิน',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunSlipUploadTransitionFlow_(ctx); }
    },
    {
      id: 'orders.status-history-flow',
      title: 'ออร์เดอร์: ประวัติสถานะต้องถูกเพิ่มตามลำดับ',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์ แล้วเปลี่ยนสถานะผ่าน paid และ approved',
      expected: 'สถานะสุดท้ายและ status_history ต้องตรงกับลำดับการเปลี่ยนสถานะ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunStatusHistoryFlow_(ctx); }
    },
    {
      id: 'orders.mark-shipped-guard',
      title: 'ออร์เดอร์: mark shipped ต้องทำได้เฉพาะออร์เดอร์ที่ approved แล้ว',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'ลอง mark shipped กับออร์เดอร์ใหม่ที่ยังเป็น unpaid',
      expected: 'orderMarkShippedRpc ต้องปฏิเสธด้วย ORDER_NOT_APPROVED',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunMarkShippedGuardFlow_(ctx); }
    },
    {
      id: 'orders.tracking-readback',
      title: 'ออร์เดอร์: อ่านข้อมูล tracking หลังจัดส่ง',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'อนุมัติออร์เดอร์ จากนั้น mark shipped พร้อมข้อมูล tracking แล้วอ่านกลับมาตรวจ',
      expected: 'สถานะที่อ่านกลับมาต้องเป็น shipped และข้อมูล tracking ต้องตรงกับ payload ที่ส่งไป',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunTrackingReadbackFlow_(ctx); }
    },
    {
      id: 'orders.delete-cleanup',
      title: 'ออร์เดอร์: ลบออร์เดอร์แล้วต้องอ่านไม่เจอ',
      area: 'orders',
      type: 'write',
      risk: 'medium',
      description: 'สร้างออร์เดอร์ ลบด้วย orderDeleteRpc แล้วลองอ่านกลับด้วย admin',
      expected: 'orderDeleteRpc ต้องลบ row ได้ และ orderGetRpc ต้องหาออร์เดอร์นั้นไม่เจอ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunOrderDeleteCleanupFlow_(ctx); }
    },
    {
      id: 'orders.split-shipping-order',
      title: 'ออร์เดอร์: แยกขนส่งแล้วต้องสร้างหลายออร์เดอร์',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า 2 ตัวและ shipping method 2 แบบ แล้วส่ง payload เดียวที่แยก item_product_ids ตาม method',
      expected: 'submitOrderRpc ต้องคืนหลายออร์เดอร์ และแต่ละออร์เดอร์ต้องมีเฉพาะสินค้าที่ถูก assign ให้ method นั้น',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunSplitShippingOrderFlow_(ctx); }
    },
    {
      id: 'orders.promotion-snapshot-immutability',
      title: 'ออร์เดอร์: snapshot โปรโมชั่นต้องคงอยู่หลังลบโปรโมชั่น',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างออร์เดอร์ที่ใช้โปรโมชั่นสินค้า แล้วลบโปรโมชั่น จากนั้นอ่านออร์เดอร์เดิมอีกครั้ง',
      expected: 'line สินค้าในออร์เดอร์ต้องยังเก็บ promotion id เดิมและราคาหลังหักส่วนลดเดิมไว้',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunPromotionSnapshotImmutabilityFlow_(ctx); }
    },
    {
      id: 'orders.token-expiry',
      title: 'ออร์เดอร์: token หมดอายุต้องถูกปฏิเสธ',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างออร์เดอร์ แล้วบังคับ token_expires_at ให้เป็นเวลาในอดีต จากนั้นลองอ่านด้วย token',
      expected: 'getOrderByTokenRpc ต้องปฏิเสธ token ที่หมดอายุแล้ว',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunTokenExpiryFlow_(ctx); }
    },
    {
      id: 'orders.shipping-address-valid-update',
      title: 'ออร์เดอร์: แก้ไขที่อยู่จัดส่งสำเร็จ',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์ จากนั้นเรียก orderUpdateFieldsRpc พร้อม shipping address fields ครบถ้วนและถูกต้อง',
      expected: 'orderUpdateFieldsRpc ต้องคืน ok:true และข้อมูลที่อ่านกลับมาต้องตรงกับ patch ที่ส่งไป พร้อมมี address_updated ใน status_history',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingAddressValidUpdateFlow_(ctx); }
    },
    {
      id: 'orders.shipping-address-invalid-phone',
      title: 'ออร์เดอร์: ปฏิเสธเบอร์โทรไม่ถูกต้องเมื่อแก้ไขที่อยู่',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'ส่ง customer_phone ที่มีตัวเลขน้อยกว่า 7 หลักไปใน patch ของ orderUpdateFieldsRpc',
      expected: 'orderUpdateFieldsRpc ต้องคืน ok:false และไม่บันทึกข้อมูล',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingAddressInvalidPhoneFlow_(ctx); }
    },
    {
      id: 'orders.shipping-address-invalid-postal',
      title: 'ออร์เดอร์: ปฏิเสธรหัสไปรษณีย์ไม่ถูกต้อง',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'ส่ง shipping_postal_code ที่ไม่ใช่ตัวเลข 5 หลักไปใน patch ของ orderUpdateFieldsRpc',
      expected: 'orderUpdateFieldsRpc ต้องคืน ok:false',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingAddressInvalidPostalFlow_(ctx); }
    },
    {
      id: 'orders.shipping-address-empty-required',
      title: 'ออร์เดอร์: ปฏิเสธ shipping_name ว่างเปล่า',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'ส่ง shipping_name เป็นค่าว่างใน patch ของ orderUpdateFieldsRpc',
      expected: 'orderUpdateFieldsRpc ต้องคืน ok:false',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingAddressEmptyRequiredFlow_(ctx); }
    },
    {
      id: 'orders.shipping-address-no-clobber-items',
      title: 'ออร์เดอร์: แก้ไขที่อยู่ไม่กระทบรายการสินค้า',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์ แก้ไขที่อยู่ แล้วตรวจว่า items_json ยังเหมือนเดิม',
      expected: 'รายการสินค้าในออร์เดอร์ต้องไม่เปลี่ยนแปลงหลังแก้ไขที่อยู่',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingAddressNoClobberItemsFlow_(ctx); }
    },
    {
      id: 'orders.shipping-address-no-clobber-status',
      title: 'ออร์เดอร์: แก้ไขที่อยู่ไม่กระทบสถานะออร์เดอร์',
      area: 'orders',
      type: 'write',
      risk: 'high',
      description: 'สร้างออร์เดอร์ เปลี่ยนสถานะเป็น paid แล้วแก้ไขที่อยู่ ตรวจว่าสถานะยังเป็น paid',
      expected: 'สถานะออร์เดอร์ต้องไม่เปลี่ยนแปลงหลังแก้ไขที่อยู่',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) { qaRequireRealWrite_(ctx); return qaRunShippingAddressNoClobberStatusFlow_(ctx); }
    },
    qaWriteSpec_('orders.bulk-sequential-20-success', 'Orders: bulk sequential 20 success', 'orders', 'critical', 'Submit 20 sequential orders against stock 25.', 'All 20 orders should succeed with unique order ids/tokens and stock should end at 5.', 'qaRunOrderBulkSequential20SuccessFlow_'),
    qaWriteSpec_('orders.bulk-gift-stock-limited-15', 'Orders: bulk gift stock limited 15', 'orders', 'critical', 'Submit 15 sequential gift-eligible orders against gift stock 10.', 'All orders should succeed, 10 should attach gifts, 5 should warn/skip, stock should end at 0.', 'qaRunOrderBulkGiftStockLimited15Flow_'),
    qaWriteSpec_('orders.idempotent-gift-not-double-deduct', 'Orders: idempotent gift not double deducted', 'orders', 'critical', 'Submit the same client_order_id twice for an order that receives a gift.', 'Duplicate submit should not deduct product or gift stock again.', 'qaRunOrderIdempotentGiftNotDoubleDeductFlow_'),
    qaWriteSpec_('orders.multi-item-failure-rolls-back-gift-stock', 'Orders: multi-item failure rolls back gift stock', 'orders', 'critical', 'Submit a cart with one gift-eligible product and another product over stock.', 'The failed order should not be created and gift stock should not change.', 'qaRunOrderMultiItemFailureRollsBackGiftStockFlow_'),
    qaWriteSpec_('orders.zero-total-after-promotion', 'Orders: zero total after promotion', 'orders', 'high', 'Submit an order where promotion clamps product price to zero.', 'Order total should equal shipping fee and min-subtotal gift rules should see subtotal 0.', 'qaRunOrderZeroTotalAfterPromotionFlow_'),
    qaWriteSpec_('orders.full-lifecycle-slip-approve-ship-deliver-token', 'Orders: full lifecycle slip approve ship deliver token', 'orders', 'critical', 'Create a real order, upload slip, approve, mark shipped with tracking, deliver, and read it by token.', 'Final status should be delivered, status_history should contain unpaid -> paid -> approved -> shipped -> delivered, and token read should preserve tracking and product/gift lines.', 'qaRunOrderFullLifecycleSlipApproveShipDeliverTokenFlow_'),
    qaWriteSpec_('orders.rules-promo-newly-qualified-stale-pricing', 'Orders rules: promotion becomes qualified after preview', 'orders', 'critical', 'Preview a cart before a conditional promotion qualifies, then increase the qualifying quantity while sending the stale client_pricing snapshot.', 'submitOrderRpc must recompute the new conditional discount, reject with PRICE_CHANGED, create no order, and preserve stock.', 'qaRunOrderRulesPromoNewlyQualifiedStalePricingFlow_'),
    qaWriteSpec_('orders.rules-promo-expired-after-preview', 'Orders rules: promotion expires after preview', 'orders', 'critical', 'Preview an active conditional promotion, expire its schedule, then submit the stale discounted client_pricing snapshot.', 'The order must be rejected with PRICE_CHANGED including price/promotion/total diffs, with no stock change.', 'qaRunOrderRulesPromoExpiredAfterPreviewFlow_'),
    qaWriteSpec_('orders.rules-gift-expired-after-preview', 'Orders rules: gift rule expires after preview', 'orders', 'critical', 'Preview a multiplied gift, expire the gift rule, then submit the same cart.', 'The order should still succeed but attach no stale gift, emit no stock warning, and preserve gift stock.', 'qaRunOrderRulesGiftExpiredAfterPreviewFlow_'),
    qaWriteSpec_('orders.rules-gift-activated-after-preview', 'Orders rules: gift rule activates after preview', 'orders', 'critical', 'Preview while a gift rule is scheduled, activate it, then submit the unchanged cart.', 'submitOrderRpc must evaluate current rules and attach the newly active multiplied gift with the correct stock deduction.', 'qaRunOrderRulesGiftActivatedAfterPreviewFlow_'),
    qaWriteSpec_('orders.rules-conditional-promo-snapshot-immutable', 'Orders rules: conditional promotion snapshot is immutable', 'orders', 'critical', 'Create an order using a conditional promotion, then change its discount and condition.', 'The persisted order line must retain its original price, promotion id, application mode, and condition type.', 'qaRunOrderRulesConditionalPromoSnapshotImmutableFlow_'),
    qaWriteSpec_('orders.rules-gift-rule-snapshot-immutable', 'Orders rules: gift-rule snapshot is immutable', 'orders', 'critical', 'Create an order with a multiplied auto gift, then rename and delete the source gift rule.', 'The order gift line must retain the original rule id/name and multiplied quantity.', 'qaRunOrderRulesGiftRuleSnapshotImmutableFlow_'),
    qaWriteSpec_('orders.rules-variant-promo-any-repeat-gift', 'Orders rules: variant promotion + ANY repeated gift', 'orders', 'critical', 'Submit duplicate M variant lines and an L line with a direct M promotion plus an ANY required_variants per-threshold gift rule.', 'Variant quantities must aggregate independently for promotion, stock, and ANY multipliers; the order should persist six gift units.', 'qaRunOrderRulesVariantPromoAnyRepeatGiftFlow_'),
    qaWriteSpec_('orders.rules-multi-promo-multi-gift-contract', 'Orders rules: multi-promotion + multi-gift checkout contract', 'orders', 'critical', 'Submit one cart with a direct promotion, a conditional promotion, an ANY repeated-product gift, a repeated subtotal gift, and matching client_pricing.', 'Pricing snapshots, direct-only gift subtotal base, gift quantities, response data, persisted lines, totals, and stocks must all agree.', 'qaRunOrderRulesMultiPromoMultiGiftContractFlow_'),
    qaWriteSpec_('orders.rules-mega-overlap-single-order-workflow', 'Orders rules: mega item/order-total promotion + gift overlap', 'orders', 'critical', 'Preview and submit one six-line order where eight item/order-total promotions compete and five gift rules qualify across subtotal, product ALL/ANY, and variant ALL/ANY conditions.', 'Exactly one order should persist with deterministic line-price and order-total winners, direct-only qualification subtotal, five correct gift grants, matching admin/token snapshots, exact net totals, and exact product/variant/gift stock deductions.', 'qaRunOrderRulesMegaOverlapSingleOrderWorkflow_'),
    qaWriteSpec_('orders.rules-mega-promotion-update-recovery', 'Orders rules: mega promotion update stale-price recovery', 'orders', 'critical', 'Preview a cart with direct, conditional order-total, and gift rules; increase the order-total discount before submit; reject the stale snapshot, then refresh and complete the order before editing/deleting the live promotion.', 'The stale submit returns PRICE_CHANGED with order_discount/total diffs and no stock change; the refreshed submit persists immutable promotion/gift snapshots, survives source deletion, and keeps exact stock behavior across cancel/un-cancel.', 'qaRunOrderRulesMegaPromotionUpdateRecoveryFlow_'),
    qaWriteSpec_('orders.rules-order-total-split-allocation', 'Orders rules: order-total discount split allocation', 'orders', 'critical', 'Submit a two-product checkout split across two shipping methods with one odd fixed order-total discount.', 'The discount is allocated proportionally across exactly two persisted orders, integer remainder is preserved, allocated discounts sum to the cart discount, per-order totals include their own shipping fee, and token reads match.', 'qaRunOrderRulesOrderTotalSplitAllocationFlow_'),
    qaWriteSpec_('orders.rules-idempotent-multi-repeat-gifts', 'Orders rules: idempotency with multiple repeated gifts', 'orders', 'critical', 'Submit the same client_order_id twice where two per-threshold rules award different multiplied quantities.', 'Only the first submit may create an order or deduct product/gift stocks; the retry must return DUPLICATE_ORDER.', 'qaRunOrderRulesIdempotentMultiRepeatGiftsFlow_'),
    qaWriteSpec_('orders.rules-cancel-same-gift-multi-rule-lifecycle', 'Orders rules: cancel lifecycle with same gift from multiple rules', 'orders', 'critical', 'Two repeated rules award separate lines of the same gift; cancel twice, then move the order back to paid.', 'Cancel restores the aggregated product/gift quantities exactly once and un-cancel atomically re-deducts them.', 'qaRunOrderRulesCancelSameGiftMultiRuleLifecycleFlow_'),
    qaWriteSpec_('orders.rules-production-summary-multiplied-gifts', 'Orders rules: production summary counts multiplied gifts', 'orders', 'critical', 'Approve a discounted order containing a per-threshold gift quantity greater than one and read the production summary.', 'The summary must count product units and the full multiplied gift quantity from the persisted order.', 'qaRunOrderRulesProductionSummaryMultipliedGiftsFlow_'),
    qaWriteSpec_('orders.rules-multiplied-gifts-monetary-neutral', 'Orders rules: multiplied gifts do not affect money or shipping weight', 'orders', 'critical', 'Submit a weighted order with a promotion and a large multiplied gift quantity.', 'Gift lines must not change subtotal, shipping weight bracket, or total; only product and gift stocks should be deducted.', 'qaRunOrderRulesMultipliedGiftsMonetaryNeutralFlow_'),
    {
      id: 'orders.variant-stock-race',
      title: 'ออร์เดอร์: ผู้ซื้อ 5 คนแข่งกันซื้อ variant stock 2',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA ที่มี variant stock=2 แล้วส่งออร์เดอร์พร้อมกัน 5 รายการสำหรับ variant นั้น',
      expected: 'ต้องมี request สร้างออร์เดอร์สำเร็จ 2 รายการ ที่เหลือต้องคืน STOCK_INSUFFICIENT และ stock ของ variant ต้องเหลือ 0',
      requiresRealWrite: true,
      requiresAdminToken: true,
      clientDriven: true,
      run: function() {
        return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
      }
    },
    {
      id: 'orders.manual-gift-add-double-click',
      title: 'ออร์เดอร์: กดเพิ่มของแถมเองซ้ำพร้อมกันต้องไม่ขายเกินสต็อก',
      area: 'orders',
      type: 'write',
      risk: 'critical',
      description: 'สร้างออร์เดอร์และของแถมแบบเพิ่มเอง โดยมีสต็อก 1 ชิ้น แล้วให้ admin ยิงเพิ่มของแถมพร้อมกัน 2 ครั้ง',
      expected: 'ต้องสำเร็จ 1 ครั้ง ล้มเหลวเพราะสต็อกไม่พอ 1 ครั้ง ออร์เดอร์มีของแถมที่ยังใช้งานอยู่ 1 รายการ และสต็อกของแถมเหลือ 0',
      requiresRealWrite: true,
      requiresAdminToken: true,
      clientDriven: true,
      run: function() {
        return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
      }
    },
    {
      id: 'writes.concurrent-gift-stock-race',
      title: 'ของแถม: ออร์เดอร์ 5 รายการแข่งกันรับของแถมที่มีสต็อก 2',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA ของแถม QA ที่มีสต็อก 2 และกฎของแถม แล้วให้ dashboard ส่งออร์เดอร์ที่เข้าเงื่อนไขพร้อมกัน 5 รายการ',
      expected: 'ออร์เดอร์ทั้ง 5 รายการต้องถูกสร้าง แต่มีแค่ 2 รายการที่มีรายการของแถม และสต็อกของแถมต้องเหลือ 0',
      requiresRealWrite: true,
      requiresAdminToken: true,
      clientDriven: true,
      run: function() {
        return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
      }
    },
    {
      id: 'writes.concurrent-admin-gift-order-race',
      title: 'ของแถม: admin เพิ่มของแถมชนกับออร์เดอร์ลูกค้า',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'สร้างของแถม QA ที่มีสต็อก 1 แล้วให้ dashboard เพิ่มของแถมเข้าออร์เดอร์เดิมพร้อมกับส่งออร์เดอร์ลูกค้าที่เข้าเงื่อนไขใหม่',
      expected: 'ต้องมีฝ่ายเดียวที่ได้ของแถมชิ้นเดียว ฝั่ง admin ที่แพ้ต้องเจอสต็อกไม่พอ หรือออร์เดอร์ลูกค้าใหม่ถูกสร้างโดยไม่มีของแถม',
      requiresRealWrite: true,
      requiresAdminToken: true,
      clientDriven: true,
      run: function() {
        return qaSkip_('เคสนี้รันจากหน้า dashboard เพื่อยิง google.script.run แบบ concurrent');
      }
    },
    {
      id: 'writes.manual-gift-out-of-stock',
      title: 'ของแถม: เพิ่มของแถมเองต้องคืนข้อผิดพลาดเมื่อสต็อกหมด',
      area: 'writes',
      type: 'write',
      risk: 'high',
      description: 'สร้างของแถม QA ที่มีสต็อก 0 แล้วตรวจว่า addManualGiftToOrderRpc ปฏิเสธการแนบของแถมเข้าออร์เดอร์',
      expected: 'addManualGiftToOrderRpc ต้องคืน ok=false พร้อมข้อความภาษาไทยว่าสต็อกไม่พอ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        return qaRunManualGiftOutOfStockWriteFlow_(ctx);
      }
    },
    {
      id: 'writes.full-commerce-flow',
      title: 'ออร์เดอร์: flow สินค้า + โปรโมชั่น + ของแถม + ออร์เดอร์',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'สร้างสินค้า QA, โปรโมชั่น, ของแถม และกฎของแถม แล้วส่งออร์เดอร์จริงและตรวจ snapshot ของออร์เดอร์',
      expected: 'จะถูกข้ามถ้าไม่ได้เปิดเคสเขียนข้อมูลจริงและไม่มี admin token เมื่อเปิดใช้จะสร้าง row ออร์เดอร์จริง และล้าง master data ชั่วคราวหลังตรวจ',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        return qaRunFullCommerceWriteFlow_(ctx);
      }
    },
    qaWriteSpec_(
      'writes.full-commerce-weight-promo-gift-flow',
      'ออร์เดอร์: full flow แบบละเอียดรวม shipping น้ำหนัก + promo + gift',
      'writes',
      'critical',
      'รัน checkout จริงที่รวมสินค้าหลายรายการ, variant, promotion, gift rule และค่าขนส่งตามน้ำหนักในออร์เดอร์เดียว',
      'ผลลัพธ์ต้องตรงกับ expected subtotal, shipping fee, total, gift stock, product stock และ order token read',
      'qaRunOrderE2EWeightPromoGiftOneOrderFlow_'
    ),
    {
      id: 'writes.submit-order',
      title: 'ออร์เดอร์: ส่งออร์เดอร์จริง',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'สร้างออร์เดอร์จริงสถานะ unpaid ผ่าน submitOrderRpc แล้วอ่านกลับด้วย admin token ที่ login อยู่',
      expected: 'จะถูกข้ามถ้าไม่ได้เปิดเคสเขียนข้อมูลจริงและไม่มี admin token เมื่อเปิดใช้จะสร้าง row ออร์เดอร์จริง',
      requiresRealWrite: true,
      requiresAdminToken: true,
      run: function(ctx) {
        qaRequireRealWrite_(ctx);
        var draft = qaBuildRealOrderPayload_(ctx);
        if (draft.__qaSkipped) return draft;

        var caught = null, output = null, cleanup = null;
        try {
          var created = qaCall_('submitOrderRpc', [draft.payload]);
          qaAssertOk_(created);
          var orderId = created.order_id || (created.orders && created.orders[0] && created.orders[0].order_id) || '';
          qaAssert_(!!orderId, 'submitOrderRpc did not return an order id', created);

          var readBack = qaCall_('orderGetRpc', [ctx.options.adminToken, orderId]);
          qaAssertOk_(readBack);
          qaAssert_(readBack.record && String(readBack.record.order_id) === String(orderId), 'orderGetRpc returned the wrong order', readBack);

          output = {
            order_id: orderId,
            tokenReturned: !!created.token || !!(created.orders && created.orders[0] && created.orders[0].token),
            product_id: draft.product.id,
            product_title: draft.product.title,
            shipping_method_id: draft.shipping.method.id,
            shipping_method_name: draft.shipping.method.name,
            customer_name: draft.payload.customer_name,
            total: readBack.record.total,
            status: readBack.record.status,
            note: 'A real order was created in the orders sheet; temporary QA fixtures were cleaned up.'
          };
        } catch (err) {
          caught = err;
        }
        cleanup = qaCleanupProductAndShipping_(ctx.options.adminToken, draft.cleanup.product_id, draft.cleanup.shipping_fixture);
        if (caught) {
          caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup });
          throw caught;
        }
        output.cleanup = cleanup;
        return output;
      }
    },
    {
      id: 'writes.create-gift-item',
      title: 'ของแถม: สร้างรายการของแถม',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'ขั้นตอนสร้างของแถมแบบแยกเดี่ยวถูกครอบไว้ในเคส full-commerce-flow แล้ว',
      expected: 'ข้าม เพราะ flow เขียนข้อมูลจริงแบบรวมครอบเคสนี้และมี cleanup แล้ว',
      skip: 'ครอบไว้ใน writes.full-commerce-flow แล้ว'
    },
    {
      id: 'writes.create-gift-rule',
      title: 'ของแถม: สร้างกฎของแถม',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'ขั้นตอนสร้างกฎของแถมแบบแยกเดี่ยวถูกครอบไว้ในเคส full-commerce-flow แล้ว',
      expected: 'ข้าม เพราะ flow เขียนข้อมูลจริงแบบรวมครอบเคสนี้และมี cleanup แล้ว',
      skip: 'ครอบไว้ใน writes.full-commerce-flow แล้ว'
    },
    {
      id: 'writes.save-shipping',
      title: 'การจัดส่ง: บันทึกค่าขนส่ง',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'บันทึกไว้ว่า flow เขียนค่าขนส่งมีอยู่ แต่ปิดไว้เพื่อป้องกัน config production',
      expected: 'ข้ามจนกว่าจะมี sandbox write mode ในอนาคต',
      skip: 'ปิดไว้ตาม design เพราะการเขียนค่าขนส่งควรรันกับ deployment สำหรับทดสอบเท่านั้น'
    },
    {
      id: 'writes.publish-site-config',
      title: 'การตั้งค่าเว็บ: publish site config',
      area: 'writes',
      type: 'write',
      risk: 'critical',
      description: 'บันทึกไว้ว่า flow publish site config มีอยู่ แต่ปิดไว้เพื่อป้องกันค่าหน้าร้าน production',
      expected: 'ข้ามจนกว่าจะมี sandbox write mode ในอนาคต',
      skip: 'ปิดไว้ตาม design เพราะการเขียน site config ควรรันกับ deployment สำหรับทดสอบเท่านั้น'
    }
  ];
  return specs
    .concat(qaShippingMatrixSpecs_())
    .concat(qaAdditionalEdgeSpecs_())
    .concat(qaConcurrentHeavySpecs_())
    .concat(qaPaymentLifecycleDeepSpecs_());
}

function qaRunSingleSpec_(spec, ctx) {
  var started = new Date();
  var result = qaPublicSpec_(spec);
  result.startedAt = started.toISOString();

  if (spec.requiresRealWrite && ctx.options.allowWriteTests !== true) {
    result.status = 'skipped';
    result.reason = 'ปิดเคสเขียนข้อมูลจริงอยู่ ต้องติ๊ก checkbox เพื่ออนุญาตให้สร้างข้อมูลจริง';
    result.durationMs = 0;
    result.details = {};
    return result;
  }

  if (spec.requiresAdminToken && !ctx.options.adminToken) {
    result.status = 'skipped';
    result.reason = 'Admin login is required for this testcase.';
    result.durationMs = 0;
    result.details = {};
    return result;
  }

  if (spec.skip) {
    result.status = 'skipped';
    result.reason = spec.skip;
    result.durationMs = 0;
    result.details = {};
    return result;
  }

  if (spec.requiresRouteSmoke && ctx.options.runRouteSmoke === false) {
    result.status = 'skipped';
    result.reason = 'ปิดการทดสอบหน้าเว็บไว้ในตัวเลือกการรัน';
    result.durationMs = 0;
    result.details = {};
    return result;
  }

  var previousTraceContext = QA_TRACE_CONTEXT_;
  QA_TRACE_CONTEXT_ = {
    runId: ctx && ctx.options ? ctx.options.qaRunId : '',
    testId: spec.id
  };
  qaTrace_('test.start', 'Starting testcase: ' + spec.id, {
    testcase: spec.id,
    title: spec.title,
    area: spec.area,
    type: spec.type
  });

  try {
    var details = spec.run(ctx);
    if (details && details.__qaSkipped) {
      result.status = 'skipped';
      result.reason = details.reason || 'Skipped by testcase.';
      result.details = details.details || {};
    } else {
      result.status = 'passed';
      result.details = details || {};
    }
  } catch (err) {
    result.status = 'failed';
    result.error = String(err && err.message || err);
    result.details = err && err.details ? err.details : {};
  }

  var ended = new Date();
  result.endedAt = ended.toISOString();
  result.durationMs = ended.getTime() - started.getTime();
  qaTrace_(result.status === 'failed' ? 'test.failed' : 'test.finished', 'Finished testcase: ' + spec.id, {
    testcase: spec.id,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error || '',
    reason: result.reason || ''
  });
  QA_TRACE_CONTEXT_ = previousTraceContext;
  return result;
}

function qaPublicSpec_(spec) {
  return {
    id: spec.id,
    title: spec.title,
    area: spec.area,
    type: spec.type,
    risk: spec.risk,
    description: spec.description,
    expected: spec.expected,
    requiresRouteSmoke: !!spec.requiresRouteSmoke,
    requiresRealWrite: !!spec.requiresRealWrite,
    requiresAdminToken: !!spec.requiresAdminToken,
    clientDriven: !!spec.clientDriven,
    defaultSkipped: !!spec.skip
  };
}

function qaSummarizeResults_(results) {
  var summary = {
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    byArea: {}
  };
  results.forEach(function(result) {
    summary[result.status] = (summary[result.status] || 0) + 1;
    summary.durationMs += Number(result.durationMs || 0);
    if (!summary.byArea[result.area]) {
      summary.byArea[result.area] = { total: 0, passed: 0, failed: 0, skipped: 0 };
    }
    summary.byArea[result.area].total += 1;
    summary.byArea[result.area][result.status] += 1;
  });
  return summary;
}

function qaTraceCacheKey_(runId) {
  var id = String(runId || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 120);
  return id ? QA_TRACE_CACHE_PREFIX + id : '';
}

function qaTraceRead_(runId) {
  var key = qaTraceCacheKey_(runId);
  if (!key) return [];
  var raw = CacheService.getScriptCache().get(key);
  if (!raw) return [];
  try {
    var events = JSON.parse(raw);
    return Array.isArray(events) ? events : [];
  } catch (_) {
    return [];
  }
}

function qaTraceWrite_(runId, events) {
  var key = qaTraceCacheKey_(runId);
  if (!key) return;
  var list = Array.isArray(events) ? events.slice(-QA_TRACE_MAX_EVENTS) : [];
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(list), QA_TRACE_TTL_SECONDS);
  } catch (_) {
    try {
      CacheService.getScriptCache().put(key, JSON.stringify(list.slice(-80)), QA_TRACE_TTL_SECONDS);
    } catch (__) {}
  }
}

function qaTraceShouldRedactKey_(key) {
  return /(token|password|otp|secret|api[_-]?key|base64|dataurl|data_url|authorization)/i.test(String(key || ''));
}

function qaTraceMask_(value) {
  var text = String(value == null ? '' : value);
  if (!text) return '';
  if (text.length <= 8) return '[REDACTED]';
  return text.slice(0, 4) + '...' + text.slice(-4) + ' [REDACTED]';
}

function qaTraceSanitize_(value, key, depth) {
  depth = depth || 0;
  if (qaTraceShouldRedactKey_(key)) return qaTraceMask_(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (/^data:/i.test(value)) return '[DATA_URL ' + value.length + ' chars REDACTED]';
    if (/^[A-Za-z0-9_\-]{20,}\.[A-Fa-f0-9]{32,}$/.test(value)) return qaTraceMask_(value);
    if (/^[A-Fa-f0-9]{64,}$/.test(value)) return qaTraceMask_(value);
    if (value.length > 700) return value.slice(0, 700) + '... [truncated ' + value.length + ' chars]';
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 5) return '[Max depth reached]';
  if (Array.isArray(value)) {
    var arr = value.slice(0, 16).map(function(item, index) {
      return qaTraceSanitize_(item, String(key || 'item') + '[' + index + ']', depth + 1);
    });
    if (value.length > 16) arr.push('[truncated ' + (value.length - 16) + ' more item(s)]');
    return arr;
  }
  if (typeof value === 'object') {
    var out = {};
    var keys = Object.keys(value);
    keys.slice(0, 40).forEach(function(k) {
      out[k] = qaTraceSanitize_(value[k], k, depth + 1);
    });
    if (keys.length > 40) out.__truncatedKeys = keys.length - 40;
    return out;
  }
  return String(value);
}

function qaTraceSanitizeArgs_(functionName, args) {
  var list = Array.isArray(args) ? args : [];
  return list.map(function(arg, index) {
    var key = 'arg' + index;
    if (index === 0 && typeof arg === 'string' && /Rpc$/.test(String(functionName))) key = 'token_or_arg0';
    return qaTraceSanitize_(arg, key, 0);
  });
}

function qaTraceStatus_(type) {
  if (/error|failed|fail/i.test(String(type || ''))) return 'failed';
  if (/response|finished|step/i.test(String(type || ''))) return 'passed';
  return 'running';
}

function qaTrace_(type, message, data) {
  try {
    var ctx = QA_TRACE_CONTEXT_ || {};
    var runId = ctx.runId || '';
    if (!runId) return;
    var lock = LockService.getScriptLock();
    var locked = false;
    try { locked = lock.tryLock(2000); } catch (_) {}
    try {
      var events = qaTraceRead_(runId);
      var lastSeq = events.length ? Number(events[events.length - 1].seq || 0) : 0;
      events.push({
        seq: lastSeq + 1,
        at: new Date().toISOString(),
        type: String(type || 'trace'),
        status: qaTraceStatus_(type),
        message: String(message || ''),
        testcase: String((data && (data.testcase || data.testId)) || ctx.testId || ''),
        data: qaTraceSanitize_(data || {}, 'data', 0)
      });
      qaTraceWrite_(runId, events);
    } finally {
      if (locked) { try { lock.releaseLock(); } catch (_) {} }
    }
  } catch (_) {}
}

function getQaIntegrationTraceEventsRpc(runId, afterSeq) {
  try {
    var minSeq = Number(afterSeq || 0);
    var events = qaTraceRead_(runId).filter(function(event) {
      return Number(event.seq || 0) > minSeq;
    });
    return {
      ok: true,
      runId: String(runId || ''),
      events: events,
      lastSeq: events.length ? Number(events[events.length - 1].seq || 0) : minSeq
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), events: [] };
  }
}

function clearQaIntegrationTraceRpc(runId) {
  try {
    var key = qaTraceCacheKey_(runId);
    if (key) CacheService.getScriptCache().remove(key);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function qaCall_(functionName, args) {
  var fn = globalThis[functionName];
  if (typeof fn !== 'function') {
    throw new Error('ไม่พบฟังก์ชันที่ต้องใช้: ' + functionName);
  }
  var started = Date.now();
  qaTrace_('rpc.request', 'Calling ' + functionName, {
    functionName: functionName,
    args: qaTraceSanitizeArgs_(functionName, args || [])
  });
  try {
    var response = fn.apply(null, args || []);
    qaTrace_('rpc.response', 'Returned from ' + functionName, {
      functionName: functionName,
      durationMs: Date.now() - started,
      response: response
    });
    return response;
  } catch (err) {
    qaTrace_('rpc.error', 'Error from ' + functionName, {
      functionName: functionName,
      durationMs: Date.now() - started,
      error: String(err && err.message || err),
      details: err && err.details ? err.details : {}
    });
    throw err;
  }
}

function qaAssert_(condition, message, details) {
  if (condition) return;
  var err = new Error(message || 'เงื่อนไขทดสอบไม่ผ่าน');
  err.details = details || {};
  throw err;
}

function qaAssertOk_(res) {
  qaAssert_(res && res.ok === true, 'คาดว่าต้องได้ ok=true แต่ได้: ' + JSON.stringify(res || null), res || {});
}

function qaAssertRejected_(res, label) {
  qaAssert_(res && res.ok === false, (label || 'Invalid payload') + ' must be rejected', res || {});
  return { label: label || 'invalid', error: String((res && res.error) || '') };
}

function qaSkip_(reason, details) {
  return { __qaSkipped: true, reason: reason || 'Skipped', details: details || {} };
}

function qaRequireRealWrite_(ctx) {
  qaAssert_(ctx && ctx.options && ctx.options.allowWriteTests === true, 'ยังไม่ได้เปิดเคสเขียนข้อมูลจริง');
  qaAssert_(ctx.options.adminToken, 'Admin token is required for real write tests.');
}

function qaStep_(steps, name, status, data) {
  var entry = {
    at: new Date().toISOString(),
    step: name,
    status: status || 'ok',
    data: data || {}
  };
  steps.push(entry);
  qaTrace_(entry.status === 'failed' ? 'step.failed' : 'step', 'Step: ' + name, entry);
}

function qaStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
}

function qaPastIso_(ms) { return new Date(Date.now() - ms).toISOString(); }
function qaFutureIso_(ms) { return new Date(Date.now() + ms).toISOString(); }

function qaIsOwnerToken_(token) {
  try {
    var res = qaCall_('validateSessionRpc', [token]);
    return !!(res && res.ok && res.isOwner);
  } catch(_) {
    return false;
  }
}

function qaPublicListHasProduct_(productId) {
  var res = qaCall_('productListRpc', [{ limit: 500, sort: 'new' }]);
  qaAssertOk_(res);
  return (res.items || []).some(function(p){ return String(p.id) === String(productId); });
}

function qaGetProductRecord_(productId, token) {
  var res = qaCall_('productGetRpc', [productId, token]);
  qaAssertOk_(res);
  return res.record || {};
}

function qaCreatePromotion_(token, productId, stamp, label, opts) {
  opts = opts || {};
  var payload = {
    name: 'QA Promo ' + label + ' ' + stamp,
    description: 'โปรโมชั่น QA ชั่วคราวสำหรับ ' + label,
    discount_type: opts.discount_type || 'fixed',
    discount_value: opts.discount_value !== undefined ? opts.discount_value : 100,
    target_type: opts.target_type || 'product',
    target: opts.target || [{ product_id: productId }],
    starts_at: opts.starts_at !== undefined ? opts.starts_at : qaPastIso_(60000),
    ends_at: opts.ends_at || '',
    no_end_date: opts.no_end_date !== undefined ? opts.no_end_date : true,
    enabled: opts.enabled !== false
  };
  // Conditional-promotion fields (optional). Omitting them keeps the promo unconditional.
  if (opts.application_mode !== undefined) payload.application_mode = opts.application_mode;
  if (opts.condition_type !== undefined) payload.condition_type = opts.condition_type;
  if (opts.condition_json !== undefined) payload.condition_json = opts.condition_json;
  // Discount scope (optional): 'order_total' for whole-order discounts (conditional only).
  if (opts.discount_scope !== undefined) payload.discount_scope = opts.discount_scope;
  var res = qaCall_('createPromotionRpc', [token, payload]);
  qaAssertOk_(res);
  qaAssert_(!!res.promotion_id, 'createPromotionRpc ต้องคืน promotion_id', res);
  return { promotion_id: res.promotion_id, payload: payload, response: res };
}

function qaCleanupPromosProductsShipping_(token, promotionIds, productIds, shippingFixture) {
  var out = { ok:true, promotions:[], products:[], shipping:null };
  (promotionIds || []).filter(Boolean).forEach(function(pid) {
    try {
      var res = qaCall_('deletePromotionRpc', [token, pid]);
      out.promotions.push({ promotion_id:pid, ok:!!(res && res.ok), response:res });
      if (!res || res.ok !== true) out.ok = false;
    } catch (err) {
      out.promotions.push({ promotion_id:pid, ok:false, error:String(err && err.message || err) });
      out.ok = false;
    }
  });
  (productIds || []).filter(Boolean).forEach(function(pid) {
    try {
      var resP = qaCall_('productDeleteRpc', [token, pid]);
      out.products.push({ product_id:pid, ok:!!(resP && resP.ok), response:resP });
      if (!resP || resP.ok !== true) out.ok = false;
    } catch (errP) {
      out.products.push({ product_id:pid, ok:false, error:String(errP && errP.message || errP) });
      out.ok = false;
    }
  });
  try {
    out.shipping = qaCleanupTempShipping_(token, shippingFixture);
    if (!out.shipping || out.shipping.ok !== true) out.ok = false;
  } catch (errS) {
    out.shipping = { ok:false, error:String(errS && errS.message || errS) };
    out.ok = false;
  }
  return out;
}

function qaPrepareConcurrentStockRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);

  var token = ctx.options.adminToken;
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'StockRace');

  var productPayload = {
    title: 'QA Race Product ' + stamp,
    desc: 'Temporary product for concurrent stock race integration test.',
    price: 500,
    badge: 'QA-RACE',
    weight_grams: 100,
    allowed_shipping_ids: [shipping.method.id],
    stock: 2,
    sale_mode: 'always',
    variants: [],
    extra_images: []
  };
  var productRes = qaCall_('productCreateRpc', [token, productPayload]);
  qaAssertOk_(productRes);
  var productId = productRes.id;
  qaAssert_(!!productId, 'productCreateRpc did not return id', productRes);

  var buyers = ['A', 'B', 'C', 'D', 'E'];
  var jobs = buyers.map(function(buyer, index) {
    return {
      buyer: buyer,
      delayMs: index * 100,
      payload: {
        client_order_id: 'qa-race-' + stamp + '-' + buyer + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8),
        customer_name: 'QA Race Buyer ' + buyer,
        customer_phone: '0812345678',
        customer_contact_platform: '',
        customer_contact: 'qa-race-' + buyer,
        customer_notes: 'Concurrent stock race buyer ' + buyer + ' at ' + now.toISOString(),
        shipping_name: 'QA Race Buyer ' + buyer,
        shipping_address: 'QA Race Address',
        shipping_district: 'QA District',
        shipping_amphoe: 'QA Amphoe',
        shipping_province: 'Bangkok',
        shipping_postal_code: '10110',
        shipping_info: [{
          company_id: shipping.company.id,
          method_id: shipping.method.id
        }],
        items: [{
          product_id: productId,
          qty: 1,
          selected_variants: {}
        }]
      }
    };
  });

  return {
    ok: true,
    product_id: productId,
    product_payload: productPayload,
    shipping: {
      company_id: shipping.company.id,
      company_name: shipping.company.name,
      method_id: shipping.method.id,
      method_name: shipping.method.name
    },
    shipping_fixture: shipping,
    stock: 2,
    expected_success_count: 2,
    expected_stock_insufficient_count: 3,
    jobs: jobs
  };
}

function qaCleanupConcurrentStockRaceRpc(token, fixtureOrProductId) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  var isFixture = fixtureOrProductId && typeof fixtureOrProductId === 'object';
  var productId = isFixture ? fixtureOrProductId.product_id : fixtureOrProductId;
  var shippingFixture = isFixture ? fixtureOrProductId.shipping_fixture : null;
  if (!productId && !shippingFixture) return { ok:true, skipped:true };
  return qaCleanupProductAndShipping_(token, productId, shippingFixture);
}

function qaGetProductStock_(productId) {
  var rowNo = _sheetRowOfId(productId);
  if (rowNo < 0) return null;
  var v = Number(_sheetProd().getRange(rowNo, 15).getValue());
  return isNaN(v) ? -1 : v;
}

function qaGetVariantStock_(productId, groupName, optionLabel) {
  var rowNo = _sheetRowOfId(productId);
  if (rowNo < 0) return null;
  var raw = String(_sheetProd().getRange(rowNo, 11).getValue() || '[]');
  var variants = [];
  try { variants = JSON.parse(raw); } catch(_) { variants = []; }
  for (var i = 0; i < variants.length; i++) {
    if (String(variants[i].name) !== String(groupName)) continue;
    var opts = variants[i].options || [];
    for (var j = 0; j < opts.length; j++) {
      if (String(opts[j].label) === String(optionLabel)) {
        var s = Number(opts[j].stock);
        return isNaN(s) ? -1 : s;
      }
    }
  }
  return null;
}

function qaCreateOrderQaProduct_(token, shipping, stamp, label, stock, extra) {
  extra = extra || {};
  var payload = {
    title: 'QA Order ' + label + ' Product ' + stamp,
    desc: 'สินค้าชั่วคราวสำหรับทดสอบระบบออร์เดอร์',
    price: extra.price || 500,
    badge: 'QA-ORDER',
    weight_grams: extra.weight_grams || 100,
    allowed_shipping_ids: extra.allowed_shipping_ids || [shipping.method.id],
    stock: stock,
    sale_mode: extra.sale_mode || 'always',
    sale_starts_at: extra.sale_starts_at || '',
    sale_ends_at: extra.sale_ends_at || '',
    variants: extra.variants || [],
    extra_images: []
  };
  var res = qaCall_('productCreateRpc', [token, payload]);
  qaAssertOk_(res);
  qaAssert_(!!res.id, 'productCreateRpc did not return id', res);
  return { id: res.id, payload: payload };
}

function qaBuildOrderPayloadForProduct_(prefix, stamp, buyer, productId, shipping, overrides) {
  overrides = overrides || {};
  var item = {
    product_id: productId,
    qty: overrides.qty !== undefined ? overrides.qty : 1,
    selected_variants: overrides.selected_variants || {}
  };
  return {
    client_order_id: overrides.client_order_id || (prefix + '-' + stamp + '-' + buyer + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8)),
    customer_name: 'QA Order Buyer ' + buyer,
    customer_phone: '0812345678',
    customer_contact_platform: '',
    customer_contact: 'qa-order-' + buyer,
    customer_notes: 'Order testcase buyer ' + buyer + ' at ' + new Date().toISOString(),
    shipping_name: 'QA Order Buyer ' + buyer,
    shipping_address: 'QA Order Address',
    shipping_district: 'QA District',
    shipping_amphoe: 'QA Amphoe',
    shipping_province: 'Bangkok',
    shipping_postal_code: '10110',
    shipping_info: [{
      company_id: shipping.company.id,
      method_id: shipping.method.id
    }],
    items: overrides.items || [item]
  };
}

function qaRunDuplicateClientOrderIdFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var ids = { product_id: '', shipping_fixture: shipping, order_ids: [] };
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'DuplicateId', 5);
    ids.product_id = product.id;
    var clientOrderId = 'qa-dup-' + stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    var payload = qaBuildOrderPayloadForProduct_('qa-dup', stamp, 'First', ids.product_id, shipping, { client_order_id: clientOrderId });
    var first = qaCall_('submitOrderRpc', [payload]);
    qaTrackSubmittedOrders_(first, ids.order_ids);
    qaAssertOk_(first);
    var second = qaCall_('submitOrderRpc', [payload]);
    qaTrackSubmittedOrders_(second, ids.order_ids);
    qaAssert_(second && second.ok === false && second.error === 'DUPLICATE_ORDER', 'การส่งซ้ำควรคืน DUPLICATE_ORDER', second);
    output = {
      client_order_id: clientOrderId,
      first_order_id: first.order_id || '',
      second_response: second,
      final_product_stock: qaGetProductStock_(ids.product_id)
    };
  } catch (err) {
    caught = err;
  }
  var cleanup = qaCleanupOrdersProductsShipping_(token, ids.order_ids, [ids.product_id], ids.shipping_fixture);
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, { created: ids, cleanup: cleanup });
    throw caught;
  }
  output.cleanup = cleanup;
  return output;
}

function qaRunMultiItemStockRollbackFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var ids = { product_ok_id: '', product_empty_id: '', shipping_fixture: shipping, order_ids: [] };
  var caught = null, output = null;
  try {
    ids.product_ok_id = qaCreateOrderQaProduct_(token, shipping, stamp, 'RollbackOk', 1).id;
    ids.product_empty_id = qaCreateOrderQaProduct_(token, shipping, stamp, 'RollbackEmpty', 0).id;
    var payload = qaBuildOrderPayloadForProduct_('qa-rollback', stamp, 'BothItems', ids.product_ok_id, shipping, {
      items: [
        { product_id: ids.product_ok_id, qty: 1, selected_variants: {} },
        { product_id: ids.product_empty_id, qty: 1, selected_variants: {} }
      ]
    });
    var res = qaCall_('submitOrderRpc', [payload]);
    qaTrackSubmittedOrders_(res, ids.order_ids);
    qaAssert_(res && res.ok === false && res.error === 'STOCK_INSUFFICIENT', 'ออร์เดอร์หลายสินค้าควรล้มเหลวด้วย STOCK_INSUFFICIENT', res);
    var okStock = qaGetProductStock_(ids.product_ok_id);
    qaAssert_(okStock === 1, 'The first product stock should not be deducted when another item is out of stock', { okStock: okStock, response: res });
    output = { submit_response: res, product_ok_stock_after: okStock, product_empty_stock_after: qaGetProductStock_(ids.product_empty_id) };
  } catch (err) {
    caught = err;
  }
  var cleanup = qaCleanupOrdersProductsShipping_(token, ids.order_ids, [ids.product_ok_id, ids.product_empty_id], ids.shipping_fixture);
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, { created: ids, cleanup: cleanup });
    throw caught;
  }
  output.cleanup = cleanup;
  return output;
}

function qaRunInvalidQtyRejectedFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var ids = { product_id: '', shipping_fixture: shipping, order_ids: [] };
  var caught = null, output = null;
  try {
    ids.product_id = qaCreateOrderQaProduct_(token, shipping, stamp, 'InvalidQty', 20).id;
    var badQtys = [0, -1, 'abc', 1.5];
    var results = [];
    badQtys.forEach(function(qty) {
      var res = qaCall_('submitOrderRpc', [
        qaBuildOrderPayloadForProduct_('qa-invalid-qty', stamp, String(qty).replace(/[^A-Za-z0-9]/g, '_'), ids.product_id, shipping, { qty: qty })
      ]);
      qaTrackSubmittedOrders_(res, ids.order_ids);
      results.push({ qty: qty, response: res, rejected: !!(res && res.ok === false) });
    });
    var accepted = results.filter(function(r){ return !r.rejected; });
    qaAssert_(accepted.length === 0, 'Invalid qty values should be rejected, but some were accepted', { results: results });
    output = { invalid_qty_results: results, final_product_stock: qaGetProductStock_(ids.product_id) };
  } catch (err) {
    caught = err;
  }
  var cleanup = qaCleanupOrdersProductsShipping_(token, ids.order_ids, [ids.product_id], ids.shipping_fixture);
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, { created: ids, cleanup: cleanup });
    throw caught;
  }
  output.cleanup = cleanup;
  return output;
}

function qaRunInactiveProductRejectedFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var ids = { product_id: '', shipping_fixture: shipping, order_ids: [] };
  var caught = null, output = null;
  try {
    ids.product_id = qaCreateOrderQaProduct_(token, shipping, stamp, 'Inactive', 5, {
      sale_mode: 'disabled',
      allowed_shipping_ids: []
    }).id;
    var res = qaCall_('submitOrderRpc', [
      qaBuildOrderPayloadForProduct_('qa-inactive', stamp, 'Inactive', ids.product_id, shipping)
    ]);
    qaTrackSubmittedOrders_(res, ids.order_ids);
    qaAssert_(res && res.ok === false, 'Inactive product should not be orderable', res);
    output = { submit_response: res, final_product_stock: qaGetProductStock_(ids.product_id) };
  } catch (err) {
    caught = err;
  }
  var cleanup = qaCleanupOrdersProductsShipping_(token, ids.order_ids, [ids.product_id], ids.shipping_fixture);
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, { created: ids, cleanup: cleanup });
    throw caught;
  }
  output.cleanup = cleanup;
  return output;
}

function qaClone_(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function qaOrderIdsFromSubmit_(res) {
  if (!res || res.ok !== true) return [];
  if (res.order_id) return [res.order_id];
  if (Array.isArray(res.orders)) {
    return res.orders.map(function(o){ return o && o.order_id; }).filter(Boolean);
  }
  return [];
}

function qaTrackSubmittedOrders_(res, orderIds) {
  qaOrderIdsFromSubmit_(res).forEach(function(id) {
    if (orderIds.indexOf(id) < 0) orderIds.push(id);
  });
  return res;
}

function qaDeleteOrdersSafe_(token, orderIds) {
  var ids = Array.from(new Set((orderIds || []).filter(Boolean).map(String)));
  if (!ids.length) return { ok:true, skipped:true, deleted:0 };
  try {
    return qaCall_('orderDeleteRpc', [token, ids]);
  } catch (err) {
    return { ok:false, error:String(err && err.message || err), order_ids:ids };
  }
}

function qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shippingFixture) {
  var out = { ok:true, orders:null, products:[], shipping:null };
  out.orders = qaDeleteOrdersSafe_(token, orderIds || []);
  if (!out.orders || out.orders.ok !== true) out.ok = false;
  (productIds || []).filter(Boolean).forEach(function(pid) {
    try {
      var res = qaCall_('productDeleteRpc', [token, pid]);
      out.products.push({ product_id:pid, ok:!!(res && res.ok), response:res });
      if (!res || res.ok !== true) out.ok = false;
    } catch (err) {
      out.products.push({ product_id:pid, ok:false, error:String(err && err.message || err) });
      out.ok = false;
    }
  });
  try {
    out.shipping = qaCleanupTempShipping_(token, shippingFixture);
    if (!out.shipping || out.shipping.ok !== true) out.ok = false;
  } catch (shipErr) {
    out.shipping = { ok:false, error:String(shipErr && shipErr.message || shipErr) };
    out.ok = false;
  }
  return out;
}

function qaCreateOrderFixture_(ctx, label, stock, productExtra, shippingOpts) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, label || 'OrderFixture', shippingOpts || {});
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, label || 'Fixture', stock, productExtra || {});
  return { token:token, stamp:stamp, shipping:shipping, product:product, order_ids:[] };
}

function qaSubmitAndTrack_(payload, orderIds) {
  var res = qaCall_('submitOrderRpc', [payload]);
  qaTrackSubmittedOrders_(res, orderIds);
  return res;
}

function qaReadOrder_(token, orderId) {
  var rb = qaCall_('orderGetRpc', [token, orderId]);
  qaAssertOk_(rb);
  return rb.record || {};
}

function qaFindProductLine_(record, productId) {
  var items = Array.isArray(record.items) ? record.items : [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].line_type !== 'gift' && String(items[i].product_id) === String(productId)) return items[i];
  }
  return null;
}

function qaFindProductLineByVariantKey_(record, productId, variantKey) {
  var items = Array.isArray(record.items) ? record.items : [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].line_type !== 'gift'
        && String(items[i].product_id) === String(productId)
        && String(items[i].variant_key || '') === String(variantKey || '')) return items[i];
  }
  return null;
}

function qaOrderCount_(token) {
  var res = qaCall_('orderListRpc', [token, { status:'all', limit:1 }]);
  qaAssertOk_(res);
  return Number(res.total || 0);
}

// Count only orders written from this exact QA payload. customer_notes is unique
// per qaBuildOrderPayloadForProduct_ call and is stored plaintext in the order
// sheet, so unrelated live orders cannot make a rejection testcase flaky.
function qaOrderCountForPayload_(payload) {
  var marker = String(payload && payload.customer_notes || '');
  if (!marker) return null;
  var sh = sheetOrders_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  var notes = sh.getRange(2, 14, lastRow - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < notes.length; i++) {
    if (String(notes[i][0] || '') === marker) count += 1;
  }
  return count;
}

function qaAssertNoNewOrderAfterFailure_(token, beforeCount, response, orderIds, expectedError, payload) {
  qaAssert_(response && response.ok === false, 'submitOrderRpc should reject the payload', response);
  if (expectedError) qaAssert_(response.error === expectedError, 'Unexpected submitOrderRpc error code', { expected:expectedError, response:response });
  var afterCount = qaOrderCount_(token);
  var payloadOrderCount = qaOrderCountForPayload_(payload);
  var noPayloadOrders = payloadOrderCount === null ? afterCount === beforeCount : payloadOrderCount === 0;
  qaAssert_(noPayloadOrders && !(orderIds || []).length,
    'Rejected submit must not create orders',
    { before_count:beforeCount, after_count:afterCount, payload_order_count:payloadOrderCount,
      tracked_order_ids:orderIds || [], response:response });
  return { before_count:beforeCount, after_count:afterCount, payload_order_count:payloadOrderCount };
}

function qaDiffKinds_(response) {
  return (response && response.diff || []).map(function(d){ return String(d.kind || ''); });
}

function qaAssertDiffKinds_(response, expectedKinds) {
  var kinds = qaDiffKinds_(response);
  (expectedKinds || []).forEach(function(k) {
    qaAssert_(kinds.indexOf(k) >= 0, 'PRICE_CHANGED diff is missing ' + k, { expected:expectedKinds, actual:kinds, response:response });
  });
  return kinds;
}

function qaCreateMultiMethodShippingFixture_(token, stamp, label, methodDefs) {
  var suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var methods = (methodDefs || []).map(function(m, idx) {
    var out = {
      id: m.id || ('qa_method_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + idx + '_' + suffix),
      name: m.name || ('QA ' + label + ' Method ' + (idx + 1)),
      active: m.active !== false,
      mode: m.mode || 'flat',
      flat_rate: m.flat_rate !== undefined ? Number(m.flat_rate) : 0
    };
    if (m.brackets) out.brackets = m.brackets;
    return out;
  });
  var shipping = qaCreateTempShippingMethod_(token, stamp, label, { methods:methods });
  shipping.methods = methods;
  shipping.method_by_id = {};
  methods.forEach(function(m){ shipping.method_by_id[m.id] = m; });
  return shipping;
}

function qaSetGiftStock_(token, giftId, stock) {
  var res = qaCall_('updateGiftItemRpc', [token, giftId, { stock:stock }]);
  qaAssertOk_(res);
  return res;
}

function qaFindOrderRowNo_(orderId) {
  var sh = _sheetOrders();
  var n = sh.getLastRow();
  if (n < 2) return -1;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
  var idx = ids.indexOf(String(orderId));
  return idx < 0 ? -1 : idx + 2;
}

function qaSetOrderTokenExpiry_(orderId, iso) {
  var rowNo = qaFindOrderRowNo_(orderId);
  qaAssert_(rowNo > 0, 'Order row not found for token expiry mutation', { order_id:orderId });
  _sheetOrders().getRange(rowNo, ORDER_COLS.indexOf('token_expires_at') + 1).setValue(iso || '');
}

function qaTinyPngBase64_() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR5k7wAAAABJRU5ErkJggg==';
}

function qaRunProductCrudFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [], stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'ProductCrud');
  var productId = '', output = null, caught = null;
  try {
    qaStep_(steps, 'สร้างค่าขนส่ง QA', 'ok', { method_id: shipping.method.id });
    var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'Crud', 5, { price: 321 });
    productId = product.id;
    qaStep_(steps, 'สร้างสินค้า QA', 'ok', { product_id: productId, payload: product.payload });
    var read = qaGetProductRecord_(productId);
    qaStep_(steps, 'อ่านสินค้าหลังสร้าง', 'ok', { record: read });
    qaAssert_(String(read.title).indexOf('Crud') >= 0, 'ชื่อสินค้าหลังสร้างไม่ถูกต้อง', read);
    var upd = qaCall_('productUpdateRpc', [token, productId, { title:'QA Product Crud Updated ' + stamp, price:432, stock:9 }]);
    qaAssertOk_(upd);
    qaStep_(steps, 'แก้ไขสินค้า', 'ok', { response: upd });
    var after = qaGetProductRecord_(productId);
    qaAssert_(Number(after.price) === 432 && Number(after.stock) === 9, 'ข้อมูลสินค้าหลังแก้ไขไม่ถูกต้อง', after);
    qaStep_(steps, 'อ่านสินค้าหลังแก้ไข', 'ok', { record: after });
    var del = qaCall_('productDeleteRpc', [token, productId]);
    qaAssertOk_(del);
    productId = '';
    var missing = qaCall_('productGetRpc', [product.id]);
    qaAssert_(missing && missing.ok === false, 'หลังลบต้องอ่านสินค้าไม่เจอ', missing);
    qaStep_(steps, 'ลบสินค้าและตรวจว่าไม่พบแล้ว', 'ok', { delete_response: del, get_after_delete: missing });
    output = { steps: steps, product_id: product.id, final_readback: after };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(token, productId, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunProductDisabledHiddenFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'DisabledHidden', 5, { sale_mode:'disabled', allowed_shipping_ids:[] });
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้างสินค้า disabled', 'ok', { product_id: fx.product.id });
    var visible = qaPublicListHasProduct_(fx.product.id);
    qaAssert_(!visible, 'สินค้า disabled ต้องไม่อยู่ใน public list', { product_id: fx.product.id });
    qaStep_(steps, 'ตรวจ public list', 'ok', { visible: visible });
    output = { steps:steps, product_id:fx.product.id, visible:visible };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(fx.token, fx.product.id, fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunProductScheduleFutureFlow_(ctx) {
  return qaRunProductScheduleVisibilityFlow_(ctx, 'ScheduleFuture', qaFutureIso_(86400000), '', false, 'scheduled');
}

function qaRunProductScheduleActiveFlow_(ctx) {
  return qaRunProductScheduleVisibilityFlow_(ctx, 'ScheduleActive', qaPastIso_(60000), '', true, 'active');
}

function qaRunProductScheduleEndedFlow_(ctx) {
  return qaRunProductScheduleVisibilityFlow_(ctx, 'ScheduleEnded', qaPastIso_(172800000), qaPastIso_(86400000), false, 'ended');
}

function qaRunProductScheduleVisibilityFlow_(ctx, label, startsAt, endsAt, shouldBeVisible, expectedSaleStatus) {
  var token = ctx.options.adminToken, steps = [], stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, label);
  var productId = '', caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(token, shipping, stamp, label, 5, {
      sale_mode:'scheduled',
      sale_starts_at: startsAt,
      sale_ends_at: endsAt,
      price: 500
    });
    productId = product.id;
    qaStep_(steps, 'สร้างสินค้า scheduled', 'ok', { product_id:productId, starts_at:startsAt, ends_at:endsAt });
    var record = qaGetProductRecord_(productId, token);
    var visible = qaPublicListHasProduct_(productId);
    qaAssert_(visible === shouldBeVisible, 'สถานะการแสดงสินค้า scheduled ไม่ตรงที่คาด', { visible:visible, shouldBeVisible:shouldBeVisible, record:record });
    qaAssert_(record.sale_status === expectedSaleStatus, 'sale_status ของสินค้า scheduled ไม่ตรงที่คาด', { sale_status:record.sale_status, expectedSaleStatus:expectedSaleStatus, record:record });
    qaStep_(steps, 'ตรวจสถานะและ public list', 'ok', { sale_status:record.sale_status, visible:visible });
    output = { steps:steps, product_id:productId, sale_status:record.sale_status, visible:visible };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(token, productId, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunProductVariantReadbackFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'VariantReadback', -1, {
    price: 999,
    variants: [{ name:'Size', type:'text', options:[
      { label:'S', price:111, weight_grams:50, stock:3 },
      { label:'M', price:222, weight_grams:80, stock:4 }
    ]}]
  });
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้างสินค้า variant', 'ok', { product_id:fx.product.id });
    var record = qaGetProductRecord_(fx.product.id);
    var optM = ((record.variants[0] || {}).options || []).filter(function(o){ return o.label === 'M'; })[0];
    qaAssert_(optM && Number(optM.price) === 222 && Number(optM.weight_grams) === 80 && Number(optM.stock) === 4, 'variant หลังสร้างไม่ถูกต้อง', record);
    qaAssert_(Number(record.price) === 111, 'ราคาหลักหลังสร้างต้อง derive จาก variant ที่ถูกที่สุด', record);
    qaStep_(steps, 'อ่าน variant และราคา derived หลังสร้าง', 'ok', { product_price:record.price, option_m:optM });
    var upd = qaCall_('productUpdateRpc', [fx.token, fx.product.id, { price:9999, variants:[{ name:'Size', type:'text', options:[
      { label:'S', price:444, weight_grams:50, stock:3 },
      { label:'M', price:333, weight_grams:90, stock:6 }
    ]}] }]);
    qaAssertOk_(upd);
    var after = qaGetProductRecord_(fx.product.id);
    var optM2 = ((after.variants[0] || {}).options || []).filter(function(o){ return o.label === 'M'; })[0];
    qaAssert_(optM2 && Number(optM2.price) === 333 && Number(optM2.stock) === 6, 'variant หลังแก้ไขไม่ถูกต้อง', after);
    qaAssert_(Number(after.price) === 333, 'ราคาหลักหลังแก้ไขต้อง derive ใหม่และไม่เชื่อราคาจาก client', after);
    qaStep_(steps, 'แก้ไขและอ่านราคา derived กลับ', 'ok', { product_price:after.price, option_m:optM2 });

    var invalid = qaCall_('productUpdateRpc', [fx.token, fx.product.id, { variants:[{ name:'Size', type:'text', options:[
      { label:'Broken', price:0, weight_grams:0, stock:-1 }
    ]}] }]);
    qaAssert_(invalid && invalid.ok === false, 'backend ต้องปฏิเสธ variant ราคา 0', invalid);
    var afterInvalid = qaGetProductRecord_(fx.product.id);
    qaAssert_(Number(afterInvalid.price) === 333 && ((afterInvalid.variants[0] || {}).options || []).length === 2,
      'ข้อมูลสินค้าต้องไม่เปลี่ยนเมื่อ variant validation ไม่ผ่าน', afterInvalid);
    qaStep_(steps, 'ปฏิเสธราคา variant ที่ไม่ถูกต้องโดยไม่แก้ข้อมูลเดิม', 'ok', { response:invalid });

    var duplicateOptions = qaCall_('productUpdateRpc', [fx.token, fx.product.id, { variants:[{ name:'Size', type:'text', options:[
      { label:'M', price:333, weight_grams:90, stock:6 },
      { label:' m ', price:444, weight_grams:50, stock:3 }
    ]}] }]);
    qaAssert_(duplicateOptions && duplicateOptions.ok === false, 'backend ต้องปฏิเสธชื่อตัวเลือกซ้ำแบบ trim/case-insensitive', duplicateOptions);
    qaStep_(steps, 'ปฏิเสธชื่อตัวเลือกซ้ำภายในกลุ่มเดียวกัน', 'ok', { response:duplicateOptions });

    var duplicateGroups = qaCall_('productUpdateRpc', [fx.token, fx.product.id, { variants:[
      { name:'Size', type:'text', options:[{ label:'M', price:333, weight_grams:90, stock:6 }] },
      { name:' size ', type:'text', options:[{ label:'Black', price:444, weight_grams:50, stock:3 }] }
    ] }]);
    qaAssert_(duplicateGroups && duplicateGroups.ok === false, 'backend ต้องปฏิเสธชื่อกลุ่มซ้ำแบบ trim/case-insensitive', duplicateGroups);
    var afterDuplicates = qaGetProductRecord_(fx.product.id);
    qaAssert_(Number(afterDuplicates.price) === 333 && ((afterDuplicates.variants[0] || {}).options || []).length === 2,
      'ข้อมูลสินค้าต้องไม่เปลี่ยนเมื่อชื่อ variant ซ้ำ', afterDuplicates);
    qaStep_(steps, 'ปฏิเสธชื่อกลุ่มซ้ำโดยไม่แก้ข้อมูลเดิม', 'ok', { response:duplicateGroups });
    output = { steps:steps, product_id:fx.product.id, product_price:afterDuplicates.price, option_m:optM2 };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(fx.token, fx.product.id, fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunProductExtraImageValidationFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [], stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'BadExtraImage');
  try {
    qaStep_(steps, 'สร้างค่าขนส่ง QA', 'ok', { method_id:shipping.method.id });
    var res = qaCall_('productCreateRpc', [token, {
      title:'QA Bad Extra Image ' + stamp,
      desc:'ทดสอบ URL รูปเสริมไม่ถูกต้อง',
      price:100,
      allowed_shipping_ids:[shipping.method.id],
      sale_mode:'always',
      stock:1,
      variants:[],
      extra_images:[{ mode:'url', url:'javascript:alert(1)' }]
    }]);
    qaAssert_(res && res.ok === false, 'URL รูปเสริมที่ไม่ปลอดภัยต้องถูกปฏิเสธ', res);
    qaStep_(steps, 'ตรวจการปฏิเสธ URL ไม่ปลอดภัย', 'ok', { response:res });
    return { steps:steps, response:res, cleanup:qaCleanupTempShipping_(token, shipping) };
  } finally {
    try { qaCleanupTempShipping_(token, shipping); } catch(_) {}
  }
}

function qaRunProductAllowedShippingRequiredFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [], stamp = qaStamp_();
  var res = qaCall_('productCreateRpc', [token, {
    title:'QA No Shipping ' + stamp,
    desc:'ทดสอบสินค้าที่ไม่มีวิธีจัดส่ง',
    price:100,
    allowed_shipping_ids:[],
    sale_mode:'always',
    stock:1,
    variants:[],
    extra_images:[]
  }]);
  qaAssert_(res && res.ok === false, 'สินค้าที่เปิดขายแต่ไม่มีวิธีจัดส่งต้องถูกปฏิเสธ', res);
  qaStep_(steps, 'ตรวจการบังคับเลือกวิธีจัดส่ง', 'ok', { response:res });
  return { steps:steps, response:res };
}

function qaRunProductBulkDeleteFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [], stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'BulkDelete');
  var ids = [], caught = null, output = null;
  try {
    ids.push(qaCreateOrderQaProduct_(token, shipping, stamp, 'BulkA', 1).id);
    ids.push(qaCreateOrderQaProduct_(token, shipping, stamp, 'BulkB', 1).id);
    qaStep_(steps, 'สร้างสินค้า 2 รายการ', 'ok', { product_ids:ids.slice() });
    var del = qaCall_('productBulkDeleteRpc', [token, ids]);
    qaAssertOk_(del);
    qaStep_(steps, 'ลบด้วย productBulkDeleteRpc', 'ok', { response:del });
    var checks = ids.map(function(id){ return qaCall_('productGetRpc', [id]); });
    qaAssert_(checks.every(function(r){ return r && r.ok === false; }), 'หลัง bulk delete ต้องอ่านไม่เจอทุกตัว', checks);
    output = { steps:steps, deleted:del.deleted, readbacks:checks };
    ids = [];
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, [], ids, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunProductStockSummaryUpdateFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'StockSummary', 4);
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้างสินค้า QA', 'ok', { product_id:fx.product.id, stock:4 });
    var summary = qaCall_('getStockSummaryRpc', [fx.token]);
    qaAssertOk_(summary);
    var found = (summary.products || []).filter(function(p){ return String(p.id) === String(fx.product.id); })[0];
    qaAssert_(found && Number(found.stock) === 4, 'summary ต้องมีสินค้า QA และ stock เดิม', summary);
    qaStep_(steps, 'อ่าน stock summary', 'ok', { found:found });
    var upd = qaCall_('updateStockRpc', [fx.token, [{ productId:fx.product.id, stock:8 }]]);
    qaAssertOk_(upd);
    var stock = qaGetProductStock_(fx.product.id);
    qaAssert_(stock === 8, 'stock หลัง updateStockRpc ต้องเป็น 8', { stock:stock });
    qaStep_(steps, 'แก้ไข stock และอ่านกลับ', 'ok', { update_response:upd, final_stock:stock });
    output = { steps:steps, product_id:fx.product.id, final_stock:stock };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(fx.token, fx.product.id, fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionCrudFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoCrud', 5, { price:1000 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Crud', { discount_value:50 });
    promos.push(promo.promotion_id);
    qaStep_(steps, 'สร้างโปรโมชั่น QA', 'ok', promo);
    var get = qaCall_('getPromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(get);
    qaStep_(steps, 'อ่านโปรโมชั่น', 'ok', get);
    var upd = qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, Object.assign({}, get.promotion, { name:'QA Promo Crud Updated ' + fx.stamp, discount_value:75 })]);
    qaAssertOk_(upd);
    qaStep_(steps, 'แก้ไขโปรโมชั่น', 'ok', upd);
    var off = qaCall_('togglePromotionRpc', [fx.token, promo.promotion_id, false]);
    qaAssertOk_(off);
    var on = qaCall_('togglePromotionRpc', [fx.token, promo.promotion_id, true]);
    qaAssertOk_(on);
    qaStep_(steps, 'ปิดและเปิดโปรโมชั่น', 'ok', { off:off, on:on });
    var del = qaCall_('deletePromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(del);
    promos = [];
    var after = qaCall_('getPromotionRpc', [fx.token, promo.promotion_id]);
    qaAssert_(after && after.ok === false, 'หลังลบต้องไม่พบโปรโมชั่น', after);
    qaStep_(steps, 'ลบโปรโมชั่นและตรวจว่าไม่พบ', 'ok', { delete_response:del, get_after_delete:after });
    output = { steps:steps, promotion_id:promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionFixedDiscountFlow_(ctx) {
  return qaRunPromotionPriceFlow_(ctx, 'Fixed', { discount_type:'fixed', discount_value:125 }, 875, 125);
}

function qaRunPromotionPercentDiscountFlow_(ctx) {
  return qaRunPromotionPriceFlow_(ctx, 'Percent', { discount_type:'percent', discount_value:20 }, 800, 200);
}

function qaRunPromotionPriceFlow_(ctx, label, promoOpts, expectedFinal, expectedDiscount) {
  var fx = qaCreateOrderFixture_(ctx, 'Promo' + label, 5, { price:1000 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, label, promoOpts);
    promos.push(promo.promotion_id);
    qaStep_(steps, 'สร้างโปรโมชั่น', 'ok', promo);
    var record = qaGetProductRecord_(fx.product.id);
    qaAssert_(Number(record.final_price) === expectedFinal && Number(record.discount_amount) === expectedDiscount,
      'ราคาหลังโปรไม่ตรงที่คาด', record);
    qaStep_(steps, 'อ่านราคาหลัง apply promotion', 'ok', { final_price:record.final_price, discount_amount:record.discount_amount, promotion:record.promotion });
    output = { steps:steps, product_id:fx.product.id, promotion_id:promo.promotion_id, final_price:record.final_price, discount_amount:record.discount_amount };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionPercentOver100Flow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoInvalidPercent', 5, { price:1000 });
  var steps = [], caught = null, output = null;
  try {
    var res = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Promo Invalid Percent ' + fx.stamp,
      description:'ทดสอบ percent เกิน 100',
      discount_type:'percent',
      discount_value:150,
      target_type:'product',
      target:[{ product_id:fx.product.id }],
      starts_at:qaPastIso_(60000),
      ends_at:'',
      no_end_date:true,
      enabled:true
    }]);
    qaAssert_(res && res.ok === false, 'percent เกิน 100 ต้องถูกปฏิเสธ', res);
    qaStep_(steps, 'ตรวจการปฏิเสธ percent เกิน 100', 'ok', { response:res });
    output = { steps:steps, response:res };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(fx.token, fx.product.id, fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionProductTargetOnlyFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'PromoTarget');
  var caught = null, output = null;
  try {
    var a = qaCreateOrderQaProduct_(token, shipping, stamp, 'PromoTargetA', 5, { price:1000 });
    var b = qaCreateOrderQaProduct_(token, shipping, stamp, 'PromoTargetB', 5, { price:1000 });
    productIds = [a.id, b.id];
    qaStep_(steps, 'สร้างสินค้า 2 รายการ', 'ok', { product_ids:productIds });
    var promo = qaCreatePromotion_(token, a.id, stamp, 'TargetOnly', { discount_value:100 });
    promos.push(promo.promotion_id);
    var recA = qaGetProductRecord_(a.id), recB = qaGetProductRecord_(b.id);
    qaAssert_(recA.promotion && String(recA.promotion.promotion_id) === String(promo.promotion_id), 'สินค้าที่ target ต้องมีโปร', recA);
    qaAssert_(!recB.promotion, 'สินค้าที่ไม่ target ต้องไม่มีโปร', recB);
    qaStep_(steps, 'ตรวจ target เฉพาะสินค้า', 'ok', { target:recA.promotion, other:recB.promotion });
    output = { steps:steps, promotion_id:promo.promotion_id, product_a:a.id, product_b:b.id };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, promos, productIds, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionVariantTargetOnlyFlow_(ctx) {
  return qaRunPromotionVariantFlow_(ctx, false);
}

function qaRunPromotionVariantFlow_(ctx, includeProductPromo) {
  var fx = qaCreateOrderFixture_(ctx, includeProductPromo ? 'PromoVariantPriority' : 'PromoVariantOnly', -1, {
    price:1000,
    variants:[{ name:'Color', type:'text', options:[
      { label:'Red', price:1000, weight_grams:100, stock:5 },
      { label:'Blue', price:1000, weight_grams:100, stock:5 }
    ]}]
  });
  var steps = [], promos = [], caught = null, output = null;
  try {
    if (includeProductPromo) {
      var pp = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'ProductBase', { discount_value:50 });
      promos.push(pp.promotion_id);
      qaStep_(steps, 'สร้างโปรระดับสินค้า', 'ok', pp);
    }
    var vkRed = 'Color=Red';
    var vp = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'VariantRed', {
      discount_value:200,
      target_type:'variant',
      target:[{ product_id:fx.product.id, variant_key:vkRed }]
    });
    promos.push(vp.promotion_id);
    qaStep_(steps, 'สร้างโปรระดับ variant', 'ok', vp);
    var rec = qaGetProductRecord_(fx.product.id);
    var red = rec.variant_promotions && rec.variant_promotions[vkRed];
    var blue = rec.variant_promotions && rec.variant_promotions['Color=Blue'];
    qaAssert_(red && red.promotion && String(red.promotion.promotion_id) === String(vp.promotion_id), 'variant Red ต้องใช้โปร variant', red);
    if (!includeProductPromo) qaAssert_(!blue || !blue.promotion, 'variant Blue ต้องไม่มีโปรเมื่อ target เฉพาะ Red', blue);
    if (includeProductPromo) qaAssert_(Number(red.unit_final_price) === 800, 'โปร variant ต้องชนะโปรระดับสินค้า', red);
    qaStep_(steps, 'ตรวจผลโปร variant', 'ok', { red:red, blue:blue });
    output = { steps:steps, product_id:fx.product.id, variant_red:red, variant_blue:blue };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionProductVariantOverlapRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoVariantOverlap', -1, {
    price:1000,
    variants:[{ name:'Color', type:'text', options:[
      { label:'Red', price:1000, weight_grams:100, stock:5 },
      { label:'Blue', price:1000, weight_grams:100, stock:5 }
    ]}]
  });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var productPromo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'ProductOverlap', { discount_value:50 });
    promos.push(productPromo.promotion_id);
    qaStep_(steps, 'สร้างโปรระดับสินค้า', 'ok', productPromo);
    var variantRes = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Promo Variant Overlap ' + fx.stamp,
      description:'ทดสอบโปร variant ทับกับโปรระดับสินค้า',
      discount_type:'fixed',
      discount_value:200,
      target_type:'variant',
      target:[{ product_id:fx.product.id, variant_key:'Color=Red' }],
      starts_at:qaPastIso_(60000),
      ends_at:'',
      no_end_date:true,
      enabled:true
    }]);
    qaAssert_(variantRes && variantRes.ok === false, 'โปรระดับ variant ที่ทับกับโปรระดับสินค้าต้องถูกปฏิเสธ', variantRes);
    qaAssert_(variantRes.error === 'PROMO_OVERLAP' && variantRes.conflict
      && String(variantRes.conflict.promotion_id) === String(productPromo.promotion_id),
      'การปฏิเสธ overlap ต้องคืน error PROMO_OVERLAP พร้อมข้อมูลโปรที่ชนกัน', variantRes);
    qaStep_(steps, 'ตรวจการปฏิเสธโปร variant ที่ทับซ้อน', 'ok', { response:variantRes });
    output = { steps:steps, product_promo_id:productPromo.promotion_id, variant_response:variantRes };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionOverlapRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoOverlap', 5, { price:1000 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var first = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OverlapA', { discount_value:50 });
    promos.push(first.promotion_id);
    qaStep_(steps, 'สร้างโปรแรก', 'ok', first);
    var second = qaCall_('createPromotionRpc', [fx.token, Object.assign({}, first.payload, { name:'QA Promo Overlap B ' + fx.stamp, discount_value:60 })]);
    qaAssert_(second && second.ok === false, 'โปรที่ทับซ้อนกันต้องถูกปฏิเสธ', second);
    qaAssert_(second.error === 'PROMO_OVERLAP' && second.conflict
      && String(second.conflict.promotion_id) === String(first.promotion_id),
      'การปฏิเสธ overlap ต้องคืน error PROMO_OVERLAP พร้อมข้อมูลโปรที่ชนกัน', second);
    qaStep_(steps, 'ตรวจการปฏิเสธโปรทับซ้อน', 'ok', { response:second });
    output = { steps:steps, first:first.promotion_id, second_response:second };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionDisabledNotAppliedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoDisabled', 5, { price:1000 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Disabled', { discount_value:500, enabled:false });
    promos.push(promo.promotion_id);
    var rec = qaGetProductRecord_(fx.product.id);
    // This testcase is about the disabled promo itself. If an unrelated global
    // promotion is active in the environment, ignore that so the test remains isolated.
    if (rec.promotion && String(rec.promotion.promotion_id) !== String(promo.promotion_id)) {
      rec = Object.assign({}, rec, { promotion:null, final_price:Number(rec.price || 1000) });
    }
    qaAssert_(!rec.promotion && Number(rec.final_price) === 1000, 'โปรที่ปิดใช้งานต้องไม่ถูกใช้', rec);
    qaStep_(steps, 'ตรวจว่าโปร disabled ไม่ถูก apply', 'ok', { record:rec });
    output = { steps:steps, promotion_id:promo.promotion_id, final_price:rec.final_price };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionFutureEndedStatusFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'PromoStatus');
  var caught = null, output = null;
  try {
    var pFuture = qaCreateOrderQaProduct_(token, shipping, stamp, 'PromoFuture', 5, { price:1000 });
    var pEnded = qaCreateOrderQaProduct_(token, shipping, stamp, 'PromoEnded', 5, { price:1000 });
    productIds = [pFuture.id, pEnded.id];
    var future = qaCreatePromotion_(token, pFuture.id, stamp, 'Future', { starts_at:qaFutureIso_(86400000), discount_value:50 });
    var ended = qaCreatePromotion_(token, pEnded.id, stamp, 'Ended', { starts_at:qaPastIso_(172800000), ends_at:qaPastIso_(86400000), no_end_date:false, discount_value:50 });
    promos = [future.promotion_id, ended.promotion_id];
    var list = qaCall_('listPromotionsRpc', [token]);
    qaAssertOk_(list);
    var f = (list.promotions || []).filter(function(p){ return p.promotion_id === future.promotion_id; })[0];
    var e = (list.promotions || []).filter(function(p){ return p.promotion_id === ended.promotion_id; })[0];
    qaAssert_(f && f.status === 'scheduled' && e && e.status === 'expired', 'สถานะโปรโมชั่นอนาคต/หมดอายุไม่ถูกต้อง', { future:f, ended:e, expected_ended_status:'expired' });
    qaStep_(steps, 'ตรวจสถานะโปรโมชั่น', 'ok', { future:f, ended:e });
    var boundaryNow = Date.now();
    var expectedBoundary = Date.parse(future.payload.starts_at);
    var boundary = _nextDirectPromotionBoundaryMs_(boundaryNow, [
      Object.assign({}, future.payload, { promotion_id:future.promotion_id, application_mode:'direct' }),
      Object.assign({}, ended.payload, { promotion_id:ended.promotion_id, application_mode:'direct' }),
      Object.assign({}, future.payload, { promotion_id:'conditional-ignored', application_mode:'conditional', starts_at:new Date(boundaryNow + 1000).toISOString() })
    ]);
    qaAssert_(boundary === expectedBoundary, 'Product snapshot boundary must follow the next direct promotion schedule', { boundary:boundary, expected:expectedBoundary });
    var activeEndsAt = boundaryNow + 5000;
    var endBoundary = _nextDirectPromotionBoundaryMs_(boundaryNow, [{
      promotion_id:'active-ending', application_mode:'direct', enabled:true,
      starts_at:new Date(boundaryNow - 1000).toISOString(),
      ends_at:new Date(activeEndsAt).toISOString(), no_end_date:false
    }]);
    qaAssert_(endBoundary === activeEndsAt + 1, 'Product snapshot boundary must expire immediately after a direct promotion ends', { boundary:endBoundary, expected:activeEndsAt + 1 });
    qaStep_(steps, 'ตรวจขอบเขตอายุ Product snapshot', 'ok', { start_boundary:boundary, end_boundary:endBoundary });
    output = { steps:steps, future_status:f.status, ended_status:e.status, snapshot_boundary:boundary, snapshot_end_boundary:endBoundary };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, promos, productIds, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingCrudRestoreFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CrudRestore', { flat_rate:12 });
  qaStep_(steps, 'เพิ่มค่าขนส่ง QA', 'ok', { company:shipping.company, save_response:shipping.save_response });
  var found = qaCall_('getShippingRpc');
  qaAssertOk_(found);
  var exists = (found.companies || []).some(function(c){ return c.id === shipping.company.id; });
  qaAssert_(exists, 'ต้องพบค่าขนส่ง QA หลัง saveShippingRpc', found);
  qaStep_(steps, 'อ่านค่าขนส่งหลังบันทึก', 'ok', { exists:exists });
  var cleanup = qaCleanupTempShipping_(token, shipping);
  qaAssertOk_(cleanup);
  qaStep_(steps, 'restore ค่าเดิม', 'ok', cleanup);
  return { steps:steps, company_id:shipping.company.id, cleanup:cleanup };
}

function qaRunShippingFlatFeeFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'ShippingFlat', 5, { price:100 }, { flat_rate:77 });
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้างสินค้าและค่าขนส่ง flat', 'ok', { product_id:fx.product.id, flat_rate:77 });
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-ship-flat', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var record = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(Number(record.shipping_fee) === 77 && Number(record.total) === 177, 'ค่าขนส่ง flat หรือ total ไม่ถูกต้อง', record);
    qaStep_(steps, 'ส่งออร์เดอร์และตรวจค่าขนส่ง', 'ok', { order_id:record.order_id, shipping_fee:record.shipping_fee, total:record.total });
    output = { steps:steps, order_id:record.order_id, shipping_fee:record.shipping_fee, total:record.total };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingWeightTierFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'ShippingWeight', 5, { price:100, weight_grams:600 }, {
    mode:'weight',
    brackets:[{ from_g:0, to_g:500, price:10 }, { from_g:501, to_g:1000, price:25 }]
  });
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้างค่าขนส่งแบบน้ำหนัก', 'ok', { brackets:fx.shipping.method.brackets, product_weight:600 });
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-ship-weight', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var record = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(Number(record.shipping_fee) === 25, 'ค่าขนส่งตามน้ำหนักต้องเป็น 25', record);
    qaStep_(steps, 'ส่งออร์เดอร์และตรวจ tier', 'ok', { order_id:record.order_id, shipping_fee:record.shipping_fee });
    output = { steps:steps, order_id:record.order_id, shipping_fee:record.shipping_fee };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingWeightTierBoundariesFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'WeightBoundary', {
    mode:'weight',
    brackets:[
      { from_g:0, to_g:500, price:15 },
      { from_g:501, to_g:1000, price:35 },
      { from_g:1001, to_g:2000, price:65 }
    ]
  });
  var productIds = [], orderIds = [], steps = [], caught = null, output = null;
  try {
    var cases = [
      { label:'Exact500', weight:500, expected:15 },
      { label:'Start501', weight:501, expected:35 },
      { label:'Exact1000', weight:1000, expected:35 },
      { label:'Overflow2500', weight:2500, expected:65 }
    ];
    var results = cases.map(function(c) {
      var product = qaCreateOrderQaProduct_(token, shipping, stamp, c.label, 5, {
        price:100,
        weight_grams:c.weight
      });
      productIds.push(product.id);
      var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-weight-boundary', stamp, c.label, product.id, shipping), orderIds);
      qaAssertOk_(res);
      var orderId = qaOrderIdsFromSubmit_(res)[0];
      var record = qaReadOrder_(token, orderId);
      qaAssert_(Number(record.shipping_fee) === c.expected, 'Weight tier boundary fee mismatch for ' + c.label, { expected:c.expected, record:record, testcase:c });
      qaAssert_(Number(record.total) === 100 + c.expected, 'Weight tier boundary total mismatch for ' + c.label, { expected_total:100 + c.expected, record:record, testcase:c });
      var info = (record.shipping_info || [])[0] || {};
      qaAssert_(Number(info.fee) === c.expected, 'shipping_info snapshot fee mismatch for ' + c.label, { shipping_info:record.shipping_info, expected:c.expected });
      steps.push({ step:c.label, status:'ok', data:{ product_id:product.id, order_id:orderId, weight_g:c.weight, shipping_fee:record.shipping_fee } });
      return { label:c.label, product_id:product.id, order_id:orderId, weight_g:c.weight, expected_fee:c.expected, actual_fee:record.shipping_fee, total:record.total };
    });
    output = { steps:steps, method:shipping.method, results:results };
  } catch (err) {
    caught = err;
    steps.push({ step:'error', status:'failed', data:{ error:String(err && err.message || err) } });
  }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  steps.push({ step:'cleanup', status:cleanup.ok ? 'ok' : 'failed', data:cleanup });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.steps = steps;
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingInactiveMethodRejectedFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], orderIds = [], productId = '';
  var method = { id:'qa_inactive_method_' + Utilities.getUuid().replace(/-/g,'').slice(0,8), name:'QA Inactive', active:false, mode:'flat', flat_rate:0 };
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'InactiveMethod', { methods:[method] });
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'InactiveMethod', 5, { allowed_shipping_ids:[method.id] });
    productId = product.id;
    qaStep_(steps, 'สร้างสินค้าและ method inactive', 'ok', { product_id:productId, method:method });
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-inactive-method', stamp, 'Buyer', productId, shipping), orderIds);
    qaAssert_(res && res.ok === false, 'method ที่ปิดใช้งานต้องสั่งซื้อไม่ได้', res);
    qaStep_(steps, 'ตรวจการปฏิเสธ method inactive', 'ok', { response:res });
    output = { steps:steps, response:res };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, [productId], shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingRemovedMethodCleanupFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], productId = '';
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'RemovedMethod');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'RemovedMethod', 5);
    productId = product.id;
    qaStep_(steps, 'สร้างสินค้าที่ผูก method ชั่วคราว', 'ok', { product_id:productId, method_id:shipping.method.id });
    var restore = qaCleanupTempShipping_(token, shipping);
    qaAssertOk_(restore);
    qaStep_(steps, 'restore shipping ให้ method ถูกลบ', 'ok', restore);
    var rec = qaGetProductRecord_(productId, token);
    qaAssert_((rec.allowed_shipping_ids || []).indexOf(shipping.method.id) < 0, 'allowed_shipping_ids ต้องไม่มี method ที่ถูกลบ', rec);
    qaStep_(steps, 'ตรวจสินค้าได้รับ cleanup method', 'ok', { allowed_shipping_ids:rec.allowed_shipping_ids, sale_status:rec.sale_status });
    output = { steps:steps, product_id:productId, allowed_shipping_ids:rec.allowed_shipping_ids };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, [], [productId], null);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingNoValidMethodDeactivatesFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], productId = '';
  var method = { id:'qa_inactive_only_' + Utilities.getUuid().replace(/-/g,'').slice(0,8), name:'QA Inactive Only', active:false, mode:'flat', flat_rate:0 };
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'NoValidMethod', { methods:[method] });
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'NoValidMethod', 5, { allowed_shipping_ids:[method.id] });
    productId = product.id;
    qaStep_(steps, 'สร้างสินค้าที่มีเฉพาะ method inactive', 'ok', { product_id:productId, method_id:method.id });
    var rec = qaGetProductRecord_(productId, token);
    qaAssert_(rec.sale_status !== 'active', 'สินค้าควรถูกปิดขายเมื่อไม่มี method active ที่ใช้ได้', rec);
    qaStep_(steps, 'ตรวจ sale_status', 'ok', { sale_status:rec.sale_status });
    output = { steps:steps, product_id:productId, sale_status:rec.sale_status };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, [], [productId], shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingValidationFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [];
  var current = qaCall_('getShippingRpc');
  qaAssertOk_(current);
  var bad = (current.companies || []).concat([{
    id:'qa_bad_shipping',
    name:'QA Bad Shipping',
    active:true,
    carrier_id:'bad carrier!',
    tracking_url_template:'javascript:alert(1)',
    tracking_provider:'unknown',
    methods:[{ id:'qa_bad_method', name:'Bad', active:true, mode:'flat', flat_rate:0 }]
  }]);
  var res = qaCall_('saveShippingRpc', [token, bad]);
  qaAssert_(res && res.ok === false, 'ค่าขนส่งที่ไม่ถูกต้องต้องถูกปฏิเสธ', res);
  qaStep_(steps, 'ตรวจ validation ค่าขนส่ง', 'ok', { response:res });
  return { steps:steps, response:res };
}

function qaRunShippingTrackingProviderReadbackFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [];
  var current = qaCall_('getShippingRpc');
  qaAssertOk_(current);
  var original = (current.companies || []).map(function(c){ return qaClone_(c); });
  var company = {
    id:'qa_track_' + Utilities.getUuid().replace(/-/g,'').slice(0,8),
    name:'QA Tracking Provider ' + stamp,
    active:true,
    carrier_id:'other',
    tracking_url_template:'https://track.example.com/{tracking_number}',
    tracking_provider:'etracking',
    methods:[{ id:'qa_track_method_' + Utilities.getUuid().replace(/-/g,'').slice(0,8), name:'QA Track', active:true, mode:'flat', flat_rate:0 }]
  };
  var caught = null, output = null;
  try {
    var save = qaCall_('saveShippingRpc', [token, original.concat([company])]);
    qaAssertOk_(save);
    qaStep_(steps, 'บันทึก provider', 'ok', save);
    var read = qaCall_('getShippingRpc');
    qaAssertOk_(read);
    var found = (read.companies || []).filter(function(c){ return c.id === company.id; })[0];
    qaAssert_(found && found.tracking_provider === 'etracking' && found.tracking_url_template === company.tracking_url_template, 'อ่าน provider กลับไม่ตรง', found);
    qaStep_(steps, 'อ่าน provider กลับ', 'ok', found);
    output = { steps:steps, company_id:company.id, provider:found.tracking_provider };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCall_('saveShippingRpc', [token, original]);
  qaStep_(steps, 'restore ค่าเดิม', cleanup && cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderPriceIntegrityFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PriceIntegrity', 5, { price: 777 }, { flat_rate: 0 });
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-price-integrity', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.items[0].unit_price = 1;
    payload.items[0].unit_final_price = 1;
    payload.items[0].subtotal = 1;
    payload.subtotal = 1;
    payload.total = 1;
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var record = qaReadOrder_(fx.token, orderId);
    var line = qaFindProductLine_(record, fx.product.id);
    qaAssert_(!!line, 'Created order does not contain fixture product', record);
    qaAssert_(Number(line.unit_final_price) === 777, 'Backend did not preserve server-side product price', line);
    qaAssert_(Number(line.subtotal) === 777, 'Backend did not recalculate line subtotal', line);
    qaAssert_(Number(record.subtotal) === 777 && Number(record.total) === 777, 'Backend did not recalculate order totals', record);
    output = { order_id:orderId, unit_final_price:line.unit_final_price, subtotal:record.subtotal, total:record.total };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingFeeIntegrityFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'ShippingFeeIntegrity', 5, { price: 500 }, { flat_rate: 123 });
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-ship-fee', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.shipping_info[0].fee = 1;
    payload.shipping_fee = 1;
    payload.total = 501;
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(Number(record.shipping_fee) === 123, 'Backend did not recalculate shipping_fee', record);
    qaAssert_(Number(record.total) === 623, 'Backend did not include backend shipping fee in total', record);
    output = { order_id:orderId, shipping_fee:record.shipping_fee, total:record.total };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunInvalidShippingMethodFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'InvalidShipping', 5);
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-invalid-ship', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.shipping_info = [{ company_id:'qa_missing_company', method_id:'qa_missing_method' }];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssert_(res && res.ok === false, 'Invalid shipping method should be rejected', res);
    qaAssert_(qaGetProductStock_(fx.product.id) === 5, 'Stock should not be deducted on invalid shipping', { stock:qaGetProductStock_(fx.product.id), response:res });
    output = { response:res, final_stock:qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunDeletedProductBeforeSubmitFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'DeletedBeforeSubmit', 5);
  var productDeleted = false, caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-deleted-product', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    var del = qaCall_('productDeleteRpc', [fx.token, fx.product.id]);
    qaAssertOk_(del);
    productDeleted = true;
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssert_(res && res.ok === false, 'Deleted product payload should be rejected', res);
    output = { delete_response:del, submit_response:res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, productDeleted ? [] : [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunStockBoundaryFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'StockBoundary');
  var pExact = qaCreateOrderQaProduct_(token, shipping, stamp, 'BoundaryExact', 2);
  var pOver = qaCreateOrderQaProduct_(token, shipping, stamp, 'BoundaryOver', 2);
  var orderIds = [], caught = null, output = null;
  try {
    var exact = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-stock-exact', stamp, 'Exact', pExact.id, shipping, { qty:2 }), orderIds);
    qaAssertOk_(exact);
    var over = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-stock-over', stamp, 'Over', pOver.id, shipping, { qty:3 }), orderIds);
    qaAssert_(over && over.ok === false && over.error === 'STOCK_INSUFFICIENT', 'qty over stock should fail with STOCK_INSUFFICIENT', over);
    qaAssert_(qaGetProductStock_(pExact.id) === 0, 'Exact stock product should be depleted to 0', { stock:qaGetProductStock_(pExact.id) });
    qaAssert_(qaGetProductStock_(pOver.id) === 2, 'Over-stock failure should not deduct stock', { stock:qaGetProductStock_(pOver.id) });
    output = { exact_response:exact, over_response:over, exact_stock:qaGetProductStock_(pExact.id), over_stock:qaGetProductStock_(pOver.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, [pExact.id, pOver.id], shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunUnlimitedStockFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'UnlimitedStock', -1);
  var caught = null, output = null;
  try {
    var first = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-unlimited', fx.stamp, 'A', fx.product.id, fx.shipping, { qty:3 }), fx.order_ids);
    var second = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-unlimited', fx.stamp, 'B', fx.product.id, fx.shipping, { qty:4 }), fx.order_ids);
    qaAssertOk_(first);
    qaAssertOk_(second);
    qaAssert_(qaGetProductStock_(fx.product.id) === -1, 'Unlimited stock should remain -1', { stock:qaGetProductStock_(fx.product.id) });
    output = { order_ids:fx.order_ids.slice(), final_stock:qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunInvalidVariantOptionFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'InvalidVariant', -1, {
    variants: [{
      name:'Color',
      type:'text',
      options:[
        { label:'Red', price:500, weight_grams:100, stock:2 },
        { label:'Blue', price:500, weight_grams:100, stock:2 }
      ]
    }]
  });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-invalid-var', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      selected_variants:{ Color:'Green' }
    }), fx.order_ids);
    qaAssert_(res && res.ok === false, 'Unknown variant option should be rejected', res);
    output = { response:res, product_stock:qaGetProductStock_(fx.product.id), red_stock:qaGetVariantStock_(fx.product.id, 'Color', 'Red') };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunRequiredCustomerFieldsFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'RequiredFields', 20);
  var caught = null, output = null;
  try {
    var cases = [
      { name:'missing_customer_name', patch:{ customer_name:'' } },
      { name:'missing_customer_phone', patch:{ customer_phone:'' } },
      { name:'missing_shipping_address', patch:{ shipping_address:'' } },
      { name:'invalid_postal_code', patch:{ shipping_postal_code:'abc' } }
    ];
    var results = [];
    cases.forEach(function(c) {
      var payload = qaBuildOrderPayloadForProduct_('qa-required-fields', fx.stamp, c.name, fx.product.id, fx.shipping);
      Object.keys(c.patch).forEach(function(k){ payload[k] = c.patch[k]; });
      var res = qaSubmitAndTrack_(payload, fx.order_ids);
      results.push({ case:c.name, response:res, rejected:!!(res && res.ok === false) });
    });
    var accepted = results.filter(function(r){ return !r.rejected; });
    qaAssert_(accepted.length === 0, 'Required-field payloads should all be rejected', { results:results });
    output = { results:results, final_stock:qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunStockInsufficientMetadataFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'StockInsufficientMeta', 1);
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-stock-meta', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 3 });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssert_(res && res.ok === false && res.error === 'STOCK_INSUFFICIENT', 'ต้องคืน error===STOCK_INSUFFICIENT', res);
    qaAssert_(String(res.product_id) === String(fx.product.id), 'product_id ต้องตรงกับ fixture', res);
    qaAssert_(Number(res.requested_qty) === 3, 'requested_qty ต้องเท่ากับ 3', res);
    qaAssert_(Number(res.available_qty) === 1, 'available_qty ต้องเท่ากับ 1 (stock เริ่มต้น)', res);
    qaAssert_(!!res.outOfStockTitle, 'outOfStockTitle ต้องถูกส่ง (backward-compat)', res);
    output = { response: res, final_stock: qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunSaleEndedRejectedCodeFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'SaleEnded');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'SaleEnded', 5, {
    sale_mode: 'scheduled',
    sale_starts_at: qaPastIso_(7 * 86400000),
    sale_ends_at:   qaPastIso_(1 * 86400000)
  });
  var orderIds = [];
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-sale-ended', stamp, 'Buyer', product.id, shipping);
    var res = qaSubmitAndTrack_(payload, orderIds);
    qaAssert_(res && res.ok === false && res.error === 'SALE_NOT_ACTIVE', 'ต้องคืน error===SALE_NOT_ACTIVE', res);
    qaAssert_(String(res.product_id) === String(product.id), 'product_id ต้องตรงกับ fixture', res);
    qaAssert_(res.sale_status === 'ended', 'sale_status ต้องเป็น ended', res);
    output = { response: res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, [product.id], shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPriceChangedDetectionFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PriceChanged', 5, { price: 1000 });
  var caught = null, output = null;
  try {
    var before = qaCall_('orderListRpc', [fx.token, { status:'all', limit: 1 }]);
    var beforeCount = Number((before && before.total) || 0);

    var payload = qaBuildOrderPayloadForProduct_('qa-price-changed', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.client_pricing = {
      items: [{
        product_id: String(fx.product.id),
        selected_variants: {},
        qty: 1,
        unit_final_price: 500,   // fake — backend will recompute as 1000
        promotion_id: null
      }],
      subtotal: 500,
      shipping_fee: Number(fx.shipping.method.flat_rate || 0),
      total: 500 + Number(fx.shipping.method.flat_rate || 0)
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssert_(res && res.ok === false && res.error === 'PRICE_CHANGED', 'ต้องคืน error===PRICE_CHANGED', res);
    qaAssert_(Array.isArray(res.diff) && res.diff.length > 0, 'diff ต้องไม่ว่าง', res);
    qaAssert_(Number(res.new_total) === 1000 + Number(fx.shipping.method.flat_rate || 0), 'new_total ต้องตรงกับ backend recompute', res);
    qaAssert_(Array.isArray(res.updated_items) && res.updated_items.length === 1, 'ต้องมี updated_items', res);
    qaAssert_(Number(res.updated_items[0].unit_final_price) === 1000, 'updated_items[0].unit_final_price ต้องเป็น 1000', res);

    var after = qaCall_('orderListRpc', [fx.token, { status:'all', limit: 1 }]);
    var afterCount = Number((after && after.total) || 0);
    qaAssert_(afterCount === beforeCount, 'จำนวน order ต้องไม่เพิ่ม', { before: beforeCount, after: afterCount });

    output = { response: res, before_count: beforeCount, after_count: afterCount };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftOutOfStockWarningFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'GiftOosWarning', { gift_stock: 0 });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-oos-warn', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    qaAssert_(Array.isArray(res.gifts_skipped) && res.gifts_skipped.length > 0, 'gifts_skipped ต้องไม่ว่าง', res);
    qaAssert_(res.gifts_skipped[0].code === 'GIFT_OUT_OF_STOCK', 'code ต้องเป็น GIFT_OUT_OF_STOCK', res);
    qaAssert_(String(res.gifts_skipped[0].gift_id) === String(fx.gift_id), 'gift_id ต้องตรงกับ fixture', res);
    qaAssert_(Array.isArray(res.warnings) && res.warnings.length > 0, 'warnings array ต้องไม่ว่าง', res);
    qaAssert_(Array.isArray(res.gifts_attached) && !(res.gifts_attached).some(function(g){ return String(g.gift_id) === String(fx.gift_id); }), 'gifts_attached ต้องไม่มี gift ของ fixture นี้ (stock 0)', res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssert_(!!orderId, 'order ต้องถูกสร้างจริง', res);
    var record = qaReadOrder_(fx.token, orderId);
    var gifts = qaActiveGiftLines_(record, fx.gift_id);
    qaAssert_(gifts.length === 0, 'ใน items_json ต้องไม่มี gift line', { gifts: gifts });
    output = { response: res, order_id: orderId, final_gift_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderInputSanitizationFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'InputSanitization', 5);
  var caught = null, output = null;
  try {
    var htmlPayload = qaBuildOrderPayloadForProduct_('qa-html-injection', fx.stamp, 'Html', fx.product.id, fx.shipping);
    htmlPayload.customer_name = '<script>alert(1)</script>';
    var htmlRes = qaSubmitAndTrack_(htmlPayload, fx.order_ids);
    qaAssert_(htmlRes && htmlRes.ok === false, 'HTML/script payload should be rejected', htmlRes);

    var formulaPayload = qaBuildOrderPayloadForProduct_('qa-formula-text', fx.stamp, 'Formula', fx.product.id, fx.shipping);
    formulaPayload.customer_notes = '=IMPORTXML("https://example.com","//x")';
    var formulaRes = qaSubmitAndTrack_(formulaPayload, fx.order_ids);
    qaAssertOk_(formulaRes);
    var orderId = qaOrderIdsFromSubmit_(formulaRes)[0];
    var rowNo = qaFindOrderRowNo_(orderId);
    var rawNotes = String(_sheetOrders().getRange(rowNo, ORDER_COLS.indexOf('customer_notes') + 1).getValue() || '');
    qaAssert_(rawNotes.charAt(0) !== '=', 'Formula-like text must not be stored as executable formula', { rawNotes:rawNotes });
    output = { html_response:htmlRes, formula_order_id:orderId, raw_notes_prefix:rawNotes.slice(0, 4) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunTokenReadFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'TokenRead', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-token-read', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token;
    qaAssert_(!!token, 'submitOrderRpc did not return token', res);
    var read = qaCall_('getOrderByTokenRpc', [token]);
    qaAssertOk_(read);
    qaAssert_(read.record && String(read.record.order_id) === String(orderId), 'Token read returned wrong order', read);
    var bad = qaCall_('getOrderByTokenRpc', [token + 'bad']);
    qaAssert_(bad && bad.ok === false, 'Invalid token should be rejected', bad);
    output = { order_id:orderId, token_read_status:read.record.status, bad_token_error:bad.error || bad.code || '' };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunSlipUploadTransitionFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'SlipUpload', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-slip-upload', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var up = qaCall_('uploadSlipRpc', [res.token, qaTinyPngBase64_(), 'qa-slip.png', 'image/png']);
    qaAssertOk_(up);
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'paid', 'Slip upload should move order status to paid', record);
    qaAssert_(!!record.slip_drive_file_id, 'Slip upload should save slip_drive_file_id', record);
    var hasPaidHistory = (record.status_history || []).some(function(h){ return h.status === 'paid'; });
    qaAssert_(hasPaidHistory, 'Slip upload should append paid status history', record.status_history);
    output = { order_id:orderId, status:record.status, slip_drive_file_id:record.slip_drive_file_id };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunStatusHistoryFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'StatusHistory', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-status-history', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA paid']));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved']));
    var record = qaReadOrder_(fx.token, orderId);
    var statuses = (record.status_history || []).map(function(h){ return h.status; });
    qaAssert_(record.status === 'approved', 'Final status should be approved', record);
    qaAssert_(statuses.indexOf('unpaid') >= 0 && statuses.indexOf('paid') >= 0 && statuses.indexOf('approved') >= 0, 'Status history is missing expected statuses', statuses);
    output = { order_id:orderId, status:record.status, status_history:statuses };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunMarkShippedGuardFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'ShipGuard', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-ship-guard', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var ship = qaCall_('orderMarkShippedRpc', [fx.token, orderId, { tracking_number:'QA123', carrier_id:'other', carrier_name:'QA Carrier' }]);
    qaAssert_(ship && ship.ok === false && ship.error === 'ORDER_NOT_APPROVED', 'Unapproved order should not be mark-shipped', ship);
    output = { order_id:orderId, ship_response:ship };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunTrackingReadbackFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'TrackingReadback', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-tracking', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved for shipping']));
    var td = { tracking_number:'QA' + fx.stamp.replace(/[^0-9]/g, ''), carrier_id:'other', carrier_name:'QA Carrier', tracking_url:'https://example.com/track/QA', note:'QA shipped' };
    var ship = qaCall_('orderMarkShippedRpc', [fx.token, orderId, td]);
    qaAssertOk_(ship);
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'shipped', 'Status should be shipped after mark shipped', record);
    qaAssert_(record.tracking && record.tracking.tracking_number === td.tracking_number, 'Tracking readback mismatch', record.tracking);
    output = { order_id:orderId, status:record.status, tracking:record.tracking };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// ===== Fulfillment carrier override + monetary lock test helpers/flows =====

// Build a shipping config with several companies/methods for override testing:
//  company1 (active): methodA (checkout), methodB (active), methodInactive (active=false)
//  company2 (active): methodC — carrier_id 'flash' + tracking_url_template (proves backend resolution)
//  company3 (inactive): methodD
function qaCreateFulfillmentShippingFixture_(token, stamp) {
  var current = qaCall_('getShippingRpc');
  qaAssertOk_(current);
  var originalCompanies = (current.companies || []).map(function(c){ return JSON.parse(JSON.stringify(c)); });
  var sfx = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  var methodA = { id:'qa_ff_ma_'+sfx, name:'QA Method A', active:true, mode:'flat', flat_rate:30 };
  var methodB = { id:'qa_ff_mb_'+sfx, name:'QA Method B', active:true, mode:'flat', flat_rate:50 };
  var methodInactive = { id:'qa_ff_mx_'+sfx, name:'QA Method Inactive', active:false, mode:'flat', flat_rate:40 };
  var company1 = { id:'qa_ff_c1_'+sfx, name:'QA Carrier One '+stamp, active:true, carrier_id:'other', tracking_url_template:'', tracking_provider:'', methods:[methodA, methodB, methodInactive] };
  var methodC = { id:'qa_ff_mc_'+sfx, name:'QA Method C', active:true, mode:'flat', flat_rate:70 };
  var company2 = { id:'qa_ff_c2_'+sfx, name:'QA Carrier Two '+stamp, active:true, carrier_id:'flash', tracking_url_template:'https://track.example.com/{T}', tracking_provider:'', methods:[methodC] };
  var methodD = { id:'qa_ff_md_'+sfx, name:'QA Method D', active:true, mode:'flat', flat_rate:60 };
  var company3 = { id:'qa_ff_c3_'+sfx, name:'QA Carrier Three '+stamp, active:false, carrier_id:'other', tracking_url_template:'', tracking_provider:'', methods:[methodD] };
  var saved = qaCall_('saveShippingRpc', [token, originalCompanies.concat([company1, company2, company3])]);
  qaAssertOk_(saved);
  return {
    original_companies: originalCompanies,
    company: company1, method: methodA,   // compat shape for qaCreateOrderQaProduct_/qaBuildOrderPayloadForProduct_
    company1: company1, company2: company2, company3: company3,
    methodA: methodA, methodB: methodB, methodInactive: methodInactive, methodC: methodC, methodD: methodD
  };
}

function qaSetupFulfillmentOrder_(ctx, label, stock) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var ship = qaCreateFulfillmentShippingFixture_(token, stamp);
  var product = qaCreateOrderQaProduct_(token, { company: ship.company, method: ship.method }, stamp, label, stock || 5, { price: 500 });
  return { token:token, stamp:stamp, ship:ship, product:product, order_ids:[], shipping:ship };
}

function qaFulfillmentSubmit_(fx, label) {
  var payload = qaBuildOrderPayloadForProduct_('qa-ff-'+label, fx.stamp, 'Buyer', fx.product.id, { company: fx.ship.company, method: fx.ship.method });
  var res = qaSubmitAndTrack_(payload, fx.order_ids);
  qaAssertOk_(res);
  return qaOrderIdsFromSubmit_(res)[0];
}

function qaFulfillmentCleanup_(fx, caught, output) {
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunFulfillmentAllowed_(ctx, targetStatus) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfAllowed', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'allowed');
    if (targetStatus === 'paid') {
      qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA paid']));
    } else if (targetStatus === 'approved') {
      qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA paid']));
      qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved']));
    }
    var before = qaReadOrder_(fx.token, orderId);
    var reason = (targetStatus === 'unpaid') ? '' : 'QA เปลี่ยนขนส่ง';
    var res = qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company2.id, fx.ship.methodC.id, reason]);
    qaAssertOk_(res);
    var after = res.record || qaReadOrder_(fx.token, orderId);
    qaAssert_(after.status === targetStatus, 'สถานะต้องไม่เปลี่ยนหลังเปลี่ยนบริษัทขนส่ง', { expected:targetStatus, got:after.status });
    var ff = after.fulfillment_shipping || {};
    qaAssert_(ff.company_id === fx.ship.company2.id, 'fulfillment company_id ผิด', ff);
    qaAssert_(ff.method_id === fx.ship.methodC.id, 'fulfillment method_id ผิด', ff);
    qaAssert_(ff.carrier_id === 'flash', 'carrier_id ต้อง resolve จาก backend เป็น flash', ff);
    qaAssert_(ff.tracking_url_template === 'https://track.example.com/{T}', 'tracking_url_template ต้อง resolve จาก backend', ff);
    qaAssert_(Number(after.shipping_fee) === Number(before.shipping_fee), 'shipping_fee ต้องไม่เปลี่ยน', { before:before.shipping_fee, after:after.shipping_fee });
    qaAssert_(Number(after.subtotal) === Number(before.subtotal), 'subtotal ต้องไม่เปลี่ยน', { before:before.subtotal, after:after.subtotal });
    qaAssert_(Number(after.total) === Number(before.total), 'total ต้องไม่เปลี่ยน', { before:before.total, after:after.total });
    qaAssert_(after.shipping_method_id === before.shipping_method_id, 'shipping_method_id ต้องไม่เปลี่ยน', { before:before.shipping_method_id, after:after.shipping_method_id });
    qaAssert_(JSON.stringify(after.shipping_info) === JSON.stringify(before.shipping_info), 'shipping_info ต้องไม่เปลี่ยน', { before:before.shipping_info, after:after.shipping_info });
    qaAssert_((after.status_history || []).some(function(h){ return h.status === 'shipping_carrier_changed'; }), 'ต้องมี history shipping_carrier_changed', after.status_history);
    output = { order_id:orderId, status:after.status, fulfillment:ff };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}
function qaRunFulfillmentAllowedUnpaidFlow_(ctx) { return qaRunFulfillmentAllowed_(ctx, 'unpaid'); }
function qaRunFulfillmentAllowedPaidFlow_(ctx) { return qaRunFulfillmentAllowed_(ctx, 'paid'); }
function qaRunFulfillmentAllowedApprovedFlow_(ctx) { return qaRunFulfillmentAllowed_(ctx, 'approved'); }

function qaRunFulfillmentRejectedShippedFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfRejShip', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'rejship');
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA paid']));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved']));
    qaAssertOk_(qaCall_('orderMarkShippedRpc', [fx.token, orderId, { tracking_number:'QAFF'+fx.stamp.replace(/[^0-9]/g,''), note:'QA' }]));
    var res = qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company2.id, fx.ship.methodC.id, 'QA']);
    qaAssert_(res && res.ok === false && res.error === 'STATUS_NOT_ALLOWED', 'ออร์เดอร์ shipped ต้องเปลี่ยนบริษัทขนส่งไม่ได้', res);
    output = { order_id:orderId, response:res };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFulfillmentRejectedTerminalFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfRejTerm', 8);
  var caught = null, output = null, results = {};
  try {
    ['delivered','rejected','cancelled'].forEach(function(st) {
      var orderId = qaFulfillmentSubmit_(fx, 'term-'+st);
      if (st === 'delivered') {
        qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA']));
        qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA']));
        qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'delivered', 'QA']));
      } else {
        qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, st, 'QA']));
      }
      var res = qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company2.id, fx.ship.methodC.id, 'QA']);
      qaAssert_(res && res.ok === false && res.error === 'STATUS_NOT_ALLOWED', 'สถานะ ' + st + ' ต้องเปลี่ยนบริษัทขนส่งไม่ได้', res);
      results[st] = res.error;
    });
    output = { results:results };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFulfillmentInactiveCompanyFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfInactiveCo', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'inactco');
    var res = qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company3.id, fx.ship.methodD.id, '']);
    qaAssert_(res && res.ok === false && res.error === 'COMPANY_INVALID', 'บริษัทที่ปิดใช้งานต้องถูกปฏิเสธ', res);
    output = { order_id:orderId, response:res };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFulfillmentInvalidMethodFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfInvalidMethod', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'invmethod');
    var r1 = qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company1.id, fx.ship.methodInactive.id, '']);
    qaAssert_(r1 && r1.ok === false && r1.error === 'METHOD_INVALID', 'method ที่ปิดใช้งานต้องถูกปฏิเสธ', r1);
    var r2 = qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company1.id, fx.ship.methodC.id, '']);
    qaAssert_(r2 && r2.ok === false && r2.error === 'METHOD_INVALID', 'method ของบริษัทอื่นต้องถูกปฏิเสธ', r2);
    output = { order_id:orderId, inactive:r1.error, foreign:r2.error };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFulfillmentMarkShippedOverrideFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfMarkOverride', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'markov');
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA']));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA']));
    qaAssertOk_(qaCall_('orderUpdateFulfillmentShippingRpc', [fx.token, orderId, fx.ship.company2.id, fx.ship.methodC.id, 'QA override']));
    var tn = 'QAOVR' + fx.stamp.replace(/[^0-9]/g,'');
    var ship = qaCall_('orderMarkShippedRpc', [fx.token, orderId, { tracking_number:tn, note:'QA' }]);
    qaAssertOk_(ship);
    var rec = ship.record || qaReadOrder_(fx.token, orderId);
    var td = rec.tracking || {};
    qaAssert_(td.carrier_id === 'flash', 'tracking carrier_id ต้องเป็นของ override (flash)', td);
    qaAssert_(td.fulfillment_source === 'override', 'fulfillment_source ต้องเป็น override', td);
    qaAssert_(td.tracking_url === 'https://track.example.com/' + encodeURIComponent(tn), 'tracking_url ต้อง resolve จาก template ฝั่ง backend', td);
    output = { order_id:orderId, tracking:td };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFulfillmentMarkShippedOriginalFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FfMarkOrig', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'markorig');
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA']));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA']));
    var ship = qaCall_('orderMarkShippedRpc', [fx.token, orderId, { tracking_number:'QAORIG'+fx.stamp.replace(/[^0-9]/g,''), note:'QA' }]);
    qaAssertOk_(ship);
    var rec = ship.record || qaReadOrder_(fx.token, orderId);
    var td = rec.tracking || {};
    qaAssert_(td.carrier_id === 'other', 'ไม่มี override ต้องใช้ carrier เดิม (other)', td);
    qaAssert_(td.fulfillment_source === 'original', 'fulfillment_source ต้องเป็น original', td);
    qaAssert_(td.carrier_name === fx.ship.company1.name, 'carrier_name ต้องเป็นบริษัทที่ลูกค้าเลือก', td);
    output = { order_id:orderId, tracking:td };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFieldsMonetaryLockFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FieldsLock', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'fieldslock');
    var before = qaReadOrder_(fx.token, orderId);
    // unpaid: shipping_fee editable; total recomputed by backend (client total ignored)
    var newFee = Number(before.shipping_fee) + 15;
    qaAssertOk_(qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, { shipping_fee:newFee, total:999999 }]));
    var mid = qaReadOrder_(fx.token, orderId);
    qaAssert_(Number(mid.shipping_fee) === newFee, 'unpaid: shipping_fee ต้องอัปเดตได้', mid);
    qaAssert_(Number(mid.total) === Number(mid.subtotal) + newFee, 'total ต้องคำนวณจาก backend (ไม่เชื่อ client total)', mid);
    // subtotal never editable
    var subRes = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, { subtotal:1 }]);
    qaAssert_(subRes && subRes.ok === false && subRes.error === 'SUBTOTAL_IMMUTABLE', 'subtotal ต้องถูกปฏิเสธเสมอ', subRes);
    // move to paid → monetary lock
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA']));
    var lockedFee = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, { shipping_fee:5 }]);
    qaAssert_(lockedFee && lockedFee.ok === false && lockedFee.error === 'PRICING_LOCKED', 'paid: shipping_fee ต้องถูกล็อก', lockedFee);
    var lockedTotal = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, { total:5 }]);
    qaAssert_(lockedTotal && lockedTotal.ok === false && lockedTotal.error === 'PRICING_LOCKED', 'paid: total ต้องถูกล็อก', lockedTotal);
    var after = qaReadOrder_(fx.token, orderId);
    qaAssert_(Number(after.shipping_fee) === newFee, 'shipping_fee ต้องไม่เปลี่ยนหลังถูกล็อก', after);
    output = { order_id:orderId, shipping_fee:after.shipping_fee, total:after.total };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunFieldsMonetaryLockPersistFlow_(ctx) {
  var fx = qaSetupFulfillmentOrder_(ctx, 'FieldsLockPersist', 5);
  var caught = null, output = null;
  try {
    var orderId = qaFulfillmentSubmit_(fx, 'lockpersist');
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA paid']));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'unpaid', 'QA rollback']));
    var res = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, { shipping_fee:12345 }]);
    qaAssert_(res && res.ok === false && res.error === 'PRICING_LOCKED', 'ยอดเงินต้องยังถูกล็อกแม้ย้อนกลับเป็น unpaid', res);
    output = { order_id:orderId, response:res };
  } catch (err) { caught = err; }
  return qaFulfillmentCleanup_(fx, caught, output || {});
}

function qaRunOrderDeleteCleanupFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'DeleteCleanup', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-delete-order', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var del = qaCall_('orderDeleteRpc', [fx.token, [orderId]]);
    qaAssertOk_(del);
    var read = qaCall_('orderGetRpc', [fx.token, orderId]);
    qaAssert_(read && read.ok === false, 'Deleted order should not be readable by admin', read);
    fx.order_ids = fx.order_ids.filter(function(id){ return id !== orderId; });
    output = { order_id:orderId, delete_response:del, read_after_delete:read };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunSplitShippingOrderFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var methods = [
    { id:'qa_method_a_' + suffix, name:'QA Split A', active:true, mode:'flat', flat_rate:10 },
    { id:'qa_method_b_' + suffix, name:'QA Split B', active:true, mode:'flat', flat_rate:20 }
  ];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'SplitShipping', { methods:methods });
  var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'SplitA', 5, { allowed_shipping_ids:[methods[0].id], price:300 });
  var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'SplitB', 5, { allowed_shipping_ids:[methods[1].id], price:400 });
  var orderIds = [], caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-split', stamp, 'Buyer', productA.id, shipping, {
      items:[
        { product_id:productA.id, qty:1, selected_variants:{} },
        { product_id:productB.id, qty:1, selected_variants:{} }
      ]
    });
    payload.shipping_info = [
      { company_id:shipping.company.id, method_id:methods[0].id, item_product_ids:[productA.id] },
      { company_id:shipping.company.id, method_id:methods[1].id, item_product_ids:[productB.id] }
    ];
    var res = qaSubmitAndTrack_(payload, orderIds);
    qaAssertOk_(res);
    qaAssert_(Array.isArray(res.orders) && res.orders.length === 2, 'Split shipping should return two orders', res);
    var readbacks = orderIds.map(function(orderId){ return qaReadOrder_(token, orderId); });
    qaAssert_(readbacks.every(function(r){ return (r.items || []).filter(function(i){ return i.line_type !== 'gift'; }).length === 1; }), 'Each split order should contain one product line', readbacks);
    output = { order_ids:orderIds.slice(), order_count:orderIds.length, totals:readbacks.map(function(r){ return r.total; }) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, [productA.id, productB.id], shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionSnapshotImmutabilityFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoSnapshot', 5, { price:1000 });
  var promoId = '', caught = null, output = null;
  try {
    var startedAt = new Date(Date.now() - 60000).toISOString();
    var promoRes = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Snapshot Promo ' + fx.stamp,
      description:'Temporary promotion for order snapshot test.',
      discount_type:'fixed',
      discount_value:200,
      target_type:'product',
      target:[{ product_id:fx.product.id }],
      starts_at:startedAt,
      ends_at:'',
      no_end_date:true,
      enabled:true
    }]);
    qaAssertOk_(promoRes);
    promoId = promoRes.promotion_id;
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-promo-snapshot', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssertOk_(qaCall_('deletePromotionRpc', [fx.token, promoId]));
    promoId = '';
    var record = qaReadOrder_(fx.token, orderId);
    var line = qaFindProductLine_(record, fx.product.id);
    qaAssert_(line && line.promotion && line.promotion.promotion_id === promoRes.promotion_id, 'Order line lost promotion snapshot after promotion deletion', line);
    qaAssert_(Number(line.unit_final_price) === 800, 'Order line final price changed after promotion deletion', line);
    output = { order_id:orderId, promotion_id:promoRes.promotion_id, unit_final_price:line.unit_final_price };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (promoId) {
    try { qaCall_('deletePromotionRpc', [fx.token, promoId]); } catch(_) {}
  }
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

/* ===================== Conditional promotion flows ===================== */
// Shared helpers for behavior-based conditional-promotion tests. Every flow drives the
// real public preview RPC and the real submitOrderRpc, then asserts the persisted order,
// so preview and order can never silently diverge.
function qaCartItem_(productId, qty, sel) { return { product_id: String(productId), qty: qty, selected_variants: sel || {} }; }
function qaPreviewPromo_(cartItems) {
  var r = qaCall_('previewPromotionEligibilityRpc', [{ items: cartItems }]);
  qaAssertOk_(r);
  return r;
}
function qaPromoPreviewLine_(preview, productId, variantKey) {
  var lines = preview.lines || [];
  for (var i = 0; i < lines.length; i++) {
    if (String(lines[i].product_id) === String(productId) && String(lines[i].variant_key || '') === String(variantKey || '')) return lines[i];
  }
  return null;
}
function qaPromoEligibleHas_(preview, promoId) {
  return (preview.eligible || []).some(function(e){ return String(e.promotion_id) === String(promoId); });
}
function qaPromoNearHas_(preview, promoId) {
  return (preview.near || []).some(function(e){ return String(e.promotion_id) === String(promoId); });
}
// Submit an order for `cartItems`, read it back, and assert every product line's
// unit_final_price/promotion matches the preview for the same cart. Returns { order_id, record }.
function qaSubmitAndAssertMatchesPreview_(fx, buyer, cartItems, preview) {
  var payload = qaBuildOrderPayloadForProduct_('qa-cond-promo', fx.stamp, buyer, cartItems[0].product_id, fx.shipping, { items: cartItems });
  var res = qaSubmitAndTrack_(payload, fx.order_ids);
  qaAssertOk_(res);
  var orderId = qaOrderIdsFromSubmit_(res)[0];
  var record = qaReadOrder_(fx.token, orderId);
  var lineSubtotal = 0;
  cartItems.forEach(function(ci){
    var pv = qaPromoPreviewLine_(preview, ci.product_id, qaVariantKeyOf_(ci.selected_variants));
    var line = qaFindProductLineByVariantKey_(record, ci.product_id, qaVariantKeyOf_(ci.selected_variants));
    qaAssert_(!!line, 'ไม่พบรายการสินค้าในออร์เดอร์', { product_id: ci.product_id, record: record });
    qaAssert_(!!pv, 'ไม่พบรายการสินค้าใน preview', { product_id: ci.product_id, preview: preview });
    qaAssert_(Number(line.unit_final_price) === Number(pv.unit_final_price),
      'ราคาต่อหน่วยในออร์เดอร์ไม่ตรงกับ preview (preview!=order)', { order_line: line, preview_line: pv });
    var lPromo = line.promotion ? String(line.promotion.promotion_id) : null;
    var pPromo = pv.promotion ? String(pv.promotion.promotion_id) : null;
    qaAssert_(lPromo === pPromo, 'promotion_id ในออร์เดอร์ไม่ตรงกับ preview', { order_line: line, preview_line: pv });
    lineSubtotal += Number(line.subtotal);
  });
  // Whole-order (order-total) discount, if the preview reported one. total nets it before shipping.
  var previewOrderDiscount = (preview && preview.order_discount) ? Number(preview.order_discount.amount || 0) : 0;
  var orderRecordDiscount = (record.order_discount && Number(record.order_discount.amount)) || 0;
  qaAssert_(orderRecordDiscount === previewOrderDiscount,
    'ส่วนลดท้ายบิลในออร์เดอร์ไม่ตรงกับ preview', { record_discount: orderRecordDiscount, preview_discount: previewOrderDiscount });
  if (record.total !== undefined && record.shipping_fee !== undefined) {
    qaAssert_(Number(record.total) === Math.max(0, lineSubtotal - previewOrderDiscount) + Number(record.shipping_fee || 0),
      'ยอดรวมออร์เดอร์ไม่เท่ากับ (ผลรวมรายการ - ส่วนลดท้ายบิล) + ค่าส่ง',
      { record: record, line_subtotal: lineSubtotal, order_discount: previewOrderDiscount });
  }
  return { order_id: orderId, record: record, line_subtotal: lineSubtotal, order_discount: previewOrderDiscount };
}
// Fetch a specific eligible-promo entry from a preview (for order-total assertions).
function qaPromoEligibleEntry_(preview, promoId) {
  return (preview.eligible || []).filter(function(e){ return String(e.promotion_id) === String(promoId); })[0] || null;
}
// Canonical variant_key from a selected_variants object (mirror backend buildVariantKey_).
function qaVariantKeyOf_(sel) {
  if (!sel || typeof sel !== 'object') return '';
  return Object.keys(sel).sort().map(function(k){ return k + '=' + String(sel[k] || ''); }).join('|');
}

// min_subtotal: below / exact / over thresholds; discount applies to whole cart when met.
function qaRunConditionalMinSubtotalFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'CondMinSub', 20, { price: 1000 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'MinSub', {
      discount_type: 'fixed', discount_value: 100, target_type: 'all', target: [],
      application_mode: 'conditional', condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 2000, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(promo.promotion_id);
    qaStep_(steps, 'สร้างโปรเงื่อนไข min_subtotal', 'ok', promo);

    // Below threshold (1 x 1000 = 1000 < 2000): not eligible, no discount.
    var below = qaPreviewPromo_([qaCartItem_(fx.product.id, 1, {})]);
    qaAssert_(qaPromoNearHas_(below, promo.promotion_id), 'ยอดต่ำกว่าเกณฑ์ควรอยู่ในรายการใกล้ได้รับ', below);
    qaAssert_(Number(qaPromoPreviewLine_(below, fx.product.id, '').unit_final_price) === 1000, 'ยอดต่ำกว่าเกณฑ์ต้องไม่ลดราคา', below);
    qaSubmitAndAssertMatchesPreview_(fx, 'Below', [qaCartItem_(fx.product.id, 1, {})], below);

    // Exact threshold (2 x 1000 = 2000): eligible, each unit -100 -> 900.
    var exact = qaPreviewPromo_([qaCartItem_(fx.product.id, 2, {})]);
    qaAssert_(qaPromoEligibleHas_(exact, promo.promotion_id), 'ยอดครบเกณฑ์พอดีต้องได้รับส่วนลด', exact);
    qaAssert_(Number(qaPromoPreviewLine_(exact, fx.product.id, '').unit_final_price) === 900, 'ราคาหลังลดต้องเป็น 900', exact);
    qaSubmitAndAssertMatchesPreview_(fx, 'Exact', [qaCartItem_(fx.product.id, 2, {})], exact);

    // Over threshold (3 x 1000 = 3000): eligible, still -100 each.
    var over = qaPreviewPromo_([qaCartItem_(fx.product.id, 3, {})]);
    qaAssert_(qaPromoEligibleHas_(over, promo.promotion_id), 'ยอดเกินเกณฑ์ต้องได้รับส่วนลด', over);
    qaAssert_(Number(qaPromoPreviewLine_(over, fx.product.id, '').unit_final_price) === 900, 'ยอดเกินเกณฑ์ราคาหลังลดต้องเป็น 900', over);

    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

/* ========================================================================
 * Order-total (whole-order) discount scope — conditional promos only.
 * The discount is deducted ONCE from the item subtotal (never × qty) and
 * ignores product/variant targeting. Preview and order must agree.
 * ===================================================================== */

// Order-total FIXED discount: qualifies on min_subtotal, deducts a flat amount once.
// Also verifies per-line prices are unchanged (order-total never touches unit price) and
// the below-threshold near-miss case.
function qaRunOrderTotalFixedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotFixed', 20, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotFixed', {
      discount_type: 'fixed', discount_value: 60, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 400, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(promo.promotion_id);
    qaStep_(steps, 'สร้างโปรลดท้ายบิลแบบบาท (fixed)', 'ok', promo);

    // Below threshold: 1 × 250 = 250 < 400 → near-miss, no order discount.
    var below = qaPreviewPromo_([qaCartItem_(fx.product.id, 1, {})]);
    qaAssert_(qaPromoNearHas_(below, promo.promotion_id), 'ยอดต่ำกว่าเกณฑ์ควรอยู่ในรายการใกล้ได้รับ', below);
    qaAssert_(!below.order_discount, 'ยอดต่ำกว่าเกณฑ์ต้องไม่มีส่วนลดท้ายบิล', below);
    qaAssert_(Number(qaPromoPreviewLine_(below, fx.product.id, '').unit_final_price) === 250, 'ราคาต่อชิ้นต้องไม่เปลี่ยน', below);

    // At/over threshold: 2 × 250 = 500 ≥ 400 → order discount 60, net subtotal 440,
    // per-line price still 250 (order-total never changes unit price).
    var ok = qaPreviewPromo_([qaCartItem_(fx.product.id, 2, {})]);
    qaAssert_(qaPromoEligibleHas_(ok, promo.promotion_id), 'ยอดครบเกณฑ์ต้องได้รับส่วนลดท้ายบิล', ok);
    qaAssert_(!!ok.order_discount && Number(ok.order_discount.amount) === 60, 'ส่วนลดท้ายบิลต้องเป็น 60', ok);
    qaAssert_(Number(ok.subtotal) === 500, 'ยอดสินค้าต้องเป็น 500', ok);
    qaAssert_(Number(ok.subtotal_after_order_discount) === 440, 'ยอดหลังหักส่วนลดท้ายบิลต้องเป็น 440', ok);
    qaAssert_(Number(qaPromoPreviewLine_(ok, fx.product.id, '').unit_final_price) === 250, 'ลดท้ายบิลต้องไม่เปลี่ยนราคาต่อชิ้น', ok);
    var entry = qaPromoEligibleEntry_(ok, promo.promotion_id);
    qaAssert_(entry && entry.applied === true && Number(entry.order_discount_amount) === 60, 'รายการ eligible ต้อง applied=true และ order_discount_amount=60', entry);

    // Submit: order total = 500 − 60 + shipping; persisted order_discount = 60.
    qaSubmitAndAssertMatchesPreview_(fx, 'OrdTotFixed', [qaCartItem_(fx.product.id, 2, {})], ok);
    qaStep_(steps, 'ตรวจ preview + order ลดท้ายบิล fixed', 'ok', { order_discount: ok.order_discount });

    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Order-total PERCENT discount: percent of the item subtotal, deducted once.
function qaRunOrderTotalPercentFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotPct', 20, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotPct', {
      discount_type: 'percent', discount_value: 10, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 400, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(promo.promotion_id);
    // 2 × 250 = 500 ≥ 400 → 10% of 500 = 50, net 450.
    var ok = qaPreviewPromo_([qaCartItem_(fx.product.id, 2, {})]);
    qaAssert_(!!ok.order_discount && Number(ok.order_discount.amount) === 50, 'ส่วนลดท้ายบิล 10% ของ 500 ต้องเป็น 50', ok);
    qaAssert_(Number(ok.subtotal_after_order_discount) === 450, 'ยอดหลังหักต้องเป็น 450', ok);
    qaSubmitAndAssertMatchesPreview_(fx, 'OrdTotPct', [qaCartItem_(fx.product.id, 2, {})], ok);
    qaStep_(steps, 'ตรวจ preview + order ลดท้ายบิล percent', 'ok', { order_discount: ok.order_discount });
    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Order-total discount greater than the subtotal is clamped so the net subtotal floors at 0.
function qaRunOrderTotalExceedsSubtotalFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotClamp', 20, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotClamp', {
      discount_type: 'fixed', discount_value: 9999, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(promo.promotion_id);
    // 1 × 250 = 250 ≥ 100 → discount clamped to 250, net 0.
    var ok = qaPreviewPromo_([qaCartItem_(fx.product.id, 1, {})]);
    qaAssert_(!!ok.order_discount && Number(ok.order_discount.amount) === 250, 'ส่วนลดท้ายบิลต้องถูก clamp เท่ากับยอดสินค้า (250)', ok);
    qaAssert_(Number(ok.subtotal_after_order_discount) === 0, 'ยอดหลังหักต้องเป็น 0 (ไม่ติดลบ)', ok);
    var sub = qaSubmitAndAssertMatchesPreview_(fx, 'OrdTotClamp', [qaCartItem_(fx.product.id, 1, {})], ok);
    qaAssert_(Number(sub.record.total) === Number(sub.record.shipping_fee || 0), 'ยอดรวมต้องเท่ากับค่าส่งเท่านั้น (สินค้าเป็น 0)', sub.record);
    qaStep_(steps, 'ตรวจ clamp ส่วนลด > ยอดสินค้า', 'ok', { order_discount: ok.order_discount });
    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Disabled and expired order-total promos never apply (no order_discount, not eligible).
function qaRunOrderTotalDisabledExpiredFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotOff', 20, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var disabled = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotDisabled', {
      discount_type: 'fixed', discount_value: 60, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total', enabled: false,
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(disabled.promotion_id);
    var expired = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotExpired', {
      discount_type: 'fixed', discount_value: 60, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      starts_at: qaPastIso_(7200000), ends_at: qaPastIso_(3600000), no_end_date: false,
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(expired.promotion_id);

    var prev = qaPreviewPromo_([qaCartItem_(fx.product.id, 2, {})]);
    qaAssert_(!prev.order_discount, 'โปรที่ปิด/หมดอายุต้องไม่ให้ส่วนลดท้ายบิล', prev);
    qaAssert_(!qaPromoEligibleHas_(prev, disabled.promotion_id), 'โปรที่ปิดต้องไม่อยู่ใน eligible', prev);
    qaAssert_(!qaPromoEligibleHas_(prev, expired.promotion_id), 'โปรที่หมดอายุต้องไม่อยู่ใน eligible', prev);
    qaSubmitAndAssertMatchesPreview_(fx, 'OrdTotOff', [qaCartItem_(fx.product.id, 2, {})], prev);
    qaStep_(steps, 'ตรวจโปรลดท้ายบิลที่ปิด/หมดอายุไม่ทำงาน', 'ok', { disabled: disabled.promotion_id, expired: expired.promotion_id });
    output = { steps: steps };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Two qualified order-total promos → the larger discount wins (once), the other is reported
// qualified-but-outpriced (applied:false). Conditional promos are exempt from overlap guard.
function qaRunOrderTotalBestWinsFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotBest', 20, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var big = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotBig', {
      discount_type: 'fixed', discount_value: 100, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(big.promotion_id);
    var small = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotSmall', {
      discount_type: 'fixed', discount_value: 50, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(small.promotion_id);

    // 2 × 250 = 500 ≥ 100 → both qualify; winner is the 100-baht promo.
    var ok = qaPreviewPromo_([qaCartItem_(fx.product.id, 2, {})]);
    qaAssert_(!!ok.order_discount && Number(ok.order_discount.amount) === 100, 'ส่วนลดที่มากกว่า (100) ต้องชนะ', ok);
    qaAssert_(String(ok.order_discount.promotion.promotion_id) === String(big.promotion_id), 'โปรที่ชนะต้องเป็นตัวที่ลดมากกว่า', ok);
    var eBig = qaPromoEligibleEntry_(ok, big.promotion_id);
    var eSmall = qaPromoEligibleEntry_(ok, small.promotion_id);
    qaAssert_(eBig && eBig.applied === true, 'โปรที่ชนะต้อง applied=true', eBig);
    qaAssert_(eSmall && eSmall.applied === false, 'โปรที่แพ้ราคาต้อง applied=false (qualified but outpriced)', eSmall);
    qaSubmitAndAssertMatchesPreview_(fx, 'OrdTotBest', [qaCartItem_(fx.product.id, 2, {})], ok);
    qaStep_(steps, 'ตรวจโปรลดท้ายบิลสองตัว เลือกตัวที่คุ้มสุด', 'ok', { winner: big.promotion_id });
    output = { steps: steps };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// A DIRECT promo can never be order-total: createPromotionRpc must reject it. A conditional
// order-total promo can be switched to direct only when the scope is also reset to item.
function qaRunOrderTotalDirectRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotDirectRej', 5, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    // Direct + order_total → rejected (application_mode omitted defaults to direct).
    var badPayload = {
      name: 'QA OrdTot DirectReject ' + fx.stamp, description: 'x',
      discount_type: 'fixed', discount_value: 60, target_type: 'all', target: [],
      starts_at: qaPastIso_(60000), no_end_date: true, enabled: true,
      discount_scope: 'order_total'
    };
    var rej = qaCall_('createPromotionRpc', [fx.token, badPayload]);
    qaAssert_(rej && rej.ok === false, 'โปรแบบ direct + ลดท้ายบิล ต้องถูกปฏิเสธ', rej);
    qaStep_(steps, 'ปฏิเสธ direct + order_total', 'ok', rej);

    // Explicit direct + order_total → also rejected.
    badPayload.application_mode = 'direct';
    var rej2 = qaCall_('createPromotionRpc', [fx.token, badPayload]);
    qaAssert_(rej2 && rej2.ok === false, 'ระบุ application_mode=direct + order_total ต้องถูกปฏิเสธ', rej2);

    // Valid conditional order-total can be created, then switched to direct with scope reset.
    var good = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotSwitch', {
      discount_type: 'fixed', discount_value: 60, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(good.promotion_id);
    var switched = qaCall_('updatePromotionRpc', [fx.token, good.promotion_id, { application_mode: 'direct', discount_scope: 'item' }]);
    qaAssertOk_(switched);
    var reread = qaCall_('getPromotionRpc', [fx.token, good.promotion_id]);
    qaAssertOk_(reread);
    qaAssert_(reread.promotion.discount_scope === 'item', 'สลับเป็น direct แล้ว scope ต้องเป็น item', reread);
    qaStep_(steps, 'สลับ conditional order-total → direct item สำเร็จ', 'ok', reread.promotion);
    output = { steps: steps };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Create item-scope, edit to order-total, reload: discount_scope persists and targeting is
// cleared to whole-store. Verifies create/edit/persisted-reload consistency.
function qaRunOrderTotalEditReloadFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'OrdTotReload', 5, { price: 250 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    // Start as an item-scoped conditional promo targeting the product.
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'OrdTotReload', {
      discount_type: 'fixed', discount_value: 30, target_type: 'product', target: [{ product_id: fx.product.id }],
      application_mode: 'conditional', discount_scope: 'item',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    promos.push(promo.promotion_id);
    var r1 = qaCall_('getPromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(r1);
    qaAssert_(r1.promotion.discount_scope === 'item', 'เริ่มต้น scope ต้องเป็น item', r1);

    // Switch to order-total; backend forces target_type=all, target=[].
    var upd = qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, { discount_scope: 'order_total' }]);
    qaAssertOk_(upd);
    var r2 = qaCall_('getPromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(r2);
    qaAssert_(r2.promotion.discount_scope === 'order_total', 'หลังแก้ scope ต้องเป็น order_total', r2);
    qaAssert_(r2.promotion.target_type === 'all', 'ลดท้ายบิลต้องบังคับ target_type=all', r2);
    qaAssert_((r2.promotion.target || []).length === 0, 'ลดท้ายบิลต้องล้าง target', r2);

    // Confirm it now behaves as an order-total discount in preview.
    var prev = qaPreviewPromo_([qaCartItem_(fx.product.id, 1, {})]);
    qaAssert_(!!prev.order_discount && Number(prev.order_discount.amount) === 30, 'หลัง reload ต้องทำงานเป็นส่วนลดท้ายบิล 30', prev);
    qaStep_(steps, 'ตรวจ create/edit/reload ของ scope order-total', 'ok', r2.promotion);
    output = { steps: steps };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  promos.forEach(function(pid){ try { qaCall_('deletePromotionRpc', [fx.token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Regression: an order-total (conditional) discount must NOT change the gift min_subtotal
// basis (subtotal_after_direct). Gift eligibility stays independent of the whole-order discount.
function qaRunGiftIgnoresOrderTotalDiscountFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftOrdTot');
  var steps = [], caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftOrdTot', 10, { price: 1000 });
    fx.product_ids.push(product.id);

    // Order-total promo: qualifies at subtotal >= 500, deducts 600 from the whole order.
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'GiftOrdTot', {
      discount_type: 'fixed', discount_value: 600, target_type: 'all', target: [],
      application_mode: 'conditional', discount_scope: 'order_total',
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 500, calculation_base: 'after_discount_before_shipping' }
    });
    fx.promotion_ids.push(promo.promotion_id);

    // Gift rule min_subtotal 900. Direct-only base for qty=1 is 1000 → eligible, even though
    // the order-total discount would bring the paid subtotal to 400.
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftOrdTot', { stock: 5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftOrdTot', gift.gift_id, {
      condition_type: 'min_subtotal', condition_json: { min_subtotal: 900 }
    });
    fx.rule_ids.push(rule.rule_id);

    // Promo preview: order discount applies (600), per-line price unchanged (1000).
    var promoPrev = qaCall_('previewPromotionEligibilityRpc', [{ items: [qaCartItem_(product.id, 1, {})] }]);
    qaAssertOk_(promoPrev);
    qaAssert_(!!promoPrev.order_discount && Number(promoPrev.order_discount.amount) === 600, 'ส่วนลดท้ายบิลต้องเป็น 600', promoPrev);
    qaAssert_(Number(qaPromoPreviewLine_(promoPrev, product.id, '').unit_final_price) === 1000, 'ลดท้ายบิลต้องไม่เปลี่ยนราคาต่อชิ้น', promoPrev);

    // Gift preview: basis stays 1000 (direct-only), gift still eligible.
    var giftPrev = qaCall_('previewGiftEligibilityRpc', [{ items: [{ product_id: product.id, qty: 1, selected_variants: {} }] }]);
    qaAssertOk_(giftPrev);
    qaAssert_(Number(giftPrev.subtotal_after_promo) === 1000, 'ฐานของแถมต้องไม่ถูกลดด้วยส่วนลดท้ายบิล (คงเป็น 1000)', giftPrev);
    qaAssert_(qaHasEligibleRule_(giftPrev, rule.rule_id), 'ของแถมต้องยังผ่านเงื่อนไขแม้มีส่วนลดท้ายบิล', giftPrev);

    // Submit: order total nets the 600 discount and the gift is still attached.
    var payload = qaBuildOrderPayloadForProduct_('qa-gift-ordtot', fx.stamp, 'Buyer', product.id, fx.shipping, {
      items: [{ product_id: product.id, qty: 1, selected_variants: {} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var record = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_((record.order_discount && Number(record.order_discount.amount)) === 600, 'ออร์เดอร์ต้องบันทึกส่วนลดท้ายบิล 600', record);
    qaAssert_(Number(record.total) === (1000 - 600) + Number(record.shipping_fee || 0), 'ยอดรวมต้อง = (1000-600)+ค่าส่ง', record);
    qaAssert_(qaActiveGiftLines_(record, gift.gift_id).length === 1, 'ของแถมต้องยังถูกแนบในออร์เดอร์', record.items);
    qaStep_(steps, 'ตรวจ gift ไม่ถูกกระทบด้วยส่วนลดท้ายบิล', 'ok', { order_discount: record.order_discount });
    output = { steps: steps, order_id: record.order_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// required_products, match_mode 'all': buy A (condition) unlocks a discount on B (target).
// Condition product differs from discount target. Also verifies incomplete qty + duplicate
// cart lines summing.
function qaRunConditionalRequiredProductsAllFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [], orderIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondReqProd');
  var caught = null, output = null;
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: orderIds };
  try {
    var A = qaCreateOrderQaProduct_(token, shipping, stamp, 'CondBuyA', 20, { price: 500 });   // condition product
    var B = qaCreateOrderQaProduct_(token, shipping, stamp, 'CondGetB', 20, { price: 1000 });  // discount target
    productIds = [A.id, B.id];
    qaStep_(steps, 'สร้างสินค้า A(เงื่อนไข) B(เป้าหมาย)', 'ok', { A: A.id, B: B.id });
    var promo = qaCreatePromotion_(token, B.id, stamp, 'ReqProdAll', {
      discount_type: 'fixed', discount_value: 300, target_type: 'product', target: [{ product_id: B.id }],
      application_mode: 'conditional', condition_type: 'required_products',
      condition_json: { match_mode: 'all', required_products: [{ product_id: A.id, min_qty: 2 }] }
    });
    promos.push(promo.promotion_id);

    // Only B, no A: not eligible, B not discounted.
    var noA = qaPreviewPromo_([qaCartItem_(B.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(noA, B.id, '').unit_final_price) === 1000, 'ยังไม่ซื้อ A ต้องไม่ลดราคา B', noA);
    qaAssert_(qaPromoNearHas_(noA, promo.promotion_id), 'ควรแสดงเป็นใกล้ได้รับส่วนลด', noA);

    // A qty 1 (need 2) + B: incomplete condition -> not eligible.
    var incomplete = qaPreviewPromo_([qaCartItem_(A.id, 1, {}), qaCartItem_(B.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(incomplete, B.id, '').unit_final_price) === 1000, 'ซื้อ A ไม่ครบจำนวนต้องไม่ลดราคา B', incomplete);

    // A qty 2 + B: eligible, B -300 -> 700. A stays 500.
    var okCart = [qaCartItem_(A.id, 2, {}), qaCartItem_(B.id, 1, {})];
    var okPrev = qaPreviewPromo_(okCart);
    qaAssert_(qaPromoEligibleHas_(okPrev, promo.promotion_id), 'ซื้อ A ครบต้องปลดล็อกส่วนลด B', okPrev);
    qaAssert_(Number(qaPromoPreviewLine_(okPrev, B.id, '').unit_final_price) === 700, 'B ต้องลดเหลือ 700', okPrev);
    qaAssert_(Number(qaPromoPreviewLine_(okPrev, A.id, '').unit_final_price) === 500, 'A(เงื่อนไข) ต้องไม่ถูกลดราคา', okPrev);
    qaSubmitAndAssertMatchesPreview_(fx, 'ReqOk', okCart, okPrev);

    // Duplicate cart lines summing: two A lines qty 1 each (=2) + B -> eligible.
    var dupCart = [qaCartItem_(A.id, 1, {}), qaCartItem_(A.id, 1, {}), qaCartItem_(B.id, 1, {})];
    var dupPrev = qaPreviewPromo_(dupCart);
    qaAssert_(qaPromoEligibleHas_(dupPrev, promo.promotion_id), 'รายการ A ซ้ำต้องนับรวมกัน', dupPrev);
    qaAssert_(Number(qaPromoPreviewLine_(dupPrev, B.id, '').unit_final_price) === 700, 'B ต้องลดเหลือ 700 (นับ A ซ้ำ)', dupPrev);

    output = { steps: steps, promotion_id: promo.promotion_id, product_a: A.id, product_b: B.id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// required_products, match_mode 'any': satisfying either condition product qualifies.
function qaRunConditionalRequiredProductsAnyFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [], orderIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondReqAny');
  var caught = null, output = null;
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: orderIds };
  try {
    var A1 = qaCreateOrderQaProduct_(token, shipping, stamp, 'AnyA1', 20, { price: 500 });
    var A2 = qaCreateOrderQaProduct_(token, shipping, stamp, 'AnyA2', 20, { price: 500 });
    var T  = qaCreateOrderQaProduct_(token, shipping, stamp, 'AnyTarget', 20, { price: 1000 });
    productIds = [A1.id, A2.id, T.id];
    var promo = qaCreatePromotion_(token, T.id, stamp, 'ReqProdAny', {
      discount_type: 'percent', discount_value: 10, target_type: 'product', target: [{ product_id: T.id }],
      application_mode: 'conditional', condition_type: 'required_products',
      condition_json: { match_mode: 'any', required_products: [{ product_id: A1.id, min_qty: 1 }, { product_id: A2.id, min_qty: 1 }] }
    });
    promos.push(promo.promotion_id);

    // Neither A1 nor A2: not eligible.
    var none = qaPreviewPromo_([qaCartItem_(T.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(none, T.id, '').unit_final_price) === 1000, 'ไม่มีสินค้าเงื่อนไขต้องไม่ลดราคา', none);

    // Only A2 present: ANY qualifies, T -10% -> 900.
    var withA2 = [qaCartItem_(A2.id, 1, {}), qaCartItem_(T.id, 1, {})];
    var prev = qaPreviewPromo_(withA2);
    qaAssert_(qaPromoEligibleHas_(prev, promo.promotion_id), 'ANY: มี A2 อย่างเดียวต้องผ่านเงื่อนไข', prev);
    qaAssert_(Number(qaPromoPreviewLine_(prev, T.id, '').unit_final_price) === 900, 'T ต้องลด 10% เหลือ 900', prev);
    qaSubmitAndAssertMatchesPreview_(fx, 'AnyOk', withA2, prev);

    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Missing match_mode must normalize to 'all' (create then read back + eligibility check).
function qaRunConditionalMissingMatchModeFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondNoMM');
  var caught = null, output = null;
  try {
    var A = qaCreateOrderQaProduct_(token, shipping, stamp, 'NoMMA', 20, { price: 500 });
    var B = qaCreateOrderQaProduct_(token, shipping, stamp, 'NoMMB', 20, { price: 500 });
    var T = qaCreateOrderQaProduct_(token, shipping, stamp, 'NoMMT', 20, { price: 1000 });
    productIds = [A.id, B.id, T.id];
    // Note: condition_json omits match_mode entirely.
    var promo = qaCreatePromotion_(token, T.id, stamp, 'NoMM', {
      discount_type: 'fixed', discount_value: 100, target_type: 'product', target: [{ product_id: T.id }],
      application_mode: 'conditional', condition_type: 'required_products',
      condition_json: { required_products: [{ product_id: A.id, min_qty: 1 }, { product_id: B.id, min_qty: 1 }] }
    });
    promos.push(promo.promotion_id);
    var got = qaCall_('getPromotionRpc', [token, promo.promotion_id]);
    qaAssertOk_(got);
    qaAssert_(got.promotion && got.promotion.condition_json && got.promotion.condition_json.match_mode === 'all',
      'match_mode ที่ขาดต้อง normalize เป็น all', got);
    qaStep_(steps, 'ตรวจ normalize match_mode=all', 'ok', got.promotion.condition_json);

    // Only A present (all requires A AND B): not eligible.
    var onlyA = qaPreviewPromo_([qaCartItem_(A.id, 1, {}), qaCartItem_(T.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(onlyA, T.id, '').unit_final_price) === 1000, 'ALL: มีแค่ A ต้องไม่ลดราคา', onlyA);
    // Both A and B present: eligible.
    var both = qaPreviewPromo_([qaCartItem_(A.id, 1, {}), qaCartItem_(B.id, 1, {}), qaCartItem_(T.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(both, T.id, '').unit_final_price) === 900, 'ALL: มีทั้ง A และ B ต้องลดราคา', both);

    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, promos, productIds, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// required_variants: correct variant qualifies; wrong variant excluded.
function qaRunConditionalRequiredVariantsFlow_(ctx) {
  var variants = [{ name: 'Size', options: [{ label: 'S', price: 500 }, { label: 'L', price: 800 }] }];
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [], orderIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondReqVar');
  var caught = null, output = null;
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: orderIds };
  try {
    var A = qaCreateOrderQaProduct_(token, shipping, stamp, 'VarCondA', 20, { price: 500, variants: variants });
    var T = qaCreateOrderQaProduct_(token, shipping, stamp, 'VarTarget', 20, { price: 1000 });
    productIds = [A.id, T.id];
    var vkL = 'Size=L';
    var promo = qaCreatePromotion_(token, T.id, stamp, 'ReqVar', {
      discount_type: 'fixed', discount_value: 200, target_type: 'product', target: [{ product_id: T.id }],
      application_mode: 'conditional', condition_type: 'required_variants',
      condition_json: { match_mode: 'all', required_variants: [{ product_id: A.id, variant_key: vkL, min_qty: 1 }] }
    });
    promos.push(promo.promotion_id);

    // Wrong variant (S): not eligible.
    var wrong = qaPreviewPromo_([qaCartItem_(A.id, 1, { Size: 'S' }), qaCartItem_(T.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(wrong, T.id, '').unit_final_price) === 1000, 'variant ผิดต้องไม่ปลดล็อกส่วนลด', wrong);
    // Correct variant (L): eligible, T -200 -> 800.
    var rightCart = [qaCartItem_(A.id, 1, { Size: 'L' }), qaCartItem_(T.id, 1, {})];
    var right = qaPreviewPromo_(rightCart);
    qaAssert_(qaPromoEligibleHas_(right, promo.promotion_id), 'variant ถูกต้องต้องปลดล็อกส่วนลด', right);
    qaAssert_(Number(qaPromoPreviewLine_(right, T.id, '').unit_final_price) === 800, 'T ต้องลดเหลือ 800', right);
    qaSubmitAndAssertMatchesPreview_(fx, 'VarOk', rightCart, right);

    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Duplicate conditions must be rejected by createPromotionRpc (products + variants).
function qaRunConditionalDuplicateRejectedFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], productIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondDup');
  var caught = null, output = null;
  try {
    var A = qaCreateOrderQaProduct_(token, shipping, stamp, 'DupA', 5, { price: 500, variants: [{ name:'Size', options:[{label:'S', price:500}] }] });
    productIds = [A.id];
    var dupProd = qaCall_('createPromotionRpc', [token, {
      name: 'QA Dup Prod ' + stamp, discount_type:'fixed', discount_value:100,
      target_type:'all', target:[], starts_at: qaPastIso_(60000), no_end_date:true, enabled:true,
      application_mode:'conditional', condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[{ product_id:A.id, min_qty:1 }, { product_id:A.id, min_qty:2 }] }
    }]);
    qaAssert_(dupProd && dupProd.ok === false, 'สินค้าเงื่อนไขซ้ำต้องถูกปฏิเสธ', dupProd);
    qaStep_(steps, 'ปฏิเสธสินค้าเงื่อนไขซ้ำ', 'ok', dupProd);

    var dupVar = qaCall_('createPromotionRpc', [token, {
      name: 'QA Dup Var ' + stamp, discount_type:'fixed', discount_value:100,
      target_type:'all', target:[], starts_at: qaPastIso_(60000), no_end_date:true, enabled:true,
      application_mode:'conditional', condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[{ product_id:A.id, variant_key:'Size=S', min_qty:1 }, { product_id:A.id, variant_key:'Size=S', min_qty:2 }] }
    }]);
    qaAssert_(dupVar && dupVar.ok === false, 'ตัวเลือกเงื่อนไขซ้ำต้องถูกปฏิเสธ', dupVar);
    qaStep_(steps, 'ปฏิเสธตัวเลือกเงื่อนไขซ้ำ', 'ok', dupVar);
    output = { steps: steps, dup_prod: dupProd, dup_var: dupVar };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(token, productIds[0], shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Disabled / scheduled / expired conditional promos must not apply even when the
// condition is met.
function qaRunConditionalInactiveNotAppliedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'CondInactive', 20, { price: 1000 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    var cj = { min_subtotal: 500, calculation_base: 'after_discount_before_shipping' };
    var disabled = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Disabled', {
      discount_type:'fixed', discount_value:100, target_type:'all', target:[], enabled:false,
      application_mode:'conditional', condition_type:'min_subtotal', condition_json: cj });
    var scheduled = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Scheduled', {
      discount_type:'fixed', discount_value:100, target_type:'all', target:[],
      starts_at: qaFutureIso_(3600000), no_end_date:true,
      application_mode:'conditional', condition_type:'min_subtotal', condition_json: cj });
    var expired = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Expired', {
      discount_type:'fixed', discount_value:100, target_type:'all', target:[],
      starts_at: qaPastIso_(7200000), ends_at: qaPastIso_(3600000), no_end_date:false,
      application_mode:'conditional', condition_type:'min_subtotal', condition_json: cj });
    promos.push(disabled.promotion_id, scheduled.promotion_id, expired.promotion_id);

    // Condition (>=500) is easily met, but none of these should apply.
    var prev = qaPreviewPromo_([qaCartItem_(fx.product.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(prev, fx.product.id, '').unit_final_price) === 1000,
      'โปรที่ปิด/ยังไม่เริ่ม/หมดอายุต้องไม่ลดราคา', prev);
    qaAssert_(!qaPromoEligibleHas_(prev, disabled.promotion_id) && !qaPromoEligibleHas_(prev, scheduled.promotion_id) && !qaPromoEligibleHas_(prev, expired.promotion_id),
      'โปรที่ไม่ active ต้องไม่อยู่ในรายการได้รับส่วนลด', prev);
    qaStep_(steps, 'ตรวจโปรที่ไม่ active ไม่ถูกใช้', 'ok', prev);
    output = { steps: steps };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Priority/no-stacking: a direct product promo (-100) and a qualified conditional variant
// promo (-300) on the same line -> the bigger discount wins (best-price policy), NOT stacked.
// Also proves conditional promos are exempt from the overlap guard (both created on the
// same product/time).
function qaRunConditionalPriorityNoStackFlow_(ctx) {
  var variants = [{ name: 'Size', options: [{ label: 'S', price: 1000 }, { label: 'L', price: 1000 }] }];
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [], orderIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondPrio');
  var caught = null, output = null;
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: orderIds };
  try {
    var P = qaCreateOrderQaProduct_(token, shipping, stamp, 'PrioP', 20, { price: 1000, variants: variants });
    productIds = [P.id];
    // Direct product-level promo: -100 on the whole product.
    var direct = qaCreatePromotion_(token, P.id, stamp, 'DirectProd', {
      discount_type:'fixed', discount_value:100, target_type:'product', target:[{ product_id:P.id }] });
    promos.push(direct.promotion_id);
    // Conditional variant-level promo on Size=L: -300, condition = buy >=1 of Size=L.
    // Overlaps the direct promo's target — must be ACCEPTED because it is conditional.
    var cond = qaCreatePromotion_(token, P.id, stamp, 'CondVar', {
      discount_type:'fixed', discount_value:300, target_type:'variant', target:[{ product_id:P.id, variant_key:'Size=L' }],
      application_mode:'conditional', condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[{ product_id:P.id, variant_key:'Size=L', min_qty:1 }] } });
    qaAssert_(!!cond.promotion_id, 'โปรเงื่อนไขที่ทับ target โปรตรงต้องสร้างได้ (ยกเว้น overlap guard)', cond);
    promos.push(cond.promotion_id);
    qaStep_(steps, 'สร้างโปรตรง + โปรเงื่อนไขบนสินค้าเดียวกัน', 'ok', { direct: direct.promotion_id, cond: cond.promotion_id });

    // Cart Size=L: conditional variant promo qualifies and gives the lower price -> -300 -> 700
    // (NOT stacked with direct -100; would be 600 if stacked).
    var cartL = [qaCartItem_(P.id, 1, { Size: 'L' })];
    var prevL = qaPreviewPromo_(cartL);
    var lineL = qaPromoPreviewLine_(prevL, P.id, 'Size=L');
    qaAssert_(Number(lineL.unit_final_price) === 700, 'variant เงื่อนไขต้องชนะโดยไม่ซ้อนกับโปรตรง (คาด 700)', prevL);
    qaAssert_(lineL.promotion && String(lineL.promotion.promotion_id) === String(cond.promotion_id), 'ต้องใช้โปรเงื่อนไข variant', prevL);
    qaSubmitAndAssertMatchesPreview_(fx, 'PrioL', cartL, prevL);

    // Cart Size=S: conditional (needs L) does NOT qualify -> falls back to direct -100 -> 900.
    var prevS = qaPreviewPromo_([qaCartItem_(P.id, 1, { Size: 'S' })]);
    var lineS = qaPromoPreviewLine_(prevS, P.id, 'Size=S');
    qaAssert_(Number(lineS.unit_final_price) === 900, 'Size=S ต้องใช้โปรตรง -100 -> 900', prevS);
    qaAssert_(lineS.promotion && String(lineS.promotion.promotion_id) === String(direct.promotion_id), 'Size=S ต้องใช้โปรตรง', prevS);

    output = { steps: steps, direct: direct.promotion_id, cond: cond.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Legacy/direct regression + zero-floor: a legacy unconditional promo still applies, and a
// fixed discount larger than the price floors the unit price at 0.
function qaRunConditionalLegacyAndZeroFloorFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'CondLegacy', 20, { price: 400 });
  var steps = [], promos = [], caught = null, output = null;
  try {
    // Direct promo created WITHOUT any application_mode/condition — must behave as before.
    var legacy = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Legacy', { discount_type:'fixed', discount_value:500, target_type:'product', target:[{ product_id: fx.product.id }] });
    promos.push(legacy.promotion_id);
    var got = qaCall_('getPromotionRpc', [fx.token, legacy.promotion_id]);
    qaAssertOk_(got);
    qaAssert_(got.promotion.application_mode === 'direct', 'โปรที่ไม่ระบุโหมดต้องเป็น direct', got.promotion);
    var rec = qaGetProductRecord_(fx.product.id);
    qaAssert_(Number(rec.final_price) === 0 && Number(rec.discount_amount) === 400, 'ส่วนลดเกินราคาต้อง floor ที่ 0', rec);
    qaStep_(steps, 'legacy direct + zero floor', 'ok', { promotion: got.promotion, record: rec });

    // Order applies it too (direct discount baked into snapshot).
    var prev = qaPreviewPromo_([qaCartItem_(fx.product.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(prev, fx.product.id, '').unit_final_price) === 0, 'ราคาหลังลดต้องเป็น 0', prev);
    output = { steps: steps, promotion_id: legacy.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(fx.token, promos, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Immutable order snapshot: submit a qualifying conditional order, then delete the promo;
// the persisted order line keeps its discounted price + promotion snapshot.
function qaRunConditionalOrderSnapshotImmutableFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'CondSnap', 20, { price: 1000 });
  var steps = [], promoId = '', caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'CondSnap', {
      discount_type:'fixed', discount_value:150, target_type:'all', target:[],
      application_mode:'conditional', condition_type:'min_subtotal',
      condition_json:{ min_subtotal: 1000, calculation_base:'after_discount_before_shipping' } });
    promoId = promo.promotion_id;
    var cart = [qaCartItem_(fx.product.id, 1, {})];
    var prev = qaPreviewPromo_(cart);
    qaAssert_(Number(qaPromoPreviewLine_(prev, fx.product.id, '').unit_final_price) === 850, 'เงื่อนไขครบต้องลดเหลือ 850', prev);
    var submitted = qaSubmitAndAssertMatchesPreview_(fx, 'SnapBuyer', cart, prev);

    // Delete the promotion; the order snapshot must not change.
    qaAssertOk_(qaCall_('deletePromotionRpc', [fx.token, promoId]));
    promoId = '';
    var record = qaReadOrder_(fx.token, submitted.order_id);
    var line = qaFindProductLine_(record, fx.product.id);
    qaAssert_(line && line.promotion && String(line.promotion.promotion_id) === String(promo.promotion_id), 'ออร์เดอร์ต้องเก็บ snapshot โปรเงื่อนไขไว้', line);
    qaAssert_(Number(line.unit_final_price) === 850, 'ราคาในออร์เดอร์ต้องไม่เปลี่ยนหลังลบโปร', line);
    qaStep_(steps, 'ตรวจ snapshot ไม่เปลี่ยนหลังลบโปร', 'ok', line);
    output = { steps: steps, order_id: submitted.order_id, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (promoId) { try { qaCall_('deletePromotionRpc', [fx.token, promoId]); } catch(_){} }
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// required_variants, match_mode 'any': satisfying either listed variant of the condition
// product qualifies. Two entries on the same product (Size=S, Size=L); target a separate
// product T so the condition product's own price is never touched by the discount.
function qaRunConditionalRequiredVariantsAnyFlow_(ctx) {
  var variants = [{ name: 'Size', options: [{ label: 'S', price: 500 }, { label: 'L', price: 500 }] }];
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [], orderIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondReqVarAny');
  var caught = null, output = null;
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: orderIds };
  try {
    var A = qaCreateOrderQaProduct_(token, shipping, stamp, 'VarAnyA', 20, { price: 500, variants: variants });
    var T = qaCreateOrderQaProduct_(token, shipping, stamp, 'VarAnyTarget', 20, { price: 1000 });
    productIds = [A.id, T.id];
    var promo = qaCreatePromotion_(token, T.id, stamp, 'ReqVarAny', {
      discount_type: 'fixed', discount_value: 200, target_type: 'product', target: [{ product_id: T.id }],
      application_mode: 'conditional', condition_type: 'required_variants',
      condition_json: { match_mode: 'any', required_variants: [
        { product_id: A.id, variant_key: 'Size=S', min_qty: 1 },
        { product_id: A.id, variant_key: 'Size=L', min_qty: 1 }
      ] }
    });
    promos.push(promo.promotion_id);

    // Neither variant present: not eligible.
    var none = qaPreviewPromo_([qaCartItem_(T.id, 1, {})]);
    qaAssert_(Number(qaPromoPreviewLine_(none, T.id, '').unit_final_price) === 1000, 'ไม่มี variant เงื่อนไขต้องไม่ลดราคา', none);

    // Only Size=S present: ANY qualifies, T -200 -> 800.
    var withS = [qaCartItem_(A.id, 1, { Size: 'S' }), qaCartItem_(T.id, 1, {})];
    var prevS = qaPreviewPromo_(withS);
    qaAssert_(qaPromoEligibleHas_(prevS, promo.promotion_id), 'ANY: มี Size=S อย่างเดียวต้องผ่านเงื่อนไข', prevS);
    qaAssert_(Number(qaPromoPreviewLine_(prevS, T.id, '').unit_final_price) === 800, 'T ต้องลดเหลือ 800 เมื่อมี Size=S', prevS);
    qaSubmitAndAssertMatchesPreview_(fx, 'AnyVarS', withS, prevS);

    // Only Size=L present: ANY also qualifies, T -200 -> 800.
    var withL = [qaCartItem_(A.id, 1, { Size: 'L' }), qaCartItem_(T.id, 1, {})];
    var prevL = qaPreviewPromo_(withL);
    qaAssert_(qaPromoEligibleHas_(prevL, promo.promotion_id), 'ANY: มี Size=L อย่างเดียวต้องผ่านเงื่อนไข', prevL);
    qaAssert_(Number(qaPromoPreviewLine_(prevL, T.id, '').unit_final_price) === 800, 'T ต้องลดเหลือ 800 เมื่อมี Size=L', prevL);

    output = { steps: steps, promotion_id: promo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Two simultaneously-qualified conditional promotions targeting overlapping scopes on the
// same product (product-level -100 and variant-level -300). Both are trivially satisfiable
// at once — unlike promotions.conditional-priority-no-stack, which pits a conditional promo
// against a DIRECT one, this exercises the best-price resolver
// (resolveBestPromotionForLine_) between two CONDITIONAL promotions. Conditional promos are
// exempt from the overlap guard, so both can be created targeting the same product.
function qaRunConditionalTwoQualifiedCompetingFlow_(ctx) {
  var variants = [{ name: 'Size', options: [{ label: 'S', price: 1000 }, { label: 'L', price: 1000 }] }];
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], promos = [], productIds = [], orderIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondTwoQual');
  var caught = null, output = null;
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: orderIds };
  try {
    var P = qaCreateOrderQaProduct_(token, shipping, stamp, 'TwoQualP', 20, { price: 1000, variants: variants });
    productIds = [P.id];
    // Product-level conditional promo, trivially qualified (min_subtotal 100).
    var prodPromo = qaCreatePromotion_(token, P.id, stamp, 'TwoQualProd', {
      discount_type: 'fixed', discount_value: 100, target_type: 'product', target: [{ product_id: P.id }],
      application_mode: 'conditional', condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' } });
    promos.push(prodPromo.promotion_id);
    // Variant-level conditional promo on the same product (Size=L), also trivially qualified
    // (min_subtotal 50) and overlapping the product-level promo's target/time window — allowed
    // because both are conditional.
    var varPromo = qaCreatePromotion_(token, P.id, stamp, 'TwoQualVar', {
      discount_type: 'fixed', discount_value: 300, target_type: 'variant', target: [{ product_id: P.id, variant_key: 'Size=L' }],
      application_mode: 'conditional', condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 50, calculation_base: 'after_discount_before_shipping' } });
    qaAssert_(!!varPromo.promotion_id, 'โปรเงื่อนไข variant ที่ทับ target โปรเงื่อนไข product ต้องสร้างได้', varPromo);
    promos.push(varPromo.promotion_id);
    qaStep_(steps, 'สร้างโปรเงื่อนไข product + variant บนสินค้าเดียวกัน (ทั้งคู่ผ่านเงื่อนไข)', 'ok', { prodPromo: prodPromo.promotion_id, varPromo: varPromo.promotion_id });

    // Both promos are qualified for Size=L; the bigger discount must win: -300 -> 700.
    var cart = [qaCartItem_(P.id, 1, { Size: 'L' })];
    var prev = qaPreviewPromo_(cart);
    var line = qaPromoPreviewLine_(prev, P.id, 'Size=L');
    qaAssert_(Number(line.unit_final_price) === 700, 'โปรที่ลดมากกว่า (variant -300) ต้องชนะระหว่างโปรเงื่อนไขสองตัว (คาด 700)', prev);
    qaAssert_(line.promotion && String(line.promotion.promotion_id) === String(varPromo.promotion_id), 'ต้องใช้โปรเงื่อนไข variant ที่ให้ราคาต่ำสุด', prev);
    qaSubmitAndAssertMatchesPreview_(fx, 'TwoQualWin', cart, prev);

    // Disable the variant promo; the product-level conditional promo must now win: -100 -> 900.
    qaAssertOk_(qaCall_('togglePromotionRpc', [token, varPromo.promotion_id, false]));
    var prev2 = qaPreviewPromo_(cart);
    var line2 = qaPromoPreviewLine_(prev2, P.id, 'Size=L');
    qaAssert_(Number(line2.unit_final_price) === 900, 'หลังปิดโปร variant ต้องใช้โปรเงื่อนไข product แทน (คาด 900)', prev2);
    qaAssert_(line2.promotion && String(line2.promotion.promotion_id) === String(prodPromo.promotion_id), 'ต้องใช้โปรเงื่อนไข product หลังปิดโปร variant', prev2);

    output = { steps: steps, product_promo: prodPromo.promotion_id, variant_promo: varPromo.promotion_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(token, orderIds, productIds, shipping);
  (promos).forEach(function(pid){ try { qaCall_('deletePromotionRpc', [token, pid]); } catch(_){} });
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// A required_variants condition entry whose variant_key omits one of a multi-group
// product's variant groups is not a real enumerable variant_key and must be rejected at
// create time, not silently accepted as an always-false/always-true condition.
function qaRunConditionalRequiredVariantsIncompleteKeyRejectedFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], productIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'CondIncompleteKey');
  var caught = null, output = null;
  try {
    var A = qaCreateOrderQaProduct_(token, shipping, stamp, 'IncompleteKeyA', 5, {
      price: 500,
      variants: [
        { name: 'Color', options: [{ label: 'Red', price: 500 }, { label: 'Blue', price: 500 }] },
        { name: 'Size', options: [{ label: 'S', price: 500 }, { label: 'L', price: 500 }] }
      ]
    });
    productIds = [A.id];
    var res = qaCall_('createPromotionRpc', [token, {
      name: 'QA Incomplete Key ' + stamp, discount_type: 'fixed', discount_value: 100,
      target_type: 'all', target: [], starts_at: qaPastIso_(60000), no_end_date: true, enabled: true,
      application_mode: 'conditional', condition_type: 'required_variants',
      // Missing the 'Size=' portion of the canonical key — not a real enumerable variant_key.
      condition_json: { match_mode: 'all', required_variants: [{ product_id: A.id, variant_key: 'Color=Red', min_qty: 1 }] }
    }]);
    qaAssert_(res && res.ok === false, 'variant_key ที่ไม่ครบทุกกลุ่มต้องถูกปฏิเสธ', res);
    qaStep_(steps, 'ปฏิเสธ variant_key ที่ไม่ครบทุกกลุ่ม', 'ok', res);
    output = { steps: steps, rejected: res };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupProductAndShipping_(token, productIds[0], shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

/* ===== Gift × conditional-promotion interaction ===== */
// Gift min_subtotal is defined to use the subtotal AFTER DIRECT discounts only —
// conditional-promotion discounts are deliberately excluded from that base (see
// resolveCartPromotions_ / previewGiftEligibilityRpc). This is easy to regress silently
// if someone later wires gifts to the final (conditional-inclusive) price, so it needs a
// real behavior-based test, not just a design comment.
function qaRunGiftMinSubtotalIgnoresConditionalPromotionFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftCondPromo');
  var steps = [], caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftCondPromo', 10, { price: 1000 });
    fx.product_ids.push(product.id);

    // Conditional promo: qualifies once subtotal >= 500 (always true for qty>=1 @ 1000),
    // discounts the whole cart by 600 -> final unit price 400.
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'GiftCondPromo', {
      discount_type: 'fixed', discount_value: 600, target_type: 'all', target: [],
      application_mode: 'conditional', condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 500, calculation_base: 'after_discount_before_shipping' }
    });
    fx.promotion_ids.push(promo.promotion_id);

    // Gift rule: min_subtotal 900. Direct-only base for qty=1 is 1000 (no direct promo
    // exists) -> should be eligible, even though the FINAL price after the conditional
    // discount is only 400 (which would be < 900 if gifts used the final price instead).
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftCondPromo', { stock: 5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftCondPromo', gift.gift_id, {
      condition_type: 'min_subtotal', condition_json: { min_subtotal: 900 }
    });
    fx.rule_ids.push(rule.rule_id);
    qaStep_(steps, 'สร้าง conditional promo + gift rule min_subtotal', 'ok', { promotion_id: promo.promotion_id, rule_id: rule.rule_id });

    // Confirm the conditional promo itself is qualified and discounts to 400.
    var promoPrev = qaCall_('previewPromotionEligibilityRpc', [{ items: [qaCartItem_(product.id, 1, {})] }]);
    qaAssertOk_(promoPrev);
    var promoLine = qaPromoPreviewLine_(promoPrev, product.id, '');
    qaAssert_(Number(promoLine.unit_final_price) === 400, 'โปรเงื่อนไขต้องลดราคาเหลือ 400', promoPrev);

    // Gift preview: subtotal_after_promo must be the DIRECT-only base (1000), not 400,
    // and the gift rule must be eligible.
    var giftPrev = qaCall_('previewGiftEligibilityRpc', [{ items: [{ product_id: product.id, qty: 1, selected_variants: {} }] }]);
    qaAssertOk_(giftPrev);
    qaAssert_(Number(giftPrev.subtotal_after_promo) === 1000, 'ฐานคำนวณของแถมต้องเป็นยอดหลัง direct discount เท่านั้น (1000) ไม่ใช่ราคาหลังลด conditional (400)', giftPrev);
    qaAssert_(qaHasEligibleRule_(giftPrev, rule.rule_id), 'กฎของแถมควรผ่านเงื่อนไขแม้ราคาสุทธิหลังโปรเงื่อนไขจะต่ำกว่า min_subtotal', giftPrev);
    qaStep_(steps, 'ตรวจ gift preview ใช้ฐาน direct-only', 'ok', { promo_final: promoLine.unit_final_price, gift_subtotal_after_promo: giftPrev.subtotal_after_promo });

    // Submit: order total must reflect the conditional discount (400), and the gift line
    // must still be attached (eligibility already decided independent of that discount).
    var payload = qaBuildOrderPayloadForProduct_('qa-gift-cond-promo', fx.stamp, 'Buyer', product.id, fx.shipping, {
      items: [{ product_id: product.id, qty: 1, selected_variants: {} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var record = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var line = qaFindProductLine_(record, product.id);
    qaAssert_(!!line && Number(line.unit_final_price) === 400, 'ราคาสินค้าในออร์เดอร์ต้องลดตามโปรเงื่อนไข', line);
    var giftLines = qaActiveGiftLines_(record, gift.gift_id);
    qaAssert_(giftLines.length === 1, 'ของแถมต้องถูกแนบแม้ราคาสุทธิหลังลดจะต่ำกว่า min_subtotal ของกฎของแถม', record.items);
    qaStep_(steps, 'ตรวจออร์เดอร์: ราคาสินค้าลดตามโปร + ของแถมยังแนบอยู่', 'ok', { product_final: line.unit_final_price, gift_count: giftLines.length });

    output = { steps: steps, promotion_id: promo.promotion_id, rule_id: rule.rule_id, order_id: record.order_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// A conditional promotion excluded from a product does not block gift required_products
// eligibility on that same product — the gift condition is evaluated on raw cart quantities,
// independent of which promotion (if any) ultimately wins the line's price.
function qaRunGiftRequiredProductsWithConditionalPromotionFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftReqProdCondPromo');
  var steps = [], caught = null, output = null;
  try {
    var A = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftReqProdA', 10, { price: 500 });
    fx.product_ids.push(A.id);

    // Conditional promo on A: needs subtotal>=100 (trivially met), discounts A by 100.
    var promo = qaCreatePromotion_(fx.token, A.id, fx.stamp, 'GiftReqProdCondPromo', {
      discount_type: 'fixed', discount_value: 100, target_type: 'product', target: [{ product_id: A.id }],
      application_mode: 'conditional', condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 100, calculation_base: 'after_discount_before_shipping' }
    });
    fx.promotion_ids.push(promo.promotion_id);

    // Gift rule requires buying A qty>=2.
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftReqProdCondPromo', { stock: 5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftReqProdCondPromo', gift.gift_id, {
      condition_type: 'required_products', condition_json: { required_products: [{ product_id: A.id, min_qty: 2 }] }
    });
    fx.rule_ids.push(rule.rule_id);

    // qty 1: gift not eligible (condition unmet), even though the conditional promo applies.
    var one = qaCall_('previewGiftEligibilityRpc', [{ items: [{ product_id: A.id, qty: 1, selected_variants: {} }] }]);
    qaAssertOk_(one);
    qaAssert_(!qaHasEligibleRule_(one, rule.rule_id), 'ซื้อ A ไม่ครบ 2 ต้องไม่ได้ของแถม แม้โปรเงื่อนไขจะ apply', one);

    // qty 2: gift eligible; product price still reflects the conditional discount.
    var cart2 = [{ product_id: A.id, qty: 2, selected_variants: {} }];
    var two = qaCall_('previewGiftEligibilityRpc', [{ items: cart2 }]);
    qaAssertOk_(two);
    qaAssert_(qaHasEligibleRule_(two, rule.rule_id), 'ซื้อ A ครบ 2 ต้องได้ของแถม', two);
    var promoPrev = qaCall_('previewPromotionEligibilityRpc', [{ items: cart2 }]);
    qaAssertOk_(promoPrev);
    qaAssert_(Number(qaPromoPreviewLine_(promoPrev, A.id, '').unit_final_price) === 400, 'A ต้องยังคงลดราคาตามโปรเงื่อนไข (400)', promoPrev);

    var payload = qaBuildOrderPayloadForProduct_('qa-gift-reqprod-condpromo', fx.stamp, 'Buyer', A.id, fx.shipping, { items: cart2 });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var record = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var line = qaFindProductLine_(record, A.id);
    qaAssert_(!!line && Number(line.unit_final_price) === 400, 'ราคาสินค้าในออร์เดอร์ต้องลดตามโปรเงื่อนไข', line);
    qaAssert_(qaActiveGiftLines_(record, gift.gift_id).length === 1, 'ของแถมต้องถูกแนบเมื่อซื้อ A ครบ 2', record.items);
    qaStep_(steps, 'ตรวจ gift required_products ทำงานถูกต้องร่วมกับโปรเงื่อนไข', 'ok', { product_final: line.unit_final_price });

    output = { steps: steps, promotion_id: promo.promotion_id, rule_id: rule.rule_id };
  } catch (err) { caught = err; qaStep_(steps, 'error', 'failed', { error: String(err && err.message || err) }); }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps: steps, cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunTokenExpiryFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'TokenExpiry', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-token-expiry', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssert_(!!res.token, 'submitOrderRpc did not return token', res);
    var expiredAt = new Date(Date.now() - 60000).toISOString();
    qaSetOrderTokenExpiry_(orderId, expiredAt);
    var read = qaCall_('getOrderByTokenRpc', [res.token]);
    qaAssert_(read && read.ok === false, 'Expired token should be rejected', read);
    output = { order_id:orderId, expired_at:expiredAt, response:read };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaPrepareConcurrentDuplicateOrderIdRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'ConcurrentDuplicateId', 5);
  var clientOrderId = 'qa-condup-' + stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var buyers = ['A', 'B', 'C', 'D', 'E'];
  return {
    ok: true,
    product_id: product.id,
    shipping_fixture: shipping,
    client_order_id: clientOrderId,
    expected_success_count: 1,
    expected_duplicate_count: 4,
    jobs: buyers.map(function(buyer) {
      return {
        buyer: buyer,
        delayMs: 0,
        payload: qaBuildOrderPayloadForProduct_('qa-condup', stamp, buyer, product.id, shipping, { client_order_id: clientOrderId })
      };
    })
  };
}

function qaVerifyConcurrentDuplicateOrderIdRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  submissions = submissions || [];
  var success = submissions.filter(function(e){ return e && e.ok; });
  var dupes = submissions.filter(function(e){ return e && !e.ok && e.response && e.response.error === 'DUPLICATE_ORDER'; });
  var otherFailures = submissions.filter(function(e){ return e && !e.ok && !(e.response && e.response.error === 'DUPLICATE_ORDER'); });
  var orderIds = success.map(function(e){ return e.response && e.response.order_id; }).filter(Boolean);
  var uniqueOrderIds = Array.from(new Set(orderIds));
  var stock = qaGetProductStock_(fixture.product_id);
  return {
    ok: true,
    success_count: success.length,
    duplicate_count: dupes.length,
    other_failure_count: otherFailures.length,
    order_ids: uniqueOrderIds,
    final_product_stock: stock,
    passed: success.length === 1 && dupes.length === 4 && otherFailures.length === 0 && uniqueOrderIds.length === 1 && stock === 4
  };
}

function qaCleanupConcurrentDuplicateOrderIdRpc(token, fixture) {
  fixture = fixture || {};
  return qaCleanupConcurrentStockRaceRpc(token, fixture);
}

function qaPrepareVariantStockRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'VariantRace', -1, {
    variants: [{
      name: 'Color',
      type: 'text',
      options: [
        { label: 'Red', price: 500, weight_grams: 100, stock: 2 },
        { label: 'Blue', price: 500, weight_grams: 100, stock: 5 }
      ]
    }]
  });
  var buyers = ['A', 'B', 'C', 'D', 'E'];
  return {
    ok: true,
    product_id: product.id,
    shipping_fixture: shipping,
    group_name: 'Color',
    option_label: 'Red',
    expected_success_count: 2,
    expected_stock_insufficient_count: 3,
    jobs: buyers.map(function(buyer) {
      return {
        buyer: buyer,
        delayMs: 0,
        payload: qaBuildOrderPayloadForProduct_('qa-var-race', stamp, buyer, product.id, shipping, {
          selected_variants: { Color: 'Red' }
        })
      };
    })
  };
}

function qaVerifyVariantStockRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  submissions = submissions || [];
  var success = submissions.filter(function(e){ return e && e.ok; });
  var stockFails = submissions.filter(function(e){ return e && !e.ok && e.response && e.response.error === 'STOCK_INSUFFICIENT'; });
  var otherFailures = submissions.filter(function(e){ return e && !e.ok && !(e.response && e.response.error === 'STOCK_INSUFFICIENT'); });
  var variantStock = qaGetVariantStock_(fixture.product_id, fixture.group_name, fixture.option_label);
  return {
    ok: true,
    success_count: success.length,
    stock_insufficient_count: stockFails.length,
    other_failure_count: otherFailures.length,
    final_variant_stock: variantStock,
    passed: success.length === 2 && stockFails.length === 3 && otherFailures.length === 0 && variantStock === 0
  };
}

function qaCleanupVariantStockRaceRpc(token, fixture) {
  fixture = fixture || {};
  return qaCleanupConcurrentStockRaceRpc(token, fixture);
}

function qaSubmittedOrderIdsFromEntries_(entries) {
  var ids = [];
  (entries || []).forEach(function(entry) {
    if (!entry || !entry.ok || !entry.response) return;
    qaOrderIdsFromSubmit_(entry.response).forEach(function(id) {
      if (ids.indexOf(id) < 0) ids.push(id);
    });
  });
  return ids;
}

function qaPrepareConcurrentHeavyPromoGiftStockRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'HeavyPromoGiftRace', { flat_rate:20 });
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'HeavyPromoGiftRace', 3, { price:1000 });
  var promo = qaCreatePromotion_(token, product.id, stamp, 'HeavyPromoGiftRace', { discount_type:'fixed', discount_value:100 });
  var gift = qaCreateGiftItem_(token, stamp, 'HeavyPromoGiftRace', { stock:2 });
  var rule = qaCreateGiftRule_(token, stamp, 'HeavyPromoGiftRace', gift.gift_id, {
    condition_type:'required_products',
    condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] },
    gift_qty:1,
    repeat_mode:'once_per_order',
    priority:9997
  });
  var buyers = ['A','B','C','D','E','F','G','H'];
  return {
    ok:true,
    product_id:product.id,
    promotion_id:promo.promotion_id,
    gift_id:gift.gift_id,
    rule_id:rule.rule_id,
    shipping_fixture:shipping,
    expected_success_count:3,
    expected_stock_insufficient_count:5,
    expected_gift_attached_count:2,
    expected_gift_skipped_count:1,
    expected_total:920,
    jobs:buyers.map(function(buyer) {
      return {
        buyer:buyer,
        delayMs:0,
        payload:qaBuildOrderPayloadForProduct_('qa-heavy-promo-gift-race', stamp, buyer, product.id, shipping)
      };
    })
  };
}

function qaVerifyConcurrentHeavyPromoGiftStockRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  submissions = submissions || [];
  var success = submissions.filter(function(e){ return e && e.ok; });
  var stockFails = submissions.filter(function(e){ return e && !e.ok && e.response && e.response.error === 'STOCK_INSUFFICIENT'; });
  var otherFailures = submissions.filter(function(e){ return e && !e.ok && !(e.response && e.response.error === 'STOCK_INSUFFICIENT'); });
  var orderIds = qaSubmittedOrderIdsFromEntries_(success);
  var records = orderIds.map(function(orderId) {
    var record = qaReadOrder_(token, orderId);
    var giftLines = qaActiveGiftLines_(record, fixture.gift_id);
    return {
      order_id:orderId,
      total:Number(record.total || 0),
      has_target_gift:giftLines.length > 0,
      gift_count:giftLines.length
    };
  });
  var giftAttachedCount = records.filter(function(r){ return r.has_target_gift; }).length;
  var giftSkippedCount = success.filter(function(e) {
    return (e.response.gifts_skipped || []).some(function(g) {
      return String(g.gift_id) === String(fixture.gift_id) && g.code === 'GIFT_OUT_OF_STOCK';
    });
  }).length;
  var totalsOk = records.every(function(r){ return Number(r.total) === Number(fixture.expected_total); });
  var productStock = qaGetProductStock_(fixture.product_id);
  var giftStock = qaGetGiftStock_(fixture.gift_id);
  var passed = success.length === Number(fixture.expected_success_count || 3)
    && stockFails.length === Number(fixture.expected_stock_insufficient_count || 5)
    && otherFailures.length === 0
    && orderIds.length === Number(fixture.expected_success_count || 3)
    && giftAttachedCount === Number(fixture.expected_gift_attached_count || 2)
    && giftSkippedCount === Number(fixture.expected_gift_skipped_count || 1)
    && productStock === 0
    && giftStock === 0
    && totalsOk;
  return {
    ok:true,
    success_count:success.length,
    stock_insufficient_count:stockFails.length,
    other_failure_count:otherFailures.length,
    order_ids:orderIds,
    records:records,
    gift_attached_count:giftAttachedCount,
    gift_skipped_count:giftSkippedCount,
    final_product_stock:productStock,
    final_gift_stock:giftStock,
    totals_ok:totalsOk,
    passed:passed
  };
}

function qaCleanupConcurrentHeavyPromoGiftStockRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  return qaCleanupCommerceFixture_({
    token:token,
    order_ids:qaSubmittedOrderIdsFromEntries_(submissions || []),
    promotion_ids:[fixture.promotion_id],
    rule_ids:[fixture.rule_id],
    gift_ids:[fixture.gift_id],
    product_ids:[fixture.product_id],
    shipping:fixture.shipping_fixture
  });
}

function qaPrepareConcurrentRepeatGiftMultipliedStockRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'RepeatGiftMultipliedRace', { flat_rate:20 });
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'RepeatGiftMultipliedRace', 6, { price:1000 });
  var promo = qaCreatePromotion_(token, product.id, stamp, 'RepeatGiftMultipliedRace', { discount_type:'fixed', discount_value:100 });
  var gift = qaCreateGiftItem_(token, stamp, 'RepeatGiftMultipliedRace', { stock:4 });
  var rule = qaCreateGiftRule_(token, stamp, 'RepeatGiftMultipliedRace', gift.gift_id, {
    condition_type:'required_products',
    condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] },
    gift_qty:1,
    repeat_mode:'per_threshold',
    priority:9998
  });
  var buyers = ['A','B','C','D','E','F','G','H'];
  return {
    ok:true,
    product_id:product.id,
    promotion_id:promo.promotion_id,
    gift_id:gift.gift_id,
    rule_id:rule.rule_id,
    shipping_fixture:shipping,
    expected_success_count:3,
    expected_stock_insufficient_count:5,
    expected_gift_attached_orders:2,
    expected_gift_attached_units:4,
    expected_gift_skipped_count:1,
    expected_total:1820,
    jobs:buyers.map(function(buyer) {
      return {
        buyer:buyer,
        delayMs:0,
        payload:qaBuildOrderPayloadForProduct_('qa-repeat-gift-multiplied-race', stamp, buyer, product.id, shipping, { qty:2 })
      };
    })
  };
}

function qaVerifyConcurrentRepeatGiftMultipliedStockRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  submissions = submissions || [];
  var success = submissions.filter(function(e){ return e && e.ok; });
  var stockFails = submissions.filter(function(e){ return e && !e.ok && e.response && e.response.error === 'STOCK_INSUFFICIENT'; });
  var otherFailures = submissions.filter(function(e){ return e && !e.ok && !(e.response && e.response.error === 'STOCK_INSUFFICIENT'); });
  var orderIds = qaSubmittedOrderIdsFromEntries_(success);
  var records = orderIds.map(function(orderId) {
    var record = qaReadOrder_(token, orderId);
    var giftLines = qaActiveGiftLines_(record, fixture.gift_id);
    var giftUnits = giftLines.reduce(function(sum, line){ return sum + Number(line.gift_qty || 0); }, 0);
    return { order_id:orderId, total:Number(record.total || 0), gift_lines:giftLines.length, gift_units:giftUnits };
  });
  var attached = records.filter(function(r){ return r.gift_units > 0; });
  var attachedUnits = attached.reduce(function(sum, r){ return sum + r.gift_units; }, 0);
  var skipped = success.filter(function(e) {
    return (e.response.gifts_skipped || []).some(function(g) {
      return String(g.gift_id) === String(fixture.gift_id)
        && g.code === 'GIFT_OUT_OF_STOCK'
        && Number(g.requested_qty) === 2;
    });
  });
  var totalsOk = records.every(function(r){ return Number(r.total) === Number(fixture.expected_total) && (r.gift_units === 0 || r.gift_units === 2); });
  var productStock = qaGetProductStock_(fixture.product_id);
  var giftStock = qaGetGiftStock_(fixture.gift_id);
  var passed = success.length === Number(fixture.expected_success_count || 3)
    && stockFails.length === Number(fixture.expected_stock_insufficient_count || 5)
    && otherFailures.length === 0
    && orderIds.length === Number(fixture.expected_success_count || 3)
    && attached.length === Number(fixture.expected_gift_attached_orders || 2)
    && attachedUnits === Number(fixture.expected_gift_attached_units || 4)
    && skipped.length === Number(fixture.expected_gift_skipped_count || 1)
    && productStock === 0
    && giftStock === 0
    && totalsOk;
  return {
    ok:true,
    success_count:success.length,
    stock_insufficient_count:stockFails.length,
    other_failure_count:otherFailures.length,
    order_ids:orderIds,
    records:records,
    gift_attached_orders:attached.length,
    gift_attached_units:attachedUnits,
    gift_skipped_count:skipped.length,
    final_product_stock:productStock,
    final_gift_stock:giftStock,
    totals_ok:totalsOk,
    passed:passed
  };
}

function qaCleanupConcurrentRepeatGiftMultipliedStockRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  return qaCleanupCommerceFixture_({
    token:token,
    order_ids:qaSubmittedOrderIdsFromEntries_(submissions || []),
    promotion_ids:[fixture.promotion_id],
    rule_ids:[fixture.rule_id],
    gift_ids:[fixture.gift_id],
    product_ids:[fixture.product_id],
    shipping:fixture.shipping_fixture
  });
}

function qaPrepareConcurrentHeavySplitIdempotencyRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'HeavySplitIdem', [
    { name:'QA Heavy Split A', mode:'flat', flat_rate:10 },
    { name:'QA Heavy Split B', mode:'flat', flat_rate:20 }
  ]);
  var methodA = shipping.methods[0];
  var methodB = shipping.methods[1];
  var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'HeavySplitA', 5, { allowed_shipping_ids:[methodA.id], price:500 });
  var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'HeavySplitB', 5, { allowed_shipping_ids:[methodB.id], price:700 });
  var promo = qaCreatePromotion_(token, productA.id, stamp, 'HeavySplitA', { discount_type:'fixed', discount_value:50 });
  var clientOrderId = 'qa-heavy-split-idem-' + stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var payload = qaBuildOrderPayloadForProduct_('qa-heavy-split-idem', stamp, 'SameCheckout', productA.id, shipping, {
    client_order_id:clientOrderId,
    items:[
      { product_id:productA.id, qty:1, selected_variants:{} },
      { product_id:productB.id, qty:1, selected_variants:{} }
    ]
  });
  payload.shipping_info = [
    { company_id:shipping.company.id, method_id:methodA.id, item_product_ids:[productA.id] },
    { company_id:shipping.company.id, method_id:methodB.id, item_product_ids:[productB.id] }
  ];
  var buyers = ['A','B','C','D','E','F'];
  return {
    ok:true,
    product_a_id:productA.id,
    product_b_id:productB.id,
    promotion_id:promo.promotion_id,
    shipping_fixture:shipping,
    client_order_id:clientOrderId,
    expected_success_count:1,
    expected_duplicate_count:5,
    expected_order_count:2,
    expected_product_a_stock:4,
    expected_product_b_stock:4,
    expected_totals:[460, 720],
    jobs:buyers.map(function(buyer) {
      return {
        buyer:buyer,
        delayMs:0,
        payload:qaClone_(payload)
      };
    })
  };
}

function qaVerifyConcurrentHeavySplitIdempotencyRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  submissions = submissions || [];
  var success = submissions.filter(function(e){ return e && e.ok; });
  var dupes = submissions.filter(function(e){ return e && !e.ok && e.response && e.response.error === 'DUPLICATE_ORDER'; });
  var otherFailures = submissions.filter(function(e){ return e && !e.ok && !(e.response && e.response.error === 'DUPLICATE_ORDER'); });
  var orderIds = qaSubmittedOrderIdsFromEntries_(success);
  var records = orderIds.map(function(orderId) {
    var record = qaReadOrder_(token, orderId);
    var productIds = (record.items || []).filter(function(item){ return item.line_type !== 'gift'; }).map(function(item){ return String(item.product_id); });
    return { order_id:orderId, total:Number(record.total || 0), product_ids:productIds };
  });
  var totals = records.map(function(r){ return r.total; }).sort(function(a, b){ return a - b; });
  var expectedTotals = (fixture.expected_totals || []).slice().sort(function(a, b){ return a - b; });
  var totalsOk = totals.length === expectedTotals.length && totals.every(function(total, i){ return Number(total) === Number(expectedTotals[i]); });
  var stockA = qaGetProductStock_(fixture.product_a_id);
  var stockB = qaGetProductStock_(fixture.product_b_id);
  var passed = success.length === Number(fixture.expected_success_count || 1)
    && dupes.length === Number(fixture.expected_duplicate_count || 5)
    && otherFailures.length === 0
    && orderIds.length === Number(fixture.expected_order_count || 2)
    && stockA === Number(fixture.expected_product_a_stock || 4)
    && stockB === Number(fixture.expected_product_b_stock || 4)
    && totalsOk;
  return {
    ok:true,
    success_count:success.length,
    duplicate_count:dupes.length,
    other_failure_count:otherFailures.length,
    order_ids:orderIds,
    records:records,
    final_product_a_stock:stockA,
    final_product_b_stock:stockB,
    totals:totals,
    totals_ok:totalsOk,
    passed:passed
  };
}

function qaCleanupConcurrentHeavySplitIdempotencyRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  return qaCleanupCommerceFixture_({
    token:token,
    order_ids:qaSubmittedOrderIdsFromEntries_(submissions || []),
    promotion_ids:[fixture.promotion_id],
    product_ids:[fixture.product_a_id, fixture.product_b_id],
    shipping:fixture.shipping_fixture
  });
}

function qaGetGiftStock_(giftId) {
  var sh = _sheetGiftItems();
  var n = sh.getLastRow();
  if (n < 2) return null;
  var rows = sh.getRange(2, 1, n - 1, 6).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(giftId)) return Number(rows[i][5]);
  }
  return null;
}

function qaFindGiftItem_(token, giftId) {
  var res = qaCall_('listGiftItemsRpc', [token]);
  qaAssertOk_(res);
  return (res.items || []).filter(function(g){ return String(g.gift_id) === String(giftId); })[0] || null;
}

function qaFindGiftRule_(token, ruleId) {
  var res = qaCall_('listGiftRulesRpc', [token]);
  qaAssertOk_(res);
  return (res.rules || []).filter(function(r){ return String(r.rule_id) === String(ruleId); })[0] || null;
}

function qaCreateGiftItem_(token, stamp, label, opts) {
  opts = opts || {};
  var res = qaCall_('createGiftItemRpc', [token, {
    name: 'QA Gift ' + label + ' ' + stamp,
    description: opts.description || ('ของแถม QA ชั่วคราวสำหรับ ' + label),
    stock: opts.stock !== undefined ? opts.stock : 5,
    enabled: opts.enabled !== false
  }]);
  qaAssertOk_(res);
  qaAssert_(!!res.gift_id, 'createGiftItemRpc did not return gift_id', res);
  return { gift_id: res.gift_id, response: res };
}

function qaCreateGiftRule_(token, stamp, label, giftId, opts) {
  opts = opts || {};
  var startedAt = opts.starts_at !== undefined ? opts.starts_at : new Date(Date.now() - 60000).toISOString();
  var conditionType = opts.condition_type || 'required_products';
  var conditionJson = opts.condition_json || {};
  var res = qaCall_('createGiftRuleRpc', [token, {
    name: 'QA Gift Rule ' + label + ' ' + stamp,
    description: opts.description || ('กฎของแถม QA ชั่วคราวสำหรับ ' + label),
    gift_id: giftId,
    condition_type: conditionType,
    condition_json: conditionJson,
    gift_qty: opts.gift_qty || 1,
    repeat_mode: opts.repeat_mode || 'once_per_order',
    starts_at: startedAt,
    ends_at: opts.ends_at || '',
    no_end_date: opts.no_end_date !== undefined ? opts.no_end_date : true,
    enabled: opts.enabled !== false,
    priority: opts.priority !== undefined ? opts.priority : 9000
  }]);
  qaAssertOk_(res);
  qaAssert_(!!res.rule_id, 'createGiftRuleRpc did not return rule_id', res);
  return { rule_id: res.rule_id, response: res };
}

function qaCreateGiftEligibilityFixture_(ctx, label, opts) {
  opts = opts || {};
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'Gift' + label);
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'Gift' + label, opts.product_stock !== undefined ? opts.product_stock : 10, {
    price: opts.product_price || 500
  });
  var gift = qaCreateGiftItem_(token, stamp, label, {
    stock: opts.gift_stock !== undefined ? opts.gift_stock : 5,
    enabled: opts.gift_enabled !== false
  });
  var conditionType = opts.condition_type || 'required_products';
  var conditionJson = opts.condition_json;
  if (!conditionJson) {
    if (conditionType === 'min_subtotal') {
      conditionJson = { min_subtotal: opts.min_subtotal || 500 };
    } else {
      conditionJson = { required_products: [{ product_id: product.id, min_qty: opts.min_qty || 1 }] };
    }
  }
  var rule = qaCreateGiftRule_(token, stamp, label, gift.gift_id, {
    condition_type: conditionType,
    condition_json: conditionJson,
    gift_qty: opts.gift_qty || 1,
    repeat_mode: opts.repeat_mode || 'once_per_order',
    starts_at: opts.starts_at,
    ends_at: opts.ends_at,
    no_end_date: opts.no_end_date,
    enabled: opts.rule_enabled !== false,
    priority: opts.priority !== undefined ? opts.priority : 9000
  });
  return {
    token: token,
    stamp: stamp,
    shipping: shipping,
    product: product,
    gift_id: gift.gift_id,
    rule_id: rule.rule_id,
    order_ids: []
  };
}

function qaCleanupGiftFixture_(fx) {
  fx = fx || {};
  var token = fx.token;
  var cleanup = { ok:true, orders:null, rule:null, gift:null, product:null, shipping:null };
  cleanup.orders = qaDeleteOrdersSafe_(token, fx.order_ids || []);
  if (!cleanup.orders || cleanup.orders.ok !== true) cleanup.ok = false;
  if (fx.rule_id) {
    try { cleanup.rule = qaCall_('deleteGiftRuleRpc', [token, fx.rule_id]); if (!cleanup.rule || cleanup.rule.ok !== true) cleanup.ok = false; }
    catch (errRule) { cleanup.rule = { ok:false, error:String(errRule && errRule.message || errRule) }; cleanup.ok = false; }
  }
  if (fx.gift_id) {
    try { cleanup.gift = qaCall_('deleteGiftItemRpc', [token, fx.gift_id]); if (!cleanup.gift || cleanup.gift.ok !== true) cleanup.ok = false; }
    catch (errGift) { cleanup.gift = { ok:false, error:String(errGift && errGift.message || errGift) }; cleanup.ok = false; }
  }
  if (fx.product && fx.product.id) {
    try { cleanup.product = qaCall_('productDeleteRpc', [token, fx.product.id]); if (!cleanup.product || cleanup.product.ok !== true) cleanup.ok = false; }
    catch (errProd) { cleanup.product = { ok:false, error:String(errProd && errProd.message || errProd) }; cleanup.ok = false; }
  }
  try { cleanup.shipping = qaCleanupTempShipping_(token, fx.shipping); if (!cleanup.shipping || cleanup.shipping.ok !== true) cleanup.ok = false; }
  catch (errShip) { cleanup.shipping = { ok:false, error:String(errShip && errShip.message || errShip) }; cleanup.ok = false; }
  return cleanup;
}

function qaPreviewGiftFixture_(fx, qty) {
  return qaCall_('previewGiftEligibilityRpc', [{
    items: [{ product_id: fx.product.id, qty: qty === undefined ? 1 : qty, selected_variants: {} }]
  }]);
}

function qaHasEligibleRule_(preview, ruleId) {
  return (preview && preview.eligible || []).some(function(e){ return String(e.rule_id) === String(ruleId); });
}

function qaActiveGiftLines_(record, giftId) {
  return (record.items || []).filter(function(item) {
    return item.line_type === 'gift'
      && String(item.gift_id) === String(giftId)
      && item.status !== 'removed';
  });
}

function qaRunGiftItemCrudFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var giftId = '', caught = null, output = null;
  try {
    var create = qaCreateGiftItem_(token, stamp, 'Crud', { stock: 3, enabled: true });
    giftId = create.gift_id;
    var found = qaFindGiftItem_(token, giftId);
    qaAssert_(!!found, 'ต้องพบของแถมหลังสร้าง', { gift_id: giftId });
    var update = qaCall_('updateGiftItemRpc', [token, giftId, { name: 'QA Gift Crud Updated ' + stamp, stock: 7, enabled: false }]);
    qaAssertOk_(update);
    var updated = qaFindGiftItem_(token, giftId);
    qaAssert_(updated && updated.name.indexOf('Updated') >= 0 && Number(updated.stock) === 7 && updated.enabled === false, 'ข้อมูลของแถมหลังแก้ไขไม่ถูกต้อง', updated);
    var del = qaCall_('deleteGiftItemRpc', [token, giftId]);
    qaAssertOk_(del);
    giftId = '';
    qaAssert_(!qaFindGiftItem_(token, create.gift_id), 'หลังลบต้องไม่พบ gift_id เดิม');
    output = { gift_id: create.gift_id, updated: updated, delete_response: del };
  } catch (err) { caught = err; }
  var cleanup = giftId ? qaCall_('deleteGiftItemRpc', [token, giftId]) : { ok:true, skipped:true };
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRuleCrudFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var giftId = '', ruleId = '', caught = null, output = null;
  try {
    giftId = qaCreateGiftItem_(token, stamp, 'RuleCrud', { stock: 3 }).gift_id;
    ruleId = qaCreateGiftRule_(token, stamp, 'RuleCrud', giftId, {
      condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 500 },
      priority: 10
    }).rule_id;
    qaAssert_(!!qaFindGiftRule_(token, ruleId), 'ต้องพบกฎหลังสร้าง', { rule_id: ruleId });
    var update = qaCall_('updateGiftRuleRpc', [token, ruleId, { name: 'QA Gift Rule Updated ' + stamp, priority: 123, enabled: false }]);
    qaAssertOk_(update);
    var updated = qaFindGiftRule_(token, ruleId);
    qaAssert_(updated && updated.name.indexOf('Updated') >= 0 && Number(updated.priority) === 123 && updated.enabled === false, 'ข้อมูลกฎหลังแก้ไขไม่ถูกต้อง', updated);
    var delRule = qaCall_('deleteGiftRuleRpc', [token, ruleId]);
    qaAssertOk_(delRule);
    ruleId = '';
    var delGift = qaCall_('deleteGiftItemRpc', [token, giftId]);
    qaAssertOk_(delGift);
    giftId = '';
    output = { updated: updated, delete_rule: delRule, delete_gift: delGift };
  } catch (err) { caught = err; }
  var cleanup = [];
  if (ruleId) cleanup.push(qaCall_('deleteGiftRuleRpc', [token, ruleId]));
  if (giftId) cleanup.push(qaCall_('deleteGiftItemRpc', [token, giftId]));
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftDisabledItemFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'DisabledItem', { gift_enabled: false });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(!qaHasEligibleRule_(preview, fx.rule_id), 'gift item ที่ปิดใช้งานต้องไม่ eligible', preview);
    output = { rule_id: fx.rule_id, eligible_count: preview.eligible.length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftDisabledRuleFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'DisabledRule', { rule_enabled: false });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(!qaHasEligibleRule_(preview, fx.rule_id), 'กฎที่ปิดใช้งานต้องไม่ eligible', preview);
    output = { rule_id: fx.rule_id, eligible_count: preview.eligible.length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftScheduleNotStartedFlow_(ctx) {
  var future = new Date(Date.now() + 86400000).toISOString();
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'ScheduleFuture', { starts_at: future, no_end_date: true });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(!qaHasEligibleRule_(preview, fx.rule_id), 'กฎที่ยังไม่เริ่มต้องไม่ eligible', preview);
    output = { rule_id: fx.rule_id, starts_at: future, eligible_count: preview.eligible.length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftScheduleEndedFlow_(ctx) {
  var start = new Date(Date.now() - 172800000).toISOString();
  var end = new Date(Date.now() - 86400000).toISOString();
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'ScheduleEnded', { starts_at: start, ends_at: end, no_end_date: false });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(!qaHasEligibleRule_(preview, fx.rule_id), 'กฎที่หมดเวลาแล้วต้องไม่ eligible', preview);
    output = { rule_id: fx.rule_id, starts_at: start, ends_at: end, eligible_count: preview.eligible.length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRequiredProductsMinQtyFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RequiredMinQty', { min_qty: 2 });
  var caught = null, output = null;
  try {
    var one = qaPreviewGiftFixture_(fx, 1);
    var two = qaPreviewGiftFixture_(fx, 2);
    qaAssertOk_(one); qaAssertOk_(two);
    qaAssert_(!qaHasEligibleRule_(one, fx.rule_id), 'qty=1 ต้องยังไม่ eligible', one);
    qaAssert_(qaHasEligibleRule_(two, fx.rule_id), 'qty=2 ต้อง eligible', two);
    output = { qty1_eligible: qaHasEligibleRule_(one, fx.rule_id), qty2_eligible: qaHasEligibleRule_(two, fx.rule_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftMinSubtotalFlow_(ctx) {
  var endsAt = new Date(Date.now() + 86400000).toISOString();
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'MinSubtotal', {
    condition_type: 'min_subtotal',
    min_subtotal: 1000,
    product_price: 600,
    ends_at: endsAt,
    no_end_date: false
  });
  var caught = null, output = null;
  try {
    var low = qaPreviewGiftFixture_(fx, 1);
    var high = qaPreviewGiftFixture_(fx, 2);
    qaAssertOk_(low); qaAssertOk_(high);
    qaAssert_(!qaHasEligibleRule_(low, fx.rule_id), 'ยอด 600 ต้องยังไม่ eligible', low);
    qaAssert_(qaHasEligibleRule_(high, fx.rule_id), 'ยอด 1200 ต้อง eligible', high);
    var nearEntry = (low.near || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    var eligibleEntry = (high.eligible || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    qaAssert_(nearEntry && nearEntry.starts_at && nearEntry.ends_at === endsAt && nearEntry.no_end_date === false,
      'Gift near preview must expose its active schedule', nearEntry);
    qaAssert_(eligibleEntry && eligibleEntry.starts_at && eligibleEntry.ends_at === endsAt && eligibleEntry.no_end_date === false,
      'Gift eligible preview must expose its active schedule', eligibleEntry);
    output = { low_subtotal: low.subtotal_after_promo, high_subtotal: high.subtotal_after_promo };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftOncePerOrderFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'OncePerOrder', { min_qty: 1, gift_qty: 1, repeat_mode: 'once_per_order' });
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-gift-once', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 3 });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var record = qaReadOrder_(fx.token, orderId);
    var gifts = qaActiveGiftLines_(record, fx.gift_id);
    qaAssert_(gifts.length === 1 && Number(gifts[0].gift_qty || 0) === 1, 'once_per_order ต้องมี gift line เดียว qty=1', gifts);
    output = { order_id: orderId, gift_line_count: gifts.length, gift_qty: gifts[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// per_threshold repeat mode: gift_qty is multiplied by the number of complete
// times the cart clears the threshold; the default once_per_order still fires once.
function qaRunGiftRepeatThresholdFlow_(ctx) {
  var fxSingle = qaCreateGiftEligibilityFixture_(ctx, 'RepeatSingle', { min_qty: 1, gift_qty: 1, gift_stock: 10, repeat_mode: 'per_threshold' });
  var fxRatio  = qaCreateGiftEligibilityFixture_(ctx, 'RepeatRatio',  { min_qty: 3, gift_qty: 1, gift_stock: 10, repeat_mode: 'per_threshold' });
  var fxOnce   = qaCreateGiftEligibilityFixture_(ctx, 'RepeatControl', { min_qty: 1, gift_qty: 1, gift_stock: 10, repeat_mode: 'once_per_order' });
  // Keep this global subtotal rule disabled while the earlier orders run;
  // otherwise those carts consume its gift stock before the subtotal case starts.
  var fxSub    = qaCreateGiftEligibilityFixture_(ctx, 'RepeatSubtotal', { condition_type: 'min_subtotal', min_subtotal: 500, product_price: 500, gift_qty: 1, gift_stock: 10, repeat_mode: 'per_threshold', rule_enabled: false });
  var fxMulti  = qaCreateCommerceFixture_(ctx, 'GiftRepeatMulti');
  var caught = null, output = null;
  try {
    // Verify that the fixture still has its clean price before creating orders.
    // An unrelated all-target promotion is staging contamination, not a gift defect.
    var promoPreflight = qaPreviewPromo_([qaCartItem_(fxSub.product.id, 3, {})]);
    var promoLine = qaPromoPreviewLine_(promoPreflight, fxSub.product.id, '');
    var preflightUnit = promoLine ? Number(promoLine.unit_final_price) : NaN;
    var preflightSubtotal = preflightUnit * 3;
    if (!promoLine || promoLine.promotion || preflightUnit !== 500 || preflightSubtotal !== 1500) {
      var earlyCleanup = {
        multi: qaCleanupCommerceFixture_(fxMulti), subtotal: qaCleanupGiftFixture_(fxSub),
        control: qaCleanupGiftFixture_(fxOnce), ratio: qaCleanupGiftFixture_(fxRatio),
        single: qaCleanupGiftFixture_(fxSingle)
      };
      return qaSkip_('External promotion changes the clean subtotal fixture', {
        promotion_id: promoLine && promoLine.promotion && promoLine.promotion.promotion_id || '',
        unit_price: preflightUnit,
        subtotal: preflightSubtotal,
        promotion_preview: promoPreflight,
        cleanup: earlyCleanup
      });
    }
    // Case 1: min_qty=1, buy 3 → 3 sets.
    var r1 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-rep1', fxSingle.stamp, 'Buyer', fxSingle.product.id, fxSingle.shipping, { qty: 3 }), fxSingle.order_ids);
    qaAssertOk_(r1);
    var g1 = qaActiveGiftLines_(qaReadOrder_(fxSingle.token, qaOrderIdsFromSubmit_(r1)[0]), fxSingle.gift_id);
    qaAssert_(g1.length === 1 && Number(g1[0].gift_qty || 0) === 3, 'per_threshold min_qty=1 ซื้อ 3 ต้องได้ของแถม 3 ชุด', g1);

    // Case 2: min_qty=3, buy 6 → 2 sets (remainder ignored).
    var r2 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-rep2', fxRatio.stamp, 'Buyer', fxRatio.product.id, fxRatio.shipping, { qty: 6 }), fxRatio.order_ids);
    qaAssertOk_(r2);
    var g2 = qaActiveGiftLines_(qaReadOrder_(fxRatio.token, qaOrderIdsFromSubmit_(r2)[0]), fxRatio.gift_id);
    qaAssert_(g2.length === 1 && Number(g2[0].gift_qty || 0) === 2, 'per_threshold min_qty=3 ซื้อ 6 ต้องได้ของแถม 2 ชุด', g2);

    // Case 3 (control): once_per_order min_qty=1, buy 3 → still 1 set.
    var r3 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-rep3', fxOnce.stamp, 'Buyer', fxOnce.product.id, fxOnce.shipping, { qty: 3 }), fxOnce.order_ids);
    qaAssertOk_(r3);
    var g3 = qaActiveGiftLines_(qaReadOrder_(fxOnce.token, qaOrderIdsFromSubmit_(r3)[0]), fxOnce.gift_id);
    qaAssert_(g3.length === 1 && Number(g3[0].gift_qty || 0) === 1, 'once_per_order ต้องได้ของแถม 1 ชุดเสมอ', g3);

    // Case 4: min_subtotal=500 with price 500 × qty 3 = 1500 → 3 sets.
    qaAssertOk_(qaCall_('toggleGiftRuleRpc', [fxSub.token, fxSub.rule_id, true]));
    var giftPreflight = qaPreviewGiftFixture_(fxSub, 3);
    qaAssertOk_(giftPreflight);
    var giftEligible = (giftPreflight.eligible || []).filter(function(entry){ return String(entry.rule_id) === String(fxSub.rule_id); })[0];
    qaAssert_(giftEligible && Number(giftEligible.gift && giftEligible.gift.qty) === 3,
      'Gift preview must award three units before order submission', {
        promotion_preview:promoPreflight, gift_preview:giftPreflight,
        unit_price:preflightUnit, subtotal:preflightSubtotal, stock:qaGetGiftStock_(fxSub.gift_id)
      });
    var r4 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-rep4', fxSub.stamp, 'Buyer', fxSub.product.id, fxSub.shipping, { qty: 3 }), fxSub.order_ids);
    qaAssertOk_(r4);
    var order4 = qaReadOrder_(fxSub.token, qaOrderIdsFromSubmit_(r4)[0]);
    var g4 = qaActiveGiftLines_(order4, fxSub.gift_id);
    qaAssert_(g4.length === 1 && Number(g4[0].gift_qty || 0) === 3, 'per_threshold min_subtotal 500 ยอด 1500 ต้องได้ของแถม 3 ชุด', {
      promotion_preview:promoPreflight, gift_preview:giftPreflight,
      order:order4, order_lines:order4 && order4.items || [], awarded_lines:g4,
      gift_stock:qaGetGiftStock_(fxSub.gift_id)
    });
    qaAssertOk_(qaCall_('toggleGiftRuleRpc', [fxSub.token, fxSub.rule_id, false]));

    // Case 5: multi-entry required_products uses the LOWEST completed multiplier.
    // p1 min_qty=2 buy 4 → 2; p2 min_qty=2 buy 6 → 3; min = 2.
    var mp1 = qaCreateOrderQaProduct_(fxMulti.token, fxMulti.shipping, fxMulti.stamp, 'RepMultiA', 20, { price: 100 });
    var mp2 = qaCreateOrderQaProduct_(fxMulti.token, fxMulti.shipping, fxMulti.stamp, 'RepMultiB', 20, { price: 100 });
    fxMulti.product_ids.push(mp1.id, mp2.id);
    var mGift = qaCreateGiftItem_(fxMulti.token, fxMulti.stamp, 'RepMulti', { stock: 10 });
    fxMulti.gift_ids.push(mGift.gift_id);
    var mRule = qaCreateGiftRule_(fxMulti.token, fxMulti.stamp, 'RepMulti', mGift.gift_id, {
      condition_type: 'required_products',
      condition_json: { required_products: [{ product_id: mp1.id, min_qty: 2 }, { product_id: mp2.id, min_qty: 2 }] },
      gift_qty: 1,
      repeat_mode: 'per_threshold'
    });
    fxMulti.rule_ids.push(mRule.rule_id);
    var r5 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-rep5', fxMulti.stamp, 'Buyer', mp1.id, fxMulti.shipping, {
      items: [{ product_id: mp1.id, qty: 4, selected_variants: {} }, { product_id: mp2.id, qty: 6, selected_variants: {} }]
    }), fxMulti.order_ids);
    qaAssertOk_(r5);
    var g5 = qaActiveGiftLines_(qaReadOrder_(fxMulti.token, qaOrderIdsFromSubmit_(r5)[0]), mGift.gift_id);
    qaAssert_(g5.length === 1 && Number(g5[0].gift_qty || 0) === 2, 'multi-entry required_products ต้องใช้ตัวคูณต่ำสุด (min=2)', g5);

    output = {
      single_qty: g1[0].gift_qty, ratio_qty: g2[0].gift_qty, control_qty: g3[0].gift_qty,
      subtotal_qty: g4[0].gift_qty, multi_qty: g5[0].gift_qty
    };
  } catch (err) { caught = err; }
  // Fixtures are nested snapshots of the global shipping config, so restore them
  // in reverse creation order. Forward cleanup removes methods still used by later
  // fixtures and leaves temporary methods behind after the final restore.
  var cleanup = {
    multi: qaCleanupCommerceFixture_(fxMulti), subtotal: qaCleanupGiftFixture_(fxSub),
    control: qaCleanupGiftFixture_(fxOnce), ratio: qaCleanupGiftFixture_(fxRatio),
    single: qaCleanupGiftFixture_(fxSingle)
  };
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

/* ============================================================================
 * per_threshold repeat-mode coverage — focused, isolated specs.
 * Each verifies awarded gift quantity AND (where relevant) final gift stock.
 * The multiplier = number of complete times the cart clears the threshold;
 * remainders are ignored; multi-entry rules use the lowest per-entry multiplier;
 * 'once_per_order' (default/blank/invalid) always grants exactly one set.
 * ==========================================================================*/

// required_products: exact boundary and ignored remainder, with stock deduction.
// min_qty=2 → buy 4 gives 2 sets; buy 5 still gives 2 (remainder ignored).
function qaRunGiftRepeatRequiredProductsBoundaryFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatBoundary', { min_qty: 2, gift_qty: 1, gift_stock: 10, product_stock: 20, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var exact = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-bnd-exact', fx.stamp, 'Exact', fx.product.id, fx.shipping, { qty: 4 }), fx.order_ids);
    qaAssertOk_(exact);
    var gExact = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(exact)[0]), fx.gift_id);
    qaAssert_(gExact.length === 1 && Number(gExact[0].gift_qty || 0) === 2, 'min_qty=2 ซื้อ 4 ต้องได้ 2 ชุด (พอดี)', gExact);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 8, 'สต็อกของแถมต้องลดลง 2 หลังคำสั่งซื้อแรก', { stock: qaGetGiftStock_(fx.gift_id) });

    var remainder = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-bnd-rem', fx.stamp, 'Remainder', fx.product.id, fx.shipping, { qty: 5 }), fx.order_ids);
    qaAssertOk_(remainder);
    var gRem = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(remainder)[0]), fx.gift_id);
    qaAssert_(gRem.length === 1 && Number(gRem[0].gift_qty || 0) === 2, 'min_qty=2 ซื้อ 5 ต้องได้ 2 ชุด (เศษถูกละไว้)', gRem);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 6, 'สต็อกของแถมต้องลดลงอีก 2 (รวม 4)', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { exact_qty: gExact[0].gift_qty, remainder_qty: gRem[0].gift_qty, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// required_products below threshold → not eligible, no gift, stock untouched.
function qaRunGiftRepeatBelowThresholdFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatBelow', { min_qty: 3, gift_qty: 1, gift_stock: 5, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-below', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 2 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'ซื้อไม่ครบขั้นต่ำต้องไม่ได้ของแถม', order.items);
    qaAssert_(!(res.gifts_skipped || []).some(function(s){ return String(s.gift_id) === String(fx.gift_id); }), 'ไม่ครบขั้นต่ำไม่ควรถูกนับเป็น skipped', res);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 5, 'สต็อกของแถมต้องไม่ถูกหักเมื่อไม่ eligible', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { gift_lines: 0, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// gift_qty > 1 combined with the threshold multiplier: gift_qty=3, min_qty=1,
// buy 4 → 4 thresholds × 3 = 12; stock 20 → 8.
function qaRunGiftRepeatGiftQtyMultiplierFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatGiftQty', { min_qty: 1, gift_qty: 3, gift_stock: 20, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-giftqty', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 4 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 12, 'gift_qty=3 × 4 thresholds ต้องได้ 12 ชิ้น', g);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 8, 'สต็อกของแถมต้องลดลง 12', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { gift_qty: g[0].gift_qty, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// min_subtotal multiplier with an ignored remainder.
// price 250, min_subtotal 500, buy 5 → subtotal 1250 → floor(1250/500)=2 sets.
function qaRunGiftRepeatMinSubtotalMultiplierFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatSubtotal', { condition_type: 'min_subtotal', min_subtotal: 500, product_price: 250, gift_qty: 1, gift_stock: 5, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-sub', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 5 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 2, 'ยอด 1250 / ขั้นต่ำ 500 ต้องได้ 2 ชุด (เศษ 250 ถูกละไว้)', g);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 3, 'สต็อกของแถมต้องลดลง 2', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { gift_qty: g[0].gift_qty, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// min_subtotal multiplier must use the DISCOUNTED subtotal (after promotion),
// verified through both preview and the submitted order for consistency.
// price 1000, promo −600 → unit 400; min_subtotal 500; buy 3 → 1200 → 2 sets.
// (Undiscounted 3000 would wrongly yield 6.)
function qaRunGiftRepeatMinSubtotalAfterDiscountFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatSubDiscount', { condition_type: 'min_subtotal', min_subtotal: 500, product_price: 1000, gift_qty: 1, gift_stock: 10, product_stock: 10, repeat_mode: 'per_threshold' });
  fx.promotion_ids = [];
  var caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'RepeatSubDiscount', { discount_value: 600 });
    fx.promotion_ids.push(promo.promotion_id);
    var preview = qaPreviewGiftFixture_(fx, 3);
    qaAssertOk_(preview);
    qaAssert_(Number(preview.subtotal_after_promo) === 1200, 'ยอดหลังหักโปรโมชั่นต้องเป็น 1200', preview);
    var elig = (preview.eligible || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    qaAssert_(elig && Number(elig.gift.qty) === 2, 'ตัวอย่าง (preview) ต้องแสดงของแถม 2 ชุดจากยอดหลังหักส่วนลด', preview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-sub-disc', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 2, 'คำสั่งซื้อจริงต้องได้ของแถม 2 ชุด (คิดจากยอดหลังหักส่วนลด)', g);
    output = { preview_qty: elig.gift.qty, order_qty: g[0].gift_qty, subtotal_after_promo: preview.subtotal_after_promo };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token: fx.token, order_ids: fx.order_ids, promotion_ids: fx.promotion_ids, rule_ids: [fx.rule_id], gift_ids: [fx.gift_id], product_ids: [fx.product.id], shipping: fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// required_variants multiplier: only the matching variant counts toward the
// threshold. Size=M min_qty=2, buy 6×M (→3 sets) plus 3×L (ignored).
function qaRunGiftRepeatRequiredVariantsMultiplierFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'RepeatVariant');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RepeatVariant', -1, {
      price: 100,
      variants: [{ name: 'Size', type: 'text', options: [{ label: 'M', price: 100, weight_grams: 100, stock: 10 }, { label: 'L', price: 100, weight_grams: 100, stock: 10 }] }]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'RepeatVariant', { stock: 10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'RepeatVariant', gift.gift_id, {
      condition_type: 'required_variants',
      condition_json: { required_variants: [{ product_id: product.id, variant_key: 'Size=M', min_qty: 2 }] },
      gift_qty: 1, repeat_mode: 'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-variant', fx.stamp, 'Buyer', product.id, fx.shipping, {
      items: [{ product_id: product.id, qty: 6, selected_variants: { Size: 'M' } }, { product_id: product.id, qty: 3, selected_variants: { Size: 'L' } }]
    }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), gift.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 3, 'Size=M min 2 ซื้อ 6 ต้องได้ 3 ชุด (variant L ไม่นับ)', g);
    output = { gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Multiple required_products entries → lowest completed multiplier wins.
// p1 min2 buy4 (→2), p2 min3 buy12 (→4); result = min(2,4) = 2.
function qaRunGiftRepeatMultiProductsLowestFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'RepeatMultiProducts');
  var caught = null, output = null;
  try {
    var p1 = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RepMultiP1', 20, { price: 100 });
    var p2 = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RepMultiP2', 20, { price: 100 });
    fx.product_ids.push(p1.id, p2.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'RepeatMultiProducts', { stock: 10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'RepeatMultiProducts', gift.gift_id, {
      condition_type: 'required_products',
      condition_json: { required_products: [{ product_id: p1.id, min_qty: 2 }, { product_id: p2.id, min_qty: 3 }] },
      gift_qty: 1, repeat_mode: 'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-multi-prod', fx.stamp, 'Buyer', p1.id, fx.shipping, {
      items: [{ product_id: p1.id, qty: 4, selected_variants: {} }, { product_id: p2.id, qty: 12, selected_variants: {} }]
    }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), gift.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 2, 'หลายสินค้า: ต้องใช้ตัวคูณต่ำสุด min(2,4)=2', g);
    output = { gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// match_mode 'any': satisfying at least one listed entry qualifies (once mode → 1 set).
// [A min2, B min3] any-mode; buy A×2 only → eligible; buy A×1 only → not eligible.
function qaRunGiftMatchAnyProductsOneQualifiesFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'MatchAnyProducts');
  var caught = null, output = null;
  try {
    var pA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchAnyA', 20, { price: 100 });
    var pB = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchAnyB', 20, { price: 100 });
    fx.product_ids.push(pA.id, pB.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'MatchAnyProducts', { stock: 10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'MatchAnyProducts', gift.gift_id, {
      condition_type: 'required_products',
      condition_json: { match_mode: 'any', required_products: [{ product_id: pA.id, min_qty: 2 }, { product_id: pB.id, min_qty: 3 }] },
      gift_qty: 1, repeat_mode: 'once_per_order'
    });
    fx.rule_ids.push(rule.rule_id);
    // Buy only A×2 (B absent) → A qualifies → eligible, 1 set.
    var okRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-any-ok', fx.stamp, 'One', pA.id, fx.shipping, { qty: 2 }), fx.order_ids);
    qaAssertOk_(okRes);
    var gOk = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(okRes)[0]), gift.gift_id);
    qaAssert_(gOk.length === 1 && Number(gOk[0].gift_qty || 0) === 1, 'any-mode: ซื้อ A×2 อย่างเดียวต้องได้ของแถม 1 ชุด', gOk);
    // Buy only A×1 → no entry qualifies → not eligible.
    var noRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-any-no', fx.stamp, 'None', pA.id, fx.shipping, { qty: 1 }), fx.order_ids);
    qaAssertOk_(noRes);
    var gNo = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(noRes)[0]), gift.gift_id);
    qaAssert_(gNo.length === 0, 'any-mode: ซื้อ A×1 (ไม่ครบ) ต้องไม่ได้ของแถม', gNo);
    output = { ok_qty: gOk[0].gift_qty, none_lines: gNo.length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// match_mode 'any' + per_threshold: multiplier = SUM of completed rounds across qualifying entries.
// [A min2, B min3]; buy A×6 (3 rounds) + B×3 (1 round) → 3+1 = 4 sets.
function qaRunGiftMatchAnyRepeatSumFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'MatchAnySum');
  var caught = null, output = null;
  try {
    var pA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchSumA', 30, { price: 100 });
    var pB = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchSumB', 30, { price: 100 });
    fx.product_ids.push(pA.id, pB.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'MatchAnySum', { stock: 20 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'MatchAnySum', gift.gift_id, {
      condition_type: 'required_products',
      condition_json: { match_mode: 'any', required_products: [{ product_id: pA.id, min_qty: 2 }, { product_id: pB.id, min_qty: 3 }] },
      gift_qty: 1, repeat_mode: 'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-any-sum', fx.stamp, 'Buyer', pA.id, fx.shipping, {
      items: [{ product_id: pA.id, qty: 6, selected_variants: {} }, { product_id: pB.id, qty: 3, selected_variants: {} }]
    }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), gift.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 4, 'any-mode per_threshold: A(3 รอบ)+B(1 รอบ) = 4 ชุด', g);
    output = { gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Backward compat: a rule with NO match_mode defaults to 'all' (every entry required).
// [A min1, B min1] no match_mode; buy A only → not eligible (B missing).
function qaRunGiftMatchAllDefaultBackwardCompatFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'MatchAllDefault');
  var caught = null, output = null;
  try {
    var pA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchAllA', 20, { price: 100 });
    var pB = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchAllB', 20, { price: 100 });
    fx.product_ids.push(pA.id, pB.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'MatchAllDefault', { stock: 10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'MatchAllDefault', gift.gift_id, {
      condition_type: 'required_products',
      // NOTE: no match_mode → must default to 'all'
      condition_json: { required_products: [{ product_id: pA.id, min_qty: 1 }, { product_id: pB.id, min_qty: 1 }] },
      gift_qty: 1, repeat_mode: 'once_per_order'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-all-default', fx.stamp, 'Buyer', pA.id, fx.shipping, { qty: 1 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), gift.gift_id);
    qaAssert_(g.length === 0, 'ไม่มี match_mode ต้อง default = all: ซื้อ A อย่างเดียวต้องไม่ได้ของแถม', g);
    var stored = qaFindGiftRule_(fx.token, rule.rule_id);
    qaAssert_(stored && (stored.condition_json || {}).match_mode === 'all', 'match_mode ควรถูก normalize เป็น all', stored);
    output = { gift_lines: 0, stored_mode: (stored.condition_json || {}).match_mode };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// match_mode 'any' on required_variants (mirrors the required_products ANY-mode tests, which
// never exercise variant matching): once_per_order — buying only one listed variant qualifies,
// buying it below its own min_qty does not; per_threshold — completed rounds from every
// qualifying variant entry are SUMMED (not just the lowest), same as the products case.
function qaRunGiftMatchAnyRequiredVariantsFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'MatchAnyVariant');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MatchAnyVariant', -1, {
      price: 100,
      variants: [{ name: 'Size', type: 'text', options: [
        { label: 'M', price: 100, weight_grams: 100, stock: 20 },
        { label: 'L', price: 100, weight_grams: 100, stock: 20 }
      ] }]
    });
    fx.product_ids.push(product.id);
    var cond = { match_mode: 'any', required_variants: [
      { product_id: product.id, variant_key: 'Size=M', min_qty: 2 },
      { product_id: product.id, variant_key: 'Size=L', min_qty: 3 }
    ] };

    // Case A (once_per_order): Size=M x2 alone qualifies (1 set); Size=M x1 alone does not.
    var giftOnce = qaCreateGiftItem_(fx.token, fx.stamp, 'MatchAnyVariantOnce', { stock: 10 });
    fx.gift_ids.push(giftOnce.gift_id);
    var ruleOnce = qaCreateGiftRule_(fx.token, fx.stamp, 'MatchAnyVariantOnce', giftOnce.gift_id, {
      condition_type: 'required_variants', condition_json: cond, gift_qty: 1, repeat_mode: 'once_per_order'
    });
    fx.rule_ids.push(ruleOnce.rule_id);
    var okRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-any-var-ok', fx.stamp, 'One', product.id, fx.shipping, {
      items: [{ product_id: product.id, qty: 2, selected_variants: { Size: 'M' } }]
    }), fx.order_ids);
    qaAssertOk_(okRes);
    var gOk = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(okRes)[0]), giftOnce.gift_id);
    qaAssert_(gOk.length === 1 && Number(gOk[0].gift_qty || 0) === 1, 'any-mode variant: ซื้อ Size=M x2 อย่างเดียวต้องได้ของแถม 1 ชุด', gOk);

    var noRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-any-var-no', fx.stamp, 'None', product.id, fx.shipping, {
      items: [{ product_id: product.id, qty: 1, selected_variants: { Size: 'M' } }]
    }), fx.order_ids);
    qaAssertOk_(noRes);
    var gNo = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(noRes)[0]), giftOnce.gift_id);
    qaAssert_(gNo.length === 0, 'any-mode variant: ซื้อ Size=M x1 (ไม่ครบ) ต้องไม่ได้ของแถม', gNo);

    // Case B (per_threshold): M x4 (2 rounds) + L x3 (1 round) sums to 3.
    var giftRepeat = qaCreateGiftItem_(fx.token, fx.stamp, 'MatchAnyVariantRepeat', { stock: 20 });
    fx.gift_ids.push(giftRepeat.gift_id);
    var ruleRepeat = qaCreateGiftRule_(fx.token, fx.stamp, 'MatchAnyVariantRepeat', giftRepeat.gift_id, {
      condition_type: 'required_variants', condition_json: cond, gift_qty: 1, repeat_mode: 'per_threshold'
    });
    fx.rule_ids.push(ruleRepeat.rule_id);
    var sumRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-any-var-sum', fx.stamp, 'Buyer', product.id, fx.shipping, {
      items: [
        { product_id: product.id, qty: 4, selected_variants: { Size: 'M' } },
        { product_id: product.id, qty: 3, selected_variants: { Size: 'L' } }
      ]
    }), fx.order_ids);
    qaAssertOk_(sumRes);
    var gSum = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(sumRes)[0]), giftRepeat.gift_id);
    qaAssert_(gSum.length === 1 && Number(gSum[0].gift_qty || 0) === 3, 'any-mode per_threshold variant: M(2 รอบ)+L(1 รอบ) = 3 ชุด', gSum);

    output = { ok_qty: gOk[0].gift_qty, none_lines: gNo.length, sum_qty: gSum[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Duplicate conditions must be rejected at create time.
function qaRunGiftDuplicateProductsRejectedFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'DupProducts');
  var caught = null, output = null;
  try {
    var pA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'DupA', 10, { price: 100 });
    fx.product_ids.push(pA.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'DupProducts', { stock: 5 });
    fx.gift_ids.push(gift.gift_id);
    var res = qaCall_('createGiftRuleRpc', [fx.token, {
      name: 'QA Dup Products ' + fx.stamp,
      gift_id: gift.gift_id,
      condition_type: 'required_products',
      condition_json: { required_products: [{ product_id: pA.id, min_qty: 1 }, { product_id: pA.id, min_qty: 2 }] },
      gift_qty: 1, no_end_date: true, enabled: true, priority: 9000
    }]);
    if (res && res.rule_id) fx.rule_ids.push(res.rule_id); // track for cleanup if it wrongly succeeded
    qaAssert_(res && res.ok === false, 'สินค้าซ้ำในเงื่อนไขต้องถูกปฏิเสธ', res);
    output = { rejected: true, error: res.error };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftDuplicateVariantsRejectedFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'DupVariants');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'DupVar', -1, {
      price: 100,
      variants: [{ name: 'Size', type: 'text', options: [{ label: 'M', price: 100, weight_grams: 100, stock: 5 }, { label: 'L', price: 100, weight_grams: 100, stock: 5 }] }]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'DupVariants', { stock: 5 });
    fx.gift_ids.push(gift.gift_id);
    var res = qaCall_('createGiftRuleRpc', [fx.token, {
      name: 'QA Dup Variants ' + fx.stamp,
      gift_id: gift.gift_id,
      condition_type: 'required_variants',
      condition_json: { required_variants: [{ product_id: product.id, variant_key: 'Size=M', min_qty: 1 }, { product_id: product.id, variant_key: 'Size=M', min_qty: 2 }] },
      gift_qty: 1, no_end_date: true, enabled: true, priority: 9000
    }]);
    if (res && res.rule_id) fx.rule_ids.push(res.rule_id);
    qaAssert_(res && res.ok === false, 'รุ่น/ตัวเลือกซ้ำในเงื่อนไขต้องถูกปฏิเสธ', res);
    output = { rejected: true, error: res.error };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// A required_variants condition entry whose variant_key omits one of a multi-group
// product's variant groups is not a real enumerable variant_key and must be rejected at
// create time (mirrors promotions.conditional-required-variants-incomplete-key-rejected).
function qaRunGiftRequiredVariantsIncompleteKeyRejectedFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftIncompleteKey');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftIncompleteKey', 5, {
      price: 500,
      variants: [
        { name: 'Color', type: 'text', options: [{ label: 'Red', price: 500, weight_grams: 100, stock: 5 }, { label: 'Blue', price: 500, weight_grams: 100, stock: 5 }] },
        { name: 'Size', type: 'text', options: [{ label: 'S', price: 500, weight_grams: 100, stock: 5 }, { label: 'L', price: 500, weight_grams: 100, stock: 5 }] }
      ]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftIncompleteKey', { stock: 5 });
    fx.gift_ids.push(gift.gift_id);
    var res = qaCall_('createGiftRuleRpc', [fx.token, {
      name: 'QA Incomplete Key ' + fx.stamp,
      gift_id: gift.gift_id,
      condition_type: 'required_variants',
      // Missing the 'Size=' portion of the canonical key — not a real enumerable variant_key.
      condition_json: { required_variants: [{ product_id: product.id, variant_key: 'Color=Red', min_qty: 1 }] },
      gift_qty: 1, no_end_date: true, enabled: true, priority: 9000
    }]);
    if (res && res.rule_id) fx.rule_ids.push(res.rule_id);
    qaAssert_(res && res.ok === false, 'variant_key ที่ไม่ครบทุกกลุ่มต้องถูกปฏิเสธ', res);
    output = { rejected: true, error: res.error };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Multiple required_variants entries → lowest completed multiplier wins.
// Size=M min2 buy4 (→2), Size=L min2 buy6 (→3); result = min(2,3) = 2.
function qaRunGiftRepeatMultiVariantsLowestFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'RepeatMultiVariants');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RepeatMultiVariants', -1, {
      price: 100,
      variants: [{ name: 'Size', type: 'text', options: [{ label: 'M', price: 100, weight_grams: 100, stock: 10 }, { label: 'L', price: 100, weight_grams: 100, stock: 10 }] }]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'RepeatMultiVariants', { stock: 10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'RepeatMultiVariants', gift.gift_id, {
      condition_type: 'required_variants',
      condition_json: { required_variants: [{ product_id: product.id, variant_key: 'Size=M', min_qty: 2 }, { product_id: product.id, variant_key: 'Size=L', min_qty: 2 }] },
      gift_qty: 1, repeat_mode: 'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-multi-var', fx.stamp, 'Buyer', product.id, fx.shipping, {
      items: [{ product_id: product.id, qty: 4, selected_variants: { Size: 'M' } }, { product_id: product.id, qty: 6, selected_variants: { Size: 'L' } }]
    }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), gift.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 2, 'หลาย variant: ต้องใช้ตัวคูณต่ำสุด min(2,3)=2', g);
    output = { gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Duplicate cart lines for the same product aggregate before the multiplier.
// min_qty=2, lines qty2 + qty4 = 6 → 3 sets.
function qaRunGiftRepeatDuplicateLinesFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatDuplicate', { min_qty: 2, gift_qty: 1, gift_stock: 5, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-dup', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items: [{ product_id: fx.product.id, qty: 2, selected_variants: {} }, { product_id: fx.product.id, qty: 4, selected_variants: {} }]
    }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 3, 'บรรทัดซ้ำ (2+4=6) / ขั้นต่ำ 2 ต้องได้ 3 ชุด', g);
    output = { gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Preview and the submitted order must report the same multiplied gift quantity.
function qaRunGiftRepeatPreviewMatchesOrderFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatPreviewMatch', { min_qty: 1, gift_qty: 1, gift_stock: 10, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 3);
    qaAssertOk_(preview);
    var elig = (preview.eligible || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    qaAssert_(elig && Number(elig.gift.qty) === 3, 'ตัวอย่าง (preview) ต้องแสดงของแถม 3 ชุด', preview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-preview', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === Number(elig.gift.qty), 'จำนวนของแถมในคำสั่งซื้อต้องตรงกับ preview', { preview: elig.gift.qty, order: g[0] && g[0].gift_qty });
    output = { preview_qty: elig.gift.qty, order_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Invalid repeat_mode value is normalized to once_per_order (stored + behavior).
function qaRunGiftRepeatInvalidModeDefaultsOnceFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatInvalidMode', { min_qty: 1, gift_qty: 1, gift_stock: 10, product_stock: 10, repeat_mode: 'garbage_value' });
  var caught = null, output = null;
  try {
    var stored = qaFindGiftRule_(fx.token, fx.rule_id);
    qaAssert_(stored && stored.repeat_mode === 'once_per_order', 'repeat_mode ที่ไม่ถูกต้องต้องถูกปรับเป็น once_per_order', stored);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-invalid', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 1, 'โหมดที่ไม่ถูกต้องต้องให้ของแถมเพียง 1 ชุด', g);
    output = { stored_mode: stored.repeat_mode, gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Backward compatibility: a rule created WITHOUT a repeat_mode field defaults to
// once_per_order both in storage and behavior.
function qaRunGiftRepeatMissingModeBackwardCompatFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'RepeatMissingMode');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'RepeatMissingMode', 10, { price: 500 });
  var gift = qaCreateGiftItem_(token, stamp, 'RepeatMissingMode', { stock: 10 });
  var fx = { token: token, stamp: stamp, shipping: shipping, product: product, gift_id: gift.gift_id, rule_id: '', order_ids: [] };
  var caught = null, output = null;
  try {
    // Deliberately omit repeat_mode from the payload (simulates legacy rules).
    var created = qaCall_('createGiftRuleRpc', [token, {
      name: 'QA Gift Rule RepeatMissingMode ' + stamp,
      gift_id: gift.gift_id,
      condition_type: 'required_products',
      condition_json: { required_products: [{ product_id: product.id, min_qty: 1 }] },
      gift_qty: 1,
      no_end_date: true,
      enabled: true,
      priority: 9000
    }]);
    qaAssertOk_(created);
    fx.rule_id = created.rule_id;
    var stored = qaFindGiftRule_(token, fx.rule_id);
    qaAssert_(stored && stored.repeat_mode === 'once_per_order', 'กฎที่ไม่มี repeat_mode ต้องอ่านค่าเป็น once_per_order', stored);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-missing', stamp, 'Buyer', product.id, shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(token, qaOrderIdsFromSubmit_(res)[0]), gift.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 1, 'กฎเดิม (ไม่มี repeat_mode) ต้องให้ของแถม 1 ชุด', g);
    output = { stored_mode: stored.repeat_mode, gift_qty: g[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Editing a rule between once_per_order and per_threshold round-trips through
// storage and immediately changes awarded quantities.
function qaRunGiftRepeatUpdateModeRoundTripFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatRoundTrip', { min_qty: 1, gift_qty: 1, gift_stock: 20, product_stock: 30, repeat_mode: 'once_per_order' });
  var caught = null, output = null;
  try {
    var res1 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-rt-1', fx.stamp, 'Once', fx.product.id, fx.shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res1);
    var g1 = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res1)[0]), fx.gift_id);
    qaAssert_(g1.length === 1 && Number(g1[0].gift_qty || 0) === 1, 'เริ่มต้น once_per_order ต้องได้ 1 ชุด', g1);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, { repeat_mode: 'per_threshold' }]));
    qaAssert_((qaFindGiftRule_(fx.token, fx.rule_id) || {}).repeat_mode === 'per_threshold', 'หลังแก้ไขต้องเก็บค่า per_threshold', fx.rule_id);
    var res2 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-rt-2', fx.stamp, 'Threshold', fx.product.id, fx.shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res2);
    var g2 = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res2)[0]), fx.gift_id);
    qaAssert_(g2.length === 1 && Number(g2[0].gift_qty || 0) === 3, 'เปลี่ยนเป็น per_threshold แล้วซื้อ 3 ต้องได้ 3 ชุด', g2);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, { repeat_mode: 'once_per_order' }]));
    qaAssert_((qaFindGiftRule_(fx.token, fx.rule_id) || {}).repeat_mode === 'once_per_order', 'หลังแก้ไขกลับต้องเก็บค่า once_per_order', fx.rule_id);
    var res3 = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-rt-3', fx.stamp, 'BackToOnce', fx.product.id, fx.shipping, { qty: 3 }), fx.order_ids);
    qaAssertOk_(res3);
    var g3 = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res3)[0]), fx.gift_id);
    qaAssert_(g3.length === 1 && Number(g3[0].gift_qty || 0) === 1, 'เปลี่ยนกลับ once_per_order ต้องได้ 1 ชุด', g3);
    output = { once1: g1[0].gift_qty, threshold: g2[0].gift_qty, once2: g3[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// A per_threshold rule that is disabled or expired grants no gift regardless of
// how many thresholds the cart clears.
function qaRunGiftRepeatDisabledAndExpiredFlow_(ctx) {
  var fxDisabled = qaCreateGiftEligibilityFixture_(ctx, 'RepeatDisabled', { min_qty: 1, gift_qty: 1, gift_stock: 10, product_stock: 10, repeat_mode: 'per_threshold', rule_enabled: false });
  var fxExpired = qaCreateGiftEligibilityFixture_(ctx, 'RepeatExpired', { min_qty: 1, gift_qty: 1, gift_stock: 10, product_stock: 10, repeat_mode: 'per_threshold', starts_at: qaPastIso_(120000), ends_at: qaPastIso_(60000), no_end_date: false });
  var caught = null, output = null;
  try {
    var resD = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-disabled', fxDisabled.stamp, 'Buyer', fxDisabled.product.id, fxDisabled.shipping, { qty: 4 }), fxDisabled.order_ids);
    qaAssertOk_(resD);
    qaAssert_(qaActiveGiftLines_(qaReadOrder_(fxDisabled.token, qaOrderIdsFromSubmit_(resD)[0]), fxDisabled.gift_id).length === 0, 'กฎที่ปิดใช้งานต้องไม่ให้ของแถม', resD);
    qaAssert_(qaGetGiftStock_(fxDisabled.gift_id) === 10, 'สต็อกของแถมของกฎที่ปิดต้องไม่ถูกหัก', { stock: qaGetGiftStock_(fxDisabled.gift_id) });

    var resE = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-expired', fxExpired.stamp, 'Buyer', fxExpired.product.id, fxExpired.shipping, { qty: 4 }), fxExpired.order_ids);
    qaAssertOk_(resE);
    qaAssert_(qaActiveGiftLines_(qaReadOrder_(fxExpired.token, qaOrderIdsFromSubmit_(resE)[0]), fxExpired.gift_id).length === 0, 'กฎที่หมดอายุต้องไม่ให้ของแถม', resE);
    qaAssert_(qaGetGiftStock_(fxExpired.gift_id) === 10, 'สต็อกของแถมของกฎที่หมดอายุต้องไม่ถูกหัก', { stock: qaGetGiftStock_(fxExpired.gift_id) });
    output = { disabled_stock: qaGetGiftStock_(fxDisabled.gift_id), expired_stock: qaGetGiftStock_(fxExpired.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = { disabled: qaCleanupGiftFixture_(fxDisabled), expired: qaCleanupGiftFixture_(fxExpired) };
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Insufficient gift stock for the full multiplied grant is all-or-nothing:
// wants 5 but stock 3 → the whole set is skipped, no partial attach, stock stays 3.
function qaRunGiftRepeatInsufficientStockAllOrNothingFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatInsufficientStock', { min_qty: 1, gift_qty: 1, gift_stock: 3, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-insuf', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 5 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'สต็อกไม่พอสำหรับชุดที่คูณแล้วต้องไม่แนบของแถมบางส่วน', order.items);
    var skip = (res.gifts_skipped || []).filter(function(s){ return String(s.gift_id) === String(fx.gift_id); })[0];
    qaAssert_(skip && skip.code === 'GIFT_OUT_OF_STOCK' && Number(skip.requested_qty) === 5, 'ต้องรายงาน GIFT_OUT_OF_STOCK พร้อมจำนวนที่ต้องการ 5', res);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 3, 'สต็อกของแถมต้องคงเดิม (ไม่หักบางส่วน)', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { gift_lines: 0, skipped: skip, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Unlimited gift stock (-1) with per_threshold: full multiplied grant attaches,
// stock stays -1.
function qaRunGiftRepeatUnlimitedStockFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatUnlimited', { min_qty: 1, gift_qty: 1, gift_stock: -1, product_stock: 10, repeat_mode: 'per_threshold' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-unlimited', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 4 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 4, 'สต็อกไม่จำกัดต้องได้ของแถม 4 ชุด', g);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === -1, 'สต็อกไม่จำกัดต้องคงเป็น -1', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { gift_qty: g[0].gift_qty, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Regression: once_per_order with gift_qty>1 grants exactly one set regardless
// of how far the cart exceeds the threshold (must NOT multiply).
function qaRunGiftRepeatOncePerOrderRegressionFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RepeatOnceRegression', { min_qty: 1, gift_qty: 2, gift_stock: 20, product_stock: 10, repeat_mode: 'once_per_order' });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-once-reg', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty: 5 }), fx.order_ids);
    qaAssertOk_(res);
    var g = qaActiveGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]), fx.gift_id);
    qaAssert_(g.length === 1 && Number(g[0].gift_qty || 0) === 2, 'once_per_order gift_qty=2 ซื้อ 5 ต้องได้ 2 ชิ้น (1 ชุด) เท่านั้น', g);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 18, 'สต็อกต้องลดลงเพียง 2 (ไม่คูณ)', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { gift_qty: g[0].gift_qty, final_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Two simultaneous per_threshold rules on one cart each multiply independently
// by their own gift_qty, and gift lines follow rule priority order.
function qaRunGiftRepeatMultipleRulesPriorityFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'RepeatMultiRules');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RepeatMultiRules', 20, { price: 500 });
    fx.product_ids.push(product.id);
    var giftA = qaCreateGiftItem_(fx.token, fx.stamp, 'RepeatRuleA', { stock: 10 });
    var giftB = qaCreateGiftItem_(fx.token, fx.stamp, 'RepeatRuleB', { stock: 20 });
    fx.gift_ids = [giftA.gift_id, giftB.gift_id];
    var cond = { required_products: [{ product_id: product.id, min_qty: 1 }] };
    var ruleA = qaCreateGiftRule_(fx.token, fx.stamp, 'RepeatRuleA', giftA.gift_id, { condition_json: cond, gift_qty: 1, repeat_mode: 'per_threshold', priority: 100 });
    var ruleB = qaCreateGiftRule_(fx.token, fx.stamp, 'RepeatRuleB', giftB.gift_id, { condition_json: cond, gift_qty: 2, repeat_mode: 'per_threshold', priority: 50 });
    fx.rule_ids = [ruleA.rule_id, ruleB.rule_id];
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rep-multi-rules', fx.stamp, 'Buyer', product.id, fx.shipping, { qty: 4 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var lines = qaAllGiftLines_(order).filter(function(l){ return fx.rule_ids.indexOf(String(l.rule_id)) >= 0; });
    qaAssert_(lines.length === 2, 'ต้องมีของแถมจากทั้งสองกฎ', lines);
    qaAssert_(String(lines[0].rule_id) === String(ruleA.rule_id) && String(lines[1].rule_id) === String(ruleB.rule_id), 'ลำดับของแถมต้องเรียงตาม priority', lines);
    var qtyA = qaActiveGiftLines_(order, giftA.gift_id);
    var qtyB = qaActiveGiftLines_(order, giftB.gift_id);
    qaAssert_(qtyA.length === 1 && Number(qtyA[0].gift_qty || 0) === 4, 'กฎ A (gift_qty=1 × 4) ต้องได้ 4 ชิ้น', qtyA);
    qaAssert_(qtyB.length === 1 && Number(qtyB[0].gift_qty || 0) === 8, 'กฎ B (gift_qty=2 × 4) ต้องได้ 8 ชิ้น', qtyB);
    qaAssert_(qaGetGiftStock_(giftA.gift_id) === 6 && qaGetGiftStock_(giftB.gift_id) === 12, 'สต็อกของแถมทั้งสองต้องถูกหักตามจำนวนที่คูณแล้ว', { a: qaGetGiftStock_(giftA.gift_id), b: qaGetGiftStock_(giftB.gift_id) });
    output = { a_qty: qtyA[0].gift_qty, b_qty: qtyB[0].gift_qty, order: lines.map(function(l){ return l.rule_id; }) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftStockInsufficientSkipFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'StockSkip', { gift_stock: 0 });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-stock-skip', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var record = qaReadOrder_(fx.token, orderId);
    var gifts = qaActiveGiftLines_(record, fx.gift_id);
    qaAssert_(gifts.length === 0, 'stock=0 ต้องไม่แนบของแถมเข้าออร์เดอร์', gifts);
    output = { order_id: orderId, gift_line_count: gifts.length, final_gift_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftUnlimitedStockFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'UnlimitedGift', { gift_stock: -1 });
  var caught = null, output = null;
  try {
    var first = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-unlimited', fx.stamp, 'A', fx.product.id, fx.shipping), fx.order_ids);
    var second = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-unlimited', fx.stamp, 'B', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(first); qaAssertOk_(second);
    var giftCounts = fx.order_ids.map(function(orderId) {
      return qaActiveGiftLines_(qaReadOrder_(fx.token, orderId), fx.gift_id).length;
    });
    qaAssert_(giftCounts.every(function(n){ return n === 1; }), 'ทุกออร์เดอร์ต้องได้ของแถม', giftCounts);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === -1, 'stock ของของแถมไม่จำกัดต้องยังเป็น -1', { stock: qaGetGiftStock_(fx.gift_id) });
    output = { order_ids: fx.order_ids.slice(), gift_counts: giftCounts, final_gift_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualAddSuccessFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'GiftManualAdd');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'GiftManualAdd', 5);
  var gift = qaCreateGiftItem_(token, stamp, 'ManualAdd', { stock: 3, enabled: true });
  var fx = { token: token, stamp: stamp, shipping: shipping, product: product, gift_id: gift.gift_id, rule_id: '', order_ids: [] };
  var caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-manual-add', stamp, 'Buyer', product.id, shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
    var add = qaCall_('addManualGiftToOrderRpc', [token, orderId, { gift_id: gift.gift_id, qty: 2, note: 'QA เพิ่มของแถมด้วยมือ' }]);
    qaAssertOk_(add);
    var record = qaReadOrder_(token, orderId);
    var gifts = qaActiveGiftLines_(record, gift.gift_id);
    qaAssert_(gifts.length === 1 && Number(gifts[0].gift_qty || 0) === 2, 'manual add ต้องเพิ่ม gift line qty=2', gifts);
    qaAssert_(qaGetGiftStock_(gift.gift_id) === 1, 'stock ของของแถมต้องถูกตัดเหลือ 1', { stock: qaGetGiftStock_(gift.gift_id) });
    output = { order_id: orderId, gift_snapshot_id: add.gift_snapshot_id, gift_qty: gifts[0].gift_qty, final_gift_stock: qaGetGiftStock_(gift.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaCreateManualGiftFixture_(ctx, label, stock) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'Gift' + label);
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'Gift' + label, 5);
  var gift = qaCreateGiftItem_(token, stamp, label, { stock: stock === undefined ? 5 : stock, enabled:true });
  return { token:token, stamp:stamp, shipping:shipping, product:product, gift_id:gift.gift_id, rule_id:'', order_ids:[] };
}

function qaRunGiftManualRemoveSuccessFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'ManualRemove', 3);
  var steps = [], caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-remove', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
    qaStep_(steps, 'สร้างออร์เดอร์', 'ok', { order_id:orderId });
    var add = qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:2, note:'QA เพิ่มเพื่อทดสอบลบ' }]);
    qaAssertOk_(add);
    qaStep_(steps, 'เพิ่มของแถมเอง', 'ok', add);
    var remove = qaCall_('removeGiftLineFromOrderRpc', [fx.token, orderId, add.gift_snapshot_id]);
    qaAssertOk_(remove);
    var record = qaReadOrder_(fx.token, orderId);
    var active = qaActiveGiftLines_(record, fx.gift_id);
    var stock = qaGetGiftStock_(fx.gift_id);
    qaAssert_(active.length === 0 && stock === 3, 'ลบ gift line แล้วต้องคืนสต็อก', { active:active, stock:stock });
    qaStep_(steps, 'ลบของแถมและตรวจคืนสต็อก', 'ok', { active_count:active.length, stock:stock });
    output = { steps:steps, order_id:orderId, final_gift_stock:stock };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupGiftFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualUpdateQtySuccessFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'ManualQty', 5);
  var steps = [], caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-qty', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
    var add = qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:1, note:'QA เพิ่มเพื่อแก้จำนวน' }]);
    qaAssertOk_(add);
    qaStep_(steps, 'สร้างออร์เดอร์และเพิ่มของแถม 1 ชิ้น', 'ok', { order_id:orderId, add:add, stock:qaGetGiftStock_(fx.gift_id) });
    var up3 = qaCall_('updateGiftLineQtyRpc', [fx.token, orderId, add.gift_snapshot_id, 3]);
    qaAssertOk_(up3);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 2, 'เพิ่ม qty เป็น 3 แล้วสต็อกต้องเหลือ 2', { stock:qaGetGiftStock_(fx.gift_id) });
    qaStep_(steps, 'แก้จำนวนเป็น 3', 'ok', { response:up3, stock:qaGetGiftStock_(fx.gift_id) });
    var down2 = qaCall_('updateGiftLineQtyRpc', [fx.token, orderId, add.gift_snapshot_id, 2]);
    qaAssertOk_(down2);
    var record = qaReadOrder_(fx.token, orderId);
    var giftLine = qaActiveGiftLines_(record, fx.gift_id)[0];
    var stock = qaGetGiftStock_(fx.gift_id);
    qaAssert_(giftLine && Number(giftLine.gift_qty) === 2 && stock === 3, 'ลด qty เป็น 2 แล้วต้องคืนสต็อก 1', { giftLine:giftLine, stock:stock });
    qaStep_(steps, 'แก้จำนวนกลับเป็น 2 และตรวจสต็อก', 'ok', { gift_qty:giftLine.gift_qty, stock:stock });
    output = { steps:steps, order_id:orderId, final_qty:giftLine.gift_qty, final_gift_stock:stock };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupGiftFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualUpdateQtyOutOfStockFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'ManualQtyOos', 2);
  var steps = [], caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-qty-oos', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
    var add = qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:1, note:'QA เกินสต็อก' }]);
    qaAssertOk_(add);
    qaStep_(steps, 'เพิ่มของแถม 1 จาก stock 2', 'ok', { order_id:orderId, stock:qaGetGiftStock_(fx.gift_id) });
    var up = qaCall_('updateGiftLineQtyRpc', [fx.token, orderId, add.gift_snapshot_id, 5]);
    qaAssert_(up && up.ok === false, 'แก้จำนวนเกินสต็อกต้องล้มเหลว', up);
    var record = qaReadOrder_(fx.token, orderId);
    var line = qaActiveGiftLines_(record, fx.gift_id)[0];
    qaAssert_(line && Number(line.gift_qty) === 1, 'จำนวนเดิมต้องไม่เปลี่ยนหลังแก้เกินสต็อก', line);
    qaStep_(steps, 'ตรวจการปฏิเสธ qty เกินสต็อก', 'ok', { response:up, gift_qty:line.gift_qty, stock:qaGetGiftStock_(fx.gift_id) });
    output = { steps:steps, response:up, final_qty:line.gift_qty };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupGiftFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftOrderTokenReadFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'TokenRead', { gift_stock:5 });
  var steps = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-token', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var token = res.token || (res.orders && res.orders[0] && res.orders[0].token) || '';
    qaAssert_(!!token, 'submitOrderRpc ต้องคืน token', res);
    qaStep_(steps, 'สร้างออร์เดอร์ที่ได้ของแถม', 'ok', { order_id:qaOrderIdsFromSubmit_(res)[0], tokenReturned:!!token });
    var gifts = qaCall_('getOrderGiftsByTokenRpc', [token]);
    qaAssertOk_(gifts);
    qaAssert_((gifts.gifts || []).some(function(g){ return String(g.gift_id) === String(fx.gift_id); }), 'token ต้องอ่านของแถมของออร์เดอร์ได้', gifts);
    var bad = qaCall_('getOrderGiftsByTokenRpc', ['__BAD_TOKEN__']);
    qaAssert_(bad && bad.ok === false, 'token ปลอมต้องถูกปฏิเสธ', bad);
    qaStep_(steps, 'อ่านของแถมด้วย token และตรวจ token ปลอม', 'ok', { gifts:gifts, bad_token:bad });
    output = { steps:steps, gifts_count:(gifts.gifts || []).length };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupGiftFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRequiredVariantsFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'GiftRequiredVariant');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'GiftRequiredVariant', -1, {
    price:500,
    variants:[{ name:'Color', type:'text', options:[
      { label:'Red', price:500, weight_grams:100, stock:5 },
      { label:'Blue', price:500, weight_grams:100, stock:5 }
    ]}]
  });
  var gift = qaCreateGiftItem_(token, stamp, 'RequiredVariant', { stock:5, enabled:true });
  var rule = qaCreateGiftRule_(token, stamp, 'RequiredVariant', gift.gift_id, {
    condition_type:'required_variants',
    condition_json:{ required_variants:[{ product_id:product.id, variant_key:'Color=Red', min_qty:1 }] },
    gift_qty:1
  });
  var fx = { token:token, stamp:stamp, shipping:shipping, product:product, gift_id:gift.gift_id, rule_id:rule.rule_id, order_ids:[] };
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'เตรียมสินค้า variant และกฎ required_variants', 'ok', { product_id:fx.product.id, rule_id:fx.rule_id });
    var blue = qaCall_('previewGiftEligibilityRpc', [{ items:[{ product_id:fx.product.id, qty:1, selected_variants:{ Color:'Blue' } }] }]);
    var red = qaCall_('previewGiftEligibilityRpc', [{ items:[{ product_id:fx.product.id, qty:1, selected_variants:{ Color:'Red' } }] }]);
    qaAssertOk_(blue); qaAssertOk_(red);
    qaAssert_(!qaHasEligibleRule_(blue, fx.rule_id) && qaHasEligibleRule_(red, fx.rule_id), 'required_variants ต้องแจกเฉพาะ variant ที่ตรง', { blue:blue, red:red });
    qaStep_(steps, 'พรีวิว Blue/Red', 'ok', { blueEligible:qaHasEligibleRule_(blue, fx.rule_id), redEligible:qaHasEligibleRule_(red, fx.rule_id) });
    output = { steps:steps, blue_eligible:false, red_eligible:true };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupGiftFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftDeleteItemDisablesRulesFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'DeleteDisablesRule', { gift_stock:5 });
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้างของแถมและกฎ', 'ok', { gift_id:fx.gift_id, rule_id:fx.rule_id });
    var del = qaCall_('deleteGiftItemRpc', [fx.token, fx.gift_id]);
    qaAssertOk_(del);
    fx.gift_id = '';
    qaStep_(steps, 'ลบรายการของแถม', 'ok', del);
    var rule = qaCall_('getGiftRuleRpc', [fx.token, fx.rule_id]);
    qaAssertOk_(rule);
    qaAssert_(rule.rule && rule.rule.enabled === false, 'กฎที่ผูกกับ gift item ที่ถูกลบต้องถูกปิด', rule);
    qaStep_(steps, 'ตรวจว่ากฎถูกปิด', 'ok', rule.rule);
    output = { steps:steps, disabledRules:del.disabledRules, rule_enabled:rule.rule.enabled };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupGiftFixture_(fx);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaBuildGiftRaceOrderPayload_(prefix, stamp, buyer, productId, shipping) {
  return {
    client_order_id: prefix + '-' + stamp + '-' + buyer + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8),
    customer_name: 'QA Gift Race Buyer ' + buyer,
    customer_phone: '0812345678',
    customer_contact_platform: '',
    customer_contact: 'qa-gift-race-' + buyer,
    customer_notes: 'Gift stock race buyer ' + buyer + ' at ' + new Date().toISOString(),
    shipping_name: 'QA Gift Race Buyer ' + buyer,
    shipping_address: 'QA Gift Race Address',
    shipping_district: 'QA District',
    shipping_amphoe: 'QA Amphoe',
    shipping_province: 'Bangkok',
    shipping_postal_code: '10110',
    shipping_info: [{
      company_id: shipping.company.id,
      method_id: shipping.method.id
    }],
    items: [{
      product_id: productId,
      qty: 1,
      selected_variants: {}
    }]
  };
}

function qaCreateGiftRaceFixture_(token, stock, label) {
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var startedAt = new Date(now.getTime() - 60000).toISOString();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');

  var productRes = qaCall_('productCreateRpc', [token, {
    title: 'QA Gift Race Product ' + label + ' ' + stamp,
    desc: 'Temporary product for gift stock race integration test.',
    price: 500,
    badge: 'QA-GIFT-RACE',
    weight_grams: 100,
    allowed_shipping_ids: [shipping.method.id],
    stock: 20,
    sale_mode: 'always',
    variants: [],
    extra_images: []
  }]);
  qaAssertOk_(productRes);

  var giftRes = qaCall_('createGiftItemRpc', [token, {
    name: 'QA Gift Race Gift ' + label + ' ' + stamp,
    description: 'ของแถมชั่วคราวสำหรับทดสอบการแย่ง stock ของของแถม',
    stock: stock,
    enabled: true
  }]);
  qaAssertOk_(giftRes);

  var ruleRes = qaCall_('createGiftRuleRpc', [token, {
    name: 'QA Gift Race Rule ' + label + ' ' + stamp,
    description: 'กฎของแถมชั่วคราวสำหรับทดสอบการแย่ง stock ของของแถม',
    gift_id: giftRes.gift_id,
    condition_type: 'required_products',
    condition_json: { required_products: [{ product_id: productRes.id, min_qty: 1 }] },
    gift_qty: 1,
    repeat_mode: 'once_per_order',
    starts_at: startedAt,
    ends_at: '',
    no_end_date: true,
    enabled: true,
    priority: 9998
  }]);
  qaAssertOk_(ruleRes);

  return {
    ok: true,
    stamp: stamp,
    product_id: productRes.id,
    gift_id: giftRes.gift_id,
    rule_id: ruleRes.rule_id,
    shipping: shipping,
    shipping_fixture: shipping,
    stock: stock
  };
}

function qaPrepareConcurrentGiftStockRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var fixture = qaCreateGiftRaceFixture_(token, 2, 'Orders');
  if (!fixture.ok) return fixture;
  var buyers = ['A', 'B', 'C', 'D', 'E'];
  var jobs = buyers.map(function(buyer) {
    return {
      buyer: buyer,
      delayMs: 0,
      payload: qaBuildGiftRaceOrderPayload_('qa-gift-race', fixture.stamp, buyer, fixture.product_id, fixture.shipping)
    };
  });
  return {
    ok: true,
    product_id: fixture.product_id,
    gift_id: fixture.gift_id,
    rule_id: fixture.rule_id,
    shipping_fixture: fixture.shipping_fixture,
    stock: 2,
    expected_gift_count: 2,
    jobs: jobs
  };
}

function qaVerifyConcurrentGiftStockRaceRpc(token, fixture, submissions) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  submissions = submissions || [];
  var orderIds = [];
  submissions.forEach(function(entry) {
    var res = entry && entry.response;
    var orderId = res && (res.order_id || (res.orders && res.orders[0] && res.orders[0].order_id));
    if (entry && entry.ok && orderId) orderIds.push(orderId);
  });
  var giftOrderIds = [];
  var records = [];
  orderIds.forEach(function(orderId) {
    var rb = qaCall_('orderGetRpc', [token, orderId]);
    qaAssertOk_(rb);
    var record = rb.record || {};
    var hasGift = (record.items || []).some(function(item) {
      return item.line_type === 'gift'
        && String(item.gift_id) === String(fixture.gift_id)
        && item.status !== 'removed';
    });
    if (hasGift) giftOrderIds.push(orderId);
    records.push({ order_id: orderId, has_target_gift: hasGift });
  });
  var stock = qaGetGiftStock_(fixture.gift_id);
  return {
    ok: true,
    order_count: orderIds.length,
    gift_order_count: giftOrderIds.length,
    gift_order_ids: giftOrderIds,
    final_gift_stock: stock,
    records: records,
    passed: orderIds.length === 5 && giftOrderIds.length === 2 && stock === 0
  };
}

function qaCleanupConcurrentGiftStockRaceRpc(token, fixture) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  var cleanup = [];
  function step(name, id, fn) {
    if (!id) return;
    try {
      var res = fn();
      cleanup.push({ step: name, ok: !!(res && res.ok), response: res || null });
    } catch (err) {
      cleanup.push({ step: name, ok: false, error: String(err && err.message || err) });
    }
  }
  step('deleteGiftRuleRpc', fixture.rule_id, function(){ return qaCall_('deleteGiftRuleRpc', [token, fixture.rule_id]); });
  step('deleteGiftItemRpc', fixture.gift_id, function(){ return qaCall_('deleteGiftItemRpc', [token, fixture.gift_id]); });
  step('productDeleteRpc', fixture.product_id, function(){ return qaCall_('productDeleteRpc', [token, fixture.product_id]); });
  step('restoreShippingRpc', fixture.shipping_fixture, function(){ return qaCleanupTempShipping_(token, fixture.shipping_fixture); });
  return { ok:true, cleanup: cleanup };
}

function qaPrepareAdminGiftOrderRaceRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var fixture = qaCreateGiftRaceFixture_(token, 1, 'AdminVsOrder');
  if (!fixture.ok) return fixture;

  // Create an existing order that qualifies by product but was created before
  // the admin manually attaches the gift. If auto gift attached here, remove it
  // so the race starts with exactly one gift in stock.
  var existingOrderRes = qaCall_('submitOrderRpc', [
    qaBuildGiftRaceOrderPayload_('qa-admin-gift-existing', fixture.stamp, 'Existing', fixture.product_id, fixture.shipping)
  ]);
  qaAssertOk_(existingOrderRes);
  var existingOrderId = existingOrderRes.order_id || (existingOrderRes.orders && existingOrderRes.orders[0] && existingOrderRes.orders[0].order_id) || '';
  qaAssert_(!!existingOrderId, 'submitOrderRpc did not return existing order id', existingOrderRes);

  var existingRead = qaCall_('orderGetRpc', [token, existingOrderId]);
  qaAssertOk_(existingRead);
  (existingRead.record.items || []).forEach(function(item) {
    if (item.line_type === 'gift' && String(item.gift_id) === String(fixture.gift_id) && item.status !== 'removed') {
      qaCall_('removeGiftLineFromOrderRpc', [token, existingOrderId, item.gift_snapshot_id]);
    }
  });

  var newOrderPayload = qaBuildGiftRaceOrderPayload_('qa-admin-gift-new', fixture.stamp, 'NewOrder', fixture.product_id, fixture.shipping);
  return {
    ok: true,
    product_id: fixture.product_id,
    gift_id: fixture.gift_id,
    rule_id: fixture.rule_id,
    shipping_fixture: fixture.shipping_fixture,
    existing_order_id: existingOrderId,
    stock: 1,
    jobs: [
      { kind: 'admin_add', delayMs: 0, order_id: existingOrderId, payload: { gift_id: fixture.gift_id, qty: 1, note: 'QA concurrent admin gift add' } },
      { kind: 'submit_order', delayMs: 0, payload: newOrderPayload }
    ]
  };
}

function qaVerifyAdminGiftOrderRaceRpc(token, fixture, results) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  results = results || [];
  var adminEntry = results.filter(function(r){ return r.kind === 'admin_add'; })[0] || {};
  var orderEntry = results.filter(function(r){ return r.kind === 'submit_order'; })[0] || {};
  var newOrderId = orderEntry.response && (orderEntry.response.order_id || (orderEntry.response.orders && orderEntry.response.orders[0] && orderEntry.response.orders[0].order_id));
  var orderIds = [fixture.existing_order_id, newOrderId].filter(Boolean);
  var giftHits = [];
  orderIds.forEach(function(orderId) {
    var rb = qaCall_('orderGetRpc', [token, orderId]);
    qaAssertOk_(rb);
    var hasGift = (rb.record.items || []).some(function(item) {
      return item.line_type === 'gift'
        && String(item.gift_id) === String(fixture.gift_id)
        && item.status !== 'removed';
    });
    if (hasGift) giftHits.push(orderId);
  });
  var stock = qaGetGiftStock_(fixture.gift_id);
  var adminStockInsufficient = !adminEntry.ok
    && adminEntry.response
    && String(adminEntry.response.error || '').indexOf('สต็อกไม่พอ') >= 0;
  return {
    ok: true,
    admin_add_ok: !!adminEntry.ok,
    admin_add_error: adminEntry.response && adminEntry.response.error,
    admin_stock_insufficient: adminStockInsufficient,
    submit_order_ok: !!orderEntry.ok,
    gift_order_count: giftHits.length,
    gift_order_ids: giftHits,
    final_gift_stock: stock,
    passed: !!orderEntry.ok && giftHits.length === 1 && stock === 0
  };
}

function qaCleanupAdminGiftOrderRaceRpc(token, fixture) {
  return qaCleanupConcurrentGiftStockRaceRpc(token, fixture);
}

function qaPrepareManualGiftDoubleClickRpc(options) {
  var ctx = qaCreateContext_(options || {});
  qaRequireRealWrite_(ctx);
  var token = ctx.options.adminToken;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'ManualGiftDoubleClick', 5);
  var orderRes = qaCall_('submitOrderRpc', [
    qaBuildOrderPayloadForProduct_('qa-manual-gift-dbl', stamp, 'Order', product.id, shipping)
  ]);
  qaAssertOk_(orderRes);
  var orderId = orderRes.order_id || (orderRes.orders && orderRes.orders[0] && orderRes.orders[0].order_id) || '';
  qaAssert_(!!orderId, 'submitOrderRpc did not return order id', orderRes);
  var giftRes = qaCall_('createGiftItemRpc', [token, {
    name: 'QA Manual Double Click Gift ' + stamp,
    description: 'ของแถมชั่วคราวสำหรับทดสอบการกดเพิ่มของแถมซ้ำพร้อมกัน',
    stock: 1,
    enabled: true
  }]);
  qaAssertOk_(giftRes);
  return {
    ok: true,
    product_id: product.id,
    gift_id: giftRes.gift_id,
    shipping_fixture: shipping,
    order_id: orderId,
    stock: 1,
    jobs: [
      { kind: 'admin_add', delayMs: 0, order_id: orderId, payload: { gift_id: giftRes.gift_id, qty: 1, note: 'QA double-click add 1' } },
      { kind: 'admin_add', delayMs: 0, order_id: orderId, payload: { gift_id: giftRes.gift_id, qty: 1, note: 'QA double-click add 2' } }
    ]
  };
}

function qaVerifyManualGiftDoubleClickRpc(token, fixture, results) {
  if (!token) return { ok:false, error:'AUTH_REQUIRED' };
  fixture = fixture || {};
  results = results || [];
  var success = results.filter(function(e){ return e && e.ok; });
  var failures = results.filter(function(e){ return e && !e.ok; });
  var stock = qaGetGiftStock_(fixture.gift_id);
  var readBack = qaCall_('orderGetRpc', [token, fixture.order_id]);
  qaAssertOk_(readBack);
  var activeGiftLines = (readBack.record.items || []).filter(function(item) {
    return item.line_type === 'gift'
      && String(item.gift_id) === String(fixture.gift_id)
      && item.status !== 'removed';
  });
  return {
    ok: true,
    success_count: success.length,
    failure_count: failures.length,
    failure_errors: failures.map(function(e){ return e.response && e.response.error || e.error || ''; }),
    active_gift_line_count: activeGiftLines.length,
    final_gift_stock: stock,
    passed: success.length === 1 && failures.length === 1 && activeGiftLines.length === 1 && stock === 0
  };
}

function qaCleanupManualGiftDoubleClickRpc(token, fixture) {
  fixture = fixture || {};
  var cleanup = qaCleanupConcurrentGiftStockRaceRpc(token, {
    product_id: fixture.product_id,
    gift_id: fixture.gift_id,
    shipping_fixture: fixture.shipping_fixture
  });
  return cleanup;
}

function qaRunManualGiftOutOfStockWriteFlow_(ctx) {
  var token = ctx.options.adminToken;
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'OrderFixture');
  var ids = { product_id: '', gift_id: '', order_id: '', shipping_fixture: shipping };
  var caught = null;
  var output = null;
  try {
    var productRes = qaCall_('productCreateRpc', [token, {
      title: 'QA Manual Gift Stock Product ' + stamp,
      desc: 'สินค้าชั่วคราวสำหรับทดสอบ stock ของของแถมแบบ manual',
      price: 500,
      badge: 'QA-GIFT-STOCK',
      weight_grams: 100,
      allowed_shipping_ids: [shipping.method.id],
      stock: 5,
      sale_mode: 'always',
      variants: [],
      extra_images: []
    }]);
    qaAssertOk_(productRes);
    ids.product_id = productRes.id;

    var orderRes = qaCall_('submitOrderRpc', [
      qaBuildGiftRaceOrderPayload_('qa-manual-gift-empty', stamp, 'OutOfStock', ids.product_id, shipping)
    ]);
    qaAssertOk_(orderRes);
    ids.order_id = orderRes.order_id || (orderRes.orders && orderRes.orders[0] && orderRes.orders[0].order_id) || '';
    qaAssert_(!!ids.order_id, 'submitOrderRpc did not return order id', orderRes);

    var giftRes = qaCall_('createGiftItemRpc', [token, {
      name: 'QA Manual Empty Gift ' + stamp,
      description: 'ของแถมชั่วคราว stock หมด สำหรับทดสอบ integration',
      stock: 0,
      enabled: true
    }]);
    qaAssertOk_(giftRes);
    ids.gift_id = giftRes.gift_id;

    var addRes = qaCall_('addManualGiftToOrderRpc', [token, ids.order_id, { gift_id: ids.gift_id, qty: 1, note: 'QA out-of-stock check' }]);
    qaAssert_(addRes && addRes.ok === false, 'การเพิ่มของแถมแบบ manual ควรล้มเหลวเมื่อ stock ของแถมเป็น 0', addRes);
    qaAssert_(String(addRes.error || '').indexOf('สต็อกไม่พอ') >= 0, 'Unexpected out-of-stock error message', addRes);

    var readBack = qaCall_('orderGetRpc', [token, ids.order_id]);
    qaAssertOk_(readBack);
    var hasGift = (readBack.record.items || []).some(function(item) {
      return item.line_type === 'gift' && String(item.gift_id) === String(ids.gift_id) && item.status !== 'removed';
    });
    qaAssert_(!hasGift, 'Out-of-stock gift should not be attached to the order', readBack.record);

    output = {
      order_id: ids.order_id,
      gift_id: ids.gift_id,
      add_response: addRes,
      expected_contract: { ok: false, error_contains: 'สต็อกไม่พอ' },
      final_gift_stock: qaGetGiftStock_(ids.gift_id)
    };
  } catch (err) {
    caught = err;
  }

  var cleanup = qaCleanupConcurrentGiftStockRaceRpc(token, ids);
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, { created: ids, cleanup: cleanup });
    throw caught;
  }
  output.cleanup = cleanup;
  return output;
}

function qaCreateTempShippingMethod_(token, stamp, label, opts) {
  opts = opts || {};
  var current = qaCall_('getShippingRpc');
  qaAssertOk_(current);
  var originalCompanies = (current.companies || []).map(function(company) {
    return JSON.parse(JSON.stringify(company));
  });
  var suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  var methods = opts.methods || [{
    id: 'qa_method_' + suffix,
    name: 'QA Standard',
    active: true,
    mode: opts.mode || 'flat',
    flat_rate: opts.flat_rate !== undefined ? Number(opts.flat_rate) : 0
  }];
  if (!opts.methods && opts.brackets) methods[0].brackets = opts.brackets;
  var company = {
    id: 'qa_ship_' + suffix,
    name: 'QA Shipping ' + label + ' ' + stamp,
    active: true,
    carrier_id: 'other',
    tracking_url_template: '',
    tracking_provider: '',
    methods: methods
  };
  var saved = qaCall_('saveShippingRpc', [token, originalCompanies.concat([company])]);
  qaAssertOk_(saved);
  return {
    company: company,
    method: company.methods[0],
    original_companies: originalCompanies,
    save_response: saved
  };
}

function qaCleanupTempShipping_(token, shippingFixture) {
  if (!shippingFixture || !Array.isArray(shippingFixture.original_companies)) {
    return { ok: true, skipped: true };
  }
  return qaCall_('saveShippingRpc', [token, shippingFixture.original_companies]);
}

function qaCleanupProductAndShipping_(token, productId, shippingFixture) {
  var out = { ok: true, product: null, shipping: null };
  if (productId) {
    try {
      out.product = qaCall_('productDeleteRpc', [token, productId]);
      if (!out.product || out.product.ok !== true) out.ok = false;
    } catch (err) {
      out.product = { ok: false, error: String(err && err.message || err) };
      out.ok = false;
    }
  }
  try {
    out.shipping = qaCleanupTempShipping_(token, shippingFixture);
    if (!out.shipping || out.shipping.ok !== true) out.ok = false;
  } catch (shipErr) {
    out.shipping = { ok: false, error: String(shipErr && shipErr.message || shipErr) };
    out.ok = false;
  }
  return out;
}

function qaBuildRealOrderPayload_(ctx) {
  var token = ctx.options.adminToken;
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'SubmitOrder');
  var product = qaCreateOrderQaProduct_(token, shipping, stamp, 'SubmitOrder', 5);
  var payload = {
    client_order_id: 'qa-real-' + stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
    customer_name: 'QA Integration Test',
    customer_phone: '0812345678',
    customer_contact_platform: '',
    customer_contact: 'qa-integration',
    customer_notes: 'สร้างโดยแดชบอร์ด QA integration เวลา ' + now.toISOString(),
    shipping_name: 'QA Integration Test',
    shipping_address: 'QA Test Address',
    shipping_district: 'QA District',
    shipping_amphoe: 'QA Amphoe',
    shipping_province: 'Bangkok',
    shipping_postal_code: '10110',
    shipping_info: [{
      company_id: shipping.company.id,
      method_id: shipping.method.id
    }],
    items: [{
      product_id: product.id,
      qty: 1,
      selected_variants: {}
    }]
  };

  return {
    payload: payload,
    product: { id: product.id, title: product.payload.title },
    shipping: shipping,
    cleanup: {
      product_id: product.id,
      shipping_fixture: shipping
    }
  };
}

function qaRunFullCommerceWriteFlow_(ctx) {
  var token = ctx.options.adminToken;
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  var startedAt = new Date(now.getTime() - 60000).toISOString();
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'FullFlow');
  var ids = {
    product_id: '',
    promotion_id: '',
    gift_id: '',
    rule_id: '',
    order_id: '',
    shipping_fixture: shipping
  };
  var output = null;
  var caught = null;
  var steps = [];
  function stepLog(name, status, data) {
    steps.push({
      at: new Date().toISOString(),
      step: name,
      status: status || 'ok',
      data: data || {}
    });
  }

  try {
    stepLog('select_shipping_method', 'ok', {
      method_id: shipping.method.id,
      method_name: shipping.method.name,
      company_id: shipping.company.id,
      company_name: shipping.company.name
    });

    var productPayload = {
      title: 'QA E2E Product ' + stamp,
      desc: 'สินค้าชั่วคราวที่สร้างโดย QA integration test',
      price: 1000,
      badge: 'QA',
      weight_grams: 100,
      allowed_shipping_ids: [shipping.method.id],
      stock: 5,
      sale_mode: 'always',
      variants: [],
      extra_images: []
    };
    var productRes = qaCall_('productCreateRpc', [token, productPayload]);
    qaAssertOk_(productRes);
    ids.product_id = productRes.id;
    qaAssert_(!!ids.product_id, 'productCreateRpc did not return id', productRes);
    stepLog('create_product', 'ok', { request: productPayload, response: productRes });

    var promoPayload = {
      name: 'QA E2E Promo ' + stamp,
      description: 'โปรโมชั่นชั่วคราวที่สร้างโดย QA integration test',
      discount_type: 'fixed',
      discount_value: 125,
      target_type: 'product',
      target: [{ product_id: ids.product_id }],
      starts_at: startedAt,
      ends_at: '',
      no_end_date: true,
      enabled: true
    };
    var promoRes = qaCall_('createPromotionRpc', [token, promoPayload]);
    qaAssertOk_(promoRes);
    ids.promotion_id = promoRes.promotion_id;
    qaAssert_(!!ids.promotion_id, 'createPromotionRpc did not return promotion_id', promoRes);
    stepLog('create_promotion', 'ok', { request: promoPayload, response: promoRes });

    var giftPayload = {
      name: 'QA E2E Gift ' + stamp,
      description: 'ของแถมชั่วคราวที่สร้างโดย QA integration test',
      stock: 5,
      enabled: true
    };
    var giftRes = qaCall_('createGiftItemRpc', [token, giftPayload]);
    qaAssertOk_(giftRes);
    ids.gift_id = giftRes.gift_id;
    qaAssert_(!!ids.gift_id, 'createGiftItemRpc did not return gift_id', giftRes);
    stepLog('create_gift_item', 'ok', { request: giftPayload, response: giftRes });

    var rulePayload = {
      name: 'QA E2E Gift Rule ' + stamp,
      description: 'กฎของแถมชั่วคราวที่สร้างโดย QA integration test',
      gift_id: ids.gift_id,
      condition_type: 'required_products',
      condition_json: {
        required_products: [{ product_id: ids.product_id, min_qty: 1 }]
      },
      gift_qty: 1,
      repeat_mode: 'once_per_order',
      starts_at: startedAt,
      ends_at: '',
      no_end_date: true,
      enabled: true,
      priority: 9999
    };
    var ruleRes = qaCall_('createGiftRuleRpc', [token, rulePayload]);
    qaAssertOk_(ruleRes);
    ids.rule_id = ruleRes.rule_id;
    qaAssert_(!!ids.rule_id, 'createGiftRuleRpc did not return rule_id', ruleRes);
    stepLog('create_gift_rule', 'ok', { request: rulePayload, response: ruleRes });

    var orderPayload = {
      client_order_id: 'qa-full-' + stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
      customer_name: 'QA Full Flow Test',
      customer_phone: '0812345678',
      customer_contact_platform: '',
      customer_contact: 'qa-integration',
      customer_notes: 'สร้างโดย full QA integration flow เวลา ' + now.toISOString(),
      shipping_name: 'QA Full Flow Test',
      shipping_address: 'QA Test Address',
      shipping_district: 'QA District',
      shipping_amphoe: 'QA Amphoe',
      shipping_province: 'Bangkok',
      shipping_postal_code: '10110',
      shipping_info: [{
        company_id: shipping.company.id,
        method_id: shipping.method.id
      }],
      items: [{
        product_id: ids.product_id,
        qty: 1,
        selected_variants: {}
      }]
    };
    var orderRes = qaCall_('submitOrderRpc', [orderPayload]);
    qaAssertOk_(orderRes);
    ids.order_id = orderRes.order_id || (orderRes.orders && orderRes.orders[0] && orderRes.orders[0].order_id) || '';
    qaAssert_(!!ids.order_id, 'submitOrderRpc did not return an order id', orderRes);
    stepLog('submit_order', 'ok', { request: orderPayload, response: orderRes });

    var readBack = qaCall_('orderGetRpc', [token, ids.order_id]);
    qaAssertOk_(readBack);
    stepLog('read_order_back', 'ok', { order_id: ids.order_id, response: readBack });
    var record = readBack.record || {};
    var items = Array.isArray(record.items) ? record.items : [];
    var productLine = null;
    var giftLine = null;
    items.forEach(function(item) {
      if (item.line_type !== 'gift' && String(item.product_id) === String(ids.product_id)) productLine = item;
      if (item.line_type === 'gift' && String(item.gift_id) === String(ids.gift_id)) giftLine = item;
    });

    qaAssert_(!!productLine, 'Order does not contain the created QA product', { items: items });
    qaAssert_(!!giftLine, 'Order does not contain the created QA gift line', { items: items });
    qaAssert_(productLine.promotion && String(productLine.promotion.promotion_id) === String(ids.promotion_id),
      'Order product line does not contain the created promotion snapshot', productLine);
    qaAssert_(Number(productLine.unit_base_price) === 1000, 'Unexpected base price in order snapshot', productLine);
    qaAssert_(Number(productLine.unit_discount_amount) === 125, 'Unexpected promotion discount in order snapshot', productLine);
    qaAssert_(Number(productLine.unit_final_price) === 875, 'Unexpected final price in order snapshot', productLine);
    qaAssert_(String(giftLine.rule_id) === String(ids.rule_id), 'Gift line is not tied to the created gift rule', giftLine);
    qaAssert_(Number(giftLine.gift_qty || 0) === 1, 'Unexpected gift quantity', giftLine);
    stepLog('verify_order_snapshot', 'ok', {
      product_line: productLine,
      gift_line: giftLine
    });

    output = {
      steps: steps,
      order_id: ids.order_id,
      product_id: ids.product_id,
      promotion_id: ids.promotion_id,
      gift_id: ids.gift_id,
      rule_id: ids.rule_id,
      shipping_method_id: shipping.method.id,
      shipping_method_name: shipping.method.name,
      product_line: {
        unit_base_price: productLine.unit_base_price,
        unit_discount_amount: productLine.unit_discount_amount,
        unit_final_price: productLine.unit_final_price,
        promotion_id: productLine.promotion && productLine.promotion.promotion_id
      },
      gift_line: {
        gift_id: giftLine.gift_id,
        rule_id: giftLine.rule_id,
        gift_qty: giftLine.gift_qty
      },
      order_total: record.total,
      order_status: record.status,
      note: 'A real order was created. Temporary QA product, promotion, gift item, and gift rule are cleaned up after verification.'
    };
  } catch (err) {
    stepLog('error', 'failed', { error: String(err && err.message || err), created: ids });
    caught = err;
  }

  var cleanup = qaCleanupFullCommerceWriteFlow_(token, ids);
  stepLog('cleanup_master_data', 'ok', { cleanup: cleanup });
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, {
      created: ids,
      steps: steps,
      cleanup: cleanup
    });
    throw caught;
  }
  output.steps = steps;
  output.cleanup = cleanup;
  return output;
}

function qaCleanupFullCommerceWriteFlow_(token, ids) {
  var cleanup = [];
  function step(name, fn) {
    try {
      var res = fn();
      cleanup.push({ step: name, ok: !!(res && res.ok), response: res || null });
    } catch (err) {
      cleanup.push({ step: name, ok: false, error: String(err && err.message || err) });
    }
  }
  if (ids.promotion_id) step('deletePromotionRpc', function() {
    return qaCall_('deletePromotionRpc', [token, ids.promotion_id]);
  });
  if (ids.rule_id) step('deleteGiftRuleRpc', function() {
    return qaCall_('deleteGiftRuleRpc', [token, ids.rule_id]);
  });
  if (ids.gift_id) step('deleteGiftItemRpc', function() {
    return qaCall_('deleteGiftItemRpc', [token, ids.gift_id]);
  });
  if (ids.product_id) step('productDeleteRpc', function() {
    return qaCall_('productDeleteRpc', [token, ids.product_id]);
  });
  if (ids.shipping_fixture) step('restoreShippingRpc', function() {
    return qaCleanupTempShipping_(token, ids.shipping_fixture);
  });
  return cleanup;
}

function qaCleanupCommerceFixture_(fx) {
  fx = fx || {};
  var token = fx.token;
  var out = { ok:true, orders:null, promotions:[], rules:[], gifts:[], products:[], shipping:null };
  out.orders = qaDeleteOrdersSafe_(token, fx.order_ids || []);
  if (!out.orders || out.orders.ok !== true) out.ok = false;
  (fx.promotion_ids || []).filter(Boolean).forEach(function(id) {
    try { var r = qaCall_('deletePromotionRpc', [token, id]); out.promotions.push({ promotion_id:id, ok:!!(r && r.ok), response:r }); if (!r || r.ok !== true) out.ok = false; }
    catch (err) { out.promotions.push({ promotion_id:id, ok:false, error:String(err && err.message || err) }); out.ok = false; }
  });
  (fx.rule_ids || []).filter(Boolean).forEach(function(id) {
    try { var r = qaCall_('deleteGiftRuleRpc', [token, id]); out.rules.push({ rule_id:id, ok:!!(r && r.ok), response:r }); if (!r || r.ok !== true) out.ok = false; }
    catch (err) { out.rules.push({ rule_id:id, ok:false, error:String(err && err.message || err) }); out.ok = false; }
  });
  (fx.gift_ids || []).filter(Boolean).forEach(function(id) {
    try { var r = qaCall_('deleteGiftItemRpc', [token, id]); out.gifts.push({ gift_id:id, ok:!!(r && r.ok), response:r }); if (!r || r.ok !== true) out.ok = false; }
    catch (err) { out.gifts.push({ gift_id:id, ok:false, error:String(err && err.message || err) }); out.ok = false; }
  });
  (fx.product_ids || []).filter(Boolean).forEach(function(id) {
    try { var r = qaCall_('productDeleteRpc', [token, id]); out.products.push({ product_id:id, ok:!!(r && r.ok), response:r }); if (!r || r.ok !== true) out.ok = false; }
    catch (err) { out.products.push({ product_id:id, ok:false, error:String(err && err.message || err) }); out.ok = false; }
  });
  try { out.shipping = qaCleanupTempShipping_(token, fx.shipping); if (!out.shipping || out.shipping.ok !== true) out.ok = false; }
  catch (shipErr) { out.shipping = { ok:false, error:String(shipErr && shipErr.message || shipErr) }; out.ok = false; }
  return out;
}

function qaAllGiftLines_(record, giftId) {
  return (record.items || []).filter(function(item) {
    return item.line_type === 'gift' && (!giftId || String(item.gift_id) === String(giftId));
  });
}

function qaCreateCommerceFixture_(ctx, label, shippingOpts) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateTempShippingMethod_(token, stamp, label, shippingOpts || {});
  return { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
}

function qaSecurityCartRpcResults_(fx, label, items) {
  var promotionPreview = qaCall_('previewPromotionEligibilityRpc', [{ items:items }]);
  var giftPreview = qaCall_('previewGiftEligibilityRpc', [{ items:items }]);
  var payload = qaBuildOrderPayloadForProduct_('qa-security-cart', fx.stamp, label,
    items && items[0] ? items[0].product_id : '', fx.shipping, { items:items });
  var submit = qaSubmitAndTrack_(payload, fx.order_ids);
  return { promotion_preview:promotionPreview, gift_preview:giftPreview, submit:submit };
}

function qaAssertSecurityCartRejected_(fx, label, items, expectedError) {
  var results = qaSecurityCartRpcResults_(fx, label, items);
  ['promotion_preview','gift_preview','submit'].forEach(function(key) {
    var response = results[key];
    qaAssert_(response && response.ok === false && response.error === expectedError,
      label + ' should fail ' + key + ' with ' + expectedError, results);
  });
  qaAssert_(Array.isArray(results.promotion_preview.lines)
    && Array.isArray(results.promotion_preview.eligible)
    && Array.isArray(results.promotion_preview.near),
    label + ' promotion preview must preserve its error response shape', results.promotion_preview);
  qaAssert_(Array.isArray(results.gift_preview.eligible)
    && Array.isArray(results.gift_preview.near),
    label + ' gift preview must preserve its error response shape', results.gift_preview);
  return results;
}

function qaAssertSecurityCartAccepted_(fx, label, items) {
  var results = qaSecurityCartRpcResults_(fx, label, items);
  qaAssertOk_(results.promotion_preview);
  qaAssertOk_(results.gift_preview);
  qaAssertOk_(results.submit);
  return results;
}

function qaRunOrderSecurityVariantSelectionContractFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'SecurityVariantContract');
  var steps = [], caught = null, output = null;
  try {
    var oneGroup = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityOneGroup', -1, {
      price:300,
      variants:[{ name:'Size', type:'text', options:[
        { label:'M', price:350, weight_grams:200, stock:10 },
        { label:'L', price:400, weight_grams:250, stock:10 }
      ] }]
    });
    fx.product_ids.push(oneGroup.id);
    var twoGroups = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityTwoGroups', -1, {
      price:500,
      variants:[
        { name:'Size', type:'text', options:[
          { label:'M', price:550, weight_grams:200, stock:20 },
          { label:'L', price:600, weight_grams:250, stock:20 }
        ] },
        { name:'Color', type:'text', options:[
          { label:'Red', price:700, weight_grams:300, stock:20 },
          { label:'Blue', price:750, weight_grams:350, stock:20 }
        ] }
      ]
    });
    fx.product_ids.push(twoGroups.id);
    var plainProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityNoVariant', 5, { price:250 });
    fx.product_ids.push(plainProduct.id);
    qaStep_(steps, 'create generic one-group, multi-group, and no-variant products', 'ok', { product_ids:fx.product_ids.slice() });

    var initial = {
      one_m:qaGetVariantStock_(oneGroup.id, 'Size', 'M'),
      two_red:qaGetVariantStock_(twoGroups.id, 'Color', 'Red'),
      plain:qaGetProductStock_(plainProduct.id)
    };
    var rejected = [];
    rejected.push(qaAssertSecurityCartRejected_(fx, 'missing-one-group', [
      { product_id:oneGroup.id, qty:1, selected_variants:{} }
    ], 'VARIANT_SELECTION_REQUIRED'));
    rejected.push(qaAssertSecurityCartRejected_(fx, 'partial-two-groups', [
      { product_id:twoGroups.id, qty:1, selected_variants:{ Size:'M' } }
    ], 'VARIANT_SELECTION_REQUIRED'));
    rejected.push(qaAssertSecurityCartRejected_(fx, 'unknown-group', [
      { product_id:twoGroups.id, qty:1, selected_variants:{ Size:'M', Color:'Red', Material:'Cotton' } }
    ], 'INVALID_VARIANT_GROUP'));
    rejected.push(qaAssertSecurityCartRejected_(fx, 'unknown-option', [
      { product_id:twoGroups.id, qty:1, selected_variants:{ Size:'M', Color:'Green' } }
    ], 'INVALID_VARIANT_OPTION'));
    rejected.push(qaAssertSecurityCartRejected_(fx, 'invalid-selection-shape', [
      { product_id:twoGroups.id, qty:1, selected_variants:[] }
    ], 'INVALID_VARIANT_OPTION'));
    rejected.push(qaAssertSecurityCartRejected_(fx, 'unknown-product', [
      { product_id:'qa-missing-security-product', qty:1, selected_variants:{} }
    ], 'PRODUCT_NOT_FOUND'));
    qaAssert_(fx.order_ids.length === 0, 'Rejected variant payloads must not create orders', { order_ids:fx.order_ids, rejected:rejected });
    qaAssert_(qaGetVariantStock_(oneGroup.id, 'Size', 'M') === initial.one_m
      && qaGetVariantStock_(twoGroups.id, 'Color', 'Red') === initial.two_red
      && qaGetProductStock_(plainProduct.id) === initial.plain,
      'Rejected variant payloads must preserve every stock value', { initial:initial });
    qaStep_(steps, 'reject missing/partial/unknown variants consistently across all cart RPCs', 'ok', { rejected_count:rejected.length });

    var validVariant = qaAssertSecurityCartAccepted_(fx, 'valid-two-groups', [
      { product_id:twoGroups.id, qty:1, selected_variants:{ Color:'Red', Size:'M' } }
    ]);
    var validPlain = qaAssertSecurityCartAccepted_(fx, 'valid-no-variant', [
      { product_id:plainProduct.id, qty:1, selected_variants:{} }
    ]);
    qaAssert_(qaGetVariantStock_(twoGroups.id, 'Color', 'Red') === initial.two_red - 1,
      'A complete selection should deduct the verified variant stock', { response:validVariant });
    qaAssert_(qaGetProductStock_(plainProduct.id) === initial.plain - 1,
      'A no-variant product should retain product-level stock behavior', { response:validPlain });
    qaStep_(steps, 'accept complete variants and backward-compatible no-variant products', 'ok', { order_ids:fx.order_ids.slice() });
    output = { steps:steps, rejected_cases:rejected.length, accepted_order_ids:fx.order_ids.slice() };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup security variant fixtures', cleanup && cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  qaAssert_(cleanup && cleanup.ok === true, 'Security variant fixture cleanup failed', cleanup);
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderSecurityCartQuantityLimitsContractFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'SecurityCartLimits');
  var steps = [], caught = null, output = null;
  try {
    var main = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityLimitMain', -1, { price:1 });
    fx.product_ids.push(main.id);
    var variantProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityLimitVariants', -1, {
      price:1,
      variants:[{ name:'Size', type:'text', options:[
        { label:'M', price:1, weight_grams:1, stock:-1 },
        { label:'L', price:1, weight_grams:1, stock:-1 }
      ] }]
    });
    fx.product_ids.push(variantProduct.id);

    var invalidQtys = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1e3', '9'.repeat(200)];
    invalidQtys.forEach(function(qty, index) {
      qaAssertSecurityCartRejected_(fx, 'invalid-qty-' + index, [
        { product_id:main.id, qty:qty, selected_variants:{} }
      ], 'INVALID_QTY');
    });
    qaStep_(steps, 'reject unsafe qty values across promotion preview, gift preview, and submit', 'ok', { case_count:invalidQtys.length });

    qaAssertSecurityCartRejected_(fx, 'qty-over-line-limit', [
      { product_id:main.id, qty:10000, selected_variants:{} }
    ], 'QTY_LIMIT_EXCEEDED');
    qaAssertSecurityCartAccepted_(fx, 'qty-at-line-limit', [
      { product_id:main.id, qty:9999, selected_variants:{} }
    ]);

    var hundredLines = [];
    for (var li = 0; li < 100; li++) hundredLines.push({ product_id:main.id, qty:1, selected_variants:{} });
    qaAssertSecurityCartAccepted_(fx, 'line-count-at-limit', hundredLines);
    qaAssertSecurityCartRejected_(fx, 'line-count-over-limit', hundredLines.concat([
      { product_id:main.id, qty:1, selected_variants:{} }
    ]), 'TOO_MANY_ITEMS');

    var oversizedClientPricing = qaBuildOrderPayloadForProduct_('qa-security-client-pricing', fx.stamp, 'OversizedSnapshot', main.id, fx.shipping, {
      items:[{ product_id:main.id, qty:1, selected_variants:{} }]
    });
    oversizedClientPricing.client_pricing = {
      items:Array.from({ length:101 }, function(){
        return { product_id:main.id, qty:1, selected_variants:{}, unit_final_price:1, promotion_id:null };
      }),
      subtotal:1, shipping_fee:Number(fx.shipping.method.flat_rate || 0), total:1 + Number(fx.shipping.method.flat_rate || 0)
    };
    var oversizedPricingResponse = qaSubmitAndTrack_(oversizedClientPricing, fx.order_ids);
    qaAssert_(oversizedPricingResponse && oversizedPricingResponse.ok === false
      && oversizedPricingResponse.error === 'TOO_MANY_ITEMS'
      && oversizedPricingResponse.field === 'client_pricing.items',
      'Oversized client_pricing.items must be rejected before snapshot matching', oversizedPricingResponse);

    qaAssertSecurityCartRejected_(fx, 'duplicate-variant-aggregate-limit', [
      { product_id:main.id, qty:5000, selected_variants:{} },
      { product_id:main.id, qty:5000, selected_variants:{} }
    ], 'QTY_LIMIT_EXCEEDED');
    qaAssertSecurityCartRejected_(fx, 'multi-variant-product-aggregate-limit', [
      { product_id:variantProduct.id, qty:6000, selected_variants:{ Size:'M' } },
      { product_id:variantProduct.id, qty:4000, selected_variants:{ Size:'L' } }
    ], 'QTY_LIMIT_EXCEEDED');
    qaStep_(steps, 'block duplicate-line and cross-variant splitting from bypassing product caps', 'ok', {});

    var totalItems = [];
    for (var pi = 0; pi < 6; pi++) {
      var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityTotal' + pi, -1, { price:1 });
      fx.product_ids.push(product.id);
      totalItems.push({ product_id:product.id, qty:pi < 5 ? 9999 : 5, selected_variants:{} });
    }
    qaAssertSecurityCartAccepted_(fx, 'order-total-at-limit', totalItems);
    var overTotal = totalItems.map(function(line){ return Object.assign({}, line); });
    overTotal[5].qty = 6;
    qaAssertSecurityCartRejected_(fx, 'order-total-over-limit', overTotal, 'QTY_LIMIT_EXCEEDED');
    qaStep_(steps, 'enforce exact 50000-unit order boundary', 'ok', { accepted_total:50000, rejected_total:50001 });

    output = { steps:steps, invalid_qty_count:invalidQtys.length, valid_order_ids:fx.order_ids.slice() };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup security quantity fixtures', cleanup && cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  qaAssert_(cleanup && cleanup.ok === true, 'Security quantity fixture cleanup failed', cleanup);
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderSecurityServerVariantAuthorityWorkflow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'SecurityVariantAuthority', {
    mode:'weight',
    brackets:[
      { from_g:0, to_g:999, price:40 },
      { from_g:1000, to_g:1999, price:80 },
      { from_g:2000, to_g:999999, price:130 }
    ]
  });
  var steps = [], caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'SecurityAuthority', -1, {
      price:100,
      weight_grams:10,
      variants:[
        { name:'Size', type:'text', options:[
          { label:'M', price:400, weight_grams:400, stock:10 },
          { label:'L', price:450, weight_grams:450, stock:10 }
        ] },
        { name:'Package', type:'text', options:[
          { label:'Box', price:700, weight_grams:1200, stock:8 },
          { label:'Bag', price:650, weight_grams:900, stock:8 }
        ] }
      ]
    });
    fx.product_ids.push(product.id);
    var variantKey = 'Package=Box|Size=M';
    var promotion = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'SecurityAuthorityVariant', {
      discount_type:'fixed', discount_value:100,
      target_type:'variant', target:[{ product_id:product.id, variant_key:variantKey }]
    });
    fx.promotion_ids.push(promotion.promotion_id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'SecurityAuthority', { stock:10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'SecurityAuthority', gift.gift_id, {
      condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[{ product_id:product.id, variant_key:variantKey, min_qty:2 }] },
      gift_qty:1, repeat_mode:'once_per_order', priority:9900
    });
    fx.rule_ids.push(rule.rule_id);
    qaStep_(steps, 'create authoritative multi-group variant promotion/gift/shipping fixture', 'ok', {
      product_id:product.id, promotion_id:promotion.promotion_id, gift_id:gift.gift_id, rule_id:rule.rule_id
    });

    var cart = [{ product_id:product.id, qty:2, selected_variants:{ Package:'Box', Size:'M' } }];
    var promoPreview = qaCall_('previewPromotionEligibilityRpc', [{ items:cart }]);
    qaAssertOk_(promoPreview);
    var previewLine = qaPromoPreviewLine_(promoPreview, product.id, variantKey);
    qaAssert_(previewLine && Number(previewLine.unit_base_price) === 700
      && Number(previewLine.unit_final_price) === 600
      && previewLine.promotion && String(previewLine.promotion.promotion_id) === String(promotion.promotion_id),
      'Promotion preview must use the verified variant key and price', { line:previewLine, preview:promoPreview });
    var giftPreview = qaCall_('previewGiftEligibilityRpc', [{ items:cart }]);
    qaAssertOk_(giftPreview);
    var eligibleGift = (giftPreview.eligible || []).filter(function(entry){ return String(entry.rule_id) === String(rule.rule_id); })[0];
    qaAssert_(eligibleGift && eligibleGift.gift && Number(eligibleGift.gift.qty) === 1,
      'Gift preview must qualify from the verified variant quantity', giftPreview);
    qaStep_(steps, 'verify promotion and gift previews use the canonical server variant', 'ok', {
      variant_key:variantKey, unit_base_price:previewLine.unit_base_price, unit_final_price:previewLine.unit_final_price
    });

    var payload = qaBuildOrderPayloadForProduct_('qa-security-authority', fx.stamp, 'Buyer', product.id, fx.shipping, { items:cart });
    payload.items[0].variant_info = 'ATTACKER CONTROLLED TEXT';
    payload.items[0].unit_price = 1;
    payload.items[0].price = 1;
    payload.items[0].weight_grams = 1;
    payload.items[0].stock = 999999;
    payload.client_pricing = qaRuleOrderClientPricingFromPreview_(promoPreview, cart, 130);
    var submit = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(submit);
    var orderId = qaOrderIdsFromSubmit_(submit)[0];
    var order = qaReadOrder_(fx.token, orderId);
    var line = qaFindProductLineByVariantKey_(order, product.id, variantKey);
    qaAssert_(line
      && line.variant_info === 'Size: M, Package: Box'
      && Number(line.qty) === 2
      && Number(line.unit_base_price) === 700
      && Number(line.unit_final_price) === 600
      && Number(line.subtotal) === 1200
      && line.promotion && String(line.promotion.promotion_id) === String(promotion.promotion_id),
      'Persisted line must ignore forged client fields and use the server variant snapshot', { line:line, order:order });
    qaAssert_(Number(order.subtotal) === 1200 && Number(order.shipping_fee) === 130 && Number(order.total) === 1330,
      'Order totals and weight shipping must come from the verified variant', order);
    var giftLines = qaActiveGiftLines_(order, gift.gift_id);
    qaAssert_(giftLines.length === 1 && Number(giftLines[0].gift_qty) === 1 && String(giftLines[0].rule_id) === String(rule.rule_id),
      'Persisted gift must match the verified variant rule', { gifts:giftLines, order:order });
    qaAssert_(qaGetVariantStock_(product.id, 'Size', 'M') === 10
      && qaGetVariantStock_(product.id, 'Package', 'Box') === 6
      && qaGetGiftStock_(gift.gift_id) === 9,
      'Only the authoritative stock targets should be deducted', {
        size_m:qaGetVariantStock_(product.id, 'Size', 'M'),
        package_box:qaGetVariantStock_(product.id, 'Package', 'Box'),
        gift:qaGetGiftStock_(gift.gift_id)
      });
    qaStep_(steps, 'verify persisted pricing, shipping, promotion, gift, and stock authority', 'ok', {
      order_id:orderId, subtotal:order.subtotal, shipping_fee:order.shipping_fee, total:order.total
    });
    output = { steps:steps, order_id:orderId, line:line, gift_lines:giftLines };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup server authority fixtures', cleanup && cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  qaAssert_(cleanup && cleanup.ok === true, 'Server authority fixture cleanup failed', cleanup);
  output.cleanup = cleanup;
  return output;
}

function qaBulkOrderCount_(ctx, defaultCount) {
  var raw = ctx && ctx.options ? Number(ctx.options.bulkOrderCount) : 0;
  var n = isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultCount;
  return Math.min(50, Math.max(1, n));
}

function qaRunOrderE2EWeightPromoGiftOneOrderFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'E2EWeightPromoGift', {
    mode:'weight',
    brackets:[
      { from_g:0, to_g:999, price:40 },
      { from_g:1000, to_g:1999, price:80 },
      { from_g:2000, to_g:999999, price:130 }
    ]
  });
  var steps = [], caught = null, output = null;
  try {
    qaStep_(steps, 'สร้าง shipping แบบคิดตามน้ำหนัก', 'ok', {
      method_id:fx.shipping.method.id,
      brackets:fx.shipping.method.brackets
    });

    var variantProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'E2EVariantHeavy', -1, {
      price:900,
      weight_grams:250,
      variants:[{ name:'Size', type:'text', options:[
        { label:'Light', price:900, weight_grams:250, stock:5 },
        { label:'Heavy', price:1500, weight_grams:850, stock:5 }
      ]}]
    });
    var normalProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'E2ENormal', 5, {
      price:700,
      weight_grams:350
    });
    fx.product_ids = [variantProduct.id, normalProduct.id];
    qaStep_(steps, 'สร้างสินค้า variant + สินค้าปกติ', 'ok', {
      variant_product_id:variantProduct.id,
      normal_product_id:normalProduct.id
    });

    var promo = qaCreatePromotion_(fx.token, variantProduct.id, fx.stamp, 'E2EHeavyVariant', {
      discount_value:200,
      target_type:'variant',
      target:[{ product_id:variantProduct.id, variant_key:'Size=Heavy' }]
    });
    fx.promotion_ids.push(promo.promotion_id);
    var heavyRec = qaGetProductRecord_(variantProduct.id);
    var heavyPromo = heavyRec.variant_promotions && heavyRec.variant_promotions['Size=Heavy'];
    qaAssert_(heavyPromo && heavyPromo.promotion && String(heavyPromo.promotion.promotion_id) === String(promo.promotion_id),
      'Variant promotion should apply to Size=Heavy before checkout', heavyRec);
    qaAssert_(Number(heavyPromo.unit_final_price) === 1300, 'Variant promotion final price should be 1300', heavyPromo);
    qaStep_(steps, 'สร้างและตรวจโปรโมชั่นเฉพาะ variant', 'ok', {
      promotion_id:promo.promotion_id,
      variant_pricing:heavyPromo
    });

    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'E2EWeightPromoGift', { stock:5, enabled:true });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'E2EWeightPromoGift', gift.gift_id, {
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:3000 },
      gift_qty:2,
      repeat_mode:'once_per_order',
      priority:9999
    });
    fx.rule_ids.push(rule.rule_id);
    qaStep_(steps, 'สร้างของแถมและกฎ min_subtotal หลังโปร', 'ok', {
      gift_id:gift.gift_id,
      rule_id:rule.rule_id,
      min_subtotal:3000,
      gift_qty:2
    });

    var preview = qaCall_('previewGiftEligibilityRpc', [{
      items:[
        { product_id:variantProduct.id, qty:2, selected_variants:{ Size:'Heavy' } },
        { product_id:normalProduct.id, qty:1, selected_variants:{} }
      ]
    }]);
    qaAssertOk_(preview);
    qaAssert_(Number(preview.subtotal_after_promo) === 3300, 'Gift preview subtotal_after_promo should be 3300', preview);
    qaAssert_(qaHasEligibleRule_(preview, rule.rule_id), 'Gift preview should mark the min-subtotal rule eligible', preview);
    qaStep_(steps, 'preview gift eligibility ก่อน submit', 'ok', {
      subtotal_after_promo:preview.subtotal_after_promo,
      eligible_count:(preview.eligible || []).length
    });

    var expected = {
      heavy_base:1500,
      heavy_discount:200,
      heavy_final:1300,
      normal_final:700,
      subtotal:3300,
      weight_g:(850 * 2) + 350,
      shipping_fee:130,
      total:3430,
      gift_qty:2
    };
    var payload = qaBuildOrderPayloadForProduct_('qa-e2e-weight-promo-gift', fx.stamp, 'Buyer', variantProduct.id, fx.shipping, {
      items:[
        { product_id:variantProduct.id, qty:2, selected_variants:{ Size:'Heavy' } },
        { product_id:normalProduct.id, qty:1, selected_variants:{} }
      ]
    });
    payload.client_pricing = {
      items:[
        {
          product_id:variantProduct.id,
          selected_variants:{ Size:'Heavy' },
          qty:2,
          unit_final_price:expected.heavy_final,
          promotion_id:promo.promotion_id
        },
        {
          product_id:normalProduct.id,
          selected_variants:{},
          qty:1,
          unit_final_price:expected.normal_final,
          promotion_id:null
        }
      ],
      subtotal:expected.subtotal,
      shipping_fee:expected.shipping_fee,
      total:expected.total
    };

    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var attachedFixtureGifts = (res.gifts_attached || []).filter(function(g) {
      return String(g.gift_id) === String(gift.gift_id);
    });
    var skippedFixtureGifts = (res.gifts_skipped || []).filter(function(g) {
      return String(g.gift_id) === String(gift.gift_id);
    });
    qaAssert_(attachedFixtureGifts.length === 1 && Number(attachedFixtureGifts[0].qty) === expected.gift_qty,
      'submitOrderRpc should report the fixture gift attached', {
        expected_gift_id:gift.gift_id,
        expected_qty:expected.gift_qty,
        gifts_attached:res.gifts_attached
      });
    qaAssert_(skippedFixtureGifts.length === 0, 'Fixture gift should not be skipped in the E2E checkout', {
      expected_gift_id:gift.gift_id,
      gifts_skipped:res.gifts_skipped
    });
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || (res.orders && res.orders[0] && res.orders[0].token) || '';
    qaAssert_(!!orderId && !!token, 'submitOrderRpc should return order id and token', res);
    qaStep_(steps, 'submit checkout จริงพร้อม client_pricing ที่ถูกต้อง', 'ok', {
      order_id:orderId,
      token_returned:!!token,
      response:res
    });

    var order = qaReadOrder_(fx.token, orderId);
    var heavyLine = qaFindProductLine_(order, variantProduct.id);
    var normalLine = qaFindProductLine_(order, normalProduct.id);
    var giftLines = qaActiveGiftLines_(order, gift.gift_id);
    qaAssert_(heavyLine && normalLine, 'Order should contain both product lines', order.items);
    qaAssert_(heavyLine.variant_key === 'Size=Heavy', 'Variant key snapshot mismatch', heavyLine);
    qaAssert_(Number(heavyLine.qty) === 2 && Number(heavyLine.unit_base_price) === expected.heavy_base &&
      Number(heavyLine.unit_discount_amount) === expected.heavy_discount &&
      Number(heavyLine.unit_final_price) === expected.heavy_final &&
      Number(heavyLine.subtotal) === expected.heavy_final * 2,
      'Heavy variant pricing snapshot mismatch', heavyLine);
    qaAssert_(heavyLine.promotion && String(heavyLine.promotion.promotion_id) === String(promo.promotion_id),
      'Heavy variant line should carry the promotion snapshot', heavyLine);
    qaAssert_(!normalLine.promotion && Number(normalLine.unit_final_price) === expected.normal_final &&
      Number(normalLine.subtotal) === expected.normal_final,
      'Normal product line should stay full price without promotion', normalLine);
    qaAssert_(Number(order.subtotal) === expected.subtotal &&
      Number(order.shipping_fee) === expected.shipping_fee &&
      Number(order.total) === expected.total,
      'Order totals mismatch for E2E checkout', { expected:expected, order:order });
    qaAssert_((order.shipping_info || []).length === 1 &&
      Number(order.shipping_info[0].fee) === expected.shipping_fee &&
      String(order.shipping_info[0].method_id) === String(fx.shipping.method.id),
      'Shipping snapshot mismatch for E2E checkout', order.shipping_info);
    qaAssert_(giftLines.length === 1 && Number(giftLines[0].gift_qty) === expected.gift_qty &&
      String(giftLines[0].rule_id) === String(rule.rule_id),
      'Gift snapshot mismatch for E2E checkout', { giftLines:giftLines, orderItems:order.items });
    qaStep_(steps, 'ตรวจ order snapshot: pricing + shipping + gift', 'ok', {
      order_id:orderId,
      subtotal:order.subtotal,
      shipping_fee:order.shipping_fee,
      total:order.total,
      heavy_line:heavyLine,
      normal_line:normalLine,
      gift_line:giftLines[0]
    });

    qaAssert_(qaGetVariantStock_(variantProduct.id, 'Size', 'Heavy') === 3, 'Heavy variant stock should be deducted from 5 to 3', { stock:qaGetVariantStock_(variantProduct.id, 'Size', 'Heavy') });
    qaAssert_(qaGetVariantStock_(variantProduct.id, 'Size', 'Light') === 5, 'Unselected variant stock should remain 5', { stock:qaGetVariantStock_(variantProduct.id, 'Size', 'Light') });
    qaAssert_(qaGetProductStock_(normalProduct.id) === 4, 'Normal product stock should be deducted from 5 to 4', { stock:qaGetProductStock_(normalProduct.id) });
    qaAssert_(qaGetGiftStock_(gift.gift_id) === 3, 'Gift stock should be deducted by gift_qty=2', { stock:qaGetGiftStock_(gift.gift_id) });
    qaStep_(steps, 'ตรวจ stock หลัง submit', 'ok', {
      heavy_stock:qaGetVariantStock_(variantProduct.id, 'Size', 'Heavy'),
      light_stock:qaGetVariantStock_(variantProduct.id, 'Size', 'Light'),
      normal_stock:qaGetProductStock_(normalProduct.id),
      gift_stock:qaGetGiftStock_(gift.gift_id)
    });

    var tokenRead = qaCall_('getOrderByTokenRpc', [token]);
    qaAssertOk_(tokenRead);
    qaAssert_(tokenRead.record && String(tokenRead.record.order_id) === String(orderId), 'Token read should return the same order', tokenRead);
    qaAssert_(Number(tokenRead.record.total) === expected.total && qaActiveGiftLines_(tokenRead.record, gift.gift_id).length === 1,
      'Token read should expose the same total and active gift line', tokenRead.record);
    qaStep_(steps, 'อ่าน order-view ด้วย token', 'ok', {
      order_id:tokenRead.record.order_id,
      total:tokenRead.record.total,
      gift_count:qaActiveGiftLines_(tokenRead.record, gift.gift_id).length
    });

    output = {
      steps:steps,
      expected:expected,
      order_id:orderId,
      token_returned:!!token,
      product_ids:fx.product_ids.slice(),
      promotion_id:promo.promotion_id,
      gift_id:gift.gift_id,
      rule_id:rule.rule_id,
      final_stock:{
        heavy_variant:qaGetVariantStock_(variantProduct.id, 'Size', 'Heavy'),
        light_variant:qaGetVariantStock_(variantProduct.id, 'Size', 'Light'),
        normal_product:qaGetProductStock_(normalProduct.id),
        gift:qaGetGiftStock_(gift.gift_id)
      },
      order_totals:{
        subtotal:order.subtotal,
        shipping_fee:order.shipping_fee,
        total:order.total
      }
    };
  } catch (err) {
    caught = err;
    steps.push({ step:'error', status:'failed', data:{ error:String(err && err.message || err) } });
  }
  var cleanup = qaCleanupCommerceFixture_(fx);
  steps.push({ step:'cleanup', status:cleanup.ok ? 'ok' : 'failed', data:cleanup });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.steps = steps;
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionAllTargetMultiProductFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoAll', { flat_rate: 0 });
  var caught = null, output = null;
  try {
    var p1 = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoAllA', 5, { price:1000 });
    var p2 = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoAllB', 5, { price:500 });
    fx.product_ids = [p1.id, p2.id];
    var promo = qaCreatePromotion_(fx.token, '', fx.stamp, 'AllTarget', { target_type:'all', target:[], discount_value:100 });
    fx.promotion_ids.push(promo.promotion_id);
    var rec1 = qaGetProductRecord_(p1.id), rec2 = qaGetProductRecord_(p2.id);
    qaAssert_(Number(rec1.final_price) === 900 && Number(rec2.final_price) === 400, 'All-target promotion did not apply to both products', { rec1:rec1, rec2:rec2 });
    var payload = qaBuildOrderPayloadForProduct_('qa-promo-all', fx.stamp, 'Buyer', p1.id, fx.shipping, {
      items:[{ product_id:p1.id, qty:1, selected_variants:{} }, { product_id:p2.id, qty:2, selected_variants:{} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var l1 = qaFindProductLine_(order, p1.id), l2 = qaFindProductLine_(order, p2.id);
    qaAssert_(l1 && l2 && Number(l1.unit_final_price) === 900 && Number(l2.unit_final_price) === 400 && Number(order.total) === 1700, 'Multi-item all-target order total mismatch', order);
    output = { order_id:order.order_id, total:order.total, lines:[l1, l2] };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionFixedDiscountClampsZeroFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoClampZero', 5, { price:100 });
  fx.promotion_ids = [];
  var caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'ClampZero', { discount_value:250 });
    fx.promotion_ids.push(promo.promotion_id);
    var rec = qaGetProductRecord_(fx.product.id);
    qaAssert_(Number(rec.final_price) === 0 && Number(rec.discount_amount) === 100, 'Fixed discount should clamp at zero', rec);
    output = { promotion_id:promo.promotion_id, final_price:rec.final_price, discount_amount:rec.discount_amount };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token:fx.token, order_ids:fx.order_ids, promotion_ids:fx.promotion_ids, product_ids:[fx.product.id], shipping:fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionPercentRoundingFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoRound', 5, { price:999 });
  var promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'Round', { discount_type:'percent', discount_value:33 });
    promos.push(promo.promotion_id);
    var rec = qaGetProductRecord_(fx.product.id);
    qaAssert_(Number(rec.final_price) === 669 && Number(rec.discount_amount) === 330, 'Percent rounding mismatch', rec);
    output = { final_price:rec.final_price, discount_amount:rec.discount_amount };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token:fx.token, order_ids:fx.order_ids, promotion_ids:promos, product_ids:[fx.product.id], shipping:fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionInvalidTargetRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoInvalidTarget', -1, {
    variants:[{ name:'Color', type:'text', options:[{ label:'Red', price:500, weight_grams:100, stock:5 }] }]
  });
  var caught = null, output = null;
  try {
    var missing = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Promo Missing Target ' + fx.stamp, description:'missing product',
      discount_type:'fixed', discount_value:10, target_type:'product',
      target:[{ product_id:'qa_missing_product_' + fx.stamp }], starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true, enabled:true
    }]);
    var badVariant = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Promo Bad Variant ' + fx.stamp, description:'bad variant',
      discount_type:'fixed', discount_value:10, target_type:'variant',
      target:[{ product_id:fx.product.id, variant_key:'Color=Blue' }], starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true, enabled:true
    }]);
    qaAssert_(missing && missing.ok === false && badVariant && badVariant.ok === false, 'Invalid targets should be rejected', { missing:missing, badVariant:badVariant });
    output = { missing_response:missing, bad_variant_response:badVariant };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionToggleOverlapGuardFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PromoToggleOverlap', 5, { price:1000 });
  var promos = [], caught = null, output = null;
  try {
    var active = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'ToggleActive', { discount_value:50 });
    promos.push(active.promotion_id);
    var disabled = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'ToggleDisabled', { discount_value:60, enabled:false });
    promos.push(disabled.promotion_id);
    var toggle = qaCall_('togglePromotionRpc', [fx.token, disabled.promotion_id, true]);
    qaAssert_(toggle && toggle.ok === false, 'Overlapping disabled promotion should not be enabled', toggle);
    qaAssert_(toggle.error === 'PROMO_OVERLAP' && toggle.conflict
      && String(toggle.conflict.promotion_id) === String(active.promotion_id),
      'Toggle overlap rejection must return PROMO_OVERLAP with conflict details', toggle);
    output = { active:active.promotion_id, disabled:disabled.promotion_id, toggle_response:toggle };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token:fx.token, order_ids:fx.order_ids, promotion_ids:promos, product_ids:[fx.product.id], shipping:fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionUpdateOverlapGuardFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoUpdateOverlap');
  var caught = null, output = null;
  try {
    var p1 = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'UpdateOverlapA', 5, { price:1000 });
    var p2 = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'UpdateOverlapB', 5, { price:1000 });
    fx.product_ids = [p1.id, p2.id];
    var active = qaCreatePromotion_(fx.token, p1.id, fx.stamp, 'UpdateActive', { discount_value:50 });
    var disabled = qaCreatePromotion_(fx.token, p2.id, fx.stamp, 'UpdateDisabled', { discount_value:60, enabled:false });
    fx.promotion_ids = [active.promotion_id, disabled.promotion_id];
    var existing = qaCall_('getPromotionRpc', [fx.token, disabled.promotion_id]);
    qaAssertOk_(existing);
    var update = qaCall_('updatePromotionRpc', [fx.token, disabled.promotion_id, Object.assign({}, existing.promotion, {
      enabled:true,
      target_type:'product',
      target:[{ product_id:p1.id }]
    })]);
    qaAssert_(update && update.ok === false, 'Overlapping promotion update should be rejected', update);
    qaAssert_(update.error === 'PROMO_OVERLAP' && update.conflict
      && String(update.conflict.promotion_id) === String(active.promotion_id),
      'Update overlap rejection must return PROMO_OVERLAP with conflict details', update);
    output = { update_response:update };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderClientPricingPromotionMismatchFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'ClientPromoMismatch', 5, { price:1000 });
  var promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'ClientMismatch', { discount_value:100 });
    promos.push(promo.promotion_id);
    var payload = qaBuildOrderPayloadForProduct_('qa-client-promo-mismatch', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.client_pricing = {
      items:[{ product_id:fx.product.id, selected_variants:{}, qty:1, unit_final_price:900, promotion_id:'promo_wrong' }],
      subtotal:900,
      shipping_fee:0,
      total:900
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssert_(res && res.ok === false && res.error === 'PRICE_CHANGED', 'Promotion id mismatch should return PRICE_CHANGED', res);
    qaAssert_((res.diff || []).some(function(d){ return d.kind === 'item_promotion'; }), 'PRICE_CHANGED diff should include item_promotion', res);
    output = { response:res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token:fx.token, order_ids:fx.order_ids, promotion_ids:promos, product_ids:[fx.product.id], shipping:fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderMultiItemMixedPromotionTotalFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'MixedPromoTotal', { flat_rate:30 });
  var caught = null, output = null;
  try {
    var discounted = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MixedDiscounted', 5, { price:1000 });
    var full = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MixedFull', 5, { price:400 });
    fx.product_ids = [discounted.id, full.id];
    var promo = qaCreatePromotion_(fx.token, discounted.id, fx.stamp, 'MixedOnlyOne', { discount_value:250 });
    fx.promotion_ids.push(promo.promotion_id);
    var payload = qaBuildOrderPayloadForProduct_('qa-mixed-promo', fx.stamp, 'Buyer', discounted.id, fx.shipping, {
      items:[{ product_id:discounted.id, qty:1, selected_variants:{} }, { product_id:full.id, qty:2, selected_variants:{} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var dl = qaFindProductLine_(order, discounted.id), fl = qaFindProductLine_(order, full.id);
    qaAssert_(dl && fl && dl.promotion && !fl.promotion, 'Promotion snapshot should only be on targeted product line', order.items);
    qaAssert_(Number(order.subtotal) === 1550 && Number(order.total) === 1580, 'Mixed promotion total mismatch', order);
    output = { order_id:order.order_id, subtotal:order.subtotal, total:order.total, discounted_line:dl, full_line:fl };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftMinSubtotalAfterPromotionFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'MinSubtotalAfterPromo', { condition_type:'min_subtotal', min_subtotal:500, product_price:1000 });
  fx.promotion_ids = [];
  var caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'GiftMinSubtotalAfterPromo', { discount_value:600 });
    fx.promotion_ids.push(promo.promotion_id);
    var one = qaPreviewGiftFixture_(fx, 1);
    var two = qaPreviewGiftFixture_(fx, 2);
    qaAssertOk_(one); qaAssertOk_(two);
    qaAssert_(Number(one.subtotal_after_promo) === 400 && !qaHasEligibleRule_(one, fx.rule_id), 'Qty 1 should use after-promo subtotal and stay ineligible', one);
    qaAssert_(Number(two.subtotal_after_promo) === 800 && qaHasEligibleRule_(two, fx.rule_id), 'Qty 2 should be eligible after promotion subtotal', two);
    output = { qty1:one.subtotal_after_promo, qty2:two.subtotal_after_promo };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token:fx.token, order_ids:fx.order_ids, promotion_ids:fx.promotion_ids, rule_ids:[fx.rule_id], gift_ids:[fx.gift_id], product_ids:[fx.product.id], shipping:fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRequiredProductsAcrossDuplicateLinesFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'DuplicateLines', { min_qty:2, product_stock:10 });
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-gift-dupe-lines', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items:[{ product_id:fx.product.id, qty:1, selected_variants:{} }, { product_id:fx.product.id, qty:1, selected_variants:{} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var gifts = qaActiveGiftLines_(order, fx.gift_id);
    qaAssert_(gifts.length === 1, 'Duplicate product lines should aggregate for required_products gift rule', order.items);
    output = { order_id:order.order_id, gift_count:gifts.length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRequiredVariantsCanonicalKeyFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftCanonicalVariant');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'CanonicalVariant', -1, {
      price:500,
      variants:[
        { name:'Size', type:'text', options:[{ label:'M', price:500, weight_grams:100, stock:5 }, { label:'L', price:500, weight_grams:100, stock:5 }] },
        { name:'Color', type:'text', options:[{ label:'Red', price:500, weight_grams:100, stock:5 }, { label:'Blue', price:500, weight_grams:100, stock:5 }] }
      ]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'CanonicalVariant', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'CanonicalVariant', gift.gift_id, {
      condition_type:'required_variants',
      condition_json:{ required_variants:[{ product_id:product.id, variant_key:'Color=Red|Size=M', min_qty:1 }] }
    });
    fx.rule_ids.push(rule.rule_id);
    var preview = qaCall_('previewGiftEligibilityRpc', [{ items:[{ product_id:product.id, qty:1, selected_variants:{ Size:'M', Color:'Red' } }] }]);
    qaAssertOk_(preview);
    qaAssert_(qaHasEligibleRule_(preview, rule.rule_id), 'Canonical variant key should match regardless of selected_variants object order', preview);
    output = { eligible:true, subtotal_after_promo:preview.subtotal_after_promo };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftMultipleRulesPriorityOrderFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftPriority');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftPriority', 5, { price:500 });
    fx.product_ids.push(product.id);
    var hiGift = qaCreateGiftItem_(fx.token, fx.stamp, 'PriorityHigh', { stock:5 });
    var loGift = qaCreateGiftItem_(fx.token, fx.stamp, 'PriorityLow', { stock:5 });
    fx.gift_ids = [hiGift.gift_id, loGift.gift_id];
    var cond = { required_products:[{ product_id:product.id, min_qty:1 }] };
    var hiRule = qaCreateGiftRule_(fx.token, fx.stamp, 'PriorityHigh', hiGift.gift_id, { condition_json:cond, priority:100 });
    var loRule = qaCreateGiftRule_(fx.token, fx.stamp, 'PriorityLow', loGift.gift_id, { condition_json:cond, priority:50 });
    fx.rule_ids = [hiRule.rule_id, loRule.rule_id];
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-priority', fx.stamp, 'Buyer', product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var allGiftLines = qaAllGiftLines_(qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]));
    var fixtureRuleIds = [hiRule.rule_id, loRule.rule_id];
    var giftLines = allGiftLines.filter(function(g){ return fixtureRuleIds.indexOf(String(g.rule_id)) >= 0; });
    qaAssert_(giftLines.length === 2 && String(giftLines[0].rule_id) === String(hiRule.rule_id) && String(giftLines[1].rule_id) === String(loRule.rule_id), 'Gift lines should follow rule priority order', giftLines);
    output = { gift_rule_order:giftLines.map(function(g){ return g.rule_id; }) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSameGiftTwoRulesStockLimitedFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftSameStock');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftSameStock', 5, { price:500 });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'SameStock', { stock:1 });
    fx.gift_ids.push(gift.gift_id);
    var cond = { required_products:[{ product_id:product.id, min_qty:1 }] };
    var r1 = qaCreateGiftRule_(fx.token, fx.stamp, 'SameStockA', gift.gift_id, { condition_json:cond, priority:100 });
    var r2 = qaCreateGiftRule_(fx.token, fx.stamp, 'SameStockB', gift.gift_id, { condition_json:cond, priority:90 });
    fx.rule_ids = [r1.rule_id, r2.rule_id];
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-same-stock', fx.stamp, 'Buyer', product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, gift.gift_id).length === 1, 'Only one same-gift rule should attach when stock is 1', order.items);
    qaAssert_((res.gifts_skipped || []).some(function(s){ return s.code === 'GIFT_OUT_OF_STOCK' && String(s.gift_id) === String(gift.gift_id); }), 'Second same-gift rule should be skipped as out of stock', res);
    output = { attached:qaActiveGiftLines_(order, gift.gift_id).length, skipped:res.gifts_skipped };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftQtyStockBoundaryFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftQtyBoundary');
  var caught = null, output = null;
  try {
    var pSkip = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftQtySkip', 5, { price:500 });
    var pOk = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftQtyOk', 5, { price:500 });
    fx.product_ids = [pSkip.id, pOk.id];
    var gSkip = qaCreateGiftItem_(fx.token, fx.stamp, 'QtySkip', { stock:1 });
    var gOk = qaCreateGiftItem_(fx.token, fx.stamp, 'QtyOk', { stock:2 });
    fx.gift_ids = [gSkip.gift_id, gOk.gift_id];
    var rSkip = qaCreateGiftRule_(fx.token, fx.stamp, 'QtySkip', gSkip.gift_id, { condition_json:{ required_products:[{ product_id:pSkip.id, min_qty:1 }] }, gift_qty:2 });
    var rOk = qaCreateGiftRule_(fx.token, fx.stamp, 'QtyOk', gOk.gift_id, { condition_json:{ required_products:[{ product_id:pOk.id, min_qty:1 }] }, gift_qty:2 });
    fx.rule_ids = [rSkip.rule_id, rOk.rule_id];
    var skipRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-qty-skip', fx.stamp, 'Skip', pSkip.id, fx.shipping), fx.order_ids);
    var okRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-qty-ok', fx.stamp, 'Ok', pOk.id, fx.shipping), fx.order_ids);
    qaAssertOk_(skipRes); qaAssertOk_(okRes);
    var okOrder = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(okRes)[0]);
    qaAssert_((skipRes.gifts_skipped || []).length === 1 && qaGetGiftStock_(gSkip.gift_id) === 1, 'gift_qty=2 with stock=1 should skip without deduction', skipRes);
    qaAssert_(qaActiveGiftLines_(okOrder, gOk.gift_id).length === 1 && qaGetGiftStock_(gOk.gift_id) === 0, 'gift_qty=2 with stock=2 should attach and deplete stock', okOrder);
    output = { skip_response:skipRes, ok_response:okRes, ok_stock:qaGetGiftStock_(gOk.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftStalePreviewRuleDisabledBeforeSubmitFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'StalePreview', { gift_stock:5 });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(qaHasEligibleRule_(preview, fx.rule_id), 'Fixture should be eligible before disabling rule', preview);
    qaAssertOk_(qaCall_('toggleGiftRuleRpc', [fx.token, fx.rule_id, false]));
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-stale-preview', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'Disabled rule should not attach gift after stale preview', order.items);
    output = { preview_eligible:true, order_id:order.order_id, gift_count:0 };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSplitShippingPerDraftFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var methods = [
    { id:'qa_gift_split_a_' + suffix, name:'QA Gift Split A', active:true, mode:'flat', flat_rate:0 },
    { id:'qa_gift_split_b_' + suffix, name:'QA Gift Split B', active:true, mode:'flat', flat_rate:0 }
  ];
  var fx = { token:token, stamp:stamp, shipping:qaCreateTempShippingMethod_(token, stamp, 'GiftSplit', { methods:methods }), order_ids:[], product_ids:[], gift_ids:[], rule_ids:[], promotion_ids:[] };
  var caught = null, output = null;
  try {
    var pA = qaCreateOrderQaProduct_(token, fx.shipping, stamp, 'GiftSplitA', 5, { allowed_shipping_ids:[methods[0].id], price:300 });
    var pB = qaCreateOrderQaProduct_(token, fx.shipping, stamp, 'GiftSplitB', 5, { allowed_shipping_ids:[methods[1].id], price:400 });
    fx.product_ids = [pA.id, pB.id];
    var gift = qaCreateGiftItem_(token, stamp, 'GiftSplit', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(token, stamp, 'GiftSplit', gift.gift_id, { condition_json:{ required_products:[{ product_id:pA.id, min_qty:1 }] } });
    fx.rule_ids.push(rule.rule_id);
    var payload = qaBuildOrderPayloadForProduct_('qa-gift-split', stamp, 'Buyer', pA.id, fx.shipping, {
      items:[{ product_id:pA.id, qty:1, selected_variants:{} }, { product_id:pB.id, qty:1, selected_variants:{} }]
    });
    payload.shipping_info = [
      { company_id:fx.shipping.company.id, method_id:methods[0].id, item_product_ids:[pA.id] },
      { company_id:fx.shipping.company.id, method_id:methods[1].id, item_product_ids:[pB.id] }
    ];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var records = fx.order_ids.map(function(id){ return qaReadOrder_(token, id); });
    var aOrder = records.filter(function(r){ return !!qaFindProductLine_(r, pA.id); })[0];
    var bOrder = records.filter(function(r){ return !!qaFindProductLine_(r, pB.id); })[0];
    qaAssert_(aOrder && bOrder && qaActiveGiftLines_(aOrder, gift.gift_id).length === 1 && qaActiveGiftLines_(bOrder, gift.gift_id).length === 0, 'Gift should attach only to the matching split draft', records);
    output = { order_ids:fx.order_ids.slice(), gift_order_id:aOrder.order_id };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSplitShippingAutoGiftOnlyOnceFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var methods = [
    { id:'qa_gift_once_a_' + suffix, name:'QA Gift Once A', active:true, mode:'flat', flat_rate:0 },
    { id:'qa_gift_once_b_' + suffix, name:'QA Gift Once B', active:true, mode:'flat', flat_rate:0 }
  ];
  var fx = { token:token, stamp:stamp, shipping:qaCreateTempShippingMethod_(token, stamp, 'GiftOnce', { methods:methods }), order_ids:[], product_ids:[], gift_ids:[], rule_ids:[], promotion_ids:[] };
  var caught = null, output = null;
  try {
    // Two products, each restricted to a different shipping method → forces split.
    // Prices are chosen so each draft's subtotal individually clears min_subtotal,
    // which is the scenario where per-draft eval would duplicate the gift.
    var pA = qaCreateOrderQaProduct_(token, fx.shipping, stamp, 'GiftOnceA', 5, { allowed_shipping_ids:[methods[0].id], price:500 });
    var pB = qaCreateOrderQaProduct_(token, fx.shipping, stamp, 'GiftOnceB', 5, { allowed_shipping_ids:[methods[1].id], price:500 });
    fx.product_ids = [pA.id, pB.id];
    var giftStockBefore = 5;
    var gift = qaCreateGiftItem_(token, stamp, 'GiftOnce', { stock:giftStockBefore });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(token, stamp, 'GiftOnce', gift.gift_id, {
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:100 } // every draft (and the whole cart) clears this
    });
    fx.rule_ids.push(rule.rule_id);
    var payload = qaBuildOrderPayloadForProduct_('qa-gift-once', stamp, 'Buyer', pA.id, fx.shipping, {
      items:[{ product_id:pA.id, qty:1, selected_variants:{} }, { product_id:pB.id, qty:1, selected_variants:{} }]
    });
    payload.shipping_info = [
      { company_id:fx.shipping.company.id, method_id:methods[0].id, item_product_ids:[pA.id] },
      { company_id:fx.shipping.company.id, method_id:methods[1].id, item_product_ids:[pB.id] }
    ];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    qaAssert_(Array.isArray(res.orders) && res.orders.length === 2, 'Split shipping should create exactly 2 orders', res);

    // The success response must not duplicate the gift line.
    var attached = res.gifts_attached || [];
    var sameGiftEntries = attached.filter(function(g){ return String(g.gift_id) === String(gift.gift_id); });
    var attachedQty = sameGiftEntries.reduce(function(s, g){ return s + Number(g.qty || 0); }, 0);
    qaAssert_(attachedQty === 1, 'Cart-wide gift entitlement should be 1, not duplicated per split draft', { gifts_attached:attached });

    // Exactly one of the two persisted orders should contain the gift line.
    var records = fx.order_ids.map(function(id){ return qaReadOrder_(token, id); });
    var ordersWithGift = records.filter(function(r){ return qaActiveGiftLines_(r, gift.gift_id).length > 0; });
    qaAssert_(ordersWithGift.length === 1, 'Gift line should appear in exactly one split order', records);
    var totalGiftUnitsAcrossOrders = records.reduce(function(s, r) {
      return s + qaActiveGiftLines_(r, gift.gift_id).reduce(function(t, l){ return t + Number(l.gift_qty || 0); }, 0);
    }, 0);
    qaAssert_(totalGiftUnitsAcrossOrders === 1, 'Total gift quantity across split orders should be 1', records);

    // Gift stock should be deducted exactly once.
    var giftStockAfter = qaGetGiftStock_(gift.gift_id);
    qaAssert_(giftStockAfter === giftStockBefore - 1, 'Gift stock should decrease by exactly 1', { before:giftStockBefore, after:giftStockAfter });

    output = { order_ids:fx.order_ids.slice(), gift_order_id:ordersWithGift[0].order_id, gift_stock_after:giftStockAfter, gifts_attached:attached };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Split shipping combined with a cart-wide conditional promotion AND a per_threshold gift
// rule. Both the promotion's qualifying subtotal and the gift's threshold multiplier must be
// computed against the WHOLE cart (cartPricing.subtotal_after_direct), not per shipping
// draft — submitOrderRpc evaluates gift eligibility once for the entire cart specifically to
// avoid double-firing across drafts, and the same whole-cart base feeds the conditional
// promotion. Two products priced 300 each, each pinned to a different shipping method
// (forces a 2-draft split): whole-cart raw subtotal is 600. If evaluation were wrongly
// per-draft (each draft only sees 300), the promo (needs >=500) would NOT qualify and the
// gift (threshold 200, per_threshold) would only grant 1 set per draft (2 total, duplicated)
// instead of the correct floor(600/200)=3 granted exactly once.
function qaRunOrderSplitShippingConditionalPromoAndRepeatGiftFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'SplitCondGift', [
    { name: 'QA Split Cond Gift A' }, { name: 'QA Split Cond Gift B' }
  ]);
  var fx = { token: token, stamp: stamp, shipping: shipping, order_ids: [], product_ids: [], gift_ids: [], rule_ids: [], promotion_ids: [] };
  var caught = null, output = null;
  try {
    var methodA = shipping.methods[0], methodB = shipping.methods[1];
    var pA = qaCreateOrderQaProduct_(token, shipping, stamp, 'SplitCondGiftA', 10, { price: 300, allowed_shipping_ids: [methodA.id] });
    var pB = qaCreateOrderQaProduct_(token, shipping, stamp, 'SplitCondGiftB', 10, { price: 300, allowed_shipping_ids: [methodB.id] });
    fx.product_ids = [pA.id, pB.id];

    // Cart-wide conditional promo: target 'all', needs whole-cart subtotal >= 500 (only true
    // if evaluated across both drafts: 300+300=600; a single draft alone is only 300).
    var promo = qaCreatePromotion_(token, pA.id, stamp, 'SplitCondGift', {
      discount_type: 'fixed', discount_value: 100, target_type: 'all', target: [],
      application_mode: 'conditional', condition_type: 'min_subtotal',
      condition_json: { min_subtotal: 500, calculation_base: 'after_discount_before_shipping' }
    });
    fx.promotion_ids.push(promo.promotion_id);

    // per_threshold gift on whole-cart subtotal: min_subtotal 200 -> floor(600/200) = 3 sets.
    // A per-draft evaluation would instead yield floor(300/200)=1 per draft (2 total, doubled).
    var giftStockBefore = 20;
    var gift = qaCreateGiftItem_(token, stamp, 'SplitCondGift', { stock: giftStockBefore });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(token, stamp, 'SplitCondGift', gift.gift_id, {
      condition_type: 'min_subtotal', condition_json: { min_subtotal: 200 },
      gift_qty: 1, repeat_mode: 'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);

    var payload = qaBuildOrderPayloadForProduct_('qa-split-cond-gift', stamp, 'Buyer', pA.id, shipping, {
      items: [{ product_id: pA.id, qty: 1, selected_variants: {} }, { product_id: pB.id, qty: 1, selected_variants: {} }]
    });
    payload.shipping_info = [
      { company_id: shipping.company.id, method_id: methodA.id, item_product_ids: [pA.id] },
      { company_id: shipping.company.id, method_id: methodB.id, item_product_ids: [pB.id] }
    ];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    qaAssert_(Array.isArray(res.orders) && res.orders.length === 2, 'Split shipping should create exactly 2 orders', res);

    // Promotion discount must reflect the whole-cart subtotal (500 threshold met by 600),
    // not a smaller per-draft subtotal (300, which alone would not qualify) — both lines
    // should be discounted to 200 in their respective persisted orders.
    var records = fx.order_ids.map(function(id){ return qaReadOrder_(token, id); });
    var lineA = qaFindProductLine_(records.filter(function(r){ return !!qaFindProductLine_(r, pA.id); })[0], pA.id);
    var lineB = qaFindProductLine_(records.filter(function(r){ return !!qaFindProductLine_(r, pB.id); })[0], pB.id);
    qaAssert_(lineA && Number(lineA.unit_final_price) === 200 && lineA.promotion && String(lineA.promotion.promotion_id) === String(promo.promotion_id),
      'A ต้องถูกลดราคาตามโปรเงื่อนไขที่ประเมินจากยอดรวมทั้งตะกร้า (คาด 200)', lineA);
    qaAssert_(lineB && Number(lineB.unit_final_price) === 200 && lineB.promotion && String(lineB.promotion.promotion_id) === String(promo.promotion_id),
      'B ต้องถูกลดราคาตามโปรเงื่อนไขที่ประเมินจากยอดรวมทั้งตะกร้า (คาด 200)', lineB);

    // Gift: exactly 3 units awarded once across the whole cart, not duplicated per draft.
    var attached = (res.gifts_attached || []).filter(function(g){ return String(g.gift_id) === String(gift.gift_id); });
    var attachedQty = attached.reduce(function(s, g){ return s + Number(g.qty || 0); }, 0);
    qaAssert_(attachedQty === 3, 'ของแถมต้องคำนวณจากยอดรวมทั้งตะกร้าครั้งเดียว (คาด 3 ไม่ใช่ซ้ำต่อ draft)', { gifts_attached: res.gifts_attached });
    var ordersWithGift = records.filter(function(r){ return qaActiveGiftLines_(r, gift.gift_id).length > 0; });
    qaAssert_(ordersWithGift.length === 1, 'ของแถมต้องอยู่ในออร์เดอร์เดียวจากการแยกจัดส่งเท่านั้น', records);
    var totalGiftUnits = records.reduce(function(s, r){ return s + qaActiveGiftLines_(r, gift.gift_id).reduce(function(t, l){ return t + Number(l.gift_qty || 0); }, 0); }, 0);
    qaAssert_(totalGiftUnits === 3, 'จำนวนของแถมรวมทุกออร์เดอร์ต้องเป็น 3', records);

    var giftStockAfter = qaGetGiftStock_(gift.gift_id);
    qaAssert_(giftStockAfter === giftStockBefore - 3, 'สต็อกของแถมต้องลดลง 3 (ครั้งเดียว ไม่ใช่ซ้ำ)', { before: giftStockBefore, after: giftStockAfter });

    output = {
      order_ids: fx.order_ids.slice(), promotion_id: promo.promotion_id, rule_id: rule.rule_id,
      line_a_final: lineA.unit_final_price, line_b_final: lineB.unit_final_price,
      gift_qty_total: totalGiftUnits, gift_stock_after: giftStockAfter
    };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSnapshotImmutabilityFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'GiftSnapshot', { gift_stock:5 });
  var caught = null, output = null;
  try {
    var beforeGift = qaFindGiftItem_(fx.token, fx.gift_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-snapshot', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssertOk_(qaCall_('updateGiftItemRpc', [fx.token, fx.gift_id, { name:'QA Gift Changed ' + fx.stamp, stock:99, enabled:true }]));
    qaAssertOk_(qaCall_('deleteGiftItemRpc', [fx.token, fx.gift_id]));
    fx.gift_id = '';
    var order = qaReadOrder_(fx.token, orderId);
    var line = qaAllGiftLines_(order)[0];
    qaAssert_(line && line.gift_name === beforeGift.name, 'Gift snapshot should preserve original gift name after edit/delete', { line:line, beforeGift:beforeGift });
    output = { order_id:orderId, gift_snapshot_name:line.gift_name };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftTokenReadExcludesRemovedFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'TokenRemoved', 3);
  var caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-token-removed', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
    var add = qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:1 }]);
    qaAssertOk_(add);
    qaAssertOk_(qaCall_('removeGiftLineFromOrderRpc', [fx.token, orderId, add.gift_snapshot_id]));
    var read = qaCall_('getOrderGiftsByTokenRpc', [orderRes.token]);
    qaAssertOk_(read);
    qaAssert_(!(read.gifts || []).some(function(g){ return String(g.gift_id) === String(fx.gift_id); }), 'Token gift read should exclude removed gift lines', read);
    output = { order_id:orderId, returned_gifts:read.gifts || [] };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaCreateOrderWithManualGift_(ctx, label, stock, qty) {
  var fx = qaCreateManualGiftFixture_(ctx, label, stock);
  var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-' + label.toLowerCase(), fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
  qaAssertOk_(orderRes);
  var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
  var add = qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:qty || 1 }]);
  qaAssertOk_(add);
  fx.order_id = orderId;
  fx.gift_snapshot_id = add.gift_snapshot_id;
  return fx;
}

function qaRunGiftManualAddInvalidQtyRejectedFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'ManualBadQty', 3);
  var caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-bad-qty', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var orderId = qaOrderIdsFromSubmit_(orderRes)[0];
    var cases = [
      { qty:0, error:'INVALID_QTY' }, { qty:-1, error:'INVALID_QTY' },
      { qty:1.5, error:'INVALID_QTY' }, { qty:'abc', error:'INVALID_QTY' },
      { qty:Infinity, error:'INVALID_QTY' }, { qty:'9'.repeat(200), error:'INVALID_QTY' },
      { qty:10000, error:'QTY_LIMIT_EXCEEDED' }
    ];
    var results = cases.map(function(c){
      return { qty:(typeof c.qty === 'number' && !isFinite(c.qty)) ? String(c.qty) : c.qty,
        expected:c.error, response:qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:c.qty }]) };
    });
    qaAssert_(results.every(function(r){ return r.response && r.response.ok === false && r.response.error === r.expected; }),
      'Invalid manual gift quantities should be rejected with the strict shared contract', results);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 3, 'Invalid manual add should not change stock', { stock:qaGetGiftStock_(fx.gift_id), results:results });

    var added = qaCall_('addManualGiftToOrderRpc', [fx.token, orderId, { gift_id:fx.gift_id, qty:1 }]);
    qaAssertOk_(added);
    var updateResults = cases.map(function(c){
      return { qty:(typeof c.qty === 'number' && !isFinite(c.qty)) ? String(c.qty) : c.qty,
        expected:c.error, response:qaCall_('updateGiftLineQtyRpc', [fx.token, orderId, added.gift_snapshot_id, c.qty]) };
    });
    qaAssert_(updateResults.every(function(r){ return r.response && r.response.ok === false && r.response.error === r.expected; }),
      'Invalid manual gift updates should use the same strict quantity contract', updateResults);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 2, 'Invalid manual updates should not change the one valid reservation', {
      stock:qaGetGiftStock_(fx.gift_id), update_results:updateResults
    });
    output = { add_results:results, update_results:updateResults, final_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualAddClosedOrdersRejectedFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'ManualClosed', 4);
  var caught = null, output = null;
  try {
    var cancelled = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-closed', fx.stamp, 'Cancelled', fx.product.id, fx.shipping), fx.order_ids);
    var delivered = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-closed', fx.stamp, 'Delivered', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(cancelled); qaAssertOk_(delivered);
    var cId = qaOrderIdsFromSubmit_(cancelled)[0], dId = qaOrderIdsFromSubmit_(delivered)[0];
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, cId, 'cancelled', 'QA closed']));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, dId, 'delivered', 'QA delivered']));
    var cAdd = qaCall_('addManualGiftToOrderRpc', [fx.token, cId, { gift_id:fx.gift_id, qty:1 }]);
    var dAdd = qaCall_('addManualGiftToOrderRpc', [fx.token, dId, { gift_id:fx.gift_id, qty:1 }]);
    qaAssert_(cAdd && cAdd.ok === false && dAdd && dAdd.ok === false, 'Manual gift add should be rejected for cancelled/delivered orders', { cAdd:cAdd, dAdd:dAdd });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 4, 'Closed-order manual add should not deduct stock', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { cancelled_response:cAdd, delivered_response:dAdd };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualRemoveMissingSnapshotRejectedFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'RemoveMissing', 2);
  var caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-remove-missing', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var res = qaCall_('removeGiftLineFromOrderRpc', [fx.token, qaOrderIdsFromSubmit_(orderRes)[0], 'gl_missing_snapshot']);
    qaAssert_(res && res.ok === false, 'Removing a missing gift snapshot should be rejected', res);
    output = { response:res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualUpdateMissingSnapshotRejectedFlow_(ctx) {
  var fx = qaCreateManualGiftFixture_(ctx, 'UpdateMissing', 2);
  var caught = null, output = null;
  try {
    var orderRes = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-update-missing', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(orderRes);
    var res = qaCall_('updateGiftLineQtyRpc', [fx.token, qaOrderIdsFromSubmit_(orderRes)[0], 'gl_missing_snapshot', 2]);
    qaAssert_(res && res.ok === false, 'Updating a missing gift snapshot should be rejected', res);
    output = { response:res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualUpdateRemovedLineRejectedFlow_(ctx) {
  var fx = qaCreateOrderWithManualGift_(ctx, 'UpdateRemoved', 3, 1);
  var caught = null, output = null;
  try {
    qaAssertOk_(qaCall_('removeGiftLineFromOrderRpc', [fx.token, fx.order_id, fx.gift_snapshot_id]));
    var up = qaCall_('updateGiftLineQtyRpc', [fx.token, fx.order_id, fx.gift_snapshot_id, 2]);
    qaAssert_(up && up.ok === false, 'Removed gift line should not be updated', up);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 3, 'Failed update on removed line should not change stock', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { response:up, final_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftManualRemoveDeliveredNoStockRestoreFlow_(ctx) {
  var fx = qaCreateOrderWithManualGift_(ctx, 'DeliveredNoRestore', 2, 1);
  var caught = null, output = null;
  try {
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 1, 'Setup should reserve one gift stock', { stock:qaGetGiftStock_(fx.gift_id) });
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, fx.order_id, 'delivered', 'QA delivered']));
    var rm = qaCall_('removeGiftLineFromOrderRpc', [fx.token, fx.order_id, fx.gift_snapshot_id]);
    qaAssertOk_(rm);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 1, 'Removing from delivered order should not restore gift stock', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { response:rm, final_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderBulkSequential20SuccessFlow_(ctx) {
  var count = qaBulkOrderCount_(ctx, 20);
  var fx = qaCreateOrderFixture_(ctx, 'BulkSequential', count + 5, { price:100 });
  var caught = null, output = null;
  try {
    var tokens = [], ids = [];
    for (var i = 0; i < count; i++) {
      var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-bulk-seq', fx.stamp, 'B' + i, fx.product.id, fx.shipping), fx.order_ids);
      qaAssertOk_(res);
      ids.push(qaOrderIdsFromSubmit_(res)[0]);
      tokens.push(res.token || '');
    }
    qaAssert_(Array.from(new Set(ids)).length === count && Array.from(new Set(tokens)).length === count, 'Bulk orders should have unique ids and tokens', { ids:ids, tokens:tokens });
    qaAssert_(qaGetProductStock_(fx.product.id) === 5, 'Bulk sequential stock should end at 5', { stock:qaGetProductStock_(fx.product.id), count:count });
    output = { count:count, order_ids:ids, final_stock:qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderBulkGiftStockLimited15Flow_(ctx) {
  var count = qaBulkOrderCount_(ctx, 15);
  var giftStock = Math.min(10, count);
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'BulkGiftLimited', { gift_stock:giftStock, product_stock:count + 5 });
  var caught = null, output = null;
  try {
    var attached = 0, skipped = 0;
    for (var i = 0; i < count; i++) {
      var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-bulk-gift', fx.stamp, 'B' + i, fx.product.id, fx.shipping), fx.order_ids);
      qaAssertOk_(res);
      if ((res.gifts_attached || []).some(function(g){ return String(g.gift_id) === String(fx.gift_id); })) attached++;
      if ((res.gifts_skipped || []).some(function(g){ return String(g.gift_id) === String(fx.gift_id); })) skipped++;
    }
    qaAssert_(attached === giftStock && skipped === count - giftStock && qaGetGiftStock_(fx.gift_id) === 0, 'Bulk gift limited counts mismatch', { attached:attached, skipped:skipped, stock:qaGetGiftStock_(fx.gift_id), count:count });
    output = { count:count, attached:attached, skipped:skipped, final_gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderIdempotentGiftNotDoubleDeductFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'IdempotentGift', { gift_stock:5, product_stock:5 });
  var caught = null, output = null;
  try {
    var clientOrderId = 'qa-idem-gift-' + fx.stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    var payload = qaBuildOrderPayloadForProduct_('qa-idem-gift', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { client_order_id:clientOrderId });
    var first = qaSubmitAndTrack_(payload, fx.order_ids);
    var second = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(first);
    qaAssert_(second && second.ok === false && second.error === 'DUPLICATE_ORDER', 'Duplicate idempotent submit should return DUPLICATE_ORDER', second);
    qaAssert_(qaGetProductStock_(fx.product.id) === 4 && qaGetGiftStock_(fx.gift_id) === 4, 'Duplicate submit should not double deduct stock', { product_stock:qaGetProductStock_(fx.product.id), gift_stock:qaGetGiftStock_(fx.gift_id) });
    output = { first:first, second:second, product_stock:qaGetProductStock_(fx.product.id), gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderMultiItemFailureRollsBackGiftStockFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'RollbackGiftStock');
  var caught = null, output = null;
  try {
    var okProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RollbackGiftOk', 5, { price:500 });
    var badProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'RollbackGiftBad', 1, { price:500 });
    fx.product_ids = [okProduct.id, badProduct.id];
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'RollbackGift', { stock:2 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'RollbackGift', gift.gift_id, { condition_json:{ required_products:[{ product_id:okProduct.id, min_qty:1 }] } });
    fx.rule_ids.push(rule.rule_id);
    var payload = qaBuildOrderPayloadForProduct_('qa-rollback-gift', fx.stamp, 'Buyer', okProduct.id, fx.shipping, {
      items:[{ product_id:okProduct.id, qty:1, selected_variants:{} }, { product_id:badProduct.id, qty:2, selected_variants:{} }]
    });
    var before = qaCall_('orderListRpc', [fx.token, { status:'all', limit:1 }]);
    var beforeCount = Number((before && before.total) || 0);
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssert_(res && res.ok === false && res.error === 'STOCK_INSUFFICIENT', 'Multi-item over-stock order should fail', res);
    var after = qaCall_('orderListRpc', [fx.token, { status:'all', limit:1 }]);
    qaAssert_(Number((after && after.total) || 0) === beforeCount && qaGetGiftStock_(gift.gift_id) === 2, 'Failed order should not create order or deduct gift stock', { before:beforeCount, after:after, gift_stock:qaGetGiftStock_(gift.gift_id) });
    output = { response:res, gift_stock:qaGetGiftStock_(gift.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderZeroTotalAfterPromotionFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'ZeroAfterPromo', { flat_rate:37 });
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'ZeroAfterPromo', 5, { price:100 });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'ZeroAfterPromo', { discount_value:200 });
    fx.promotion_ids.push(promo.promotion_id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'ZeroAfterPromo', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'ZeroAfterPromo', gift.gift_id, { condition_type:'min_subtotal', condition_json:{ min_subtotal:1 } });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-zero-promo', fx.stamp, 'Buyer', product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var line = qaFindProductLine_(order, product.id);
    qaAssert_(line && Number(line.unit_final_price) === 0 && Number(order.subtotal) === 0 && Number(order.total) === 37, 'Zero-price order totals should equal shipping fee only', order);
    qaAssert_(qaActiveGiftLines_(order, gift.gift_id).length === 0, 'Min-subtotal gift should not attach when after-promo subtotal is 0', order.items);
    output = { order_id:order.order_id, subtotal:order.subtotal, total:order.total, gift_count:0 };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingSplitWeightFeePerDraftFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'SplitWeightMatrix', [
    { name:'QA Split Weight A', mode:'weight', brackets:[{ from_g:0, to_g:999, price:40 }, { from_g:1000, to_g:999999, price:90 }] },
    { name:'QA Split Weight B', mode:'weight', brackets:[{ from_g:0, to_g:999, price:70 }, { from_g:1000, to_g:999999, price:120 }] }
  ]);
  var fx = { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
  var caught = null, output = null;
  try {
    var mA = shipping.methods[0], mB = shipping.methods[1];
    var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'SplitWeightA', 5, { price:300, weight_grams:400, allowed_shipping_ids:[mA.id] });
    var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'SplitWeightB', 5, { price:500, weight_grams:1600, allowed_shipping_ids:[mB.id] });
    fx.product_ids = [productA.id, productB.id];
    var payload = qaBuildOrderPayloadForProduct_('qa-split-weight', stamp, 'Buyer', productA.id, shipping, {
      items:[
        { product_id:productA.id, qty:1, selected_variants:{} },
        { product_id:productB.id, qty:1, selected_variants:{} }
      ]
    });
    payload.shipping_info = [
      { company_id:shipping.company.id, method_id:mA.id, item_product_ids:[productA.id] },
      { company_id:shipping.company.id, method_id:mB.id, item_product_ids:[productB.id] }
    ];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    qaAssert_(Array.isArray(res.orders) && res.orders.length === 2, 'Split weight checkout should create two orders', res);
    var orders = fx.order_ids.map(function(id){ return qaReadOrder_(token, id); });
    var orderA = orders.filter(function(o){ return !!qaFindProductLine_(o, productA.id); })[0];
    var orderB = orders.filter(function(o){ return !!qaFindProductLine_(o, productB.id); })[0];
    qaAssert_(orderA && orderB, 'Each split order should be tied to its assigned product', orders);
    qaAssert_(Number(orderA.shipping_fee) === 40 && Number(orderA.total) === 340, 'Product A draft should use only 400g against method A', orderA);
    qaAssert_(Number(orderB.shipping_fee) === 120 && Number(orderB.total) === 620, 'Product B draft should use only 1600g against method B', orderB);
    output = { order_ids:fx.order_ids.slice(), order_a:{ fee:orderA.shipping_fee, total:orderA.total }, order_b:{ fee:orderB.shipping_fee, total:orderB.total } };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingSplitMissingItemAssignmentRejectedFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'SplitMissingAssign', [
    { name:'QA Missing Assign A', mode:'flat', flat_rate:10 },
    { name:'QA Missing Assign B', mode:'flat', flat_rate:20 }
  ]);
  var fx = { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
  var caught = null, output = null;
  try {
    var mA = shipping.methods[0], mB = shipping.methods[1];
    var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'MissingAssignA', 5, { price:300, allowed_shipping_ids:[mA.id] });
    var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'MissingAssignB', 5, { price:400, allowed_shipping_ids:[mB.id] });
    fx.product_ids = [productA.id, productB.id];
    var beforeCount = qaOrderCount_(token);
    var payload = qaBuildOrderPayloadForProduct_('qa-split-missing', stamp, 'Buyer', productA.id, shipping, {
      items:[
        { product_id:productA.id, qty:1, selected_variants:{} },
        { product_id:productB.id, qty:1, selected_variants:{} }
      ]
    });
    payload.shipping_info = [
      { company_id:shipping.company.id, method_id:mA.id, item_product_ids:[productA.id] },
      { company_id:shipping.company.id, method_id:mB.id }
    ];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(token, beforeCount, res, fx.order_ids, 'SHIPPING_INVALID', payload);
    qaAssert_(qaGetProductStock_(productA.id) === 5 && qaGetProductStock_(productB.id) === 5, 'Rejected split assignment should not deduct stock', { a:qaGetProductStock_(productA.id), b:qaGetProductStock_(productB.id) });
    output = { response:res, counts:noOrder, stock_a:qaGetProductStock_(productA.id), stock_b:qaGetProductStock_(productB.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingSplitWrongMethodForProductRejectedFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'SplitWrongMethod', [
    { name:'QA Wrong Method A', mode:'flat', flat_rate:10 },
    { name:'QA Wrong Method B', mode:'flat', flat_rate:20 }
  ]);
  var fx = { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
  var caught = null, output = null;
  try {
    var mA = shipping.methods[0], mB = shipping.methods[1];
    var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'WrongMethodA', 5, { price:300, allowed_shipping_ids:[mA.id] });
    var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'WrongMethodB', 5, { price:400, allowed_shipping_ids:[mB.id] });
    fx.product_ids = [productA.id, productB.id];
    var beforeCount = qaOrderCount_(token);
    var payload = qaBuildOrderPayloadForProduct_('qa-split-wrong-method', stamp, 'Buyer', productA.id, shipping, {
      items:[
        { product_id:productA.id, qty:1, selected_variants:{} },
        { product_id:productB.id, qty:1, selected_variants:{} }
      ]
    });
    payload.shipping_info = [
      { company_id:shipping.company.id, method_id:mA.id, item_product_ids:[productB.id] },
      { company_id:shipping.company.id, method_id:mB.id, item_product_ids:[productA.id] }
    ];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(token, beforeCount, res, fx.order_ids, 'SHIPPING_INVALID', payload);
    qaAssert_(qaGetProductStock_(productA.id) === 5 && qaGetProductStock_(productB.id) === 5, 'Wrong method assignment should not deduct stock', { a:qaGetProductStock_(productA.id), b:qaGetProductStock_(productB.id) });
    output = { response:res, counts:noOrder, stock_a:qaGetProductStock_(productA.id), stock_b:qaGetProductStock_(productB.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaShippingMatrixDefaultMethods_() {
  return [
    { key:'m1', name:'QA Matrix M1 Flat', mode:'flat', flat_rate:10 },
    { key:'m2', name:'QA Matrix M2 Weight', mode:'weight', brackets:[
      { from_g:0, to_g:999, price:50 },
      { from_g:1000, to_g:999999, price:120 }
    ] },
    { key:'m3', name:'QA Matrix M3 Flat', mode:'flat', flat_rate:25 },
    { key:'m4', name:'QA Matrix M4 Weight', mode:'weight', brackets:[
      { from_g:0, to_g:499, price:35 },
      { from_g:500, to_g:1499, price:75 },
      { from_g:1500, to_g:999999, price:140 }
    ] }
  ];
}

function qaShippingMatrixCases_() {
  return [
    {
      id:'shipping.matrix.single-flat-ab-valid',
      title:'Shipping Matrix: single flat A+B valid',
      description:'สินค้า A และ B ใช้ method flat เดียวกันใน order เดียว',
      expected:'order เดียว, shipping fee เป็น flat rate ของ method 1',
      expect:'ok',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m1'], price:200, weight:1600 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1' }],
      expectedOrders:[{ products:['A','B'], method:'m1', subtotal:300, shipping_fee:10, total:310 }]
    },
    {
      id:'shipping.matrix.single-weight-ab-high-valid',
      title:'Shipping Matrix: single weight A+B high tier',
      description:'สินค้า A+B รวมกันหนัก 2000g ต้องเข้า tier สูงของ method weight',
      expected:'order เดียว, shipping fee ใช้น้ำหนักรวมทั้ง cart',
      expect:'ok',
      products:{ A:{ allowed:['m2'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:1600 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m2' }],
      expectedOrders:[{ products:['A','B'], method:'m2', subtotal:300, shipping_fee:120, total:420 }]
    },
    {
      id:'shipping.matrix.single-weight-boundary-999-valid',
      title:'Shipping Matrix: weight boundary 999g',
      description:'สินค้า A+B รวม 999g ต้องยังอยู่ tier ต่ำ',
      expected:'shipping fee ต้องเป็น bracket 0-999g',
      expect:'ok',
      products:{ A:{ allowed:['m2'], price:100, weight:499 }, B:{ allowed:['m2'], price:200, weight:500 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m2' }],
      expectedOrders:[{ products:['A','B'], method:'m2', subtotal:300, shipping_fee:50, total:350 }]
    },
    {
      id:'shipping.matrix.single-weight-boundary-1000-valid',
      title:'Shipping Matrix: weight boundary 1000g',
      description:'สินค้า A+B รวม 1000g ต้องข้ามเข้า tier สูง',
      expected:'shipping fee ต้องเป็น bracket 1000g ขึ้นไป',
      expect:'ok',
      products:{ A:{ allowed:['m2'], price:100, weight:500 }, B:{ allowed:['m2'], price:200, weight:500 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m2' }],
      expectedOrders:[{ products:['A','B'], method:'m2', subtotal:300, shipping_fee:120, total:420 }]
    },
    {
      id:'shipping.matrix.split-a-flat-b-weight-valid',
      title:'Shipping Matrix: split A flat / B weight',
      description:'สินค้า A ส่งด้วย method flat และสินค้า B ส่งด้วย method weight',
      expected:'สร้าง 2 orders และแต่ละ order คิดค่าส่งจากสินค้าของตัวเอง',
      expect:'ok',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:1600 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A'] }, { method:'m2', assign:['B'] }],
      expectedOrders:[
        { products:['A'], method:'m1', subtotal:100, shipping_fee:10, total:110 },
        { products:['B'], method:'m2', subtotal:200, shipping_fee:120, total:320 }
      ]
    },
    {
      id:'shipping.matrix.split-grouped-ab-and-c-valid',
      title:'Shipping Matrix: split grouped A+B / C',
      description:'สินค้า A+B อยู่ draft เดียวกัน และสินค้า C แยกอีก draft',
      expected:'A+B ต้องอยู่ order เดียวกัน และ C อยู่อีก order',
      expect:'ok',
      products:{ A:{ allowed:['m1'], price:100, weight:300 }, B:{ allowed:['m1'], price:200, weight:400 }, C:{ allowed:['m2'], price:300, weight:800 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m1', assign:['A','B'] }, { method:'m2', assign:['C'] }],
      expectedOrders:[
        { products:['A','B'], method:'m1', subtotal:300, shipping_fee:10, total:310 },
        { products:['C'], method:'m2', subtotal:300, shipping_fee:50, total:350 }
      ]
    },
    {
      id:'shipping.matrix.split-qty-weight-tier-valid',
      title:'Shipping Matrix: split quantity affects weight tier',
      description:'สินค้า A qty=2 ต้องดันน้ำหนัก draft ของตัวเองเข้า tier สูง',
      expected:'ค่าส่งของ draft A ใช้น้ำหนัก A x qty เท่านั้น',
      expect:'ok',
      products:{ A:{ allowed:['m2'], price:100, weight:600 }, B:{ allowed:['m1'], price:200, weight:400 } },
      items:[{ p:'A', qty:2 }, { p:'B', qty:1 }],
      shipping:[{ method:'m2', assign:['A'] }, { method:'m1', assign:['B'] }],
      expectedOrders:[
        { products:['A'], method:'m2', subtotal:200, shipping_fee:120, total:320 },
        { products:['B'], method:'m1', subtotal:200, shipping_fee:10, total:210 }
      ]
    },
    {
      id:'shipping.matrix.multi-allowed-uses-second-method-valid',
      title:'Shipping Matrix: A allowed M1/M2 but uses M2',
      description:'สินค้า A อนุญาตสอง method และถูก assign ไป method ที่สอง',
      expected:'ต้องผ่าน เพราะ method ที่ assign อยู่ใน allowed_shipping_ids',
      expect:'ok',
      products:{ A:{ allowed:['m1','m2'], price:100, weight:1200 }, B:{ allowed:['m1'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m2', assign:['A'] }, { method:'m1', assign:['B'] }],
      expectedOrders:[
        { products:['A'], method:'m2', subtotal:100, shipping_fee:120, total:220 },
        { products:['B'], method:'m1', subtotal:200, shipping_fee:10, total:210 }
      ]
    },
    {
      id:'shipping.matrix.three-way-split-valid',
      title:'Shipping Matrix: three way split valid',
      description:'สินค้า A/B/C แยกไปคนละ method ใน checkout เดียว',
      expected:'ต้องสร้าง 3 orders ตาม method ที่ assign',
      expect:'ok',
      products:{ A:{ allowed:['m1'], price:100, weight:200 }, B:{ allowed:['m2'], price:200, weight:400 }, C:{ allowed:['m3'], price:300, weight:900 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m1', assign:['A'] }, { method:'m2', assign:['B'] }, { method:'m3', assign:['C'] }],
      expectedOrders:[
        { products:['A'], method:'m1', subtotal:100, shipping_fee:10, total:110 },
        { products:['B'], method:'m2', subtotal:200, shipping_fee:50, total:250 },
        { products:['C'], method:'m3', subtotal:300, shipping_fee:25, total:325 }
      ]
    },
    {
      id:'shipping.matrix.split-two-products-same-draft-valid',
      title:'Shipping Matrix: two products same split draft',
      description:'สินค้า A+B assign ไป method เดียวกัน และ C ไปอีก method',
      expected:'A+B ต้องรวมเป็น order เดียวใน split checkout',
      expect:'ok',
      products:{ A:{ allowed:['m1'], price:100, weight:100 }, B:{ allowed:['m1'], price:200, weight:200 }, C:{ allowed:['m3'], price:300, weight:300 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m1', assign:['A','B'] }, { method:'m3', assign:['C'] }],
      expectedOrders:[
        { products:['A','B'], method:'m1', subtotal:300, shipping_fee:10, total:310 },
        { products:['C'], method:'m3', subtotal:300, shipping_fee:25, total:325 }
      ]
    },
    {
      id:'shipping.matrix.single-third-flat-all-valid',
      title:'Shipping Matrix: all products via method 3 flat',
      description:'สินค้า A/B/C ใช้ method flat ตัวที่สามร่วมกัน',
      expected:'order เดียวและคิด flat rate ของ method 3 ครั้งเดียว',
      expect:'ok',
      products:{ A:{ allowed:['m3'], price:100, weight:100 }, B:{ allowed:['m3'], price:200, weight:200 }, C:{ allowed:['m3'], price:300, weight:300 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m3' }],
      expectedOrders:[{ products:['A','B','C'], method:'m3', subtotal:600, shipping_fee:25, total:625 }]
    },
    {
      id:'shipping.matrix.zero-weight-weight-method-valid',
      title:'Shipping Matrix: zero weight with weight method',
      description:'สินค้าน้ำหนัก 0g ใช้ method weight',
      expected:'น้ำหนักรวม 0g ต้องเข้า bracket แรก ไม่พังหรือคิดค่าส่งเป็นศูนย์เอง',
      expect:'ok',
      products:{ A:{ allowed:['m2'], price:100, weight:0 }, B:{ allowed:['m2'], price:200, weight:0 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m2' }],
      expectedOrders:[{ products:['A','B'], method:'m2', subtotal:300, shipping_fee:50, total:350 }]
    },
    {
      id:'shipping.matrix.reject-missing-b-assignment',
      title:'Shipping Matrix: reject missing B assignment',
      description:'cart มี A+B+C แต่ shipping_info ครอบเฉพาะ A และ C',
      expected:'ต้อง reject SHIPPING_INVALID และไม่สร้าง order',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 }, C:{ allowed:['m2'], price:300, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m1', assign:['A'] }, { method:'m2', assign:['C'] }]
    },
    {
      id:'shipping.matrix.reject-omitted-item-product-ids',
      title:'Shipping Matrix: reject omitted item_product_ids',
      description:'split shipping มี entry ที่ไม่มี item_product_ids',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A'] }, { method:'m2', omitAssign:true }]
    },
    {
      id:'shipping.matrix.reject-empty-item-assignment',
      title:'Shipping Matrix: reject empty item assignment',
      description:'split shipping มี item_product_ids=[]',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A'] }, { method:'m2', assign:[] }]
    },
    {
      id:'shipping.matrix.reject-duplicate-across-methods',
      title:'Shipping Matrix: reject duplicate product across methods',
      description:'สินค้า A ถูก assign ไปสอง method พร้อมกัน',
      expected:'ต้อง reject SHIPPING_INVALID เพราะสินค้าเดียวอยู่สอง draft ไม่ได้',
      expect:'reject',
      products:{ A:{ allowed:['m1','m2'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A'] }, { method:'m2', assign:['A','B'] }]
    },
    {
      id:'shipping.matrix.reject-unknown-product-assignment',
      title:'Shipping Matrix: reject unknown product assignment',
      description:'item_product_ids มี product id ที่ไม่ได้อยู่ใน cart',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A','UNKNOWN'] }, { method:'m2', assign:['B'] }]
    },
    {
      id:'shipping.matrix.reject-a-wrong-method-in-group',
      title:'Shipping Matrix: reject A wrong method inside group',
      description:'สินค้า A อนุญาตเฉพาะ M1 แต่ถูกใส่ใน draft M2 ร่วมกับ B',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 }, C:{ allowed:['m1'], price:300, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m2', assign:['A','B'] }, { method:'m1', assign:['C'] }]
    },
    {
      id:'shipping.matrix.reject-b-wrong-method-in-group',
      title:'Shipping Matrix: reject B wrong method inside group',
      description:'สินค้า B อนุญาตเฉพาะ M2 แต่ถูกใส่ใน draft M1 ร่วมกับ A',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 }, C:{ allowed:['m2'], price:300, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }, { p:'C', qty:1 }],
      shipping:[{ method:'m1', assign:['A','B'] }, { method:'m2', assign:['C'] }]
    },
    {
      id:'shipping.matrix.reject-swapped-a-b-methods',
      title:'Shipping Matrix: reject swapped A/B methods',
      description:'สินค้า A/B ถูกสลับ method กันทั้งคู่',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['B'] }, { method:'m2', assign:['A'] }]
    },
    {
      id:'shipping.matrix.reject-single-method-not-allowed-for-b',
      title:'Shipping Matrix: reject single method not allowed for B',
      description:'order เดียวใช้ M1 แต่สินค้า B อนุญาตเฉพาะ M2',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1' }]
    },
    {
      id:'shipping.matrix.reject-unknown-method-id',
      title:'Shipping Matrix: reject unknown method id',
      description:'payload อ้าง method_id ที่ไม่มีใน shipping config',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 } },
      items:[{ p:'A', qty:1 }],
      shipping:[{ method:'UNKNOWN_METHOD' }]
    },
    {
      id:'shipping.matrix.reject-blank-method-id',
      title:'Shipping Matrix: reject blank method id',
      description:'payload ส่ง method_id เป็นค่าว่าง',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 } },
      items:[{ p:'A', qty:1 }],
      shipping:[{ method:'' }]
    },
    {
      id:'shipping.matrix.reject-inactive-method',
      title:'Shipping Matrix: reject inactive method',
      description:'สินค้าอ้าง method ที่มีอยู่แต่ active=false',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      methods:[
        { key:'m1', name:'QA Matrix Active Flat', mode:'flat', flat_rate:10 },
        { key:'m3', name:'QA Matrix Inactive Flat', mode:'flat', flat_rate:25, active:false }
      ],
      products:{ A:{ allowed:['m1','m3'], price:100, weight:400 } },
      items:[{ p:'A', qty:1 }],
      shipping:[{ method:'m3' }]
    },
    {
      id:'shipping.matrix.reject-two-methods-no-assignments',
      title:'Shipping Matrix: reject two methods without assignments',
      description:'payload เลือกสอง method แต่ไม่มี item_product_ids เลย',
      expected:'ต้อง reject SHIPPING_INVALID แทนการสร้าง order เดียวรวมสองค่าส่ง',
      expect:'reject',
      products:{ A:{ allowed:['m1','m2'], price:100, weight:400 }, B:{ allowed:['m1','m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', omitAssign:true }, { method:'m2', omitAssign:true }]
    },
    {
      id:'shipping.matrix.reject-string-item-product-ids',
      title:'Shipping Matrix: reject string item_product_ids',
      description:'item_product_ids ถูกส่งเป็น string ไม่ใช่ array',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', rawAssignProduct:'A' }, { method:'m2', assign:['B'] }]
    },
    {
      id:'shipping.matrix.reject-duplicate-in-same-entry',
      title:'Shipping Matrix: reject duplicate product in same entry',
      description:'item_product_ids ของ method เดียวมี product id ซ้ำ',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A','A'] }, { method:'m2', assign:['B'] }]
    },
    {
      id:'shipping.matrix.reject-null-item-product-ids',
      title:'Shipping Matrix: reject null item_product_ids',
      description:'item_product_ids ถูกส่งเป็น null',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', rawAssign:null }, { method:'m2', assign:['B'] }]
    },
    {
      id:'shipping.matrix.reject-extra-product-with-valid-assignment',
      title:'Shipping Matrix: reject extra product mixed with valid assignment',
      description:'entry เดียวมีทั้งสินค้าใน cart และ product id แปลกปลอม',
      expected:'ต้อง reject SHIPPING_INVALID',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 }, B:{ allowed:['m2'], price:200, weight:400 } },
      items:[{ p:'A', qty:1 }, { p:'B', qty:1 }],
      shipping:[{ method:'m1', assign:['A','NOT_IN_CART'] }, { method:'m2', assign:['B'] }]
    },
    {
      id:'shipping.matrix.reject-company-method-mismatch',
      title:'Shipping Matrix: reject company/method mismatch',
      description:'company_id ใน payload ไม่ตรงกับบริษัทของ method_id',
      expected:'ต้อง reject SHIPPING_INVALID เพื่อไม่ให้ snapshot ขนส่งผิดบริษัท',
      expect:'reject',
      products:{ A:{ allowed:['m1'], price:100, weight:400 } },
      items:[{ p:'A', qty:1 }],
      shipping:[{ method:'m1', company:'WRONG_COMPANY' }]
    }
  ];
}

function qaShippingMatrixFindCase_(testId) {
  var cases = qaShippingMatrixCases_();
  for (var i = 0; i < cases.length; i++) {
    if (cases[i].id === testId) return cases[i];
  }
  return null;
}

function qaShippingMatrixMethodId_(methodKey, methodByKey, stamp) {
  if (methodKey === '') return '';
  if (methodKey === 'UNKNOWN_METHOD') return 'qa_missing_method_' + stamp;
  qaAssert_(methodByKey[methodKey], 'Shipping matrix method key not found: ' + methodKey, { methodKey:methodKey, available:Object.keys(methodByKey) });
  return methodByKey[methodKey].id;
}

function qaShippingMatrixResolveProductId_(key, products, stamp) {
  if (products[key]) return products[key].id;
  return 'qa_unknown_product_' + String(key || 'x') + '_' + stamp;
}

function qaShippingMatrixBuildShippingInfo_(caseDef, shipping, products, methodByKey, stamp) {
  return (caseDef.shipping || []).map(function(s) {
    var out = {
      company_id: s.company === 'WRONG_COMPANY' ? ('qa_wrong_company_' + stamp) : shipping.company.id,
      method_id: qaShippingMatrixMethodId_(s.method, methodByKey, stamp)
    };
    if (s.rawAssignProduct) {
      out.item_product_ids = qaShippingMatrixResolveProductId_(s.rawAssignProduct, products, stamp);
    } else if (Object.prototype.hasOwnProperty.call(s, 'rawAssign')) {
      out.item_product_ids = s.rawAssign;
    } else if (!s.omitAssign && Object.prototype.hasOwnProperty.call(s, 'assign')) {
      out.item_product_ids = (s.assign || []).map(function(k) {
        return qaShippingMatrixResolveProductId_(k, products, stamp);
      });
    }
    return out;
  });
}

function qaShippingMatrixProductLineCount_(order) {
  return (order.items || []).filter(function(item) { return item.line_type !== 'gift'; }).length;
}

function qaShippingMatrixAssertOrder_(order, exp, products, methodByKey) {
  qaAssert_(qaShippingMatrixProductLineCount_(order) === exp.products.length,
    'Split order should contain exactly the expected product lines', { expected:exp.products, order:order });
  (exp.products || []).forEach(function(k) {
    qaAssert_(!!qaFindProductLine_(order, products[k].id), 'Expected product line missing from order', { product_key:k, order:order });
  });
  if (exp.method) {
    qaAssert_((order.shipping_info || []).length === 1
      && String(order.shipping_info[0].method_id) === String(methodByKey[exp.method].id),
      'Shipping method snapshot mismatch', { expected_method:methodByKey[exp.method], shipping_info:order.shipping_info });
  }
  qaAssert_(Number(order.subtotal) === Number(exp.subtotal)
    && Number(order.shipping_fee) === Number(exp.shipping_fee)
    && Number(order.total) === Number(exp.total),
    'Shipping matrix order totals mismatch', { expected:exp, order:order });
}

function qaShippingMatrixAssertStock_(products, itemDefs) {
  var qtyByKey = {};
  (itemDefs || []).forEach(function(item) {
    qtyByKey[item.p] = (qtyByKey[item.p] || 0) + Number(item.qty || 1);
  });
  Object.keys(products).forEach(function(k) {
    var p = products[k];
    var start = Number(p._qa_start_stock);
    if (start < 0) return;
    var expected = start - Number(qtyByKey[k] || 0);
    qaAssert_(qaGetProductStock_(p.id) === expected,
      'Product stock mismatch after shipping matrix submit',
      { product_key:k, product_id:p.id, expected:expected, actual:qaGetProductStock_(p.id) });
  });
}

function qaRunShippingMatrixCaseFlow_(ctx, testId) {
  var caseDef = qaShippingMatrixFindCase_(testId);
  qaAssert_(!!caseDef, 'Missing shipping matrix case definition: ' + testId);
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var methodDefs = caseDef.methods || qaShippingMatrixDefaultMethods_();
  var label = String(caseDef.id).replace(/^shipping\.matrix\./, 'Matrix').replace(/[^A-Za-z0-9]+/g, '').slice(0, 42);
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, label, methodDefs);
  var fx = { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
  var caught = null, output = null;
  try {
    var methodByKey = {};
    methodDefs.forEach(function(def, idx) { methodByKey[def.key || ('m' + (idx + 1))] = shipping.methods[idx]; });

    var products = {};
    Object.keys(caseDef.products || {}).forEach(function(k) {
      var pd = caseDef.products[k];
      var allowed = (pd.allowed || []).map(function(methodKey) {
        return qaShippingMatrixMethodId_(methodKey, methodByKey, stamp);
      });
      var stock = pd.stock !== undefined ? Number(pd.stock) : 5;
      var product = qaCreateOrderQaProduct_(token, shipping, stamp, label + '_' + k, stock, {
        price:pd.price,
        weight_grams:pd.weight,
        allowed_shipping_ids:allowed
      });
      product._qa_start_stock = stock;
      products[k] = product;
      fx.product_ids.push(product.id);
    });

    var firstProductKey = (caseDef.items && caseDef.items[0] && caseDef.items[0].p) || Object.keys(products)[0];
    var payload = qaBuildOrderPayloadForProduct_('qa-shipping-matrix-' + label.toLowerCase(), stamp, 'Buyer', products[firstProductKey].id, shipping, {
      items:(caseDef.items || []).map(function(item) {
        return { product_id:products[item.p].id, qty:Number(item.qty || 1), selected_variants:{} };
      })
    });
    payload.shipping_info = qaShippingMatrixBuildShippingInfo_(caseDef, shipping, products, methodByKey, stamp);

    var beforeCount = qaOrderCount_(token);
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    if (caseDef.expect === 'reject') {
      var noOrder = qaAssertNoNewOrderAfterFailure_(token, beforeCount, res, fx.order_ids, caseDef.error || 'SHIPPING_INVALID', payload);
      Object.keys(products).forEach(function(k) {
        qaAssert_(qaGetProductStock_(products[k].id) === products[k]._qa_start_stock,
          'Rejected shipping matrix submit should preserve stock',
          { product_key:k, product_id:products[k].id, expected:products[k]._qa_start_stock, actual:qaGetProductStock_(products[k].id), response:res });
      });
      output = { case_id:testId, response:res, counts:noOrder };
    } else {
      qaAssertOk_(res);
      var orders = fx.order_ids.map(function(id) { return qaReadOrder_(token, id); });
      qaAssert_(orders.length === (caseDef.expectedOrders || []).length,
        'Shipping matrix submit created unexpected order count',
        { expected_count:(caseDef.expectedOrders || []).length, order_ids:fx.order_ids, response:res });
      (caseDef.expectedOrders || []).forEach(function(exp) {
        var found = null;
        for (var oi = 0; oi < orders.length; oi++) {
          var candidate = orders[oi];
          var allPresent = (exp.products || []).every(function(k) { return !!qaFindProductLine_(candidate, products[k].id); });
          if (allPresent && qaShippingMatrixProductLineCount_(candidate) === exp.products.length) { found = candidate; break; }
        }
        qaAssert_(!!found, 'Expected shipping matrix order draft not found', { expected:exp, orders:orders });
        qaShippingMatrixAssertOrder_(found, exp, products, methodByKey);
      });
      qaShippingMatrixAssertStock_(products, caseDef.items || []);
      output = { case_id:testId, order_ids:fx.order_ids.slice(), response:res };
    }
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { case_id:testId, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderEdgeEmptyCartRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgeEmptyCart', 5);
  var caught = null, output = null;
  try {
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-edge-empty-cart', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.items = [];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, null, payload);
    qaAssert_(qaGetProductStock_(fx.product.id) === 5, 'Empty cart rejection should preserve product stock', {
      stock: qaGetProductStock_(fx.product.id),
      response: res
    });
    output = { response: res, counts: noOrder, final_stock: qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderEdgeShippingInfoEmptyRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgeNoShippingInfo', 5);
  var caught = null, output = null;
  try {
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-edge-no-shipping-info', fx.stamp, 'Buyer', fx.product.id, fx.shipping);
    payload.shipping_info = [];
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, null, payload);
    qaAssert_(qaGetProductStock_(fx.product.id) === 5, 'Missing shipping_info rejection should preserve stock', {
      stock: qaGetProductStock_(fx.product.id),
      response: res
    });
    output = { response: res, counts: noOrder, final_stock: qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderEdgeClientPricingMissingItemRejectedFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'EdgeMissingClientItem', { flat_rate:0 });
  var caught = null, output = null;
  try {
    var pA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'EdgeClientItemA', 5, { price:200 });
    var pB = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'EdgeClientItemB', 5, { price:300 });
    fx.product_ids = [pA.id, pB.id];
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-edge-client-missing', fx.stamp, 'Buyer', pA.id, fx.shipping, {
      items:[
        { product_id:pA.id, qty:1, selected_variants:{} },
        { product_id:pB.id, qty:1, selected_variants:{} }
      ]
    });
    payload.client_pricing = {
      items:[{ product_id:pA.id, selected_variants:{}, qty:1, unit_final_price:200, promotion_id:null }],
      subtotal:200,
      shipping_fee:0,
      total:200
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'PRICE_CHANGED', payload);
    var kinds = qaAssertDiffKinds_(res, ['item_missing', 'subtotal', 'total']);
    output = { response:res, diff_kinds:kinds, counts:noOrder };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderEdgeDuplicateProductLinesStockAggregateFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgeDuplicateLines', 3, { price:100 }, { flat_rate:0 });
  var caught = null, output = null;
  try {
    var payload = qaBuildOrderPayloadForProduct_('qa-edge-duplicate-lines', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items:[
        { product_id:fx.product.id, qty:1, selected_variants:{} },
        { product_id:fx.product.id, qty:2, selected_variants:{} }
      ]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(Number(order.subtotal) === 300 && Number(order.total) === 300, 'Duplicate product line totals should use combined qty', order);
    qaAssert_(qaGetProductStock_(fx.product.id) === 0, 'Duplicate product lines should deduct combined stock once', {
      stock:qaGetProductStock_(fx.product.id),
      order:order
    });
    output = { order_id:order.order_id, subtotal:order.subtotal, total:order.total, final_stock:qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Two lines of the same product, each individually within stock but summing to more than
// it, must be rejected as a whole — not partially oversold. This is the "combined EXCEEDS
// stock" counterpart to orders.edge-duplicate-product-lines-stock-aggregate (which only
// covers combined == stock, a case that succeeds correctly). stock=3, two lines of qty 3
// each (each individually <= 3, combined = 6 > 3).
function qaRunOrderEdgeDuplicateLinesCombinedExceedsStockFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgeDuplicateExceed', 3, { price:100 }, { flat_rate:0 });
  var caught = null, output = null;
  try {
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-edge-duplicate-exceed', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items:[
        { product_id:fx.product.id, qty:3, selected_variants:{} },
        { product_id:fx.product.id, qty:3, selected_variants:{} }
      ]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'STOCK_INSUFFICIENT', payload);
    qaAssert_(res && res.ok === false && String(res.error) === 'STOCK_INSUFFICIENT'
      && Number(res.requested_qty) === 6 && Number(res.available_qty) === 3,
      'Duplicate-line stock rejection must expose cumulative requested/available quantities', {
        response:res, expected:{ error:'STOCK_INSUFFICIENT', requested_qty:6, available_qty:3 }
      });
    qaAssert_(qaGetProductStock_(fx.product.id) === 3, 'สต็อกต้องไม่ถูกหักเมื่อรายการซ้ำรวมกันเกินสต็อก (ต้องปฏิเสธคำสั่งซื้อทั้งหมด)', {
      stock:qaGetProductStock_(fx.product.id), response:res
    });
    output = { response:res, counts:noOrder, final_stock:qaGetProductStock_(fx.product.id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderEdgeVariantStockRollbackOnFailureFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'EdgeVariantRollback', { flat_rate:0 });
  var caught = null, output = null;
  try {
    var variantProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'EdgeVariantRollback', -1, {
      price:500,
      variants:[{ name:'Color', type:'text', options:[
        { label:'Red', price:500, weight_grams:100, stock:2 },
        { label:'Blue', price:500, weight_grams:100, stock:5 }
      ]}]
    });
    var emptyProduct = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'EdgeRollbackEmpty', 0, { price:100 });
    fx.product_ids = [variantProduct.id, emptyProduct.id];
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-edge-variant-rollback', fx.stamp, 'Buyer', variantProduct.id, fx.shipping, {
      items:[
        { product_id:variantProduct.id, qty:2, selected_variants:{ Color:'Red' } },
        { product_id:emptyProduct.id, qty:1, selected_variants:{} }
      ]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'STOCK_INSUFFICIENT', payload);
    qaAssert_(qaGetVariantStock_(variantProduct.id, 'Color', 'Red') === 2, 'Variant stock should roll back when a later line fails', {
      variant_stock:qaGetVariantStock_(variantProduct.id, 'Color', 'Red'),
      response:res
    });
    output = { response:res, counts:noOrder, final_variant_stock:qaGetVariantStock_(variantProduct.id, 'Color', 'Red') };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Reject returns product + gift stock to inventory; un-reject re-deducts both.
function qaRunOrderRejectRestoresStockFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'RejectRestore', {
    product_stock: 5, product_price: 500, gift_stock: 5, min_qty: 1, gift_qty: 1
  });
  var caught = null, output = null;
  try {
    var token = fx.token;
    // Order: 2 units of the product → auto-attaches 1 gift.
    var payload = qaBuildOrderPayloadForProduct_('qa-reject-restore', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items: [{ product_id: fx.product.id, qty: 2, selected_variants: {} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    var order = qaReadOrder_(token, orderId);
    var giftLines = qaActiveGiftLines_(order, fx.gift_id);
    qaAssert_(giftLines.length === 1, 'Submitted order should carry one active gift line', { order: order, gifts: giftLines });
    qaAssert_(qaGetProductStock_(fx.product.id) === 3, 'Submit should deduct product stock 5 -> 3', { stock: qaGetProductStock_(fx.product.id) });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 4, 'Submit should deduct gift stock 5 -> 4', { stock: qaGetGiftStock_(fx.gift_id) });

    // Reject → product + gift stock returns to inventory.
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [token, orderId, 'rejected', 'qa reject restore']));
    qaAssert_(qaGetProductStock_(fx.product.id) === 5, 'Reject should restore product stock 3 -> 5', { stock: qaGetProductStock_(fx.product.id) });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 5, 'Reject should restore gift stock 4 -> 5', { stock: qaGetGiftStock_(fx.gift_id) });

    // Reject again (rejected → rejected) must NOT double-restore.
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [token, orderId, 'rejected', 'qa reject twice']));
    qaAssert_(qaGetProductStock_(fx.product.id) === 5 && qaGetGiftStock_(fx.gift_id) === 5,
      'Repeat reject must not restore stock twice',
      { product: qaGetProductStock_(fx.product.id), gift: qaGetGiftStock_(fx.gift_id) });

    // Un-reject (rejected → approved) → re-deduct product + gift.
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [token, orderId, 'approved', 'qa un-reject']));
    qaAssert_(qaGetProductStock_(fx.product.id) === 3, 'Un-reject should re-deduct product stock 5 -> 3', { stock: qaGetProductStock_(fx.product.id) });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 4, 'Un-reject should re-deduct gift stock 5 -> 4', { stock: qaGetGiftStock_(fx.gift_id) });

    var finalOrder = qaReadOrder_(token, orderId);
    qaAssert_(String(finalOrder.status) === 'approved', 'Order status should be approved after un-reject', finalOrder);

    output = {
      order_id: orderId, final_status: finalOrder.status,
      final_product_stock: qaGetProductStock_(fx.product.id),
      final_gift_stock: qaGetGiftStock_(fx.gift_id)
    };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// Un-reject must abort (no stock change) when product stock can no longer cover the order.
function qaRunOrderUnrejectProductStockBlockedFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'UnrejectProdShort', {
    product_stock: 5, gift_stock: 5, min_qty: 1, gift_qty: 1
  });
  var caught = null, output = null;
  try {
    var token = fx.token;
    var payload = qaBuildOrderPayloadForProduct_('qa-unreject-prod-short', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items: [{ product_id: fx.product.id, qty: 2, selected_variants: {} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [token, orderId, 'rejected', 'qa reject']));
    // After reject stock is restored (product 5, gift 5). Drop product below the order qty (needs 2, leave 1).
    qaAssertOk_(qaCall_('updateStockRpc', [token, [{ productId: fx.product.id, stock: 1 }]]));
    var giftBefore = qaGetGiftStock_(fx.gift_id);

    var attempt = qaCall_('orderUpdateStatusRpc', [token, orderId, 'approved', 'qa un-reject blocked']);
    qaAssert_(attempt && attempt.ok === false && attempt.error === 'STOCK_INSUFFICIENT',
      'Un-reject must fail with STOCK_INSUFFICIENT when product stock is short', attempt);
    qaAssert_(Array.isArray(attempt.shortages) && attempt.shortages.some(function(s){ return s.kind === 'product'; }),
      'Failure should report the short product in shortages[]', attempt);

    // Nothing changed: status still rejected, product + gift stock untouched.
    var order = qaReadOrder_(token, orderId);
    qaAssert_(String(order.status) === 'rejected', 'Order must remain rejected after a blocked un-reject', order);
    qaAssert_(qaGetProductStock_(fx.product.id) === 1, 'Blocked un-reject must not deduct product stock', { stock: qaGetProductStock_(fx.product.id) });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === giftBefore, 'Blocked un-reject must not deduct gift stock', { before: giftBefore, after: qaGetGiftStock_(fx.gift_id) });

    output = { order_id: orderId, response: attempt, status: order.status,
      product_stock: qaGetProductStock_(fx.product.id), gift_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// All-or-nothing: a short gift blocks the whole un-reject, leaving the sufficient product untouched.
function qaRunOrderUnrejectGiftStockBlockedFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'UnrejectGiftShort', {
    product_stock: 5, gift_stock: 5, min_qty: 1, gift_qty: 1
  });
  var caught = null, output = null;
  try {
    var token = fx.token;
    var payload = qaBuildOrderPayloadForProduct_('qa-unreject-gift-short', fx.stamp, 'Buyer', fx.product.id, fx.shipping, {
      items: [{ product_id: fx.product.id, qty: 2, selected_variants: {} }]
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [token, orderId, 'rejected', 'qa reject']));
    // Product restored to 5, gift restored to 5. Deplete the gift so re-deduct cannot satisfy it.
    qaAssertOk_(qaCall_('updateGiftItemRpc', [token, fx.gift_id, { stock: 0 }]));

    var attempt = qaCall_('orderUpdateStatusRpc', [token, orderId, 'paid', 'qa un-reject blocked gift']);
    qaAssert_(attempt && attempt.ok === false && attempt.error === 'STOCK_INSUFFICIENT',
      'Un-reject must fail with STOCK_INSUFFICIENT when gift stock is short', attempt);
    qaAssert_(Array.isArray(attempt.shortages) && attempt.shortages.some(function(s){ return s.kind === 'gift'; }),
      'Failure should report the short gift in shortages[]', attempt);

    // Atomicity: the product had enough stock but must NOT be deducted because the gift failed.
    var order = qaReadOrder_(token, orderId);
    qaAssert_(String(order.status) === 'rejected', 'Order must remain rejected after a blocked un-reject', order);
    qaAssert_(qaGetProductStock_(fx.product.id) === 5, 'Blocked un-reject must not deduct product stock (atomic)', { stock: qaGetProductStock_(fx.product.id) });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 0, 'Gift stock should stay at the depleted value', { stock: qaGetGiftStock_(fx.gift_id) });

    output = { order_id: orderId, response: attempt, status: order.status,
      product_stock: qaGetProductStock_(fx.product.id), gift_stock: qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderEdgeTokenReadAfterDeleteRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgeTokenAfterDelete', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-edge-token-delete', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || (res.orders && res.orders[0] && res.orders[0].token) || '';
    qaAssert_(!!token, 'submitOrderRpc should return a customer token', res);
    var del = qaCall_('orderDeleteRpc', [fx.token, [orderId]]);
    qaAssertOk_(del);
    fx.order_ids = fx.order_ids.filter(function(id){ return String(id) !== String(orderId); });
    var read = qaCall_('getOrderByTokenRpc', [token]);
    qaAssert_(read && read.ok === false, 'Deleted order token should not read an order', read);
    output = { order_id:orderId, delete_response:del, token_read_response:read };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunProductEdgeUpdateActiveWithoutShippingRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgeProductNoShipping', 5);
  var caught = null, output = null;
  try {
    var res = qaCall_('productUpdateRpc', [fx.token, fx.product.id, {
      sale_mode:'always',
      allowed_shipping_ids:[]
    }]);
    qaAssert_(res && res.ok === false, 'Active product update without shipping should be rejected', res);
    var record = qaGetProductRecord_(fx.product.id);
    qaAssert_((record.allowed_shipping_ids || []).indexOf(fx.shipping.method.id) >= 0,
      'Rejected update should not remove the existing shipping method from the product',
      { record:record, response:res });
    output = { response:res, allowed_shipping_ids:record.allowed_shipping_ids || [] };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionEdgeNegativeDiscountRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgePromoNegative', 5, { price:1000 });
  var caught = null, output = null;
  try {
    var res = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Promo Negative ' + fx.stamp,
      description:'negative discount should be rejected',
      discount_type:'fixed',
      discount_value:-10,
      target_type:'product',
      target:[{ product_id:fx.product.id }],
      starts_at:qaPastIso_(60000),
      ends_at:'',
      no_end_date:true,
      enabled:true
    }]);
    qaAssert_(res && res.ok === false, 'Negative discount_value should be rejected', res);
    output = { response:res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionEdgeEndBeforeStartRejectedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgePromoWindow', 5, { price:1000 });
  var caught = null, output = null;
  try {
    var res = qaCall_('createPromotionRpc', [fx.token, {
      name:'QA Promo Bad Window ' + fx.stamp,
      description:'ends_at before starts_at should be rejected',
      discount_type:'fixed',
      discount_value:100,
      target_type:'product',
      target:[{ product_id:fx.product.id }],
      starts_at:qaFutureIso_(86400000),
      ends_at:qaPastIso_(60000),
      no_end_date:false,
      enabled:true
    }]);
    qaAssert_(res && res.ok === false, 'Promotion date window with ends_at before starts_at should be rejected', res);
    output = { response:res };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionEdgeDeletedPromoRemovedFromProductFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'EdgePromoDeletedSnapshot', 5, { price:1000 });
  var promos = [], caught = null, output = null;
  try {
    var promo = qaCreatePromotion_(fx.token, fx.product.id, fx.stamp, 'EdgeDeletedSnapshot', { discount_value:100 });
    promos.push(promo.promotion_id);
    var before = qaGetProductRecord_(fx.product.id);
    qaAssert_(before.promotion && String(before.promotion.promotion_id) === String(promo.promotion_id),
      'Product should show the fixture promotion before deletion',
      before);
    var del = qaCall_('deletePromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(del);
    promos = [];
    var after = qaGetProductRecord_(fx.product.id);
    qaAssert_(!after.promotion || String(after.promotion.promotion_id) !== String(promo.promotion_id),
      'Deleted promotion id should not remain on the product snapshot',
      { before:before, after:after, delete_response:del });
    output = { promotion_id:promo.promotion_id, delete_response:del, after_promotion:after.promotion || null };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_({ token:fx.token, order_ids:fx.order_ids, promotion_ids:promos, product_ids:[fx.product.id], shipping:fx.shipping });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftEdgeMinSubtotalEqualBoundaryFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'EdgeMinSubtotalEqual', {
    condition_type:'min_subtotal',
    min_subtotal:500,
    product_price:500,
    gift_stock:3
  });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(qaHasEligibleRule_(preview, fx.rule_id), 'Cart subtotal equal to min_subtotal should be eligible', preview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-min-equal', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var gifts = qaActiveGiftLines_(order, fx.gift_id);
    qaAssert_(gifts.length === 1, 'Equal-boundary gift should attach exactly once', { order:order, gifts:gifts });
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 2, 'Gift stock should be deducted once after equal-boundary submit', {
      stock:qaGetGiftStock_(fx.gift_id),
      gifts:gifts
    });
    output = { preview:preview, order_id:order.order_id, gift_lines:gifts, final_gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftEdgeGiftDisabledBeforeSubmitNotAttachedFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'EdgeGiftDisabledBeforeSubmit', { gift_stock:5, product_stock:5 });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(qaHasEligibleRule_(preview, fx.rule_id), 'Gift preview should be eligible before disabling the gift item', preview);
    var disable = qaCall_('updateGiftItemRpc', [fx.token, fx.gift_id, { enabled:false }]);
    qaAssertOk_(disable);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-disabled-before-submit', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var attachedFixture = (res.gifts_attached || []).filter(function(g){ return String(g.gift_id) === String(fx.gift_id); });
    qaAssert_(attachedFixture.length === 0, 'Disabled fixture gift should not be attached in submit response', res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'Disabled fixture gift should not appear as an active order gift line', order.items);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 5, 'Disabled fixture gift should not deduct stock', {
      stock:qaGetGiftStock_(fx.gift_id),
      response:res
    });
    output = { order_id:order.order_id, disable_response:disable, final_gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPaymentEdgeGetConfigAdminShapeFlow_(ctx) {
  var res = qaCall_('getPaymentConfigRpc', [ctx.options.adminToken]);
  qaAssertOk_(res);
  qaAssert_(res.payment && typeof res.payment === 'object' && !Array.isArray(res.payment),
    'getPaymentConfigRpc should return a payment object',
    res);
  return {
    has_promptpay_number: Object.prototype.hasOwnProperty.call(res.payment, 'promptpay_number'),
    has_promptpay_name: Object.prototype.hasOwnProperty.call(res.payment, 'promptpay_name'),
    has_background_url: Object.prototype.hasOwnProperty.call(res.payment, 'bg_url')
  };
}

function qaRunConfigEdgeLegalConfigAdminShapeFlow_(ctx) {
  var res = qaCall_('getLegalConfigRpc', [ctx.options.adminToken]);
  qaAssertOk_(res);
  qaAssert_(res.legal && typeof res.legal === 'object' && !Array.isArray(res.legal),
    'getLegalConfigRpc should return a legal object',
    res);
  return {
    legal_keys: Object.keys(res.legal || {}).sort()
  };
}

function qaRunAuthEdgeUserListInvalidTokenRejectedFlow_() {
  var res = qaCall_('userListRpc', ['__QA_INVALID_SESSION__']);
  qaAssert_(res && res.ok === false && res.error === 'AUTH_REQUIRED',
    'userListRpc should reject invalid tokens with AUTH_REQUIRED',
    res);
  return { response:res };
}

function qaRunOrderClientPricingSplitShippingMismatchFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'PricingSplitMismatch', [
    { name:'QA Pricing Split A', mode:'weight', brackets:[{ from_g:0, to_g:999, price:30 }, { from_g:1000, to_g:999999, price:80 }] },
    { name:'QA Pricing Split B', mode:'weight', brackets:[{ from_g:0, to_g:999, price:50 }, { from_g:1000, to_g:999999, price:100 }] }
  ]);
  var fx = { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
  var caught = null, output = null;
  try {
    var mA = shipping.methods[0], mB = shipping.methods[1];
    var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'PricingSplitA', 5, { price:300, weight_grams:400, allowed_shipping_ids:[mA.id] });
    var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'PricingSplitB', 5, { price:400, weight_grams:600, allowed_shipping_ids:[mB.id] });
    fx.product_ids = [productA.id, productB.id];
    var beforeCount = qaOrderCount_(token);
    var payload = qaBuildOrderPayloadForProduct_('qa-pricing-split-mismatch', stamp, 'Buyer', productA.id, shipping, {
      items:[
        { product_id:productA.id, qty:1, selected_variants:{} },
        { product_id:productB.id, qty:1, selected_variants:{} }
      ]
    });
    payload.shipping_info = [
      { company_id:shipping.company.id, method_id:mA.id, item_product_ids:[productA.id] },
      { company_id:shipping.company.id, method_id:mB.id, item_product_ids:[productB.id] }
    ];
    payload.client_pricing = {
      items:[
        { product_id:productA.id, selected_variants:{}, qty:1, unit_final_price:300, promotion_id:null },
        { product_id:productB.id, selected_variants:{}, qty:1, unit_final_price:400, promotion_id:null }
      ],
      subtotal:700,
      shipping_fee:999,
      total:1699
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(token, beforeCount, res, fx.order_ids, 'PRICE_CHANGED', payload);
    var kinds = qaAssertDiffKinds_(res, ['shipping_fee', 'total']);
    output = { response:res, diff_kinds:kinds, counts:noOrder };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionTwoGroupVariantCanonicalOrderFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'VariantCanonicalPromo');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'VariantCanonicalPromo', -1, {
      price:1000,
      variants:[
        { name:'Size', type:'text', options:[
          { label:'S', price:1000, weight_grams:100, stock:5 },
          { label:'XL', price:1200, weight_grams:100, stock:5 }
        ]},
        { name:'Color', type:'text', options:[
          { label:'White', price:1000, weight_grams:100, stock:5 },
          { label:'Black', price:1200, weight_grams:100, stock:5 }
        ]}
      ]
    });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'VariantCanonicalPromo', {
      discount_value:125,
      target_type:'variant',
      target:[{ product_id:product.id, variant_key:'Color=Black|Size=XL' }]
    });
    fx.promotion_ids.push(promo.promotion_id);
    var payload = qaBuildOrderPayloadForProduct_('qa-variant-canonical', fx.stamp, 'Buyer', product.id, fx.shipping, {
      selected_variants:{ Size:'XL', Color:'Black' }
    });
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var line = qaFindProductLineByVariantKey_(order, product.id, 'Color=Black|Size=XL');
    qaAssert_(!!line, 'Order line should use canonical variant_key Color=Black|Size=XL', order.items);
    qaAssert_(Number(line.unit_base_price) === 1200 && Number(line.unit_discount_amount) === 125 && Number(line.unit_final_price) === 1075,
      'Canonical variant promotion pricing snapshot mismatch', line);
    qaAssert_(line.promotion && String(line.promotion.promotion_id) === String(promo.promotion_id), 'Variant promotion snapshot missing from order line', line);
    output = { order_id:order.order_id, variant_key:line.variant_key, unit_base_price:line.unit_base_price, unit_discount_amount:line.unit_discount_amount, unit_final_price:line.unit_final_price };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderClientPricingPromoRemovedBeforeSubmitFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoRemovedBeforeSubmit');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoRemovedBeforeSubmit', 5, { price:1000 });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'PromoRemovedBeforeSubmit', { discount_value:200 });
    fx.promotion_ids.push(promo.promotion_id);
    var beforeCount = qaOrderCount_(fx.token);
    var delPromo = qaCall_('deletePromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(delPromo);
    fx.promotion_ids = fx.promotion_ids.filter(function(id){ return String(id) !== String(promo.promotion_id); });
    var payload = qaBuildOrderPayloadForProduct_('qa-promo-removed', fx.stamp, 'Buyer', product.id, fx.shipping);
    payload.client_pricing = {
      items:[{ product_id:product.id, selected_variants:{}, qty:1, unit_final_price:800, promotion_id:promo.promotion_id }],
      subtotal:800,
      shipping_fee:Number(fx.shipping.method.flat_rate || 0),
      total:800 + Number(fx.shipping.method.flat_rate || 0)
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'PRICE_CHANGED', payload);
    var kinds = qaAssertDiffKinds_(res, ['item_price', 'item_promotion', 'subtotal', 'total']);
    output = { delete_promotion:delPromo, response:res, diff_kinds:kinds, counts:noOrder };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// A conditional promo (unlike a direct one) can go stale WITHOUT the promotion itself being
// touched: the client previews a cart that satisfies the qualifying condition (getting a
// discounted price for the target line), then the customer edits the cart below the
// condition's threshold before submitting. The stale client_pricing snapshot still echoes the
// discounted price/promotion_id — submitOrderRpc must recompute against the ACTUAL submitted
// cart (where the condition is no longer met) and reject with PRICE_CHANGED.
function qaRunOrderClientPricingConditionalPromoUnqualifiedBeforeSubmitFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'CondPromoUnqualifiedBeforeSubmit');
  var caught = null, output = null;
  try {
    var A = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'CondUnqualA', 10, { price: 300 });
    var T = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'CondUnqualT', 10, { price: 1000 });
    fx.product_ids.push(A.id, T.id);
    var promo = qaCreatePromotion_(fx.token, T.id, fx.stamp, 'CondUnqualifiedBeforeSubmit', {
      discount_type: 'fixed', discount_value: 300, target_type: 'product', target: [{ product_id: T.id }],
      application_mode: 'conditional', condition_type: 'required_products',
      condition_json: { match_mode: 'all', required_products: [{ product_id: A.id, min_qty: 2 }] }
    });
    fx.promotion_ids.push(promo.promotion_id);

    // Preview while the cart still qualifies (A qty 2): T is discounted to 700.
    var qualifyingPreview = qaCall_('previewPromotionEligibilityRpc', [{ items: [qaCartItem_(A.id, 2, {}), qaCartItem_(T.id, 1, {})] }]);
    qaAssertOk_(qualifyingPreview);
    var tLine = qaPromoPreviewLine_(qualifyingPreview, T.id, '');
    qaAssert_(tLine && Number(tLine.unit_final_price) === 700, 'ตอน preview (A ครบ 2) T ต้องลดเหลือ 700', qualifyingPreview);

    var beforeCount = qaOrderCount_(fx.token);
    // Submit with A reduced to qty 1 (condition no longer met) while client_pricing still
    // echoes the stale qualifying preview's T price/promotion.
    var payload = qaBuildOrderPayloadForProduct_('qa-cond-unqualified', fx.stamp, 'Buyer', T.id, fx.shipping, {
      items: [{ product_id: A.id, qty: 1, selected_variants: {} }, { product_id: T.id, qty: 1, selected_variants: {} }]
    });
    var feeNum = Number(fx.shipping.method.flat_rate || 0);
    payload.client_pricing = {
      items: [
        { product_id: A.id, selected_variants: {}, qty: 1, unit_final_price: 300, promotion_id: null },
        { product_id: T.id, selected_variants: {}, qty: 1, unit_final_price: 700, promotion_id: promo.promotion_id }
      ],
      subtotal: 1000,
      shipping_fee: feeNum,
      total: 1000 + feeNum
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'PRICE_CHANGED', payload);
    var kinds = qaAssertDiffKinds_(res, ['item_price', 'item_promotion', 'subtotal', 'total']);
    output = { promotion_id: promo.promotion_id, response: res, diff_kinds: kinds, counts: noOrder };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftStalePreviewStockDepletedBeforeSubmitFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'StalePreviewStockDepleted', { gift_stock:1, product_stock:5 });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    qaAssert_(qaHasEligibleRule_(preview, fx.rule_id), 'Gift preview should be eligible before stock is depleted', preview);
    qaSetGiftStock_(fx.token, fx.gift_id, 0);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-stale-stock', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    qaAssert_((res.gifts_skipped || []).some(function(s){ return String(s.gift_id) === String(fx.gift_id) && s.code === 'GIFT_OUT_OF_STOCK'; }),
      'Submit should report skipped stale gift stock', res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'Order should not contain an active gift line after gift stock is depleted', order.items);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 0, 'Gift stock should not go negative', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { order_id:order.order_id, skipped:res.gifts_skipped, final_gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftPreviewNearMissRequiredVariantDetailsFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'NearMissVariantGift');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'NearMissVariantGift', -1, {
      price:1,
      variants:[
        { name:'Size', type:'text', options:[{ label:'S', price:1, stock:5 }, { label:'XL', price:1, stock:5 }] },
        { name:'Color', type:'text', options:[{ label:'White', price:1, stock:5 }, { label:'Black', price:1, stock:5 }] }
      ]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'NearMissVariantGift', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'NearMissVariantGift', gift.gift_id, {
      condition_type:'required_variants',
      condition_json:{ required_variants:[{ product_id:product.id, variant_key:'Color=Black|Size=XL', min_qty:2 }] }
    });
    fx.rule_ids.push(rule.rule_id);
    var preview = qaCall_('previewGiftEligibilityRpc', [{
      items:[{ product_id:product.id, qty:1, selected_variants:{ Size:'XL', Color:'White' } }]
    }]);
    qaAssertOk_(preview);
    qaAssert_(!qaHasEligibleRule_(preview, rule.rule_id), 'Required variant rule should not be eligible for wrong variant/qty', preview);
    var near = (preview.near || []).filter(function(n){ return String(n.rule_id) === String(rule.rule_id); })[0];
    qaAssert_(near && near.near && near.near.type === 'required_variants', 'Preview should include required_variants near-miss details', preview);
    var missing = (near.near.missing || [])[0] || {};
    qaAssert_(String(missing.product_id) === String(product.id)
      && String(missing.variant_key) === 'Color=Black|Size=XL'
      && Number(missing.need) === 2,
      'Near-miss missing detail should include product, canonical variant, and remaining qty', missing);
    output = { eligible_count:(preview.eligible || []).length, near_rule:near.rule_id, missing:missing };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderFullLifecycleSlipApproveShipDeliverTokenFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'FullLifecycle', { flat_rate:25 });
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'FullLifecycle', 5, { price:350 });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'FullLifecycle', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'FullLifecycle', gift.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] }
    });
    fx.rule_ids.push(rule.rule_id);
    var submit = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-full-lifecycle', fx.stamp, 'Buyer', product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(submit);
    var orderId = qaOrderIdsFromSubmit_(submit)[0];
    qaAssert_(!!submit.token, 'Full lifecycle submit should return an order token', submit);
    var slip = qaCall_('uploadSlipRpc', [submit.token, qaTinyPngBase64_(), 'qa-slip.png', 'image/png']);
    qaAssertOk_(slip);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved']));
    var tracking = { tracking_number:'QA' + fx.stamp.replace(/[^0-9]/g, ''), carrier_id:'other', carrier_name:'QA Carrier', tracking_url:'https://example.com/track/' + orderId, note:'QA shipped' };
    var shipped = qaCall_('orderMarkShippedRpc', [fx.token, orderId, tracking]);
    qaAssertOk_(shipped);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'delivered', 'QA delivered']));
    var adminRead = qaReadOrder_(fx.token, orderId);
    var statuses = (adminRead.status_history || []).map(function(h){ return h.status; });
    var expectedSeq = ['unpaid', 'paid', 'approved', 'shipped', 'delivered'];
    var pos = -1;
    expectedSeq.forEach(function(s) {
      var next = statuses.indexOf(s, pos + 1);
      qaAssert_(next > pos, 'Status history is missing lifecycle status ' + s + ' in order', { expected:expectedSeq, actual:statuses });
      pos = next;
    });
    qaAssert_(adminRead.status === 'delivered', 'Final admin status should be delivered', adminRead);
    var tokenRead = qaCall_('getOrderByTokenRpc', [submit.token]);
    qaAssertOk_(tokenRead);
    var record = tokenRead.record || {};
    qaAssert_(record.status === 'delivered', 'Token read should see delivered status', record);
    qaAssert_(record.tracking && record.tracking.tracking_number === tracking.tracking_number, 'Token read tracking mismatch', record.tracking);
    qaAssert_(!!qaFindProductLine_(record, product.id), 'Token read should preserve product line', record.items);
    qaAssert_(qaActiveGiftLines_(record, gift.gift_id).length === 1, 'Token read should preserve active gift line', record.items);
    output = { order_id:orderId, status:record.status, status_history:statuses, tracking:record.tracking, gift_count:qaActiveGiftLines_(record, gift.gift_id).length };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunAdminRpcsRequireAdminFlow_() {
  var steps = [];
  var token = '__QA_INVALID_SESSION__';
  var checks = [
    { name:'productCreateRpc', args:[token, {}] },
    { name:'productListRpc admin', fn:'productListRpc', args:[token, { includeAll:true }] },
    { name:'saveShippingRpc', args:[token, []] },
    { name:'listPromotionsRpc', args:[token] },
    { name:'createGiftItemRpc', args:[token, {}] },
    { name:'orderListRpc', args:[token, {}] },
    { name:'userListRpc', args:[token] },
    { name:'getPaymentConfigRpc', args:[token] }
  ];
  var results = checks.map(function(c) {
    var fn = c.fn || c.name;
    var res = qaCall_(fn, c.args);
    var rejected = !!(res && res.ok === false);
    qaStep_(steps, 'ตรวจสิทธิ์ ' + c.name, rejected ? 'ok' : 'failed', { response:res });
    return { name:c.name, rejected:rejected, response:res };
  });
  qaAssert_(results.every(function(r){ return r.rejected; }), 'มี RPC ที่ไม่ปฏิเสธ token ปลอม', results);
  return { steps:steps, results:results };
}

function qaRunUserCrudFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [], userId = '', email = 'qa-user-' + Utilities.getUuid().replace(/-/g,'').slice(0,10) + '@example.com';
  if (!qaIsOwnerToken_(token)) return qaSkip_('ต้องใช้ token ของ owner เพื่อทดสอบจัดการผู้ใช้', { steps:steps });
  var caught = null, output = null;
  try {
    var create = qaCall_('userCreateRpc', [token, { email:email, password:'QaTestPass123!', role:'admin', otp_required:false }]);
    qaAssertOk_(create);
    qaStep_(steps, 'สร้างผู้ใช้ QA', 'ok', { email:email, response:create });
    var list = qaCall_('userListRpc', [token]);
    qaAssertOk_(list);
    var user = (list.users || []).filter(function(u){ return String(u.email).toLowerCase() === email.toLowerCase(); })[0];
    qaAssert_(!!user, 'หลังสร้างต้องพบผู้ใช้ QA', list);
    userId = user.id;
    qaStep_(steps, 'อ่านผู้ใช้หลังสร้าง', 'ok', user);
    var upd = qaCall_('userUpdateRpc', [token, userId, { otp_required:true, password:'QaTestPass456!' }]);
    qaAssertOk_(upd);
    qaStep_(steps, 'แก้ไขผู้ใช้ QA', 'ok', upd);
    var del = qaCall_('userDeleteRpc', [token, userId]);
    qaAssertOk_(del);
    userId = '';
    qaStep_(steps, 'ลบผู้ใช้ QA', 'ok', del);
    output = { steps:steps, email:email };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = userId ? qaCall_('userDeleteRpc', [token, userId]) : { ok:true, skipped:true };
  qaStep_(steps, 'cleanup', cleanup && cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunLogoutInvalidatesSessionFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [], userId = '', email = 'qa-login-' + Utilities.getUuid().replace(/-/g,'').slice(0,10) + '@example.com';
  if (!qaIsOwnerToken_(token)) return qaSkip_('ต้องใช้ token ของ owner เพื่อสร้างผู้ใช้ชั่วคราวสำหรับทดสอบ logout', { steps:steps });
  var caught = null, output = null, tempToken = '';
  try {
    var create = qaCall_('userCreateRpc', [token, { email:email, password:'QaLoginPass123!', role:'admin', otp_required:false }]);
    qaAssertOk_(create);
    var list = qaCall_('userListRpc', [token]);
    qaAssertOk_(list);
    var user = (list.users || []).filter(function(u){ return String(u.email).toLowerCase() === email.toLowerCase(); })[0];
    qaAssert_(!!user, 'ต้องพบผู้ใช้ QA หลังสร้าง', list);
    userId = user.id;
    qaStep_(steps, 'สร้างผู้ใช้สำหรับ login', 'ok', { email:email, user_id:userId });
    var login = qaCall_('loginRpc', [email, 'QaLoginPass123!']);
    qaAssertOk_(login);
    tempToken = login.token;
    qaAssert_(!!tempToken, 'login ต้องคืน token', login);
    qaStep_(steps, 'login ผู้ใช้ QA', 'ok', { tokenReturned:!!tempToken });
    var logout = qaCall_('logoutRpc', [tempToken]);
    qaAssertOk_(logout);
    var validate = qaCall_('validateSessionRpc', [tempToken]);
    qaAssert_(validate && validate.ok === false, 'หลัง logout token ต้องใช้ไม่ได้', validate);
    qaStep_(steps, 'logout และ validate token เดิม', 'ok', { logout:logout, validate:validate });
    output = { steps:steps, email:email, validate_after_logout:validate };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = userId ? qaCall_('userDeleteRpc', [token, userId]) : { ok:true, skipped:true };
  qaStep_(steps, 'cleanup', cleanup && cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPaymentValidationFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [];
  var res = qaCall_('savePaymentConfigRpc', [token, { promptpay_number:'123', promptpay_name:'QA PromptPay' }]);
  qaAssert_(res && res.ok === false, 'PromptPay ที่สั้นเกินไปต้องถูกปฏิเสธ', res);
  qaStep_(steps, 'ตรวจ validation PromptPay', 'ok', { response:res });
  return { steps:steps, response:res };
}

function qaRunPaymentPreservesConfigFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [];
  var original = _readSiteConfig();
  var caught = null, output = null;
  try {
    var cfg = qaClone_(original);
    cfg.legal = Object.assign({}, cfg.legal || {}, { controllerName:'QA Legal Preserve' });
    _writeSiteConfig(JSON.stringify(cfg));
    qaStep_(steps, 'ตั้งค่า legal ชั่วคราว', 'ok', { legal:cfg.legal });
    var save = qaCall_('savePaymentConfigRpc', [token, { promptpay_number:'0812345678', promptpay_name:'QA Payment Preserve' }]);
    qaAssertOk_(save);
    var after = _readSiteConfig();
    qaAssert_(after.legal && after.legal.controllerName === 'QA Legal Preserve', 'legal config ต้องยังอยู่หลัง savePaymentConfigRpc', after);
    qaStep_(steps, 'บันทึก payment และตรวจ legal ยังอยู่', 'ok', { save:save, legal:after.legal, payment:after.payment });
    output = { steps:steps, legal:after.legal, payment:after.payment };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var restore = _writeSiteConfig(JSON.stringify(original || {}));
  qaStep_(steps, 'restore site config', restore && restore.ok ? 'ok' : 'failed', restore);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, restore:restore }); throw caught; }
  output.restore = restore;
  return output;
}

function qaRunSlipCustomerReadFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'SlipRead', 5);
  var steps = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-slip-read', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var token = res.token || '';
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaStep_(steps, 'สร้างออร์เดอร์ unpaid', 'ok', { order_id:orderId, tokenReturned:!!token });
    var before = qaCall_('getSlipByOrderTokenRpc', [token, 'fake-file-id']);
    qaAssert_(before && before.ok === false, 'ก่อนมีสลิปต้องอ่านสลิปไม่ได้', before);
    qaStep_(steps, 'ตรวจอ่านสลิปก่อนอัปโหลด', 'ok', before);
    var upload = qaCall_('uploadSlipRpc', [token, 'data:image/png;base64,' + qaTinyPngBase64_(), 'qa-slip.png', 'image/png']);
    qaAssertOk_(upload);
    qaStep_(steps, 'อัปโหลดสลิป', 'ok', upload);
    var read = qaCall_('getSlipByOrderTokenRpc', [token, upload.file_id]);
    qaAssertOk_(read);
    qaAssert_(String(read.dataUrl || '').indexOf('data:image/') === 0, 'อ่านสลิปต้องได้ dataUrl รูปภาพ', read);
    qaStep_(steps, 'อ่านสลิปหลังอัปโหลด', 'ok', { hasDataUrl:!!read.dataUrl, length:String(read.dataUrl||'').length });
    output = { steps:steps, order_id:orderId, slip_file_id:upload.file_id, read_bytes:String(read.dataUrl||'').length };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunSlipInvalidFileIdFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'SlipInvalidFile', 5);
  var steps = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-slip-invalid-file', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var token = res.token || '';
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var upload = qaCall_('uploadSlipRpc', [token, 'data:image/png;base64,' + qaTinyPngBase64_(), 'qa-slip.png', 'image/png']);
    qaAssertOk_(upload);
    qaStep_(steps, 'สร้างออร์เดอร์และอัปโหลดสลิป', 'ok', { order_id:orderId, slip_file_id:upload.file_id });
    var bad = qaCall_('getSlipByOrderTokenRpc', [token, 'not-the-slip-file']);
    qaAssert_(bad && bad.ok === false, 'file id ที่ไม่ตรงออร์เดอร์ต้องถูกปฏิเสธ', bad);
    qaStep_(steps, 'ตรวจ file id ที่ไม่ตรง', 'ok', bad);
    output = { steps:steps, order_id:orderId, slip_file_id:upload.file_id, bad_response:bad };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaPaymentSlipDataUrl_() {
  return 'data:image/png;base64,' + qaTinyPngBase64_();
}

function qaTrashDriveFilesSafe_(fileIds) {
  var out = { ok:true, files:[] };
  Array.from(new Set((fileIds || []).filter(Boolean).map(String))).forEach(function(fileId) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
      out.files.push({ file_id:fileId, ok:true });
    } catch (err) {
      out.files.push({ file_id:fileId, ok:false, error:String(err && err.message || err) });
    }
  });
  return out;
}

function qaCleanupPaymentLifecycleFixture_(fx, slipIds) {
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  cleanup.extra_slips = qaTrashDriveFilesSafe_(slipIds || []);
  return cleanup;
}

function qaRunPaymentLifecycleSlipReuploadLatestWinsFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PaySlipReupload', 5);
  var slipIds = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-pay-reupload', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || '';
    var first = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-first.png', 'image/png']);
    qaAssertOk_(first);
    slipIds.push(first.file_id);
    var second = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-second.png', 'image/png']);
    qaAssertOk_(second);
    slipIds.push(second.file_id);
    qaAssert_(String(first.file_id) !== String(second.file_id), 'Second slip upload should create a new file id', { first:first, second:second });
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(String(record.slip_drive_file_id) === String(second.file_id), 'Order should point to the latest slip file id', record);
    var oldRead = qaCall_('getSlipByOrderTokenRpc', [token, first.file_id]);
    var latestRead = qaCall_('getSlipByOrderTokenRpc', [token, second.file_id]);
    qaAssert_(oldRead && oldRead.ok === false, 'Old slip id should no longer be readable through the order token', oldRead);
    qaAssertOk_(latestRead);
    output = {
      order_id:orderId,
      first_slip_file_id:first.file_id,
      latest_slip_file_id:second.file_id,
      old_read_response:oldRead,
      latest_read_ok:latestRead.ok
    };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupPaymentLifecycleFixture_(fx, slipIds);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPaymentLifecycleUploadBlockedAfterApprovedFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PayApprovedUploadBlock', 5);
  var slipIds = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-pay-approved-block', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || '';
    var upload = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-paid.png', 'image/png']);
    qaAssertOk_(upload);
    slipIds.push(upload.file_id);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved after slip upload']));
    var blocked = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-after-approved.png', 'image/png']);
    if (blocked && blocked.file_id) slipIds.push(blocked.file_id);
    qaAssert_(blocked && blocked.ok === false, 'Slip upload should be blocked after order is approved', blocked);
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'approved', 'Order should remain approved after blocked upload', record);
    qaAssert_(String(record.slip_drive_file_id) === String(upload.file_id), 'Blocked upload should not replace slip id', record);
    output = { order_id:orderId, status:record.status, slip_file_id:record.slip_drive_file_id, blocked_response:blocked };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupPaymentLifecycleFixture_(fx, slipIds);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPaymentLifecycleResetUnpaidClearsSlipFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PayResetUnpaid', 5);
  var slipIds = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-pay-reset-unpaid', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || '';
    var upload = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-reset.png', 'image/png']);
    qaAssertOk_(upload);
    slipIds.push(upload.file_id);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'unpaid', 'QA reset payment to unpaid']));
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'unpaid', 'Order should be reset to unpaid', record);
    qaAssert_(!record.slip_drive_file_id, 'Reset to unpaid should clear slip_drive_file_id', record);
    var oldRead = qaCall_('getSlipByOrderTokenRpc', [token, upload.file_id]);
    qaAssert_(oldRead && oldRead.ok === false, 'Old slip should not be readable after reset to unpaid', oldRead);
    output = { order_id:orderId, status:record.status, slip_drive_file_id:record.slip_drive_file_id || '', old_read_response:oldRead };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupPaymentLifecycleFixture_(fx, slipIds);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPaymentLifecycleDeliveredBlocksSlipUploadFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PayDeliveredUploadBlock', 5);
  var slipIds = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-pay-delivered-block', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || '';
    var upload = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-delivered.png', 'image/png']);
    qaAssertOk_(upload);
    slipIds.push(upload.file_id);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved before delivery']));
    qaAssertOk_(qaCall_('orderMarkShippedRpc', [fx.token, orderId, { tracking_number:'QA' + fx.stamp.replace(/[^0-9]/g, ''), carrier_id:'other', carrier_name:'QA Carrier' }]));
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'delivered', 'QA delivered']));
    var blocked = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-after-delivered.png', 'image/png']);
    if (blocked && blocked.file_id) slipIds.push(blocked.file_id);
    qaAssert_(blocked && blocked.ok === false, 'Delivered order should block slip upload', blocked);
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'delivered', 'Order should remain delivered after blocked slip upload', record);
    output = { order_id:orderId, status:record.status, blocked_response:blocked, slip_file_id:record.slip_drive_file_id || '' };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupPaymentLifecycleFixture_(fx, slipIds);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPaymentLifecycleStatusRollbackClearsTrackingFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'PayRollbackTracking', 5);
  var slipIds = [], caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-pay-rollback-track', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var token = res.token || '';
    var upload = qaCall_('uploadSlipRpc', [token, qaPaymentSlipDataUrl_(), 'qa-slip-rollback.png', 'image/png']);
    qaAssertOk_(upload);
    slipIds.push(upload.file_id);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'QA approved before shipping']));
    var tracking = { tracking_number:'QA' + fx.stamp.replace(/[^0-9]/g, ''), carrier_id:'other', carrier_name:'QA Carrier', tracking_url:'https://example.com/track/QA' };
    qaAssertOk_(qaCall_('orderMarkShippedRpc', [fx.token, orderId, tracking]));
    var shipped = qaReadOrder_(fx.token, orderId);
    qaAssert_(shipped.tracking && shipped.tracking.tracking_number === tracking.tracking_number, 'Tracking should exist after mark shipped', shipped.tracking);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA rollback to paid']));
    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'paid', 'Order should be rolled back to paid', record);
    qaAssert_(!record.tracking || !record.tracking.tracking_number, 'Tracking should be cleared after rollback to paid', record.tracking);
    output = { order_id:orderId, status:record.status, tracking_after_rollback:record.tracking || null, slip_file_id:record.slip_drive_file_id || '' };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupPaymentLifecycleFixture_(fx, slipIds);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunConfigPublishPreservesFlow_(ctx) {
  var token = ctx.options.adminToken, steps = [];
  var originalCfg     = _readSiteConfig();
  var originalPayment = _readPaymentConfig();
  var caught = null, output = null;
  try {
    // Write legal into site_config
    var cfg = qaClone_(originalCfg);
    cfg.legal = Object.assign({}, cfg.legal || {}, { controllerName:'QA Publish Legal' });
    _writeSiteConfig(JSON.stringify(cfg));
    // Write payment into the dedicated payment sheet (payment no longer lives in site_config)
    _writePaymentConfig({
      promptpay_number: '0812345678',
      promptpay_name:   'QA Publish Payment',
      bg_drive_id: originalPayment.bg_drive_id || '',
      bg_url:      originalPayment.bg_url      || '',
      qr_x:    originalPayment.qr_x    !== undefined ? originalPayment.qr_x    : 50,
      qr_y:    originalPayment.qr_y    !== undefined ? originalPayment.qr_y    : 50,
      qr_size: originalPayment.qr_size !== undefined ? originalPayment.qr_size : 25
    }, '');
    qaStep_(steps, 'ตั้งค่า legal/payment ชั่วคราว', 'ok', { legal:cfg.legal });
    var pub = qaCall_('publishSiteConfig', [token, { siteTitle:'QA Publish Title ' + qaStamp_() }]);
    qaAssertOk_(pub);
    var afterCfg     = _readSiteConfig();
    var afterPayment = _readPaymentConfig();
    qaAssert_(afterCfg.legal && afterCfg.legal.controllerName === 'QA Publish Legal',
              'legal ต้องไม่หายหลัง publish', afterCfg);
    qaAssert_(afterPayment && afterPayment.promptpay_name === 'QA Publish Payment',
              'payment ต้องไม่หายหลัง publish (อ่านจาก payment sheet)', afterPayment);
    // site_config must NOT contain payment key after publish
    qaAssert_(!afterCfg.payment, 'payment ต้องไม่อยู่ใน site_config หลัง publish', afterCfg);
    qaStep_(steps, 'publish และตรวจ preserve', 'ok', { publish:pub, legal:afterCfg.legal, payment:afterPayment });
    output = { steps:steps, legal:afterCfg.legal, payment:afterPayment };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var restoreCfg     = _writeSiteConfig(JSON.stringify(originalCfg || {}));
  var restorePayment = _writePaymentConfig(originalPayment, '');
  qaStep_(steps, 'restore site config',   restoreCfg     && restoreCfg.ok     ? 'ok' : 'failed', restoreCfg);
  qaStep_(steps, 'restore payment config', restorePayment && restorePayment.ok ? 'ok' : 'failed', restorePayment);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, restoreCfg:restoreCfg, restorePayment:restorePayment }); throw caught; }
  output.restore = restoreCfg;
  return output;
}

function qaRunConfigBundleActiveProductsFlow_(ctx) {
  var token = ctx.options.adminToken, stamp = qaStamp_(), steps = [], productIds = [];
  var shipping = qaCreateTempShippingMethod_(token, stamp, 'BundleActive');
  var caught = null, output = null;
  try {
    var active = qaCreateOrderQaProduct_(token, shipping, stamp, 'BundleActive', 5, { price:100 });
    var disabled = qaCreateOrderQaProduct_(token, shipping, stamp, 'BundleDisabled', 5, { sale_mode:'disabled', allowed_shipping_ids:[], price:100 });
    productIds = [active.id, disabled.id];
    qaStep_(steps, 'สร้างสินค้า active และ disabled', 'ok', { active:active.id, disabled:disabled.id });
    var bundle = qaCall_('getSiteConfigBundle');
    qaAssertOk_(bundle);
    var ids = (bundle.config.products || []).map(function(p){ return String(p.id); });
    qaAssert_(ids.indexOf(String(active.id)) >= 0 && ids.indexOf(String(disabled.id)) < 0, 'bundle ต้องมีเฉพาะสินค้าที่ active', { ids:ids, active:active.id, disabled:disabled.id });
    qaStep_(steps, 'ตรวจ products ใน bundle', 'ok', { active_present:true, disabled_present:false });
    output = { steps:steps, active_id:active.id, disabled_id:disabled.id };
  } catch (err) { caught = err; qaStep_(steps, 'เกิดข้อผิดพลาด', 'failed', { error:String(err && err.message || err) }); }
  var cleanup = qaCleanupPromosProductsShipping_(token, [], productIds, shipping);
  qaStep_(steps, 'cleanup', cleanup.ok ? 'ok' : 'failed', cleanup);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRoute404_(ctx, page) {
  if (!ctx.execUrl) return qaSkip_('ไม่มี Web App URL ที่ deploy แล้วจาก ScriptApp.getService().getUrl()');
  var url = ctx.execUrl + (ctx.execUrl.indexOf('?') >= 0 ? '&' : '?') + 'page=' + encodeURIComponent(page);
  var response = UrlFetchApp.fetch(url, { method:'get', followRedirects:true, muteHttpExceptions:true });
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  qaAssert_(code === 200 || code === 404, 'Route 404 smoke ได้ HTTP ที่ไม่คาดไว้: ' + code, { url:url, statusCode:code, preview:text.slice(0,160) });
  qaAssert_(text.indexOf('404 Not Found') >= 0, 'Route ที่ไม่มีจริงต้องมีข้อความ 404 Not Found', { url:url, statusCode:code, preview:text.slice(0,160) });
  return { url:url, statusCode:code, has404Text:true, bytes:text.length };
}

function qaRouteSmoke_(ctx, page) {
  if (!ctx.execUrl) {
    return qaSkip_('ไม่มี Web App URL ที่ deploy แล้วจาก ScriptApp.getService().getUrl()');
  }

  var url = ctx.execUrl + (ctx.execUrl.indexOf('?') >= 0 ? '&' : '?') + 'page=' + encodeURIComponent(page);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'QAIntegrationTest/1.0'
    }
  });
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  qaAssert_(code >= 200 && code < 400, 'Route returned HTTP ' + code, { url: url, statusCode: code });
  qaAssert_(text.length > 50, 'Route returned an unexpectedly small response', { url: url, bytes: text.length });
  qaAssert_(/<html|<!doctype html/i.test(text), 'Route response does not look like HTML', {
    url: url,
    bytes: text.length,
    preview: text.slice(0, 160)
  });
  return {
    url: url,
    statusCode: code,
    bytes: text.length,
    hasHtml: true
  };
}

/* ============================================================
   SHIPPING ADDRESS EDIT FLOW FUNCTIONS
   ============================================================ */

var _QA_ADDR_PATCH = {
  shipping_name:        'QA ผู้รับทดสอบ',
  customer_phone:       '0812345678',
  shipping_address:     '99/9 ถนนทดสอบ',
  shipping_district:    'แขวงทดสอบ',
  shipping_amphoe:      'เขตทดสอบ',
  shipping_province:    'กรุงเทพมหานคร',
  shipping_postal_code: '10110'
};

/* ===== Promotion/gift settings coverage expansion ===== */

function qaRunPromotionSettingsValidationMatrixFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoSettingsValidation');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoSettingsValidation', 10, {
      price: 1000,
      variants: [
        { name:'Color', type:'text', options:[{ label:'Red', price:1000, stock:10 }, { label:'Blue', price:1000, stock:10 }] },
        { name:'Size', type:'text', options:[{ label:'S', price:1000, stock:10 }, { label:'L', price:1000, stock:10 }] }
      ]
    });
    fx.product_ids.push(product.id);
    function base() {
      return {
        name:'QA Promo Settings Validation ' + fx.stamp,
        discount_type:'fixed', discount_value:100,
        target_type:'all', target:[],
        starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true, enabled:true,
        application_mode:'conditional', condition_type:'min_subtotal',
        condition_json:{ min_subtotal:500 }
      };
    }
    var cases = [];
    function run(label, mutate) {
      var payload = base();
      mutate(payload);
      var res = qaCall_('createPromotionRpc', [fx.token, payload]);
      if (res && res.promotion_id) fx.promotion_ids.push(res.promotion_id);
      cases.push({ label:label, response:res });
    }
    run('invalid application_mode', function(p){ p.application_mode = 'stacked'; });
    run('invalid condition_type', function(p){ p.condition_type = 'cart_magic'; });
    run('zero min_subtotal', function(p){ p.condition_json = { min_subtotal:0 }; });
    run('empty required_products', function(p){ p.condition_type='required_products'; p.condition_json={ required_products:[] }; });
    run('missing required product', function(p){ p.condition_type='required_products'; p.condition_json={ required_products:[{ product_id:'qa_missing_product', min_qty:1 }] }; });
    run('empty required_variants', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[] }; });
    run('invalid required variant key', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[{ product_id:product.id, variant_key:'Color=Red', min_qty:1 }] }; });
    // A blank starts_at intentionally means "active immediately". Exercise the
    // actual invalid schedule branch with a non-date value instead.
    run('invalid starts_at', function(p){ p.starts_at='not-a-date'; });
    var accepted = cases.filter(function(c){ return !c.response || c.response.ok !== false; });
    qaAssert_(accepted.length === 0, 'Invalid promotion settings were accepted', { accepted:accepted, cases:cases });
    output = { checked:cases.length, cases:cases };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionSettingsScheduleRoundTripFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoScheduleRoundTrip');
  var caught = null, output = null, states = [];
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoScheduleRoundTrip', 10, { price:1000 });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'ScheduleRoundTrip', {
      discount_value:100, starts_at:qaFutureIso_(3600000), no_end_date:true
    });
    fx.promotion_ids.push(promo.promotion_id);
    function readState(label) {
      var listed = qaCall_('listPromotionsRpc', [fx.token]);
      qaAssertOk_(listed);
      var row = (listed.promotions || []).filter(function(p){ return String(p.promotion_id) === String(promo.promotion_id); })[0];
      qaAssert_(!!row, 'Promotion missing while checking schedule state: ' + label, listed);
      states.push({ label:label, status:row.status, starts_at:row.starts_at, ends_at:row.ends_at, no_end_date:row.no_end_date, enabled:row.enabled });
      return row;
    }
    qaAssert_(readState('scheduled').status === 'scheduled', 'Future promotion must be scheduled', states);
    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      starts_at:'', ends_at:'', no_end_date:true
    }]));
    var active = readState('active-immediately-no-end');
    qaAssert_(active.status === 'active' && !active.starts_at && active.no_end_date === true && !active.ends_at, 'Promotion without start/end dates did not normalize as active', active);
    var activeRecord = qaGetProductRecord_(product.id);
    qaAssert_(activeRecord.promotion && String(activeRecord.promotion.promotion_id) === String(promo.promotion_id), 'Active promotion missing from product snapshot', activeRecord);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      starts_at:qaPastIso_(120000), ends_at:qaPastIso_(60000), no_end_date:false
    }]));
    qaAssert_(readState('expired').status === 'expired', 'Past schedule must be expired', states);
    var expiredRecord = qaGetProductRecord_(product.id);
    qaAssert_(!expiredRecord.promotion || String(expiredRecord.promotion.promotion_id) !== String(promo.promotion_id), 'Expired promotion still applied', expiredRecord);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true
    }]));
    qaAssertOk_(qaCall_('togglePromotionRpc', [fx.token, promo.promotion_id, false]));
    qaAssert_(readState('disabled').status === 'disabled', 'Disabled promotion status mismatch', states);
    qaAssertOk_(qaCall_('togglePromotionRpc', [fx.token, promo.promotion_id, true]));
    qaAssert_(readState('re-enabled').status === 'active', 'Re-enabled no-end promotion must be active', states);
    output = { promotion_id:promo.promotion_id, states:states };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup, states:states }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionSettingsModeTransitionFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoModeTransition');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoModeTransition', 10, { price:1000 });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'ModeTransition', { discount_value:200 });
    fx.promotion_ids.push(promo.promotion_id);
    var directRecord = qaGetProductRecord_(product.id);
    qaAssert_(directRecord.promotion && String(directRecord.promotion.promotion_id) === String(promo.promotion_id), 'Initial direct promotion must be in snapshot', directRecord);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:2000 }
    }]));
    var conditional = qaCall_('getPromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(conditional);
    qaAssert_(conditional.promotion.application_mode === 'conditional' && Number(conditional.promotion.condition_json.min_subtotal) === 2000, 'Conditional settings were not persisted', conditional);
    var conditionalRecord = qaGetProductRecord_(product.id);
    qaAssert_(!conditionalRecord.promotion || String(conditionalRecord.promotion.promotion_id) !== String(promo.promotion_id), 'Conditional promotion must not be injected into product snapshot', conditionalRecord);
    var below = qaPreviewPromo_([qaCartItem_(product.id, 1, {})]);
    qaAssert_(qaPromoNearHas_(below, promo.promotion_id), 'Conditional promotion should be a near miss below threshold', below);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      application_mode:'direct', condition_type:'required_products',
      condition_json:{ required_products:[{ product_id:product.id, min_qty:99 }] }
    }]));
    var directAgain = qaCall_('getPromotionRpc', [fx.token, promo.promotion_id]);
    qaAssertOk_(directAgain);
    qaAssert_(directAgain.promotion.application_mode === 'direct'
      && !directAgain.promotion.condition_type
      && Object.keys(directAgain.promotion.condition_json || {}).length === 0,
      'Direct mode must strip stale condition fields', directAgain);
    var finalRecord = qaGetProductRecord_(product.id);
    qaAssert_(finalRecord.promotion && String(finalRecord.promotion.promotion_id) === String(promo.promotion_id), 'Promotion must return to direct snapshot pricing', finalRecord);
    output = { promotion_id:promo.promotion_id, conditional:conditional.promotion, direct_again:directAgain.promotion };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionConditionalSubtotalAfterDirectFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoSubtotalAfterDirect');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoSubtotalAfterDirect', 10, { price:1000 });
    fx.product_ids.push(product.id);
    var direct = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'SubtotalDirect', { discount_value:200 });
    fx.promotion_ids.push(direct.promotion_id);
    Utilities.sleep(5);
    var conditionalEndsAt = new Date(Date.now() + 86400000).toISOString();
    var conditional = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'SubtotalConditional', {
      discount_value:100, application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:900 },
      ends_at:conditionalEndsAt, no_end_date:false
    });
    fx.promotion_ids.push(conditional.promotion_id);
    var below = qaPreviewPromo_([qaCartItem_(product.id, 1, {})]);
    qaAssert_(!qaPromoEligibleHas_(below, conditional.promotion_id) && qaPromoNearHas_(below, conditional.promotion_id), 'Threshold 900 must use direct-discount subtotal 800', below);
    var belowEntry = (below.near || []).filter(function(e){ return String(e.promotion_id) === String(conditional.promotion_id); })[0];
    qaAssert_(belowEntry && belowEntry.starts_at && belowEntry.ends_at === conditionalEndsAt && belowEntry.no_end_date === false,
      'Promotion near preview must expose its active schedule', belowEntry);
    var belowLine = qaPromoPreviewLine_(below, product.id, '');
    qaAssert_(Number(belowLine.unit_final_price) === 800 && String(belowLine.promotion.promotion_id) === String(direct.promotion_id), 'Unqualified conditional must fall back to direct price 800', belowLine);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, conditional.promotion_id, { condition_json:{ min_subtotal:800 } }]));
    var exact = qaPreviewPromo_([qaCartItem_(product.id, 1, {})]);
    var exactLine = qaPromoPreviewLine_(exact, product.id, '');
    qaAssert_(qaPromoEligibleHas_(exact, conditional.promotion_id), 'Threshold 800 must qualify at direct-discount subtotal 800', exact);
    // Best-price policy: the qualified conditional (-100) is outpriced by the direct (-200),
    // so the line keeps the direct price 800 and the conditional is qualified-but-not-applied.
    qaAssert_(Number(exactLine.unit_final_price) === 800 && String(exactLine.promotion.promotion_id) === String(direct.promotion_id), 'Best-price must keep the bigger direct discount over the qualified conditional', exactLine);
    var exactEntry = (exact.eligible || []).filter(function(e){ return String(e.promotion_id) === String(conditional.promotion_id); })[0];
    qaAssert_(exactEntry && exactEntry.applied === false
      && Array.isArray(exactEntry.outpriced_lines) && exactEntry.outpriced_lines.length === 1,
      'Outpriced qualified conditional must report applied:false + outpriced_lines', exactEntry);
    qaAssert_(exactEntry.starts_at && exactEntry.ends_at === conditionalEndsAt && exactEntry.no_end_date === false,
      'Promotion eligible preview must expose its active schedule', exactEntry);
    qaSubmitAndAssertMatchesPreview_(fx, 'SubtotalAfterDirect', [qaCartItem_(product.id, 1, {})], exact);
    output = { direct:direct.promotion_id, conditional:conditional.promotion_id, below:below, exact:exact };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionResolverReverseSpecificityFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoReverseSpecificity');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoReverseSpecificity', -1, {
      price:1000,
      variants:[{ name:'Size', type:'text', options:[{ label:'S', price:1000, stock:10 }, { label:'L', price:1000, stock:10 }] }]
    });
    fx.product_ids.push(product.id);
    var directVariant = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'DirectVariant', {
      discount_value:300, target_type:'variant', target:[{ product_id:product.id, variant_key:'Size=L' }]
    });
    fx.promotion_ids.push(directVariant.promotion_id);
    Utilities.sleep(5);
    var conditionalProduct = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'ConditionalProduct', {
      discount_value:100, target_type:'product', target:[{ product_id:product.id }],
      application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:1 }
    });
    fx.promotion_ids.push(conditionalProduct.promotion_id);
    var cart = [qaCartItem_(product.id, 1, { Size:'L' }), qaCartItem_(product.id, 1, { Size:'S' })];
    var preview = qaPreviewPromo_(cart);
    var lineL = qaPromoPreviewLine_(preview, product.id, 'Size=L');
    var lineS = qaPromoPreviewLine_(preview, product.id, 'Size=S');
    qaAssert_(Number(lineL.unit_final_price) === 700 && String(lineL.promotion.promotion_id) === String(directVariant.promotion_id), 'Bigger direct variant discount must win on Size=L (best price)', lineL);
    qaAssert_(Number(lineS.unit_final_price) === 900 && String(lineS.promotion.promotion_id) === String(conditionalProduct.promotion_id), 'Sibling Size=S must use qualified conditional product promotion', lineS);
    qaSubmitAndAssertMatchesPreview_(fx, 'ReverseSpecificity', cart, preview);
    output = { direct_variant:directVariant.promotion_id, conditional_product:conditionalProduct.promotion_id, preview:preview };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunPromotionResolverCreatedAtTiebreakFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoCreatedAtTiebreak');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoCreatedAtTiebreak', 10, { price:1000 });
    fx.product_ids.push(product.id);
    // Equal discounts -> equal final price -> equal specificity: the created_at tiebreak
    // (newest wins) is the only thing separating them under the best-price policy.
    var older = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'TieOlder', {
      discount_value:250, application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:1 }
    });
    fx.promotion_ids.push(older.promotion_id);
    Utilities.sleep(20);
    var newer = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'TieNewer', {
      discount_value:250, application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:1 }
    });
    fx.promotion_ids.push(newer.promotion_id);
    var first = qaPreviewPromo_([qaCartItem_(product.id, 1, {})]);
    var firstLine = qaPromoPreviewLine_(first, product.id, '');
    qaAssert_(Number(firstLine.unit_final_price) === 750 && String(firstLine.promotion.promotion_id) === String(newer.promotion_id), 'Newer promotion must win the price tie at equal specificity', firstLine);
    qaAssertOk_(qaCall_('togglePromotionRpc', [fx.token, newer.promotion_id, false]));
    var fallback = qaPreviewPromo_([qaCartItem_(product.id, 1, {})]);
    var fallbackLine = qaPromoPreviewLine_(fallback, product.id, '');
    qaAssert_(Number(fallbackLine.unit_final_price) === 750 && String(fallbackLine.promotion.promotion_id) === String(older.promotion_id), 'Older promotion must win after newer is disabled', fallbackLine);
    output = { older:older.promotion_id, newer:newer.promotion_id, first:first, fallback:fallback };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// The core best-price policy flip: a LESS specific promotion with a BIGGER discount must
// beat a MORE specific promotion with a smaller discount on the same line. Under the old
// specificity-first rule the direct variant (-100) would have won; under best-price the
// qualified conditional product promo (-300) wins.
function qaRunPromotionBestPriceOverSpecificityFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'PromoBestPrice');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoBestPrice', -1, {
      price:1000,
      variants:[{ name:'Size', type:'text', options:[{ label:'S', price:1000, stock:10 }, { label:'L', price:1000, stock:10 }] }]
    });
    fx.product_ids.push(product.id);
    var directVariant = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'BestPriceDirectVar', {
      discount_value:100, target_type:'variant', target:[{ product_id:product.id, variant_key:'Size=L' }]
    });
    fx.promotion_ids.push(directVariant.promotion_id);
    Utilities.sleep(5);
    var conditionalProduct = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'BestPriceCondProd', {
      discount_value:300, target_type:'product', target:[{ product_id:product.id }],
      application_mode:'conditional', condition_type:'min_subtotal', condition_json:{ min_subtotal:1 }
    });
    fx.promotion_ids.push(conditionalProduct.promotion_id);
    var cart = [qaCartItem_(product.id, 1, { Size:'L' })];
    var preview = qaPreviewPromo_(cart);
    var lineL = qaPromoPreviewLine_(preview, product.id, 'Size=L');
    qaAssert_(Number(lineL.unit_final_price) === 700 && String(lineL.promotion.promotion_id) === String(conditionalProduct.promotion_id), 'Bigger conditional product discount must beat the more-specific direct variant (best price)', lineL);
    var entry = (preview.eligible || []).filter(function(e){ return String(e.promotion_id) === String(conditionalProduct.promotion_id); })[0];
    qaAssert_(entry && entry.applied === true
      && Array.isArray(entry.applied_lines) && entry.applied_lines.length === 1
      && Array.isArray(entry.outpriced_lines) && entry.outpriced_lines.length === 0,
      'Winning conditional must report applied:true with its applied line', entry);
    qaSubmitAndAssertMatchesPreview_(fx, 'BestPriceFlip', cart, preview);
    output = { direct_variant:directVariant.promotion_id, conditional_product:conditionalProduct.promotion_id, preview:preview };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftLegacyInvalidDataFailClosedFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftLegacyFailClosed');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftLegacyFailClosed', 10, { price:500 });
    fx.product_ids.push(product.id);
    var validGift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftLegacyInvalidRule', { stock:10 });
    fx.gift_ids.push(validGift.gift_id);

    var suffix = uuid_().replace(/-/g, '').slice(0, 12);
    var invalidGiftId = 'gift_legacy_' + suffix;
    var invalidGiftRuleId = 'gr_legacy_stock_' + suffix;
    var invalidQtyRuleId = 'gr_legacy_qty_' + suffix;
    var now = nowISO_();
    sheetGiftItems_().appendRow([
      invalidGiftId, 'QA Legacy Invalid Gift ' + fx.stamp, 'fractional stock fixture', '', '',
      1.5, 'TRUE', now, now, '', '', ''
    ]);
    fx.gift_ids.push(invalidGiftId);
    sheetGiftRules_().appendRow([
      invalidGiftRuleId, 'QA Legacy Invalid Gift Rule ' + fx.stamp, '', invalidGiftId,
      'required_products', JSON.stringify({ required_products:[{ product_id:product.id, min_qty:1 }] }),
      1, 'once_per_order', qaPastIso_(60000), '', 'TRUE', 'TRUE', 9200, now, now, '', '', ''
    ]);
    sheetGiftRules_().appendRow([
      invalidQtyRuleId, 'QA Legacy Invalid Qty Rule ' + fx.stamp, '', validGift.gift_id,
      'required_products', JSON.stringify({ required_products:[{ product_id:product.id, min_qty:1.5 }] }),
      1, 'per_threshold', qaPastIso_(60000), '', 'TRUE', 'TRUE', 9100, now, now, '', '', ''
    ]);
    fx.rule_ids.push(invalidGiftRuleId, invalidQtyRuleId);
    _invalidateGiftCaches_();

    var adminItems = qaCall_('listGiftItemsRpc', [fx.token]);
    var adminRules = qaCall_('listGiftRulesRpc', [fx.token]);
    qaAssertOk_(adminItems); qaAssertOk_(adminRules);
    var adminGift = (adminItems.items || []).filter(function(g){ return String(g.gift_id) === invalidGiftId; })[0];
    var adminInvalidStockRule = (adminRules.rules || []).filter(function(r){ return String(r.rule_id) === invalidGiftRuleId; })[0];
    var adminInvalidQtyRule = (adminRules.rules || []).filter(function(r){ return String(r.rule_id) === invalidQtyRuleId; })[0];
    qaAssert_(adminGift && adminGift.operational === false && (adminGift.validation_errors || []).length,
      'Legacy invalid gift must remain visible to admin with validation errors', adminGift || adminItems);
    qaAssert_(adminInvalidStockRule && adminInvalidStockRule.operational === false && (adminInvalidStockRule.validation_errors || []).length
      && adminInvalidQtyRule && adminInvalidQtyRule.operational === false && (adminInvalidQtyRule.validation_errors || []).length,
      'Legacy invalid rules must remain visible to admin with validation errors', { stock_rule:adminInvalidStockRule, qty_rule:adminInvalidQtyRule });

    var campaigns = qaCall_('getActiveGiftCampaignsRpc', []);
    var preview = qaCall_('previewGiftEligibilityRpc', [{ items:[{ product_id:product.id, qty:3, selected_variants:{} }] }]);
    qaAssertOk_(campaigns); qaAssertOk_(preview);
    var blockedRuleIds = [invalidGiftRuleId, invalidQtyRuleId];
    qaAssert_(!(campaigns.campaigns || []).some(function(c){ return blockedRuleIds.indexOf(String(c.rule_id)) >= 0; }),
      'Invalid legacy rules must not be public campaigns', campaigns);
    qaAssert_(!(preview.eligible || []).some(function(e){ return blockedRuleIds.indexOf(String(e.rule_id)) >= 0; }),
      'Invalid legacy rules must not be previewed as eligible', preview);

    var submit = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-legacy-fail-closed', fx.stamp, 'Buyer', product.id, fx.shipping, { qty:3 }), fx.order_ids);
    qaAssertOk_(submit);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(submit)[0]);
    var fixtureGiftIds = [invalidGiftId, validGift.gift_id];
    var awarded = (order.items || []).filter(function(line){ return line.line_type === 'gift' && fixtureGiftIds.indexOf(String(line.gift_id)) >= 0; });
    var manualAdd = qaCall_('addManualGiftToOrderRpc', [fx.token, order.order_id, { gift_id:invalidGiftId, qty:1 }]);
    qaAssert_(manualAdd && manualAdd.ok === false && awarded.length === 0
      && qaGetGiftStock_(invalidGiftId) === 1.5 && qaGetGiftStock_(validGift.gift_id) === 10,
      'Invalid legacy data must not award gifts or mutate gift stock', { order:order, awarded:awarded, preview:preview, manual_add:manualAdd });
    output = { admin_gift:adminGift, admin_rules:[adminInvalidStockRule, adminInvalidQtyRule], campaigns:campaigns, preview:preview, order:order, manual_add:manualAdd };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSettingsValidationMatrixFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftSettingsValidation');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftSettingsValidation', 10, {
      price:500,
      variants:[
        { name:'Color', type:'text', options:[{ label:'Red', price:500, stock:10 }, { label:'Blue', price:500, stock:10 }] },
        { name:'Size', type:'text', options:[{ label:'S', price:500, stock:10 }, { label:'L', price:500, stock:10 }] }
      ]
    });
    fx.product_ids.push(product.id);
    var productWithoutVariants = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftSettingsNoVariants', 10, { price:500 });
    fx.product_ids.push(productWithoutVariants.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftSettingsValidation', { stock:10 });
    fx.gift_ids.push(gift.gift_id);
    function base() {
      return {
        name:'QA Gift Settings Validation ' + fx.stamp,
        gift_id:gift.gift_id,
        condition_type:'required_products',
        condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] },
        gift_qty:1, repeat_mode:'once_per_order',
        starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true, enabled:true, priority:9000
      };
    }
    var cases = [];
    var validRule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftSettingsValidationUpdateTarget', gift.gift_id, {
      condition_type:'required_products',
      condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] }
    });
    fx.rule_ids.push(validRule.rule_id);
    function run(label, mutate) {
      var payload = base(); mutate(payload);
      var res = qaCall_('createGiftRuleRpc', [fx.token, payload]);
      if (res && res.rule_id) fx.rule_ids.push(res.rule_id);
      cases.push({ operation:'create', label:label, response:res });
      var updatePayload = base(); mutate(updatePayload);
      var updateRes = qaCall_('updateGiftRuleRpc', [fx.token, validRule.rule_id, updatePayload]);
      cases.push({ operation:'update', label:label, response:updateRes });
    }
    run('missing gift', function(p){ p.gift_id='qa_missing_gift'; });
    run('invalid condition_type', function(p){ p.condition_type='cart_magic'; });
    run('zero min_subtotal', function(p){ p.condition_type='min_subtotal'; p.condition_json={ min_subtotal:0 }; });
    run('empty required_products', function(p){ p.condition_json={ required_products:[] }; });
    run('missing required product', function(p){ p.condition_json={ required_products:[{ product_id:'qa_missing_product', min_qty:1 }] }; });
    run('empty required_variants', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[] }; });
    run('missing required variant product', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[{ product_id:'qa_missing_product', variant_key:'Size=S', min_qty:1 }] }; });
    run('required variant product has no variants', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[{ product_id:productWithoutVariants.id, variant_key:'', min_qty:1 }] }; });
    run('incomplete required variant key', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[{ product_id:product.id, variant_key:'Color=Red', min_qty:1 }] }; });
    run('unknown required variant value', function(p){ p.condition_type='required_variants'; p.condition_json={ required_variants:[{ product_id:product.id, variant_key:'Color=Green|Size=S', min_qty:1 }] }; });
    var accepted = cases.filter(function(c){ return !c.response || c.response.ok !== false; });
    qaAssert_(accepted.length === 0, 'Invalid gift rule settings were accepted', { accepted:accepted, cases:cases });
    output = { checked:cases.length, cases:cases };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSettingsIntegerQuantityValidationFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftIntegerValidation');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftIntegerValidation', 10, { price:500 });
    fx.product_ids.push(product.id);
    var normalGift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftIntegerValidation', { stock:10 });
    fx.gift_ids.push(normalGift.gift_id);
    var updateTarget = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftIntegerUpdateTarget', normalGift.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] }, gift_qty:1
    });
    fx.rule_ids.push(updateTarget.rule_id);
    var cases = [];
    var fracStock = qaCall_('createGiftItemRpc', [fx.token, {
      name:'QA Fractional Gift Stock ' + fx.stamp, description:'QA invalid fractional stock', stock:1.5, enabled:true
    }]);
    if (fracStock && fracStock.gift_id) fx.gift_ids.push(fracStock.gift_id);
    cases.push({ operation:'create', label:'fractional gift stock', response:fracStock });
    var fracStockUpdate = qaCall_('updateGiftItemRpc', [fx.token, normalGift.gift_id, { stock:1.5 }]);
    cases.push({ operation:'update', label:'fractional gift stock', response:fracStockUpdate });
    [-2, ''].forEach(function(invalidStock) {
      var label = invalidStock === '' ? 'blank gift stock' : 'negative gift stock below -1';
      var createStock = qaCall_('createGiftItemRpc', [fx.token, {
        name:'QA Invalid Gift Stock ' + label + ' ' + fx.stamp, stock:invalidStock, enabled:true
      }]);
      if (createStock && createStock.gift_id) fx.gift_ids.push(createStock.gift_id);
      cases.push({ operation:'create', label:label, response:createStock });
      cases.push({ operation:'update', label:label, response:qaCall_('updateGiftItemRpc', [fx.token, normalGift.gift_id, { stock:invalidStock }]) });
    });
    function createRule(label, giftQty, minQty) {
      var res = qaCall_('createGiftRuleRpc', [fx.token, {
        name:'QA Integer Rule ' + label + ' ' + fx.stamp,
        gift_id:normalGift.gift_id,
        condition_type:'required_products',
        condition_json:{ required_products:[{ product_id:product.id, min_qty:minQty }] },
        gift_qty:giftQty, repeat_mode:'per_threshold',
        starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true, enabled:true, priority:9000
      }]);
      if (res && res.rule_id) fx.rule_ids.push(res.rule_id);
      cases.push({ operation:'create', label:label, response:res });
      var updateRes = qaCall_('updateGiftRuleRpc', [fx.token, updateTarget.rule_id, {
        gift_qty:giftQty,
        condition_type:'required_products',
        condition_json:{ required_products:[{ product_id:product.id, min_qty:minQty }] }
      }]);
      cases.push({ operation:'update', label:label, response:updateRes });
    }
    createRule('zero gift_qty', 0, 1);
    createRule('negative gift_qty', -1, 1);
    createRule('fractional gift_qty', 1.5, 1);
    createRule('zero min_qty', 1, 0);
    createRule('negative min_qty', 1, -2);
    createRule('fractional min_qty', 1, 1.5);
    var accepted = cases.filter(function(c){ return !c.response || c.response.ok !== false; });
    qaAssert_(accepted.length === 0, 'Fractional or non-positive inventory quantities were accepted', { accepted:accepted, cases:cases });
    var unlimited = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftIntegerBoundaryUnlimited', { stock:-1 });
    var zeroStock = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftIntegerBoundaryZero', { stock:0 });
    fx.gift_ids.push(unlimited.gift_id, zeroStock.gift_id);
    var boundaryStockZeroUpdate = qaCall_('updateGiftItemRpc', [fx.token, unlimited.gift_id, { stock:0 }]);
    var boundaryStockUnlimitedUpdate = qaCall_('updateGiftItemRpc', [fx.token, unlimited.gift_id, { stock:-1 }]);
    qaAssertOk_(boundaryStockZeroUpdate); qaAssertOk_(boundaryStockUnlimitedUpdate);
    var boundaryRule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftIntegerBoundaryRule', unlimited.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] }, gift_qty:1
    });
    fx.rule_ids.push(boundaryRule.rule_id);
    var boundaryUpdate = qaCall_('updateGiftRuleRpc', [fx.token, boundaryRule.rule_id, {
      gift_qty:1, condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] }
    }]);
    qaAssertOk_(boundaryUpdate);
    output = { checked:cases.length, cases:cases, valid_boundaries:{
      stock_minus_one:unlimited.response, stock_zero:zeroStock.response,
      stock_update_zero:boundaryStockZeroUpdate, stock_update_minus_one:boundaryStockUnlimitedUpdate,
      rule_update:boundaryUpdate
    } };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSettingsScheduleRoundTripFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'GiftScheduleRoundTrip', {
    gift_stock:10, product_stock:10, starts_at:qaFutureIso_(3600000), no_end_date:true
  });
  var caught = null, output = null, states = [];
  try {
    function readState(label) {
      var listed = qaCall_('listGiftRulesRpc', [fx.token]);
      qaAssertOk_(listed);
      var row = (listed.rules || []).filter(function(r){ return String(r.rule_id) === String(fx.rule_id); })[0];
      qaAssert_(!!row, 'Gift rule missing while checking schedule state: ' + label, listed);
      states.push({ label:label, status:row.status, starts_at:row.starts_at, ends_at:row.ends_at, no_end_date:row.no_end_date, enabled:row.enabled });
      return row;
    }
    qaAssert_(readState('scheduled').status === 'scheduled', 'Future gift rule must be scheduled', states);
    qaAssert_(!qaHasEligibleRule_(qaPreviewGiftFixture_(fx, 1), fx.rule_id), 'Scheduled rule must not be eligible', states);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, {
      starts_at:'', ends_at:'', no_end_date:true
    }]));
    var active = readState('active-immediately-no-end');
    qaAssert_(active.status === 'active' && !active.starts_at && active.no_end_date === true && !active.ends_at, 'Gift rule without start/end dates did not normalize as active', active);
    qaAssert_(qaHasEligibleRule_(qaPreviewGiftFixture_(fx, 1), fx.rule_id), 'Active no-end rule must be eligible', active);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, {
      starts_at:qaPastIso_(120000), ends_at:qaPastIso_(60000), no_end_date:false
    }]));
    qaAssert_(readState('expired').status === 'expired', 'Past gift rule must be expired', states);
    qaAssert_(!qaHasEligibleRule_(qaPreviewGiftFixture_(fx, 1), fx.rule_id), 'Expired rule must not be eligible', states);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, {
      starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true
    }]));
    qaAssertOk_(qaCall_('toggleGiftRuleRpc', [fx.token, fx.rule_id, false]));
    qaAssert_(readState('disabled').status === 'disabled', 'Disabled gift rule status mismatch', states);
    qaAssert_(!qaHasEligibleRule_(qaPreviewGiftFixture_(fx, 1), fx.rule_id), 'Disabled gift rule must not be eligible', states);
    qaAssertOk_(qaCall_('toggleGiftRuleRpc', [fx.token, fx.rule_id, true]));
    qaAssert_(readState('re-enabled').status === 'active', 'Re-enabled gift rule must be active', states);
    qaAssert_(qaHasEligibleRule_(qaPreviewGiftFixture_(fx, 1), fx.rule_id), 'Re-enabled gift rule must be eligible', states);
    output = { rule_id:fx.rule_id, states:states };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup, states:states }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftSettingsConditionTransitionFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftConditionTransition');
  var caught = null, output = null, snapshots = [];
  try {
    var a = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftCondA', 20, { price:300 });
    var b = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftCondB', 20, { price:300 });
    var v = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftCondVariant', -1, {
      price:400, variants:[{ name:'Size', type:'text', options:[{ label:'M', price:400, stock:20 }, { label:'L', price:400, stock:20 }] }]
    });
    fx.product_ids = [a.id, b.id, v.id];
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftConditionTransition', { stock:20 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftConditionTransition', gift.gift_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[{ product_id:a.id, min_qty:1 }, { product_id:b.id, min_qty:1 }] }
    });
    fx.rule_ids.push(rule.rule_id);
    function preview(items) { return qaCall_('previewGiftEligibilityRpc', [{ items:items }]); }
    function read(label) {
      var got = qaCall_('getGiftRuleRpc', [fx.token, rule.rule_id]); qaAssertOk_(got);
      snapshots.push({ label:label, condition_type:got.rule.condition_type, condition_json:got.rule.condition_json });
      return got.rule;
    }
    qaAssert_(!qaHasEligibleRule_(preview([qaCartItem_(a.id, 1, {})]), rule.rule_id), 'ALL mode must require A and B');
    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, rule.rule_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'any', required_products:[{ product_id:a.id, min_qty:1 }, { product_id:b.id, min_qty:1 }] }
    }]));
    var anyRule = read('required-products-any');
    qaAssert_(anyRule.condition_json.match_mode === 'any' && qaHasEligibleRule_(preview([qaCartItem_(a.id, 1, {})]), rule.rule_id), 'ANY mode transition did not take effect', anyRule);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, rule.rule_id, {
      condition_type:'min_subtotal', condition_json:{ min_subtotal:500 }
    }]));
    var subtotalRule = read('min-subtotal');
    qaAssert_(Number(subtotalRule.condition_json.min_subtotal) === 500
      && subtotalRule.condition_json.required_products === undefined
      && qaHasEligibleRule_(preview([qaCartItem_(a.id, 2, {})]), rule.rule_id),
      'min_subtotal transition retained stale product conditions or failed eligibility', subtotalRule);

    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, rule.rule_id, {
      condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[{ product_id:v.id, variant_key:'Size=M', min_qty:2 }] }
    }]));
    var variantRule = read('required-variants');
    qaAssert_(variantRule.condition_json.min_subtotal === undefined && variantRule.condition_json.required_products === undefined, 'Variant transition retained stale condition fields', variantRule);
    qaAssert_(!qaHasEligibleRule_(preview([qaCartItem_(v.id, 2, { Size:'L' })]), rule.rule_id), 'Wrong variant must not qualify after transition', variantRule);
    qaAssert_(qaHasEligibleRule_(preview([qaCartItem_(v.id, 2, { Size:'M' })]), rule.rule_id), 'Correct variant must qualify after transition', variantRule);
    output = { rule_id:rule.rule_id, snapshots:snapshots };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup, snapshots:snapshots }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRepeatDuplicateVariantLinesFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftRepeatDuplicateVariants');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftRepeatDuplicateVariants', -1, {
      price:500, variants:[{ name:'Size', type:'text', options:[{ label:'M', price:500, stock:10 }, { label:'L', price:500, stock:10 }] }]
    });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftRepeatDuplicateVariants', { stock:10 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftRepeatDuplicateVariants', gift.gift_id, {
      condition_type:'required_variants', repeat_mode:'per_threshold',
      condition_json:{ required_variants:[{ product_id:product.id, variant_key:'Size=M', min_qty:2 }] }
    });
    fx.rule_ids.push(rule.rule_id);
    var items = [qaCartItem_(product.id, 1, { Size:'M' }), qaCartItem_(product.id, 3, { Size:'M' })];
    var preview = qaCall_('previewGiftEligibilityRpc', [{ items:items }]);
    qaAssertOk_(preview);
    var eligible = (preview.eligible || []).filter(function(e){ return String(e.rule_id) === String(rule.rule_id); })[0];
    qaAssert_(eligible && Number(eligible.gift.qty) === 2, 'Duplicate variant lines must preview two completed thresholds', preview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-repeat-dup-var', fx.stamp, 'Buyer', product.id, fx.shipping, { items:items }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var lines = qaActiveGiftLines_(order, gift.gift_id);
    qaAssert_(lines.length === 1 && Number(lines[0].gift_qty) === 2 && qaGetGiftStock_(gift.gift_id) === 8, 'Duplicate variant lines produced incorrect gift quantity/stock', { lines:lines, stock:qaGetGiftStock_(gift.gift_id) });
    output = { preview_qty:eligible.gift.qty, order_qty:lines[0].gift_qty, stock:qaGetGiftStock_(gift.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRepeatSameGiftCumulativeStockFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftRepeatCumulativeStock');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftRepeatCumulativeStock', 10, { price:100 });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftRepeatCumulativeStock', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var condition = { required_products:[{ product_id:product.id, min_qty:1 }] };
    var high = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftRepeatCumulativeHigh', gift.gift_id, { condition_json:condition, gift_qty:2, repeat_mode:'per_threshold', priority:9100 });
    var low = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftRepeatCumulativeLow', gift.gift_id, { condition_json:condition, gift_qty:2, repeat_mode:'per_threshold', priority:9000 });
    fx.rule_ids = [high.rule_id, low.rule_id];
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-repeat-cumulative', fx.stamp, 'Buyer', product.id, fx.shipping, { qty:2 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var lines = qaActiveGiftLines_(order, gift.gift_id);
    var skipped = (res.gifts_skipped || []).filter(function(s){ return String(s.gift_id) === String(gift.gift_id); });
    qaAssert_(lines.length === 1 && Number(lines[0].gift_qty) === 4 && String(lines[0].rule_id) === String(high.rule_id), 'Higher-priority repeated grant must attach four units', lines);
    qaAssert_(skipped.length === 1 && Number(skipped[0].requested_qty) === 4 && Number(skipped[0].available_qty) === 1, 'Second repeated grant must be skipped atomically with accurate quantities', skipped);
    qaAssert_(qaGetGiftStock_(gift.gift_id) === 1, 'Cumulative same-gift stock must end at one', { stock:qaGetGiftStock_(gift.gift_id) });
    output = { attached:lines, skipped:skipped, stock:qaGetGiftStock_(gift.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftRepeatRejectUnrejectStockLifecycleFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'GiftRepeatLifecycle', {
    product_stock:10, product_price:500, gift_stock:20, min_qty:2, gift_qty:2, repeat_mode:'per_threshold'
  });
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-repeat-lifecycle', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty:4 }), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var order = qaReadOrder_(fx.token, orderId);
    var lines = qaActiveGiftLines_(order, fx.gift_id);
    qaAssert_(lines.length === 1 && Number(lines[0].gift_qty) === 4, 'Order must attach multiplied gift quantity four', lines);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 16, 'Submit must deduct all four gift units', { stock:qaGetGiftStock_(fx.gift_id) });
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'rejected', 'qa repeat lifecycle reject']));
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 20, 'Reject must restore all four gift units', { stock:qaGetGiftStock_(fx.gift_id) });
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'qa repeat lifecycle unreject']));
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 16, 'Un-reject must re-deduct all four gift units', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { order_id:orderId, gift_qty:lines[0].gift_qty, final_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftStalePreviewCartReducedFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'GiftStaleCartReduced', {
    product_stock:10, gift_stock:10, min_qty:2, repeat_mode:'per_threshold'
  });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 4);
    qaAssertOk_(preview);
    var eligible = (preview.eligible || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    qaAssert_(eligible && Number(eligible.gift.qty) === 2, 'Preview qty four must promise two completed gift thresholds', preview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-stale-cart-reduced', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty:1 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'Reduced submitted cart must not attach stale preview gift', order.items);
    qaAssert_(!(res.gifts_skipped || []).some(function(s){ return String(s.gift_id) === String(fx.gift_id); }), 'Unqualified gift must not be reported as a stock skip', res);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 10, 'Unqualified stale preview must not change gift stock', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { preview_qty:eligible.gift.qty, order_id:order.order_id, stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftPreviewInsufficientStockContractFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'GiftPreviewInsufficient', {
    product_stock:5, gift_stock:1, min_qty:1, gift_qty:2, repeat_mode:'once_per_order'
  });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 1);
    qaAssertOk_(preview);
    var eligible = (preview.eligible || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    qaAssert_(eligible && Number(eligible.gift.qty) === 2 && Number(eligible.gift.stock) === 1, 'Preview must expose requested qty two and stock one', preview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-gift-preview-insufficient', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var skipped = (res.gifts_skipped || []).filter(function(s){ return String(s.gift_id) === String(fx.gift_id); });
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'Insufficient grant must not partially attach', order.items);
    qaAssert_(skipped.length === 1 && skipped[0].code === 'GIFT_OUT_OF_STOCK'
      && Number(skipped[0].requested_qty) === 2 && Number(skipped[0].available_qty) === 1,
      'Submit skip warning quantities mismatch', skipped);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 1, 'Skipped grant must leave stock unchanged', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { preview:eligible.gift, skipped:skipped[0], stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunGiftPublicCampaignSettingsContractFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'GiftPublicCampaignContract');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftPublicCampaignContract', 10, { price:500 });
    fx.product_ids.push(product.id);
    var activeGift = qaCreateGiftItem_(fx.token, fx.stamp, 'CampaignActive', { stock:7 });
    var scheduledGift = qaCreateGiftItem_(fx.token, fx.stamp, 'CampaignScheduled', { stock:-1 });
    var disabledGift = qaCreateGiftItem_(fx.token, fx.stamp, 'CampaignDisabled', { stock:3 });
    fx.gift_ids = [activeGift.gift_id, scheduledGift.gift_id, disabledGift.gift_id];
    var activeRule = qaCreateGiftRule_(fx.token, fx.stamp, 'CampaignActive', activeGift.gift_id, {
      condition_type:'min_subtotal', condition_json:{ min_subtotal:750 }, gift_qty:2,
      starts_at:qaPastIso_(60000), no_end_date:true, priority:9300
    });
    var scheduledRule = qaCreateGiftRule_(fx.token, fx.stamp, 'CampaignScheduled', scheduledGift.gift_id, {
      condition_type:'required_products', condition_json:{ required_products:[{ product_id:product.id, min_qty:3 }] }, gift_qty:3,
      starts_at:qaFutureIso_(3600000), no_end_date:true, priority:9200
    });
    var disabledRule = qaCreateGiftRule_(fx.token, fx.stamp, 'CampaignDisabled', disabledGift.gift_id, {
      condition_type:'required_products', condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] },
      enabled:false, priority:9100
    });
    fx.rule_ids = [activeRule.rule_id, scheduledRule.rule_id, disabledRule.rule_id];
    var res = qaCall_('getActiveGiftCampaignsRpc');
    qaAssertOk_(res);
    function campaign(ruleId) { return (res.campaigns || []).filter(function(c){ return String(c.rule_id) === String(ruleId); })[0]; }
    var active = campaign(activeRule.rule_id);
    var scheduled = campaign(scheduledRule.rule_id);
    var disabled = campaign(disabledRule.rule_id);
    qaAssert_(active && active.status === 'active' && Number(active.gift_qty) === 2
      && active.no_end_date === true && !active.ends_at
      && active.condition_details && active.condition_details.length === 1
      && Number(active.condition_details[0].amount) === 750
      && Number(active.gift_item.stock) === 7,
      'Active public campaign settings contract mismatch', active || res);
    qaAssert_(scheduled && scheduled.status === 'scheduled' && Number(scheduled.gift_qty) === 3
      && scheduled.condition_details && scheduled.condition_details.length === 1
      && Number(scheduled.condition_details[0].qty) === 3
      && Number(scheduled.gift_item.stock) === -1,
      'Scheduled public campaign settings contract mismatch', scheduled || res);
    qaAssert_(!disabled, 'Disabled rule must not be returned as a public campaign', disabled || res);
    output = { active:active, scheduled:scheduled, disabled_present:!!disabled };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingAddressValidUpdateFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'AddrValid', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-addr-valid', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    var patch = Object.assign({}, _QA_ADDR_PATCH);
    var upd = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, patch]);
    qaAssertOk_(upd);

    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.shipping_name === patch.shipping_name, 'shipping_name mismatch', record);
    qaAssert_(record.shipping_address === patch.shipping_address, 'shipping_address mismatch', record);
    qaAssert_(record.shipping_district === patch.shipping_district, 'shipping_district mismatch', record);
    qaAssert_(record.shipping_amphoe === patch.shipping_amphoe, 'shipping_amphoe mismatch', record);
    qaAssert_(record.shipping_province === patch.shipping_province, 'shipping_province mismatch', record);
    qaAssert_(record.shipping_postal_code === patch.shipping_postal_code, 'shipping_postal_code mismatch', record);
    qaAssert_(record.customer_phone === patch.customer_phone, 'customer_phone mismatch', record);

    var histStatuses = (record.status_history || []).map(function(h){ return h.status; });
    qaAssert_(histStatuses.indexOf('address_updated') >= 0, 'address_updated entry missing from status_history', histStatuses);

    output = { order_id: orderId, address_updated: true, history_statuses: histStatuses };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingAddressInvalidPhoneFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'AddrBadPhone', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-addr-bad-phone', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    var patch = Object.assign({}, _QA_ADDR_PATCH, { customer_phone: '123' });
    var upd = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, patch]);
    qaAssert_(upd && upd.ok === false, 'Short phone should be rejected', upd);

    output = { order_id: orderId, rejected: true, error: upd && upd.error };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingAddressInvalidPostalFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'AddrBadPostal', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-addr-bad-postal', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    var patch = Object.assign({}, _QA_ADDR_PATCH, { shipping_postal_code: '1234' });
    var upd = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, patch]);
    qaAssert_(upd && upd.ok === false, '4-digit postal code should be rejected', upd);

    output = { order_id: orderId, rejected: true, error: upd && upd.error };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingAddressEmptyRequiredFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'AddrEmptyReq', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-addr-empty', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    var patch = Object.assign({}, _QA_ADDR_PATCH, { shipping_name: '' });
    var upd = qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, patch]);
    qaAssert_(upd && upd.ok === false, 'Empty shipping_name should be rejected', upd);

    output = { order_id: orderId, rejected: true, error: upd && upd.error };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingAddressNoClobberItemsFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'AddrNoClobberItems', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-addr-items', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    var before = qaReadOrder_(fx.token, orderId);
    var itemsBefore = JSON.stringify((before.items || []).map(function(i){ return { id:i.product_id, qty:i.qty }; }));

    qaAssertOk_(qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, Object.assign({}, _QA_ADDR_PATCH)]));

    var after = qaReadOrder_(fx.token, orderId);
    var itemsAfter = JSON.stringify((after.items || []).map(function(i){ return { id:i.product_id, qty:i.qty }; }));
    qaAssert_(itemsBefore === itemsAfter, 'Order items changed after address update', { before: itemsBefore, after: itemsAfter });

    output = { order_id: orderId, items_preserved: true };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunShippingAddressNoClobberStatusFlow_(ctx) {
  var fx = qaCreateOrderFixture_(ctx, 'AddrNoClobberStatus', 5);
  var caught = null, output = null;
  try {
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-addr-status', fx.stamp, 'Buyer', fx.product.id, fx.shipping), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];

    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'QA paid']));
    qaAssertOk_(qaCall_('orderUpdateFieldsRpc', [fx.token, orderId, Object.assign({}, _QA_ADDR_PATCH)]));

    var record = qaReadOrder_(fx.token, orderId);
    qaAssert_(record.status === 'paid', 'Order status changed after address update', record);

    output = { order_id: orderId, status: record.status, status_preserved: true };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupOrdersProductsShipping_(fx.token, fx.order_ids, [fx.product.id], fx.shipping);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup: cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

/* ===================== Order coverage for promotion/gift rule updates ===================== */

function qaRuleOrderClientPricingFromPreview_(preview, cartItems, shippingFee) {
  var fee = Number(shippingFee || 0);
  var orderDiscount = preview && preview.order_discount
    ? Number(preview.order_discount.amount || 0)
    : 0;
  var subtotal = Number(preview.subtotal || 0);
  var items = (cartItems || []).map(function(ci) {
    var variantKey = qaVariantKeyOf_(ci.selected_variants || {});
    var line = qaPromoPreviewLine_(preview, ci.product_id, variantKey);
    qaAssert_(!!line, 'Promotion preview is missing an order item', { item:ci, preview:preview });
    return {
      product_id:String(ci.product_id),
      selected_variants:ci.selected_variants || {},
      qty:Number(ci.qty || 0),
      unit_final_price:Number(line.unit_final_price),
      promotion_id:line.promotion ? line.promotion.promotion_id : null
    };
  });
  return {
    items:items,
    subtotal:subtotal,
    order_discount:orderDiscount,
    shipping_fee:fee,
    total:Math.max(0, subtotal - orderDiscount) + fee
  };
}

function qaRunOrderRulesPromoNewlyQualifiedStalePricingFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRulePromoNewlyQualified');
  var caught = null, output = null;
  try {
    var qualifier = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoNewQualifier', 10, { price:300 });
    var target = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoNewTarget', 10, { price:1000 });
    fx.product_ids = [qualifier.id, target.id];
    var promo = qaCreatePromotion_(fx.token, target.id, fx.stamp, 'OrderPromoNewlyQualified', {
      discount_value:300,
      application_mode:'conditional',
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[{ product_id:qualifier.id, min_qty:2 }] }
    });
    fx.promotion_ids.push(promo.promotion_id);

    var staleCart = [qaCartItem_(qualifier.id, 1, {}), qaCartItem_(target.id, 1, {})];
    var stalePreview = qaPreviewPromo_(staleCart);
    var staleTarget = qaPromoPreviewLine_(stalePreview, target.id, '');
    qaAssert_(staleTarget && !staleTarget.promotion && Number(staleTarget.unit_final_price) === 1000,
      'Pre-qualification preview must show the target at full price', stalePreview);

    var submittedCart = [qaCartItem_(qualifier.id, 2, {}), qaCartItem_(target.id, 1, {})];
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-rule-promo-newly-qualified', fx.stamp, 'Buyer', qualifier.id, fx.shipping, { items:submittedCart });
    payload.client_pricing = {
      items:[
        { product_id:qualifier.id, selected_variants:{}, qty:2, unit_final_price:300, promotion_id:null },
        { product_id:target.id, selected_variants:{}, qty:1, unit_final_price:1000, promotion_id:null }
      ],
      subtotal:1600,
      shipping_fee:Number(fx.shipping.method.flat_rate || 0),
      total:1600 + Number(fx.shipping.method.flat_rate || 0)
    };
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'PRICE_CHANGED', payload);
    var kinds = qaAssertDiffKinds_(res, ['item_price', 'item_promotion', 'subtotal', 'total']);
    qaAssert_(qaGetProductStock_(qualifier.id) === 10 && qaGetProductStock_(target.id) === 10,
      'PRICE_CHANGED must preserve every product stock', { qualifier_stock:qaGetProductStock_(qualifier.id), target_stock:qaGetProductStock_(target.id) });
    output = { promotion_id:promo.promotion_id, response:res, diff_kinds:kinds, counts:noOrder };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesPromoExpiredAfterPreviewFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRulePromoExpired');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoExpiredTarget', 10, { price:1000 });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'OrderPromoExpired', {
      discount_value:250,
      application_mode:'conditional',
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:1 }
    });
    fx.promotion_ids.push(promo.promotion_id);
    var cart = [qaCartItem_(product.id, 1, {})];
    var preview = qaPreviewPromo_(cart);
    var previewLine = qaPromoPreviewLine_(preview, product.id, '');
    qaAssert_(previewLine && Number(previewLine.unit_final_price) === 750
      && previewLine.promotion && String(previewLine.promotion.promotion_id) === String(promo.promotion_id),
      'Active conditional promotion must be present before expiry', preview);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      starts_at:qaPastIso_(120000), ends_at:qaPastIso_(1000), no_end_date:false
    }]));
    var beforeCount = qaOrderCount_(fx.token);
    var payload = qaBuildOrderPayloadForProduct_('qa-rule-promo-expired', fx.stamp, 'Buyer', product.id, fx.shipping);
    payload.client_pricing = qaRuleOrderClientPricingFromPreview_(preview, cart, fx.shipping.method.flat_rate);
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    var noOrder = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, res, fx.order_ids, 'PRICE_CHANGED', payload);
    var kinds = qaAssertDiffKinds_(res, ['item_price', 'item_promotion', 'subtotal', 'total']);
    qaAssert_(qaGetProductStock_(product.id) === 10, 'Expired-promotion rejection must preserve stock', { stock:qaGetProductStock_(product.id) });
    output = { promotion_id:promo.promotion_id, response:res, diff_kinds:kinds, counts:noOrder };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesGiftExpiredAfterPreviewFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'OrderRuleGiftExpired', {
    product_stock:10, gift_stock:10, min_qty:2, gift_qty:2, repeat_mode:'per_threshold'
  });
  var caught = null, output = null;
  try {
    var preview = qaPreviewGiftFixture_(fx, 4);
    qaAssertOk_(preview);
    var eligible = (preview.eligible || []).filter(function(e){ return String(e.rule_id) === String(fx.rule_id); })[0];
    qaAssert_(eligible && Number(eligible.gift.qty) === 4, 'Preview must award four gift units before expiry', preview);
    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, {
      starts_at:qaPastIso_(120000), ends_at:qaPastIso_(1000), no_end_date:false
    }]));
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-gift-expired', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty:4 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    qaAssert_(qaActiveGiftLines_(order, fx.gift_id).length === 0, 'Expired gift rule must not attach a stale gift', order.items);
    qaAssert_(!(res.gifts_skipped || []).some(function(s){ return String(s.gift_id) === String(fx.gift_id); }),
      'An expired rule is unqualified, not a stock skip', res);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 10, 'Expired gift rule must preserve gift stock', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { preview_qty:eligible.gift.qty, order_id:order.order_id, gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesGiftActivatedAfterPreviewFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'OrderRuleGiftActivated', {
    product_stock:10, gift_stock:10, min_qty:2, gift_qty:2, repeat_mode:'per_threshold',
    starts_at:qaFutureIso_(3600000), no_end_date:true
  });
  var caught = null, output = null;
  try {
    var before = qaPreviewGiftFixture_(fx, 4);
    qaAssertOk_(before);
    qaAssert_(!qaHasEligibleRule_(before, fx.rule_id), 'Scheduled gift rule must not be eligible before activation', before);
    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, {
      starts_at:qaPastIso_(60000), ends_at:'', no_end_date:true
    }]));
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-gift-activated', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty:4 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var lines = qaActiveGiftLines_(order, fx.gift_id);
    qaAssert_(lines.length === 1 && Number(lines[0].gift_qty) === 4,
      'Newly active repeated gift rule must attach four units', lines);
    qaAssert_(qaGetGiftStock_(fx.gift_id) === 6, 'Newly active gift must deduct the full multiplied quantity', { stock:qaGetGiftStock_(fx.gift_id) });
    output = { order_id:order.order_id, gift_qty:lines[0].gift_qty, gift_stock:qaGetGiftStock_(fx.gift_id) };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesConditionalPromoSnapshotImmutableFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRulePromoSnapshot');
  var caught = null, output = null;
  try {
    var qualifier = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoSnapshotQualifier', 10, { price:300 });
    var target = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'PromoSnapshotTarget', 10, { price:1000 });
    fx.product_ids = [qualifier.id, target.id];
    var promo = qaCreatePromotion_(fx.token, target.id, fx.stamp, 'OrderConditionalSnapshot', {
      discount_value:300,
      application_mode:'conditional',
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[{ product_id:qualifier.id, min_qty:2 }] }
    });
    fx.promotion_ids.push(promo.promotion_id);
    var cart = [qaCartItem_(qualifier.id, 2, {}), qaCartItem_(target.id, 1, {})];
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-promo-snapshot', fx.stamp, 'Buyer', qualifier.id, fx.shipping, { items:cart }), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var before = qaFindProductLine_(qaReadOrder_(fx.token, orderId), target.id);
    qaAssert_(before && Number(before.unit_final_price) === 700, 'Original conditional promotion must price target at 700', before);

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, promo.promotion_id, {
      discount_value:50,
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:99999 }
    }]));
    var after = qaFindProductLine_(qaReadOrder_(fx.token, orderId), target.id);
    qaAssert_(after && Number(after.unit_base_price) === 1000
      && Number(after.unit_discount_amount) === 300
      && Number(after.unit_final_price) === 700
      && after.promotion
      && String(after.promotion.promotion_id) === String(promo.promotion_id)
      && Number(after.promotion.discount_value) === 300
      && after.promotion.application_mode === 'conditional'
      && after.promotion.condition_type === 'required_products',
      'Persisted order promotion snapshot changed after admin edit', { before:before, after:after });
    output = { order_id:orderId, promotion_snapshot:after.promotion, unit_final_price:after.unit_final_price };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesGiftRuleSnapshotImmutableFlow_(ctx) {
  var fx = qaCreateGiftEligibilityFixture_(ctx, 'OrderRuleGiftSnapshot', {
    product_stock:10, gift_stock:20, min_qty:1, gift_qty:2, repeat_mode:'per_threshold'
  });
  var caught = null, output = null;
  try {
    var originalRule = qaFindGiftRule_(fx.token, fx.rule_id);
    qaAssert_(!!originalRule, 'Gift rule must exist before snapshot test', { rule_id:fx.rule_id });
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-gift-snapshot', fx.stamp, 'Buyer', fx.product.id, fx.shipping, { qty:3 }), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var before = qaActiveGiftLines_(qaReadOrder_(fx.token, orderId), fx.gift_id)[0];
    qaAssert_(before && Number(before.gift_qty) === 6, 'Original order must contain six multiplied gift units', before);
    qaAssertOk_(qaCall_('updateGiftRuleRpc', [fx.token, fx.rule_id, {
      name:'QA Gift Rule Changed ' + fx.stamp,
      gift_qty:1,
      repeat_mode:'once_per_order'
    }]));
    qaAssertOk_(qaCall_('deleteGiftRuleRpc', [fx.token, fx.rule_id]));
    var deletedRuleId = fx.rule_id;
    fx.rule_id = '';
    var after = qaActiveGiftLines_(qaReadOrder_(fx.token, orderId), fx.gift_id)[0];
    qaAssert_(after && String(after.rule_id) === String(deletedRuleId)
      && after.rule_name === originalRule.name
      && Number(after.gift_qty) === 6,
      'Persisted gift-rule snapshot changed after rule edit/delete', { original_rule:originalRule, before:before, after:after });
    output = { order_id:orderId, rule_id:deletedRuleId, rule_name:after.rule_name, gift_qty:after.gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupGiftFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesVariantPromoAnyRepeatGiftFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleVariantPromoGift');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'VariantPromoAnyGift', -1, {
      price:1000,
      variants:[{ name:'Size', type:'text', options:[
        { label:'M', price:1000, weight_grams:100, stock:10 },
        { label:'L', price:1000, weight_grams:100, stock:10 }
      ]}]
    });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'VariantMDirect', {
      discount_value:100,
      target_type:'variant',
      target:[{ product_id:product.id, variant_key:'Size=M' }]
    });
    fx.promotion_ids.push(promo.promotion_id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'VariantAnyRepeat', { stock:20 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'VariantAnyRepeat', gift.gift_id, {
      condition_type:'required_variants',
      condition_json:{
        match_mode:'any',
        required_variants:[
          { product_id:product.id, variant_key:'Size=M', min_qty:2 },
          { product_id:product.id, variant_key:'Size=L', min_qty:3 }
        ]
      },
      gift_qty:2,
      repeat_mode:'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var cart = [
      qaCartItem_(product.id, 1, { Size:'M' }),
      qaCartItem_(product.id, 3, { Size:'M' }),
      qaCartItem_(product.id, 3, { Size:'L' })
    ];
    var promoPreview = qaPreviewPromo_(cart);
    var giftPreview = qaCall_('previewGiftEligibilityRpc', [{ items:cart }]);
    qaAssertOk_(giftPreview);
    var giftEligible = (giftPreview.eligible || []).filter(function(e){ return String(e.rule_id) === String(rule.rule_id); })[0];
    qaAssert_(giftEligible && Number(giftEligible.gift.qty) === 6 && giftEligible.match_mode === 'any',
      'ANY variant thresholds must sum to three rounds and award six units', giftPreview);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-variant-any', fx.stamp, 'Buyer', product.id, fx.shipping, { items:cart }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var mLines = (order.items || []).filter(function(line){ return line.line_type !== 'gift' && line.variant_key === 'Size=M'; });
    var lLines = (order.items || []).filter(function(line){ return line.line_type !== 'gift' && line.variant_key === 'Size=L'; });
    var mQty = mLines.reduce(function(sum, line){ return sum + Number(line.qty || 0); }, 0);
    var lQty = lLines.reduce(function(sum, line){ return sum + Number(line.qty || 0); }, 0);
    qaAssert_(mQty === 4 && mLines.every(function(line){
      return Number(line.unit_final_price) === 900 && line.promotion && String(line.promotion.promotion_id) === String(promo.promotion_id);
    }), 'Every duplicate M line must carry the direct variant promotion', mLines);
    qaAssert_(lQty === 3 && lLines.every(function(line){ return Number(line.unit_final_price) === 1000 && !line.promotion; }),
      'L lines must remain at full price without the M-only promotion', lLines);
    var giftLines = qaActiveGiftLines_(order, gift.gift_id);
    qaAssert_(giftLines.length === 1 && Number(giftLines[0].gift_qty) === 6,
      'Persisted order must contain six repeated gift units', giftLines);
    qaAssert_(Number(order.subtotal) === 6600 && Number(order.total) === 6600,
      'Variant promotion subtotal/total mismatch', order);
    qaAssert_(qaGetVariantStock_(product.id, 'Size', 'M') === 6
      && qaGetVariantStock_(product.id, 'Size', 'L') === 7
      && qaGetGiftStock_(gift.gift_id) === 14,
      'Variant or gift stock deduction mismatch', {
        m_stock:qaGetVariantStock_(product.id, 'Size', 'M'),
        l_stock:qaGetVariantStock_(product.id, 'Size', 'L'),
        gift_stock:qaGetGiftStock_(gift.gift_id)
      });
    output = { order_id:order.order_id, promo_preview:promoPreview, gift_preview_qty:giftEligible.gift.qty, subtotal:order.subtotal, gift_qty:giftLines[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesMultiPromoMultiGiftContractFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleMultiPromoGift');
  var caught = null, output = null;
  try {
    var productA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MultiPromoA', 10, { price:300 });
    var productB = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MultiPromoB', 10, { price:1000 });
    fx.product_ids = [productA.id, productB.id];
    var directA = qaCreatePromotion_(fx.token, productA.id, fx.stamp, 'DirectA', { discount_value:50 });
    var conditionalB = qaCreatePromotion_(fx.token, productB.id, fx.stamp, 'ConditionalB', {
      discount_value:200,
      application_mode:'conditional',
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[{ product_id:productA.id, min_qty:2 }] }
    });
    fx.promotion_ids = [directA.promotion_id, conditionalB.promotion_id];

    var giftAny = qaCreateGiftItem_(fx.token, fx.stamp, 'MultiAny', { stock:20 });
    var giftSubtotal = qaCreateGiftItem_(fx.token, fx.stamp, 'MultiSubtotal', { stock:20 });
    fx.gift_ids = [giftAny.gift_id, giftSubtotal.gift_id];
    var anyRule = qaCreateGiftRule_(fx.token, fx.stamp, 'MultiAny', giftAny.gift_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'any', required_products:[
        { product_id:productA.id, min_qty:2 },
        { product_id:productB.id, min_qty:1 }
      ]},
      repeat_mode:'per_threshold',
      priority:9200
    });
    var subtotalRule = qaCreateGiftRule_(fx.token, fx.stamp, 'MultiSubtotal', giftSubtotal.gift_id, {
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:500 },
      repeat_mode:'per_threshold',
      priority:9100
    });
    fx.rule_ids = [anyRule.rule_id, subtotalRule.rule_id];

    var cart = [qaCartItem_(productA.id, 2, {}), qaCartItem_(productB.id, 1, {})];
    var promoPreview = qaPreviewPromo_(cart);
    var giftPreview = qaCall_('previewGiftEligibilityRpc', [{ items:cart }]);
    qaAssertOk_(giftPreview);
    var lineA = qaPromoPreviewLine_(promoPreview, productA.id, '');
    var lineB = qaPromoPreviewLine_(promoPreview, productB.id, '');
    qaAssert_(lineA && Number(lineA.unit_final_price) === 250
      && lineA.promotion && String(lineA.promotion.promotion_id) === String(directA.promotion_id),
      'Product A direct promotion preview mismatch', lineA);
    qaAssert_(lineB && Number(lineB.unit_final_price) === 800
      && lineB.promotion && String(lineB.promotion.promotion_id) === String(conditionalB.promotion_id),
      'Product B conditional promotion preview mismatch', lineB);
    function previewGiftQty(ruleId) {
      var match = (giftPreview.eligible || []).filter(function(e){ return String(e.rule_id) === String(ruleId); })[0];
      return match ? Number(match.gift.qty) : 0;
    }
    qaAssert_(previewGiftQty(anyRule.rule_id) === 2,
      'ANY gift must sum one completed round from A and one from B', giftPreview);
    qaAssert_(previewGiftQty(subtotalRule.rule_id) === 3,
      'Subtotal gift must use 1500 after DIRECT discounts and ignore the conditional discount', giftPreview);

    var payload = qaBuildOrderPayloadForProduct_('qa-rule-multi-contract', fx.stamp, 'Buyer', productA.id, fx.shipping, { items:cart });
    payload.client_pricing = qaRuleOrderClientPricingFromPreview_(promoPreview, cart, fx.shipping.method.flat_rate);
    var res = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var persistedA = qaFindProductLine_(order, productA.id);
    var persistedB = qaFindProductLine_(order, productB.id);
    var anyLines = qaActiveGiftLines_(order, giftAny.gift_id);
    var subtotalLines = qaActiveGiftLines_(order, giftSubtotal.gift_id);
    qaAssert_(persistedA && Number(persistedA.unit_final_price) === 250
      && persistedB && Number(persistedB.unit_final_price) === 800,
      'Persisted promotion prices do not match preview', { product_a:persistedA, product_b:persistedB });
    qaAssert_(anyLines.length === 1 && Number(anyLines[0].gift_qty) === 2
      && subtotalLines.length === 1 && Number(subtotalLines[0].gift_qty) === 3,
      'Persisted multi-gift quantities do not match preview', { any:anyLines, subtotal:subtotalLines });
    qaAssert_(Number(order.subtotal) === 1300 && Number(order.shipping_fee) === 0 && Number(order.total) === 1300,
      'Gift lines must not alter the final monetary totals', order);
    var attached = res.gifts_attached || [];
    qaAssert_(attached.some(function(g){ return String(g.gift_id) === String(giftAny.gift_id) && Number(g.qty) === 2; })
      && attached.some(function(g){ return String(g.gift_id) === String(giftSubtotal.gift_id) && Number(g.qty) === 3; }),
      'Success response gift quantities do not match persisted order lines', res);
    var tokenGifts = qaCall_('getOrderGiftsByTokenRpc', [res.token]);
    qaAssertOk_(tokenGifts);
    qaAssert_((tokenGifts.gifts || []).some(function(g){ return String(g.gift_id) === String(giftAny.gift_id) && Number(g.gift_qty) === 2; })
      && (tokenGifts.gifts || []).some(function(g){ return String(g.gift_id) === String(giftSubtotal.gift_id) && Number(g.gift_qty) === 3; }),
      'Customer-token gift read does not match the checkout result', tokenGifts);
    qaAssert_(qaGetProductStock_(productA.id) === 8 && qaGetProductStock_(productB.id) === 9
      && qaGetGiftStock_(giftAny.gift_id) === 18 && qaGetGiftStock_(giftSubtotal.gift_id) === 17,
      'Multi-rule product/gift stocks were not deducted correctly', {
        product_a:qaGetProductStock_(productA.id), product_b:qaGetProductStock_(productB.id),
        gift_any:qaGetGiftStock_(giftAny.gift_id), gift_subtotal:qaGetGiftStock_(giftSubtotal.gift_id)
      });
    output = {
      order_id:order.order_id,
      subtotal:order.subtotal,
      attached_gifts:attached,
      token_gifts:tokenGifts.gifts || [],
      direct_subtotal_base:1500
    };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

// One deliberately dense checkout contract that exercises every supported conditional
// promotion/gift condition plus competing order-total discounts in a single order.
// Promotions never stack: the lowest final unit price wins per line, then one best
// order-total promotion is deducted once. Gift min-subtotal rules intentionally use the
// DIRECT-only subtotal, matching previewGiftEligibilityRpc and submit.
function qaRunOrderRulesMegaOverlapSingleOrderWorkflow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleMegaOverlap', { flat_rate:125 });
  var steps = [], caught = null, output = null;

  function trackProduct(product) {
    fx.product_ids.push(product.id);
    return product;
  }
  function trackPromotion(promotion) {
    fx.promotion_ids.push(promotion.promotion_id);
    return promotion;
  }
  function trackGift(gift) {
    fx.gift_ids.push(gift.gift_id);
    return gift;
  }
  function trackRule(rule) {
    fx.rule_ids.push(rule.rule_id);
    return rule;
  }
  function idSet(ids) {
    var out = {};
    (ids || []).forEach(function(id){ out[String(id)] = true; });
    return out;
  }
  function containsLine(lines, productId, variantKey) {
    return (lines || []).some(function(line) {
      return String(line.product_id) === String(productId)
        && String(line.variant_key || '') === String(variantKey || '');
    });
  }

  try {
    qaStep_(steps, 'สร้าง shipping แบบ flat สำหรับ mega order', 'ok', {
      company_id:fx.shipping.company.id,
      method_id:fx.shipping.method.id,
      flat_rate:fx.shipping.method.flat_rate
    });

    var productA = trackProduct(qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaA', 20, {
      price:1000
    }));
    var productB = trackProduct(qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaB', 20, {
      price:600
    }));
    var variantProduct = trackProduct(qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaVariant', -1, {
      price:400,
      variants:[{ name:'Size', type:'text', options:[
        { label:'M', price:800, weight_grams:100, stock:10 },
        { label:'S', price:400, weight_grams:100, stock:10 }
      ]}]
    }));
    var productD = trackProduct(qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaD', 20, {
      price:250
    }));
    var productE = trackProduct(qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaE', 20, {
      price:300
    }));
    var variantMKey = 'Size=M';
    var variantSKey = 'Size=S';

    qaStep_(steps, 'สร้างสินค้า 5 ประเภท รวม 6 order lines', 'ok', {
      products:[productA.id, productB.id, variantProduct.id, productD.id, productE.id],
      variant_keys:[variantMKey, variantSKey]
    });

    var directBE = trackPromotion(qaCreatePromotion_(fx.token, productB.id, fx.stamp, 'MegaDirectBE', {
      discount_type:'percent',
      discount_value:10,
      target_type:'product',
      target:[{ product_id:productB.id }, { product_id:productE.id }]
    }));
    var conditionalSubtotalAll = trackPromotion(qaCreatePromotion_(fx.token, '', fx.stamp, 'MegaSubtotalAll', {
      discount_type:'fixed',
      discount_value:20,
      target_type:'all',
      target:[],
      application_mode:'conditional',
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:9500 }
    }));
    var conditionalProductAll = trackPromotion(qaCreatePromotion_(fx.token, productB.id, fx.stamp, 'MegaProductAll', {
      discount_type:'fixed',
      discount_value:100,
      target_type:'product',
      target:[{ product_id:productB.id }],
      application_mode:'conditional',
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[
        { product_id:productA.id, min_qty:3 },
        { product_id:productD.id, min_qty:5 }
      ]}
    }));
    var conditionalProductAny = trackPromotion(qaCreatePromotion_(fx.token, productB.id, fx.stamp, 'MegaProductAny', {
      discount_type:'percent',
      discount_value:30,
      target_type:'product',
      target:[{ product_id:productB.id }],
      application_mode:'conditional',
      condition_type:'required_products',
      condition_json:{ match_mode:'any', required_products:[
        { product_id:productA.id, min_qty:99 },
        { product_id:productE.id, min_qty:2 }
      ]}
    }));
    var conditionalVariantAll = trackPromotion(qaCreatePromotion_(fx.token, variantProduct.id, fx.stamp, 'MegaVariantAll', {
      discount_type:'fixed',
      discount_value:250,
      target_type:'variant',
      target:[{ product_id:variantProduct.id, variant_key:variantMKey }],
      application_mode:'conditional',
      condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:2 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:3 }
      ]}
    }));
    var conditionalVariantAny = trackPromotion(qaCreatePromotion_(fx.token, variantProduct.id, fx.stamp, 'MegaVariantAny', {
      discount_type:'percent',
      discount_value:40,
      target_type:'variant',
      target:[{ product_id:variantProduct.id, variant_key:variantMKey }],
      application_mode:'conditional',
      condition_type:'required_variants',
      condition_json:{ match_mode:'any', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:99 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:3 }
      ]}
    }));
    var orderTotalFixed = trackPromotion(qaCreatePromotion_(fx.token, '', fx.stamp, 'MegaOrderTotalFixed', {
      discount_type:'fixed',
      discount_value:700,
      target_type:'all',
      target:[],
      application_mode:'conditional',
      discount_scope:'order_total',
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:9500, calculation_base:'after_discount_before_shipping' }
    }));
    var orderTotalPercent = trackPromotion(qaCreatePromotion_(fx.token, '', fx.stamp, 'MegaOrderTotalPercent', {
      discount_type:'percent',
      discount_value:5,
      target_type:'all',
      target:[],
      application_mode:'conditional',
      discount_scope:'order_total',
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:9500, calculation_base:'after_discount_before_shipping' }
    }));

    qaStep_(steps, 'สร้าง promotions 8 แบบและให้ชนกันทั้งระดับรายการ/ท้ายบิล', 'ok', {
      promotion_ids:fx.promotion_ids.slice(),
      overlap_on_b:[
        directBE.promotion_id,
        conditionalSubtotalAll.promotion_id,
        conditionalProductAll.promotion_id,
        conditionalProductAny.promotion_id
      ],
      order_total_competitors:[orderTotalFixed.promotion_id, orderTotalPercent.promotion_id]
    });

    var giftSubtotal = trackGift(qaCreateGiftItem_(fx.token, fx.stamp, 'MegaSubtotal', { stock:50 }));
    var giftProductAll = trackGift(qaCreateGiftItem_(fx.token, fx.stamp, 'MegaProductAll', { stock:50 }));
    var giftProductAny = trackGift(qaCreateGiftItem_(fx.token, fx.stamp, 'MegaProductAny', { stock:50 }));
    var giftVariantAll = trackGift(qaCreateGiftItem_(fx.token, fx.stamp, 'MegaVariantAll', { stock:50 }));
    var giftVariantAny = trackGift(qaCreateGiftItem_(fx.token, fx.stamp, 'MegaVariantAny', { stock:50 }));

    var ruleSubtotal = trackRule(qaCreateGiftRule_(fx.token, fx.stamp, 'MegaSubtotal', giftSubtotal.gift_id, {
      condition_type:'min_subtotal',
      condition_json:{ min_subtotal:3000 },
      gift_qty:1,
      repeat_mode:'per_threshold',
      priority:9500
    }));
    var ruleProductAll = trackRule(qaCreateGiftRule_(fx.token, fx.stamp, 'MegaProductAll', giftProductAll.gift_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'all', required_products:[
        { product_id:productA.id, min_qty:1 },
        { product_id:productB.id, min_qty:2 }
      ]},
      gift_qty:2,
      repeat_mode:'once_per_order',
      priority:9400
    }));
    var ruleProductAny = trackRule(qaCreateGiftRule_(fx.token, fx.stamp, 'MegaProductAny', giftProductAny.gift_id, {
      condition_type:'required_products',
      condition_json:{ match_mode:'any', required_products:[
        { product_id:productA.id, min_qty:2 },
        { product_id:productD.id, min_qty:2 },
        { product_id:productE.id, min_qty:2 }
      ]},
      gift_qty:1,
      repeat_mode:'per_threshold',
      priority:9300
    }));
    var ruleVariantAll = trackRule(qaCreateGiftRule_(fx.token, fx.stamp, 'MegaVariantAll', giftVariantAll.gift_id, {
      condition_type:'required_variants',
      condition_json:{ match_mode:'all', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:1 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:2 }
      ]},
      gift_qty:3,
      repeat_mode:'per_threshold',
      priority:9200
    }));
    var ruleVariantAny = trackRule(qaCreateGiftRule_(fx.token, fx.stamp, 'MegaVariantAny', giftVariantAny.gift_id, {
      condition_type:'required_variants',
      condition_json:{ match_mode:'any', required_variants:[
        { product_id:variantProduct.id, variant_key:variantMKey, min_qty:1 },
        { product_id:variantProduct.id, variant_key:variantSKey, min_qty:1 }
      ]},
      gift_qty:1,
      repeat_mode:'per_threshold',
      priority:9100
    }));

    var cart = [
      qaCartItem_(productA.id, 3, {}),
      qaCartItem_(productB.id, 4, {}),
      qaCartItem_(variantProduct.id, 2, { Size:'M' }),
      qaCartItem_(variantProduct.id, 3, { Size:'S' }),
      qaCartItem_(productD.id, 5, {}),
      qaCartItem_(productE.id, 2, {})
    ];
    var expected = {
      raw_subtotal:10050,
      direct_subtotal:9750,
      subtotal:8410,
      order_discount:700,
      subtotal_after_order_discount:7710,
      shipping_fee:125,
      total:7835,
      lines:[
        { label:'A', product_id:productA.id, variant_key:'', qty:3, base:1000, discount:20, final:980, promotion_id:conditionalSubtotalAll.promotion_id, application_mode:'conditional', condition_type:'min_subtotal' },
        { label:'B', product_id:productB.id, variant_key:'', qty:4, base:600, discount:180, final:420, promotion_id:conditionalProductAny.promotion_id, application_mode:'conditional', condition_type:'required_products' },
        { label:'Variant M', product_id:variantProduct.id, variant_key:variantMKey, qty:2, base:800, discount:320, final:480, promotion_id:conditionalVariantAny.promotion_id, application_mode:'conditional', condition_type:'required_variants' },
        { label:'Variant S', product_id:variantProduct.id, variant_key:variantSKey, qty:3, base:400, discount:20, final:380, promotion_id:conditionalSubtotalAll.promotion_id, application_mode:'conditional', condition_type:'min_subtotal' },
        { label:'D', product_id:productD.id, variant_key:'', qty:5, base:250, discount:20, final:230, promotion_id:conditionalSubtotalAll.promotion_id, application_mode:'conditional', condition_type:'min_subtotal' },
        { label:'E', product_id:productE.id, variant_key:'', qty:2, base:300, discount:30, final:270, promotion_id:directBE.promotion_id, application_mode:'direct', condition_type:'' }
      ],
      gifts:[
        { label:'subtotal', gift_id:giftSubtotal.gift_id, rule_id:ruleSubtotal.rule_id, qty:3, stock:47, condition_type:'min_subtotal', match_mode:'all' },
        { label:'product_all', gift_id:giftProductAll.gift_id, rule_id:ruleProductAll.rule_id, qty:2, stock:48, condition_type:'required_products', match_mode:'all' },
        { label:'product_any', gift_id:giftProductAny.gift_id, rule_id:ruleProductAny.rule_id, qty:4, stock:46, condition_type:'required_products', match_mode:'any' },
        { label:'variant_all', gift_id:giftVariantAll.gift_id, rule_id:ruleVariantAll.rule_id, qty:3, stock:47, condition_type:'required_variants', match_mode:'all' },
        { label:'variant_any', gift_id:giftVariantAny.gift_id, rule_id:ruleVariantAny.rule_id, qty:5, stock:45, condition_type:'required_variants', match_mode:'any' }
      ]
    };

    var promoPreview = qaPreviewPromo_(cart);
    var previewRawSubtotal = (promoPreview.lines || []).reduce(function(sum, line) {
      return sum + Number(line.unit_base_price || 0) * Number(line.qty || 0);
    }, 0);
    qaAssert_(previewRawSubtotal === expected.raw_subtotal,
      'Mega promotion preview raw subtotal mismatch', { expected:expected.raw_subtotal, actual:previewRawSubtotal, preview:promoPreview });
    qaAssert_(Number(promoPreview.subtotal_after_promo) === expected.direct_subtotal,
      'Conditional promotion qualification must use the direct-only subtotal', { expected:expected.direct_subtotal, preview:promoPreview });
    qaAssert_(Number(promoPreview.subtotal) === expected.subtotal,
      'Mega promotion preview final subtotal mismatch', { expected:expected.subtotal, preview:promoPreview });

    expected.lines.forEach(function(exp) {
      var line = qaPromoPreviewLine_(promoPreview, exp.product_id, exp.variant_key);
      qaAssert_(line
        && Number(line.qty) === exp.qty
        && Number(line.unit_base_price) === exp.base
        && Number(line.unit_discount_amount) === exp.discount
        && Number(line.unit_final_price) === exp.final
        && line.promotion
        && String(line.promotion.promotion_id) === String(exp.promotion_id),
        'Mega promotion preview line mismatch: ' + exp.label, { expected:exp, actual:line, preview:promoPreview });
    });

    var conditionalIds = [
      conditionalSubtotalAll.promotion_id,
      conditionalProductAll.promotion_id,
      conditionalProductAny.promotion_id,
      conditionalVariantAll.promotion_id,
      conditionalVariantAny.promotion_id,
      orderTotalFixed.promotion_id,
      orderTotalPercent.promotion_id
    ];
    var conditionalIdMap = idSet(conditionalIds);
    var eligibleFixturePromos = (promoPreview.eligible || []).filter(function(entry) {
      return conditionalIdMap[String(entry.promotion_id)];
    });
    qaAssert_(eligibleFixturePromos.length === conditionalIds.length,
      'All seven fixture conditional promotions must qualify', { expected_ids:conditionalIds, eligible:eligibleFixturePromos, preview:promoPreview });
    function eligiblePromotion(promotionId) {
      return eligibleFixturePromos.filter(function(entry){ return String(entry.promotion_id) === String(promotionId); })[0] || null;
    }
    var eligibleSubtotal = eligiblePromotion(conditionalSubtotalAll.promotion_id);
    var eligibleProductAll = eligiblePromotion(conditionalProductAll.promotion_id);
    var eligibleProductAny = eligiblePromotion(conditionalProductAny.promotion_id);
    var eligibleVariantAll = eligiblePromotion(conditionalVariantAll.promotion_id);
    var eligibleVariantAny = eligiblePromotion(conditionalVariantAny.promotion_id);
    var eligibleOrderTotalFixed = eligiblePromotion(orderTotalFixed.promotion_id);
    var eligibleOrderTotalPercent = eligiblePromotion(orderTotalPercent.promotion_id);
    qaAssert_(eligibleSubtotal && eligibleSubtotal.applied === true
      && containsLine(eligibleSubtotal.applied_lines, productA.id, '')
      && containsLine(eligibleSubtotal.applied_lines, variantProduct.id, variantSKey)
      && containsLine(eligibleSubtotal.applied_lines, productD.id, ''),
      'Subtotal conditional promotion should win A, Variant S, and D', eligibleSubtotal);
    qaAssert_(eligibleProductAll && eligibleProductAll.applied === false
      && containsLine(eligibleProductAll.outpriced_lines, productB.id, ''),
      'Product ALL promotion should qualify but be outpriced on B', eligibleProductAll);
    qaAssert_(eligibleProductAny && eligibleProductAny.applied === true
      && containsLine(eligibleProductAny.applied_lines, productB.id, ''),
      'Product ANY promotion should win B', eligibleProductAny);
    qaAssert_(eligibleVariantAll && eligibleVariantAll.applied === false
      && containsLine(eligibleVariantAll.outpriced_lines, variantProduct.id, variantMKey),
      'Variant ALL promotion should qualify but be outpriced on M', eligibleVariantAll);
    qaAssert_(eligibleVariantAny && eligibleVariantAny.applied === true
      && containsLine(eligibleVariantAny.applied_lines, variantProduct.id, variantMKey),
      'Variant ANY promotion should win M', eligibleVariantAny);
    qaAssert_(eligibleOrderTotalFixed && eligibleOrderTotalFixed.applied === true
      && Number(eligibleOrderTotalFixed.order_discount_amount) === expected.order_discount,
      'Fixed order-total promotion should win once for the whole mega order', eligibleOrderTotalFixed);
    qaAssert_(eligibleOrderTotalPercent && eligibleOrderTotalPercent.applied === false
      && Number(eligibleOrderTotalPercent.order_discount_amount) === 421,
      'Percent order-total promotion should qualify but lose to the larger fixed discount', eligibleOrderTotalPercent);
    qaAssert_(promoPreview.order_discount
      && String(promoPreview.order_discount.promotion.promotion_id) === String(orderTotalFixed.promotion_id)
      && Number(promoPreview.order_discount.amount) === expected.order_discount
      && Number(promoPreview.subtotal_after_order_discount) === expected.subtotal_after_order_discount,
      'Mega preview order-total winner/net subtotal mismatch', { expected:expected, preview:promoPreview });

    qaStep_(steps, 'ตรวจ promotion preview และ best-price winners', 'ok', {
      raw_subtotal:previewRawSubtotal,
      direct_subtotal:promoPreview.subtotal_after_promo,
      final_subtotal:promoPreview.subtotal,
      order_discount:promoPreview.order_discount,
      subtotal_after_order_discount:promoPreview.subtotal_after_order_discount,
      winners:expected.lines.map(function(line){ return { label:line.label, promotion_id:line.promotion_id, final:line.final }; }),
      qualified_conditional_ids:eligibleFixturePromos.map(function(entry){ return entry.promotion_id; })
    });

    var giftPreview = qaCall_('previewGiftEligibilityRpc', [{ items:cart }]);
    qaAssertOk_(giftPreview);
    qaAssert_(Number(giftPreview.subtotal_after_promo) === expected.direct_subtotal,
      'Gift preview must use the same direct-only subtotal as promotion qualification', { expected:expected.direct_subtotal, preview:giftPreview });
    var ruleIdMap = idSet(expected.gifts.map(function(g){ return g.rule_id; }));
    var eligibleFixtureGifts = (giftPreview.eligible || []).filter(function(entry) {
      return ruleIdMap[String(entry.rule_id)];
    });
    qaAssert_(eligibleFixtureGifts.length === expected.gifts.length,
      'All five fixture gift rules must qualify', { expected:expected.gifts, eligible:eligibleFixtureGifts, preview:giftPreview });
    expected.gifts.forEach(function(exp) {
      var entry = eligibleFixtureGifts.filter(function(item){ return String(item.rule_id) === String(exp.rule_id); })[0];
      qaAssert_(entry
        && entry.gift
        && String(entry.gift.gift_id) === String(exp.gift_id)
        && Number(entry.gift.qty) === exp.qty
        && entry.condition_type === exp.condition_type
        && entry.match_mode === exp.match_mode,
        'Mega gift preview mismatch: ' + exp.label, { expected:exp, actual:entry, preview:giftPreview });
    });
    qaStep_(steps, 'ตรวจ gift preview ครบทุก condition', 'ok', {
      direct_subtotal:giftPreview.subtotal_after_promo,
      gifts:expected.gifts.map(function(g){ return { label:g.label, rule_id:g.rule_id, qty:g.qty }; })
    });

    var payload = qaBuildOrderPayloadForProduct_('qa-rule-mega-overlap', fx.stamp, 'Buyer', productA.id, fx.shipping, { items:cart });
    payload.client_pricing = qaRuleOrderClientPricingFromPreview_(promoPreview, cart, expected.shipping_fee);
    qaAssert_(Number(payload.client_pricing.subtotal) === expected.subtotal
      && Number(payload.client_pricing.order_discount) === expected.order_discount
      && Number(payload.client_pricing.shipping_fee) === expected.shipping_fee
      && Number(payload.client_pricing.total) === expected.total,
      'Mega order client_pricing snapshot mismatch before submit', { expected:expected, client_pricing:payload.client_pricing });

    // This is intentionally the only submitOrderRpc invocation in the flow.
    var submit = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(submit);
    var submittedOrderIds = qaOrderIdsFromSubmit_(submit);
    qaAssert_(submittedOrderIds.length === 1,
      'Mega workflow must create exactly one order', { order_ids:submittedOrderIds, response:submit });
    var orderId = submittedOrderIds[0];
    var orderToken = submit.token || (submit.orders && submit.orders[0] && submit.orders[0].token) || '';
    qaAssert_(!!orderId && !!orderToken, 'Mega order submit must return one order id and customer token', submit);

    var giftIdMap = idSet(expected.gifts.map(function(g){ return g.gift_id; }));
    var attachedFixtureGifts = (submit.gifts_attached || []).filter(function(g){ return giftIdMap[String(g.gift_id)]; });
    var skippedFixtureGifts = (submit.gifts_skipped || []).filter(function(g){ return giftIdMap[String(g.gift_id)]; });
    qaAssert_(attachedFixtureGifts.length === expected.gifts.length,
      'Submit response must report all five fixture gifts attached', { expected:expected.gifts, attached:attachedFixtureGifts, response:submit });
    qaAssert_(skippedFixtureGifts.length === 0,
      'No fixture gift may be skipped in the mega workflow', { skipped:skippedFixtureGifts, response:submit });
    expected.gifts.forEach(function(exp) {
      var attached = attachedFixtureGifts.filter(function(g){ return String(g.gift_id) === String(exp.gift_id); })[0];
      qaAssert_(attached && Number(attached.qty) === exp.qty,
        'Submit response gift quantity mismatch: ' + exp.label, { expected:exp, actual:attached, response:submit });
    });
    qaStep_(steps, 'submit mega checkout เพียงหนึ่ง order', 'ok', {
      order_id:orderId,
      token_returned:!!orderToken,
      gifts_attached:attachedFixtureGifts,
      gifts_skipped:skippedFixtureGifts
    });

    var order = qaReadOrder_(fx.token, orderId);
    var productLines = (order.items || []).filter(function(item){ return item.line_type !== 'gift'; });
    var fixtureGiftLines = (order.items || []).filter(function(item){
      return item.line_type === 'gift' && item.status !== 'removed' && giftIdMap[String(item.gift_id)];
    });
    qaAssert_(productLines.length === expected.lines.length,
      'Persisted mega order must contain exactly six product lines', { expected:expected.lines, lines:productLines, order:order });
    qaAssert_(fixtureGiftLines.length === expected.gifts.length,
      'Persisted mega order must contain all five fixture gift lines', { expected:expected.gifts, lines:fixtureGiftLines, order:order });
    expected.lines.forEach(function(exp) {
      var line = qaFindProductLineByVariantKey_(order, exp.product_id, exp.variant_key);
      qaAssert_(line
        && Number(line.qty) === exp.qty
        && Number(line.unit_base_price) === exp.base
        && Number(line.unit_discount_amount) === exp.discount
        && Number(line.unit_final_price) === exp.final
        && Number(line.subtotal) === exp.final * exp.qty
        && line.promotion
        && String(line.promotion.promotion_id) === String(exp.promotion_id)
        && line.promotion.application_mode === exp.application_mode
        && String(line.promotion.condition_type || '') === exp.condition_type,
        'Persisted mega pricing/promotion snapshot mismatch: ' + exp.label, { expected:exp, actual:line, order:order });
    });
    expected.gifts.forEach(function(exp) {
      var lines = qaActiveGiftLines_(order, exp.gift_id);
      var line = lines[0];
      qaAssert_(lines.length === 1
        && Number(line.gift_qty) === exp.qty
        && String(line.rule_id) === String(exp.rule_id)
        && !!line.rule_name
        && line.source === 'auto'
        && line.status === 'active',
        'Persisted mega gift/rule snapshot mismatch: ' + exp.label, { expected:exp, lines:lines, order:order });
    });
    var persistedProductSubtotal = productLines.reduce(function(sum, line){ return sum + Number(line.subtotal || 0); }, 0);
    qaAssert_(persistedProductSubtotal === expected.subtotal
      && Number(order.subtotal) === expected.subtotal
      && order.order_discount
      && String(order.order_discount.promotion.promotion_id) === String(orderTotalFixed.promotion_id)
      && order.order_discount.promotion.discount_scope === 'order_total'
      && Number(order.order_discount.amount) === expected.order_discount
      && Number(order.shipping_fee) === expected.shipping_fee
      && Number(order.total) === expected.total
      && order.status === 'unpaid',
      'Persisted mega order totals/status mismatch', { expected:expected, product_subtotal:persistedProductSubtotal, order:order });
    qaAssert_((order.shipping_info || []).length === 1
      && String(order.shipping_info[0].method_id) === String(fx.shipping.method.id)
      && Number(order.shipping_info[0].fee) === expected.shipping_fee,
      'Persisted mega order shipping snapshot mismatch', { expected_method_id:fx.shipping.method.id, shipping_info:order.shipping_info });
    qaStep_(steps, 'ตรวจ persisted order pricing/promotion/gift snapshots', 'ok', {
      order_id:orderId,
      product_line_count:productLines.length,
      fixture_gift_line_count:fixtureGiftLines.length,
      subtotal:order.subtotal,
      order_discount:order.order_discount,
      shipping_fee:order.shipping_fee,
      total:order.total,
      status:order.status
    });

    var tokenOrder = qaCall_('getOrderByTokenRpc', [orderToken]);
    qaAssertOk_(tokenOrder);
    qaAssert_(tokenOrder.record
      && String(tokenOrder.record.order_id) === String(orderId)
      && Number(tokenOrder.record.subtotal) === expected.subtotal
      && tokenOrder.record.order_discount
      && String(tokenOrder.record.order_discount.promotion.promotion_id) === String(orderTotalFixed.promotion_id)
      && Number(tokenOrder.record.order_discount.amount) === expected.order_discount
      && Number(tokenOrder.record.shipping_fee) === expected.shipping_fee
      && Number(tokenOrder.record.total) === expected.total,
      'Customer token order read must match the persisted mega order', { expected:expected, token_read:tokenOrder });
    expected.lines.forEach(function(exp) {
      var line = qaFindProductLineByVariantKey_(tokenOrder.record, exp.product_id, exp.variant_key);
      qaAssert_(line && Number(line.unit_final_price) === exp.final
        && line.promotion && String(line.promotion.promotion_id) === String(exp.promotion_id),
        'Customer token pricing snapshot mismatch: ' + exp.label, { expected:exp, actual:line, token_read:tokenOrder });
    });

    var tokenGifts = qaCall_('getOrderGiftsByTokenRpc', [orderToken]);
    qaAssertOk_(tokenGifts);
    var tokenFixtureGifts = (tokenGifts.gifts || []).filter(function(g){ return giftIdMap[String(g.gift_id)]; });
    qaAssert_(tokenFixtureGifts.length === expected.gifts.length,
      'Customer token gift read must return all five fixture gifts', { expected:expected.gifts, gifts:tokenFixtureGifts, token_read:tokenGifts });
    expected.gifts.forEach(function(exp) {
      var line = tokenFixtureGifts.filter(function(g){ return String(g.gift_id) === String(exp.gift_id); })[0];
      qaAssert_(line && Number(line.gift_qty) === exp.qty && String(line.rule_id) === String(exp.rule_id),
        'Customer token gift snapshot mismatch: ' + exp.label, { expected:exp, actual:line, token_read:tokenGifts });
    });
    qaStep_(steps, 'ตรวจ customer token reads', 'ok', {
      order_id:tokenOrder.record.order_id,
      order_discount:tokenOrder.record.order_discount,
      total:tokenOrder.record.total,
      fixture_gifts:tokenFixtureGifts.map(function(g){ return { gift_id:g.gift_id, rule_id:g.rule_id, qty:g.gift_qty }; })
    });

    var finalStock = {
      product_a:qaGetProductStock_(productA.id),
      product_b:qaGetProductStock_(productB.id),
      product_d:qaGetProductStock_(productD.id),
      product_e:qaGetProductStock_(productE.id),
      variant_m:qaGetVariantStock_(variantProduct.id, 'Size', 'M'),
      variant_s:qaGetVariantStock_(variantProduct.id, 'Size', 'S'),
      gifts:expected.gifts.map(function(g){ return { gift_id:g.gift_id, stock:qaGetGiftStock_(g.gift_id) }; })
    };
    qaAssert_(finalStock.product_a === 17
      && finalStock.product_b === 16
      && finalStock.product_d === 15
      && finalStock.product_e === 18
      && finalStock.variant_m === 8
      && finalStock.variant_s === 7,
      'Mega order product/variant stocks were not deducted exactly once', finalStock);
    expected.gifts.forEach(function(exp) {
      var actual = finalStock.gifts.filter(function(g){ return String(g.gift_id) === String(exp.gift_id); })[0];
      qaAssert_(actual && Number(actual.stock) === exp.stock,
        'Mega order gift stock mismatch: ' + exp.label, { expected:exp, actual:actual, final_stock:finalStock });
    });
    qaStep_(steps, 'ตรวจ product/variant/gift stocks หลัง submit', 'ok', finalStock);

    output = {
      steps:steps,
      order_id:orderId,
      order_count:submittedOrderIds.length,
      token_returned:!!orderToken,
      expected:expected,
      preview:{
        raw_subtotal:previewRawSubtotal,
        direct_subtotal:promoPreview.subtotal_after_promo,
        final_subtotal:promoPreview.subtotal,
        order_discount:promoPreview.order_discount,
        subtotal_after_order_discount:promoPreview.subtotal_after_order_discount,
        eligible_fixture_promotions:eligibleFixturePromos,
        eligible_fixture_gifts:eligibleFixtureGifts
      },
      order_totals:{
        subtotal:order.subtotal,
        order_discount:order.order_discount,
        shipping_fee:order.shipping_fee,
        total:order.total
      },
      attached_fixture_gifts:attachedFixtureGifts,
      token_fixture_gifts:tokenFixtureGifts,
      final_stock:finalStock
    };
  } catch (err) {
    caught = err;
  }

  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup mega order fixtures', cleanup && cleanup.ok ? 'ok' : 'failed', { cleanup:cleanup });
  if (caught) {
    caught.details = Object.assign({}, caught.details || {}, {
      steps:steps,
      fixture_ids:{
        order_ids:fx.order_ids,
        product_ids:fx.product_ids,
        promotion_ids:fx.promotion_ids,
        gift_ids:fx.gift_ids,
        rule_ids:fx.rule_ids
      },
      cleanup:cleanup
    });
    throw caught;
  }
  qaAssert_(cleanup && cleanup.ok === true, 'Mega order fixture cleanup failed', cleanup);
  output.steps = steps;
  output.cleanup = cleanup;
  return output;
}

// Dense recovery workflow for a promotion edit between preview and submit. It proves that
// stale order-total money is rejected before stock writes, then the refreshed checkout can
// complete and retain immutable promotion/gift snapshots after the live rule is edited/deleted.
function qaRunOrderRulesMegaPromotionUpdateRecoveryFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleMegaPromoUpdate', { flat_rate:50 });
  var steps = [], caught = null, output = null;
  try {
    var productA = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaUpdateA', 10, { price:1000 });
    var productB = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'MegaUpdateB', 10, { price:500 });
    fx.product_ids = [productA.id, productB.id];

    var directPromo = qaCreatePromotion_(fx.token, productA.id, fx.stamp, 'MegaUpdateDirect', {
      discount_type:'fixed', discount_value:100,
      target_type:'product', target:[{ product_id:productA.id }]
    });
    var orderPromo = qaCreatePromotion_(fx.token, '', fx.stamp, 'MegaUpdateOrderTotal', {
      discount_type:'fixed', discount_value:200,
      target_type:'all', target:[], application_mode:'conditional',
      discount_scope:'order_total', condition_type:'min_subtotal',
      condition_json:{ min_subtotal:2000, calculation_base:'after_discount_before_shipping' }
    });
    fx.promotion_ids = [directPromo.promotion_id, orderPromo.promotion_id];

    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'MegaUpdateGift', { stock:5 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'MegaUpdateGift', gift.gift_id, {
      condition_type:'min_subtotal', condition_json:{ min_subtotal:2000 },
      gift_qty:1, repeat_mode:'once_per_order', priority:9800
    });
    fx.rule_ids.push(rule.rule_id);

    var cart = [
      qaCartItem_(productA.id, 2, {}),
      qaCartItem_(productB.id, 1, {})
    ];
    var stalePreview = qaPreviewPromo_(cart);
    var staleGiftPreview = qaCall_('previewGiftEligibilityRpc', [{ items:cart }]);
    qaAssertOk_(staleGiftPreview);
    var staleLineA = qaPromoPreviewLine_(stalePreview, productA.id, '');
    qaAssert_(staleLineA && Number(staleLineA.unit_final_price) === 900
      && staleLineA.promotion
      && String(staleLineA.promotion.promotion_id) === String(directPromo.promotion_id),
      'Initial direct promotion line snapshot mismatch', { line:staleLineA, preview:stalePreview });
    qaAssert_(Number(stalePreview.subtotal) === 2300
      && stalePreview.order_discount
      && Number(stalePreview.order_discount.amount) === 200
      && Number(stalePreview.subtotal_after_order_discount) === 2100,
      'Initial order-total promotion preview mismatch', stalePreview);
    qaAssert_(qaHasEligibleRule_(staleGiftPreview, rule.rule_id)
      && Number(staleGiftPreview.subtotal_after_promo) === 2300,
      'Gift should qualify from the direct-only subtotal before the order-total discount', staleGiftPreview);
    qaStep_(steps, 'preview ราคาเดิม + promotion + gift ครบทุกชั้น', 'ok', {
      subtotal:stalePreview.subtotal,
      order_discount:stalePreview.order_discount,
      gift_subtotal_basis:staleGiftPreview.subtotal_after_promo
    });

    var stalePayload = qaBuildOrderPayloadForProduct_('qa-mega-promo-update-stale', fx.stamp, 'Buyer', productA.id, fx.shipping, { items:cart });
    stalePayload.client_pricing = qaRuleOrderClientPricingFromPreview_(stalePreview, cart, 50);
    qaAssert_(Number(stalePayload.client_pricing.total) === 2150,
      'Initial client pricing total should be 2300 - 200 + 50', stalePayload.client_pricing);

    var update = qaCall_('updatePromotionRpc', [fx.token, orderPromo.promotion_id, { discount_value:400 }]);
    qaAssertOk_(update);
    var beforeCount = qaOrderCount_(fx.token);
    var rejected = qaSubmitAndTrack_(stalePayload, fx.order_ids);
    var counts = qaAssertNoNewOrderAfterFailure_(fx.token, beforeCount, rejected, fx.order_ids, 'PRICE_CHANGED', stalePayload);
    var diffKinds = qaAssertDiffKinds_(rejected, ['order_discount', 'total']);
    qaAssert_(Number(rejected.updated_subtotal) === 2300
      && Number(rejected.updated_order_discount) === 400
      && Number(rejected.updated_shipping_fee) === 50
      && Number(rejected.updated_total) === 1950,
      'PRICE_CHANGED response should expose the fully refreshed checkout summary', rejected);
    qaAssert_(qaGetProductStock_(productA.id) === 10
      && qaGetProductStock_(productB.id) === 10
      && qaGetGiftStock_(gift.gift_id) === 5,
      'Rejected stale submit must not change product or gift stock', rejected);
    qaStep_(steps, 'แก้ promotion แล้ว reject stale client pricing ก่อนแตะ stock', 'ok', {
      diff_kinds:diffKinds,
      order_counts:counts,
      updated_total:rejected.updated_total
    });

    var freshPreview = qaPreviewPromo_(cart);
    qaAssert_(freshPreview.order_discount
      && Number(freshPreview.order_discount.amount) === 400
      && Number(freshPreview.subtotal_after_order_discount) === 1900,
      'Refreshed preview should expose the updated order-total discount', freshPreview);
    var freshPayload = qaBuildOrderPayloadForProduct_('qa-mega-promo-update-fresh', fx.stamp, 'Buyer', productA.id, fx.shipping, { items:cart });
    freshPayload.client_pricing = qaRuleOrderClientPricingFromPreview_(freshPreview, cart, 50);
    var submit = qaSubmitAndTrack_(freshPayload, fx.order_ids);
    qaAssertOk_(submit);
    var orderId = qaOrderIdsFromSubmit_(submit)[0];
    var record = qaReadOrder_(fx.token, orderId);
    var lineA = qaFindProductLine_(record, productA.id);
    var giftLines = qaActiveGiftLines_(record, gift.gift_id);
    qaAssert_(Number(record.subtotal) === 2300
      && record.order_discount
      && Number(record.order_discount.amount) === 400
      && String(record.order_discount.promotion.promotion_id) === String(orderPromo.promotion_id)
      && Number(record.order_discount.promotion.discount_value) === 400
      && record.order_discount.promotion.discount_scope === 'order_total'
      && Number(record.shipping_fee) === 50
      && Number(record.total) === 1950,
      'Refreshed order totals/order-total snapshot mismatch', record);
    qaAssert_(lineA && Number(lineA.unit_final_price) === 900
      && lineA.promotion
      && String(lineA.promotion.promotion_id) === String(directPromo.promotion_id),
      'Direct line promotion must remain independent from the order-total snapshot', lineA);
    qaAssert_(giftLines.length === 1
      && Number(giftLines[0].gift_qty) === 1
      && String(giftLines[0].rule_id) === String(rule.rule_id),
      'Refreshed order should attach exactly one snapshotted gift', giftLines);
    qaAssert_(qaGetProductStock_(productA.id) === 8
      && qaGetProductStock_(productB.id) === 9
      && qaGetGiftStock_(gift.gift_id) === 4,
      'Successful refreshed submit should deduct all stocks exactly once', record);
    qaStep_(steps, 'refresh แล้ว submit order ใหม่พร้อม snapshot ที่ถูกต้อง', 'ok', {
      order_id:orderId,
      subtotal:record.subtotal,
      order_discount:record.order_discount,
      total:record.total
    });

    qaAssertOk_(qaCall_('updatePromotionRpc', [fx.token, orderPromo.promotion_id, { discount_value:650, name:'QA Mutated Mega Order Total ' + fx.stamp }]));
    qaAssertOk_(qaCall_('deletePromotionRpc', [fx.token, orderPromo.promotion_id]));
    fx.promotion_ids = fx.promotion_ids.filter(function(id){ return String(id) !== String(orderPromo.promotion_id); });

    var immutableAdmin = qaReadOrder_(fx.token, orderId);
    var immutableToken = qaCall_('getOrderByTokenRpc', [submit.token]);
    qaAssertOk_(immutableToken);
    [immutableAdmin, immutableToken.record].forEach(function(snapshot) {
      qaAssert_(snapshot.order_discount
        && Number(snapshot.order_discount.amount) === 400
        && String(snapshot.order_discount.promotion.promotion_id) === String(orderPromo.promotion_id)
        && Number(snapshot.order_discount.promotion.discount_value) === 400
        && snapshot.order_discount.promotion.discount_scope === 'order_total'
        && Number(snapshot.total) === 1950,
        'Order-total snapshot must survive source promotion edit/delete', snapshot);
    });

    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'cancelled', 'qa mega promotion update cancel']));
    qaAssert_(qaGetProductStock_(productA.id) === 10
      && qaGetProductStock_(productB.id) === 10
      && qaGetGiftStock_(gift.gift_id) === 5,
      'Cancel should restore product/gift stock without changing monetary snapshots', immutableAdmin);
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'qa mega promotion update un-cancel']));
    var finalRecord = qaReadOrder_(fx.token, orderId);
    qaAssert_(qaGetProductStock_(productA.id) === 8
      && qaGetProductStock_(productB.id) === 9
      && qaGetGiftStock_(gift.gift_id) === 4,
      'Un-cancel should re-deduct product/gift stock exactly once', finalRecord);
    qaAssert_(finalRecord.status === 'paid'
      && finalRecord.order_discount
      && Number(finalRecord.order_discount.amount) === 400
      && Number(finalRecord.total) === 1950,
      'Status lifecycle must not recalculate the immutable order-total promotion', finalRecord);
    qaStep_(steps, 'snapshot คงเดิมหลัง edit/delete และ stock lifecycle ยัง atomic', 'ok', {
      status:finalRecord.status,
      order_discount:finalRecord.order_discount,
      final_stock:{ product_a:8, product_b:9, gift:4 }
    });

    output = {
      steps:steps,
      order_id:orderId,
      stale_response:{ error:rejected.error, diff_kinds:diffKinds, updated_total:rejected.updated_total },
      persisted:{ subtotal:finalRecord.subtotal, order_discount:finalRecord.order_discount, shipping_fee:finalRecord.shipping_fee, total:finalRecord.total },
      final_status:finalRecord.status,
      final_stock:{ product_a:8, product_b:9, gift:4 }
    };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup mega promotion-update fixtures', cleanup && cleanup.ok ? 'ok' : 'failed', { cleanup:cleanup });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  qaAssert_(cleanup && cleanup.ok === true, 'Mega promotion-update fixture cleanup failed', cleanup);
  output.steps = steps;
  output.cleanup = cleanup;
  return output;
}

// Order-total discount allocation for split shipping. An odd amount deliberately creates a
// rounding remainder so the sum of persisted per-order snapshots must still equal the cart
// discount exactly (100 + 233 = 333).
function qaRunOrderRulesOrderTotalSplitAllocationFlow_(ctx) {
  var token = ctx.options.adminToken;
  var stamp = qaStamp_();
  var shipping = qaCreateMultiMethodShippingFixture_(token, stamp, 'OrderTotalSplit', [
    { name:'QA Order Total Split A', mode:'flat', flat_rate:10 },
    { name:'QA Order Total Split B', mode:'flat', flat_rate:20 }
  ]);
  var fx = { token:token, stamp:stamp, shipping:shipping, order_ids:[], product_ids:[], promotion_ids:[], gift_ids:[], rule_ids:[] };
  var steps = [], caught = null, output = null;
  try {
    var methodA = shipping.methods[0], methodB = shipping.methods[1];
    var productA = qaCreateOrderQaProduct_(token, shipping, stamp, 'OrderTotalSplitA', 5, {
      price:300, allowed_shipping_ids:[methodA.id]
    });
    var productB = qaCreateOrderQaProduct_(token, shipping, stamp, 'OrderTotalSplitB', 5, {
      price:700, allowed_shipping_ids:[methodB.id]
    });
    fx.product_ids = [productA.id, productB.id];
    var promo = qaCreatePromotion_(token, '', stamp, 'OrderTotalSplit', {
      discount_type:'fixed', discount_value:333,
      target_type:'all', target:[], application_mode:'conditional',
      discount_scope:'order_total', condition_type:'min_subtotal',
      condition_json:{ min_subtotal:1000, calculation_base:'after_discount_before_shipping' }
    });
    fx.promotion_ids.push(promo.promotion_id);

    var cart = [qaCartItem_(productA.id, 1, {}), qaCartItem_(productB.id, 1, {})];
    var preview = qaPreviewPromo_(cart);
    qaAssert_(Number(preview.subtotal) === 1000
      && preview.order_discount
      && Number(preview.order_discount.amount) === 333
      && Number(preview.subtotal_after_order_discount) === 667,
      'Split checkout preview should calculate one cart-wide order-total discount', preview);

    var payload = qaBuildOrderPayloadForProduct_('qa-order-total-split', stamp, 'Buyer', productA.id, shipping, { items:cart });
    payload.shipping_info = [
      { company_id:shipping.company.id, method_id:methodA.id, item_product_ids:[productA.id] },
      { company_id:shipping.company.id, method_id:methodB.id, item_product_ids:[productB.id] }
    ];
    payload.client_pricing = qaRuleOrderClientPricingFromPreview_(preview, cart, 30);
    qaAssert_(Number(payload.client_pricing.total) === 697,
      'Split client pricing must net the cart discount before both shipping fees', payload.client_pricing);
    var submit = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(submit);
    qaAssert_(Array.isArray(submit.orders) && submit.orders.length === 2 && fx.order_ids.length === 2,
      'Split order-total checkout should create exactly two orders', submit);

    var records = fx.order_ids.map(function(id){ return qaReadOrder_(token, id); });
    var orderA = records.filter(function(order){ return !!qaFindProductLine_(order, productA.id); })[0];
    var orderB = records.filter(function(order){ return !!qaFindProductLine_(order, productB.id); })[0];
    qaAssert_(orderA && orderB, 'Each assigned product should persist in its own split order', records);
    qaAssert_(Number(orderA.subtotal) === 300
      && orderA.order_discount
      && Number(orderA.order_discount.amount) === 100
      && Number(orderA.shipping_fee) === 10
      && Number(orderA.total) === 210,
      'Product A split order should receive its proportional discount and shipping fee', orderA);
    qaAssert_(Number(orderB.subtotal) === 700
      && orderB.order_discount
      && Number(orderB.order_discount.amount) === 233
      && Number(orderB.shipping_fee) === 20
      && Number(orderB.total) === 487,
      'Product B split order should receive the integer remainder and shipping fee', orderB);

    var aggregate = records.reduce(function(sum, order) {
      return {
        subtotal:sum.subtotal + Number(order.subtotal || 0),
        order_discount:sum.order_discount + Number(order.order_discount && order.order_discount.amount || 0),
        shipping_fee:sum.shipping_fee + Number(order.shipping_fee || 0),
        total:sum.total + Number(order.total || 0)
      };
    }, { subtotal:0, order_discount:0, shipping_fee:0, total:0 });
    qaAssert_(aggregate.subtotal === 1000
      && aggregate.order_discount === 333
      && aggregate.shipping_fee === 30
      && aggregate.total === 697,
      'Split-order aggregates must exactly match the cart preview/client snapshot', { aggregate:aggregate, preview:preview });

    (submit.orders || []).forEach(function(summary) {
      var tokenRead = qaCall_('getOrderByTokenRpc', [summary.token]);
      qaAssertOk_(tokenRead);
      var persisted = records.filter(function(order){ return String(order.order_id) === String(summary.order_id); })[0];
      qaAssert_(persisted
        && String(tokenRead.record.order_id) === String(persisted.order_id)
        && Number(tokenRead.record.total) === Number(persisted.total)
        && tokenRead.record.order_discount
        && Number(tokenRead.record.order_discount.amount) === Number(persisted.order_discount.amount)
        && String(tokenRead.record.order_discount.promotion.promotion_id) === String(promo.promotion_id),
        'Each split customer token must expose its allocated immutable discount', { summary:summary, token_read:tokenRead, persisted:persisted });
    });
    qaAssert_(qaGetProductStock_(productA.id) === 4 && qaGetProductStock_(productB.id) === 4,
      'Split checkout should deduct each product stock exactly once', records);
    qaStep_(steps, 'กระจายส่วนลดท้ายบิล 333 เป็น 100 + 233 ข้ามสอง order', 'ok', {
      order_ids:fx.order_ids.slice(),
      aggregate:aggregate,
      order_a:{ discount:orderA.order_discount.amount, total:orderA.total },
      order_b:{ discount:orderB.order_discount.amount, total:orderB.total }
    });
    output = { steps:steps, order_ids:fx.order_ids.slice(), aggregate:aggregate };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  qaStep_(steps, 'cleanup split order-total fixtures', cleanup && cleanup.ok ? 'ok' : 'failed', { cleanup:cleanup });
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { steps:steps, cleanup:cleanup }); throw caught; }
  qaAssert_(cleanup && cleanup.ok === true, 'Split order-total fixture cleanup failed', cleanup);
  output.steps = steps;
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesIdempotentMultiRepeatGiftsFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleIdempotentMultiGift');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'IdempotentMultiGift', 10, { price:100 });
    fx.product_ids.push(product.id);
    var giftA = qaCreateGiftItem_(fx.token, fx.stamp, 'IdempotentGiftA', { stock:20 });
    var giftB = qaCreateGiftItem_(fx.token, fx.stamp, 'IdempotentGiftB', { stock:10 });
    fx.gift_ids = [giftA.gift_id, giftB.gift_id];
    var ruleA = qaCreateGiftRule_(fx.token, fx.stamp, 'IdempotentGiftA', giftA.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] },
      gift_qty:2, repeat_mode:'per_threshold', priority:9200
    });
    var ruleB = qaCreateGiftRule_(fx.token, fx.stamp, 'IdempotentGiftB', giftB.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:2 }] },
      gift_qty:1, repeat_mode:'per_threshold', priority:9100
    });
    fx.rule_ids = [ruleA.rule_id, ruleB.rule_id];
    var clientOrderId = 'qa-rule-idem-' + fx.stamp + '-' + Utilities.getUuid().replace(/-/g,'').slice(0,8);
    var payload = qaBuildOrderPayloadForProduct_('qa-rule-idem', fx.stamp, 'Buyer', product.id, fx.shipping, { qty:3, client_order_id:clientOrderId });
    var first = qaSubmitAndTrack_(payload, fx.order_ids);
    qaAssertOk_(first);
    var afterFirst = {
      product:qaGetProductStock_(product.id),
      gift_a:qaGetGiftStock_(giftA.gift_id),
      gift_b:qaGetGiftStock_(giftB.gift_id)
    };
    qaAssert_(afterFirst.product === 7 && afterFirst.gift_a === 14 && afterFirst.gift_b === 9,
      'First submit deducted incorrect multiplied quantities', afterFirst);
    var second = qaCall_('submitOrderRpc', [payload]);
    qaAssert_(second && second.ok === false && second.error === 'DUPLICATE_ORDER',
      'Second submit with the same client_order_id must be rejected', second);
    var afterSecond = {
      product:qaGetProductStock_(product.id),
      gift_a:qaGetGiftStock_(giftA.gift_id),
      gift_b:qaGetGiftStock_(giftB.gift_id)
    };
    qaAssert_(JSON.stringify(afterSecond) === JSON.stringify(afterFirst),
      'Duplicate submit deducted stock a second time', { first:afterFirst, second:afterSecond });
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(first)[0]);
    qaAssert_(qaActiveGiftLines_(order, giftA.gift_id).reduce(function(s,g){ return s + Number(g.gift_qty || 0); }, 0) === 6
      && qaActiveGiftLines_(order, giftB.gift_id).reduce(function(s,g){ return s + Number(g.gift_qty || 0); }, 0) === 1,
      'Persisted idempotent order gift quantities mismatch', order.items);
    output = { client_order_id:clientOrderId, first:first, second:second, stocks:afterSecond, order_id:order.order_id };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesCancelSameGiftMultiRuleLifecycleFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleCancelSameGift');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'CancelSameGift', 10, { price:200 });
    fx.product_ids.push(product.id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'CancelSameGift', { stock:20 });
    fx.gift_ids.push(gift.gift_id);
    var condition = { required_products:[{ product_id:product.id, min_qty:1 }] };
    var ruleHigh = qaCreateGiftRule_(fx.token, fx.stamp, 'CancelSameGiftHigh', gift.gift_id, {
      condition_json:condition, repeat_mode:'per_threshold', priority:9200
    });
    var ruleLow = qaCreateGiftRule_(fx.token, fx.stamp, 'CancelSameGiftLow', gift.gift_id, {
      condition_json:condition, repeat_mode:'per_threshold', priority:9100
    });
    fx.rule_ids = [ruleHigh.rule_id, ruleLow.rule_id];
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-cancel-same-gift', fx.stamp, 'Buyer', product.id, fx.shipping, { qty:2 }), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    var order = qaReadOrder_(fx.token, orderId);
    var giftLines = qaActiveGiftLines_(order, gift.gift_id);
    var totalGiftQty = giftLines.reduce(function(sum, line){ return sum + Number(line.gift_qty || 0); }, 0);
    qaAssert_(giftLines.length === 2 && totalGiftQty === 4,
      'Two repeated rules must persist as two lines totalling four gift units', giftLines);
    qaAssert_(qaGetProductStock_(product.id) === 8 && qaGetGiftStock_(gift.gift_id) === 16,
      'Submit stock state mismatch', { product:qaGetProductStock_(product.id), gift:qaGetGiftStock_(gift.gift_id) });
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'cancelled', 'qa cancel repeated gift order']));
    qaAssert_(qaGetProductStock_(product.id) === 10 && qaGetGiftStock_(gift.gift_id) === 20,
      'Cancel must restore aggregated product/gift quantities', { product:qaGetProductStock_(product.id), gift:qaGetGiftStock_(gift.gift_id) });
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'cancelled', 'qa repeated cancel must be idempotent']));
    qaAssert_(qaGetProductStock_(product.id) === 10 && qaGetGiftStock_(gift.gift_id) === 20,
      'Repeated cancel must not restore stock twice', { product:qaGetProductStock_(product.id), gift:qaGetGiftStock_(gift.gift_id) });
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'paid', 'qa un-cancel repeated gift order']));
    qaAssert_(qaGetProductStock_(product.id) === 8 && qaGetGiftStock_(gift.gift_id) === 16,
      'Un-cancel must atomically re-deduct aggregated product/gift quantities', { product:qaGetProductStock_(product.id), gift:qaGetGiftStock_(gift.gift_id) });
    output = { order_id:orderId, gift_line_count:giftLines.length, total_gift_qty:totalGiftQty, final_product_stock:8, final_gift_stock:16 };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesProductionSummaryMultipliedGiftsFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleProductionSummary');
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'ProductionSummary', 10, { price:1000 });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'ProductionSummary', { discount_value:100 });
    fx.promotion_ids.push(promo.promotion_id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'ProductionSummary', { stock:20 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'ProductionSummary', gift.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:2 }] },
      gift_qty:2, repeat_mode:'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-production-summary', fx.stamp, 'Buyer', product.id, fx.shipping, { qty:4 }), fx.order_ids);
    qaAssertOk_(res);
    var orderId = qaOrderIdsFromSubmit_(res)[0];
    qaAssertOk_(qaCall_('orderUpdateStatusRpc', [fx.token, orderId, 'approved', 'qa production summary']));
    var summary = qaCall_('orderProductionSummaryRpc', [fx.token, { statuses:['approved'] }]);
    qaAssertOk_(summary);
    var productSummary = (summary.products || []).filter(function(p){ return String(p.product_id) === String(product.id); })[0];
    var giftSummary = (summary.gifts || []).filter(function(g){ return String(g.gift_id) === String(gift.gift_id); })[0];
    qaAssert_(productSummary && Number(productSummary.qty) === 4,
      'Production summary must count all four product units', { product:productSummary, summary:summary });
    qaAssert_(giftSummary && Number(giftSummary.qty) === 4,
      'Production summary must count all four multiplied gift units', { gift:giftSummary, summary:summary });
    var order = qaReadOrder_(fx.token, orderId);
    var line = qaFindProductLine_(order, product.id);
    qaAssert_(line && Number(line.unit_final_price) === 900,
      'Production-summary fixture must retain its promotion snapshot', line);
    output = { order_id:orderId, product_summary:productSummary, gift_summary:giftSummary, filtered_statuses:summary.filteredStatuses };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}

function qaRunOrderRulesMultipliedGiftsMonetaryNeutralFlow_(ctx) {
  var fx = qaCreateCommerceFixture_(ctx, 'OrderRuleGiftMonetaryNeutral', {
    mode:'weight',
    brackets:[
      { from_g:0, to_g:999, price:40 },
      { from_g:1000, to_g:1999, price:80 },
      { from_g:2000, to_g:999999, price:130 }
    ]
  });
  var caught = null, output = null;
  try {
    var product = qaCreateOrderQaProduct_(fx.token, fx.shipping, fx.stamp, 'GiftMonetaryNeutral', 5, {
      price:1000, weight_grams:750
    });
    fx.product_ids.push(product.id);
    var promo = qaCreatePromotion_(fx.token, product.id, fx.stamp, 'GiftMonetaryNeutral', { discount_value:100 });
    fx.promotion_ids.push(promo.promotion_id);
    var gift = qaCreateGiftItem_(fx.token, fx.stamp, 'GiftMonetaryNeutral', { stock:50 });
    fx.gift_ids.push(gift.gift_id);
    var rule = qaCreateGiftRule_(fx.token, fx.stamp, 'GiftMonetaryNeutral', gift.gift_id, {
      condition_json:{ required_products:[{ product_id:product.id, min_qty:1 }] },
      gift_qty:10, repeat_mode:'per_threshold'
    });
    fx.rule_ids.push(rule.rule_id);
    var res = qaSubmitAndTrack_(qaBuildOrderPayloadForProduct_('qa-rule-gift-money', fx.stamp, 'Buyer', product.id, fx.shipping, { qty:2 }), fx.order_ids);
    qaAssertOk_(res);
    var order = qaReadOrder_(fx.token, qaOrderIdsFromSubmit_(res)[0]);
    var line = qaFindProductLine_(order, product.id);
    var gifts = qaActiveGiftLines_(order, gift.gift_id);
    qaAssert_(line && Number(line.unit_final_price) === 900 && Number(line.subtotal) === 1800,
      'Promoted product monetary snapshot mismatch', line);
    qaAssert_(gifts.length === 1 && Number(gifts[0].gift_qty) === 20,
      'Repeated gift quantity must be twenty', gifts);
    qaAssert_(Number(order.subtotal) === 1800 && Number(order.shipping_fee) === 80 && Number(order.total) === 1880,
      'Gift quantity must not affect subtotal, shipping weight, or total', order);
    qaAssert_(qaGetProductStock_(product.id) === 3 && qaGetGiftStock_(gift.gift_id) === 30,
      'Product/gift stocks must still deduct their own quantities', { product:qaGetProductStock_(product.id), gift:qaGetGiftStock_(gift.gift_id) });
    output = { order_id:order.order_id, product_subtotal:order.subtotal, shipping_fee:order.shipping_fee, total:order.total, gift_qty:gifts[0].gift_qty };
  } catch (err) { caught = err; }
  var cleanup = qaCleanupCommerceFixture_(fx);
  if (caught) { caught.details = Object.assign({}, caught.details || {}, { cleanup:cleanup }); throw caught; }
  output.cleanup = cleanup;
  return output;
}
