'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunctionSource } = require('./lib/extractFns');

const BACKEND = path.join(__dirname, '..', '..', 'System', 'Backend', 'code.gs');
const source = fs.readFileSync(BACKEND, 'utf8');
const functionNames = [
  'buildVariantKey_',
  'parseBoundedPositiveInteger_',
  '_isPlainObject_',
  'resolveServerVariantSelection_',
  'normalizeOrderCart_'
];
const sandbox = {
  MAX_ORDER_LINES: 100,
  MAX_QTY_PER_LINE: 9999,
  MAX_QTY_PER_PRODUCT_VARIANT: 9999,
  MAX_QTY_PER_PRODUCT: 9999,
  MAX_TOTAL_ORDER_QTY: 50000,
  MAX_SAFE_INTEGER_TEXT_: '9007199254740991'
};
const context = vm.createContext(sandbox);
new vm.Script(functionNames.map((name) => extractFunctionSource(source, name)).join('\n\n'), {
  filename: BACKEND + ' (cart validation extracted)'
}).runInContext(context);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function item(productId, qty, selectedVariants) {
  return { product_id: productId, qty, selected_variants: selectedVariants };
}

const noVariant = {
  id: 'product-basic', title: 'Generic Basic', price: 100, weight_grams: 50,
  image_drive_file_id: 'root-image', image_url: 'root-url', variants: []
};
const twoGroups = {
  id: 'product-two-groups', title: 'Generic Configurable', price: 100, weight_grams: 50,
  image_drive_file_id: 'root-image', image_url: 'root-url',
  variants: [
    { name: 'Size', options: [
      { label: 'M', price: 120, weight_grams: 100, stock: 20, image_file_id: 'size-image', image: 'size-url' },
      { label: 'L', price: 130, weight_grams: 110, stock: 20 }
    ] },
    { name: 'Color', options: [
      { label: 'Red', price: 150, weight_grams: 200, stock: 10 },
      { label: 'Blue', price: 160, weight_grams: 210, stock: 10 }
    ] }
  ]
};
const productMap = {
  [noVariant.id]: noVariant,
  [twoGroups.id]: twoGroups
};

console.log('backend zero-trust cart validation');

test('rejects a missing single variant group', () => {
  const oneGroup = Object.assign({}, twoGroups, { id: 'one-group', variants: [twoGroups.variants[0]] });
  const result = context.normalizeOrderCart_([item(oneGroup.id, 1, {})], { [oneGroup.id]: oneGroup });
  assert.strictEqual(result.error, 'VARIANT_SELECTION_REQUIRED');
  assert.strictEqual(result.variant_group, 'Size');
});

test('rejects an incomplete multi-group selection', () => {
  const result = context.normalizeOrderCart_([item(twoGroups.id, 1, { Size: 'M' })], productMap);
  assert.strictEqual(result.error, 'VARIANT_SELECTION_REQUIRED');
  assert.strictEqual(result.variant_group, 'Color');
});

test('rejects unknown groups, unknown options, and non-object selections', () => {
  assert.strictEqual(context.normalizeOrderCart_([
    item(twoGroups.id, 1, { Size: 'M', Color: 'Red', Material: 'Cotton' })
  ], productMap).error, 'INVALID_VARIANT_GROUP');
  assert.strictEqual(context.normalizeOrderCart_([
    item(twoGroups.id, 1, { Size: 'M', Color: 'Green' })
  ], productMap).error, 'INVALID_VARIANT_OPTION');
  assert.strictEqual(context.normalizeOrderCart_([
    item(twoGroups.id, 1, [])
  ], productMap).error, 'INVALID_VARIANT_OPTION');
});

test('derives canonical variant pricing, weight, image, key, and display text on the server', () => {
  const result = context.normalizeOrderCart_([
    item(twoGroups.id, 2, { Color: 'Red', Size: 'M' })
  ], productMap);
  assert.strictEqual(result.ok, true);
  const line = result.items[0];
  assert.strictEqual(line.rawUnitPrice, 150);
  assert.strictEqual(line.itemWeight, 200);
  assert.strictEqual(line.itemImgFileId, 'size-image');
  assert.strictEqual(line.variantKey, 'Color=Red|Size=M');
  assert.strictEqual(line.variant_info, 'Size: M, Color: Red');
  assert.deepStrictEqual(plain(line.selectedVariants), { Size: 'M', Color: 'Red' });
});

test('keeps no-variant products backward compatible and rejects invented groups', () => {
  assert.strictEqual(context.normalizeOrderCart_([item(noVariant.id, 1, {})], productMap).ok, true);
  assert.strictEqual(context.normalizeOrderCart_([item(noVariant.id, 1)], productMap).ok, true);
  assert.strictEqual(context.normalizeOrderCart_([
    item(noVariant.id, 1, { Size: 'M' })
  ], productMap).error, 'INVALID_VARIANT_GROUP');
});

test('accepts only canonical positive safe integers', () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '+1', '01', '9'.repeat(1000), '9007199254740992'];
  invalid.forEach((qty) => assert.strictEqual(
    context.parseBoundedPositiveInteger_(qty, 9999).error,
    'INVALID_QTY',
    'expected INVALID_QTY for ' + String(qty).slice(0, 30)
  ));
  assert.deepStrictEqual(plain(context.parseBoundedPositiveInteger_(' 12 ', 9999)), { ok: true, value: 12 });
});

test('enforces the per-line quantity boundary', () => {
  assert.strictEqual(context.normalizeOrderCart_([item(noVariant.id, 9999, {})], productMap).ok, true);
  assert.strictEqual(context.normalizeOrderCart_([item(noVariant.id, '9999', {})], productMap).ok, true);
  const over = context.normalizeOrderCart_([item(noVariant.id, 10000, {})], productMap);
  assert.strictEqual(over.error, 'QTY_LIMIT_EXCEEDED');
  assert.strictEqual(over.limit, 9999);
});

test('enforces the raw line-count boundary before aggregation', () => {
  const hundred = Array.from({ length: 100 }, () => item(noVariant.id, 1, {}));
  assert.strictEqual(context.normalizeOrderCart_(hundred, productMap).ok, true);
  assert.strictEqual(context.normalizeOrderCart_(hundred.concat(item(noVariant.id, 1, {})), productMap).error, 'TOO_MANY_ITEMS');
});

test('duplicate product+variant lines cannot evade the aggregate limit', () => {
  const result = context.normalizeOrderCart_([
    item(twoGroups.id, 5000, { Size: 'M', Color: 'Red' }),
    item(twoGroups.id, 5000, { Color: 'Red', Size: 'M' })
  ], productMap);
  assert.strictEqual(result.error, 'QTY_LIMIT_EXCEEDED');
  assert.strictEqual(result.scope, 'product_variant');
});

test('different variants of one product cannot evade the product limit', () => {
  const result = context.normalizeOrderCart_([
    item(twoGroups.id, 6000, { Size: 'M', Color: 'Red' }),
    item(twoGroups.id, 4000, { Size: 'L', Color: 'Blue' })
  ], productMap);
  assert.strictEqual(result.error, 'QTY_LIMIT_EXCEEDED');
  assert.strictEqual(result.scope, 'product');
});

test('enforces the whole-order total at 50,000 units', () => {
  const map = {};
  const exact = [];
  for (let i = 0; i < 6; i++) {
    const product = Object.assign({}, noVariant, { id: 'total-product-' + i });
    map[product.id] = product;
    exact.push(item(product.id, i < 5 ? 9999 : 5, {}));
  }
  assert.strictEqual(context.normalizeOrderCart_(exact, map).ok, true);
  exact[5].qty = 6;
  const over = context.normalizeOrderCart_(exact, map);
  assert.strictEqual(over.error, 'QTY_LIMIT_EXCEEDED');
  assert.strictEqual(over.scope, 'order');
});

test('fails closed for malformed items and missing products', () => {
  assert.strictEqual(context.normalizeOrderCart_({}, productMap).error, 'INVALID_ITEMS');
  assert.strictEqual(context.normalizeOrderCart_([null], productMap).error, 'INVALID_ITEMS');
  assert.strictEqual(context.normalizeOrderCart_([item('missing-product', 1, {})], productMap).error, 'PRODUCT_NOT_FOUND');
});

console.log('\n' + passed + ' tests passed');
