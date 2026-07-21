'use strict';

// Generic, synthetic fixtures shaped exactly like the backend snapshot contract
// (System/Backend/code.gs: applyPromotionsToProducts_ / publicPromoSummary_ /
// calcPromotionPrice_ / resolveBestPromotionForLine_). Names are deliberately
// fictional — no real product/promotion names or values from any real store.

function makePromoSummary(overrides) {
  return Object.assign({
    promotion_id: 'promo-fixture-1',
    name: 'Fixture Promo',
    discount_type: 'fixed',
    discount_value: 10,
    starts_at: '2020-01-01T00:00:00.000Z',
    ends_at: '2099-01-01T00:00:00.000Z',
    no_end_date: false,
    application_mode: 'direct',
    condition_type: '',
    discount_scope: 'item'
  }, overrides || {});
}

// No variants, no promotion at all.
const productNoPromo = {
  id: 'fx-prod-1',
  title: 'Fixture Product A',
  price: 100,
  promotion: null,
  final_price: 100,
  discount_amount: 0
};

// No variants, direct fixed discount baked onto the root snapshot fields.
const productRootFixedPromo = {
  id: 'fx-prod-2',
  title: 'Fixture Product B',
  price: 99,
  promotion: makePromoSummary({ promotion_id: 'promo-fixed', name: 'Fixture Promo Fixed', discount_type: 'fixed', discount_value: 15 }),
  final_price: 84,       // Math.round(99 - 15)
  discount_amount: 15
};

// Two variant options — one priced explicitly, one via delta — each with its own
// resolved promotion in variant_promotions. "Large" is a deliberate rounding
// boundary: 150 * (1 - 0.33) = 100.5 -> Math.round -> 101.
const productVariants = {
  id: 'fx-prod-3',
  title: 'Fixture Product C',
  price: 100,
  variants: [
    { name: 'Size', type: 'text', options: [
      { label: 'Small', price: 100 },
      { label: 'Large', delta: 50 }
    ] }
  ],
  promotion: null,
  final_price: 100,
  discount_amount: 0,
  variant_promotions: {
    'Size=Small': {
      promotion: makePromoSummary({ promotion_id: 'promo-percent-small', name: 'Fixture Promo Percent', discount_type: 'percent', discount_value: 33 }),
      unit_base_price: 100,
      unit_final_price: 67,   // Math.round(100 * 0.67)
      unit_discount_amount: 33
    },
    'Size=Large': {
      promotion: makePromoSummary({ promotion_id: 'promo-percent-large', name: 'Fixture Promo Percent', discount_type: 'percent', discount_value: 33 }),
      unit_base_price: 150,
      unit_final_price: 101,  // Math.round(150 * 0.67) = Math.round(100.5)
      unit_discount_amount: 49
    }
  }
};

// Two variant options, each with a different competing promotion, to test that
// card-level resolution picks the cheapest final price ("Blue" wins).
const productCompetingPromos = {
  id: 'fx-prod-4',
  title: 'Fixture Product D',
  price: 200,
  variants: [
    { name: 'Color', type: 'text', options: [
      { label: 'Red', price: 200 },
      { label: 'Blue', price: 200 }
    ] }
  ],
  promotion: null,
  final_price: 200,
  discount_amount: 0,
  variant_promotions: {
    'Color=Red': {
      promotion: makePromoSummary({ promotion_id: 'promo-a', name: 'Fixture Promo A', discount_type: 'fixed', discount_value: 20 }),
      unit_base_price: 200, unit_final_price: 180, unit_discount_amount: 20
    },
    'Color=Blue': {
      promotion: makePromoSummary({ promotion_id: 'promo-b', name: 'Fixture Promo B', discount_type: 'fixed', discount_value: 60 }),
      unit_base_price: 200, unit_final_price: 140, unit_discount_amount: 60
    }
  }
};

module.exports = {
  makePromoSummary,
  productNoPromo,
  productRootFixedPromo,
  productVariants,
  productCompetingPromos
};
