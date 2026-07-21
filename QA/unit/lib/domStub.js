'use strict';

function makeElement(id) {
  return {
    id: id,
    textContent: '',
    style: {},
    className: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) {
        if (force === undefined) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); }
        else if (force) this._set.add(c); else this._set.delete(c);
      },
      contains(c) { return this._set.has(c); }
    },
    innerHTML: ''
  };
}

// Minimal fake DOM sufficient for the pricing/checkout-total functions under test
// (_updateOcmTotals, _buildClientPricingSnapshot). getElementById returns a
// lazily-created, persistent-per-sandbox stub element so writes can be asserted
// on afterwards. querySelectorAll is test-controlled via setQuerySelectorAllResult
// so shipping-fee radio-button lookups can be simulated without a real DOM.
function createDomStub() {
  const elements = new Map();
  let qsaResult = [];
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() {
      return qsaResult;
    },
    setQuerySelectorAllResult(arr) { qsaResult = arr || []; },
    _elements: elements
  };
}

module.exports = { createDomStub, makeElement };
