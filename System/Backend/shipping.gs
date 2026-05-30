/**
 * shipping.gs — Shipment Tracking Module
 *
 * Dedicated module for all carrier tracking logic.
 * Supports: AfterShip, Thailand Post (ไปรษณีย์ไทย), ETracking
 *
 * All provider responses are normalized into the unified TrackingResult format:
 * {
 *   ok: true,
 *   provider: 'aftership'|'thaipost'|'etracking',
 *   trackingNumber: string,
 *   carrierId: string,
 *   tag: string,          // AfterShip-compatible status tag
 *   events: [{ tag, message, location, time }],  // oldest-first
 *   isDelivered: boolean,
 *   lastUpdatedAt: string  // ISO8601
 * }
 *
 * events array is oldest-first (matches AfterShip convention).
 * order-view.html's _buildAftershipTimeline() reverses for display.
 */

/* ========== SECTION 1: CONSTANTS ========== */

var SHIP_AFTERSHIP_BASE = 'https://api.aftership.com/tracking/2026-01';
var SHIP_THP_BASE       = 'https://trackapi.thailandpost.co.th/post/api/v1';
var SHIP_ETRACK_BASE    = 'https://api.etrackings.com/api/v3';

var RATE_TRACKING_PREFIX = 'RATE_TRACK_';

// Carrier ID → AfterShip tracking slug
var AFTERSHIP_SLUGS = {
  thaipost: 'thailand-post',
  kerry:    'kerry-express-th',
  flash:    'flashexpress',
  jt:       'jt',
  best:     '800bestex',
  dhl:      'dhl-global-mail-asia'
};

// Carrier ID → ETracking courier key
// Thailand Post is intentionally absent — not supported by ETracking
var ETRACK_SLUGS = {
  kerry: 'kex-express',
  flash: 'flash-express',
  jt:    'jt-express',
  best:  'best-express',
  dhl:   'dhl-ecommerce'
};

// Thailand Post numeric status code → AfterShip tag
var THP_STATUS_TO_TAG = {
  '103': 'InfoReceived',
  '201': 'InTransit',
  '211': 'InTransit',
  '206': 'InTransit',
  '301': 'OutForDelivery',
  '501': 'Delivered'
};

// ETracking status string → AfterShip tag
var ETRACK_STATUS_TO_TAG = {
  'ON_DELIVERED':    'Delivered',
  'ON_SHIPPING':     'InTransit',
  'ON_OTHER_STATUS': 'InTransit'
};

/* ========== SECTION 2: SCRIPT PROPERTY HELPERS ========== */

function shipProp_(key) {
  return (PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function shipHasProp_(key) {
  return !!shipProp_(key);
}

// Returns masked version of a stored secret, e.g. "****abcd"
function shipPropMasked_(key) {
  var val = shipProp_(key);
  if (!val) return '';
  if (val.length <= 6) return '****';
  return '****' + val.slice(-4);
}

/* ========== SECTION 3: AFTERSHIP ADAPTER ========== */

function asHeaders_() {
  return {
    'as-api-key':     shipProp_('AFTERSHIP_API_KEY'),
    'Content-Type':   'application/json',
    'Accept':         'application/json'
  };
}

function asRequest_(method, path, body) {
  var opts = { method: method, headers: asHeaders_(), muteHttpExceptions: true };
  if (body !== null && body !== undefined) opts.payload = JSON.stringify(body);
  var resp = UrlFetchApp.fetch(SHIP_AFTERSHIP_BASE + path, opts);
  var code = resp.getResponseCode();
  var json; try { json = JSON.parse(resp.getContentText()); } catch(_) { json = {}; }
  return { statusCode: code, body: json };
}

// Normalize AfterShip tracking object → unified TrackingResult
function asNormalize_(trackingData, trackingNumber, carrierId) {
  var checkpoints = (trackingData.checkpoints || []).map(function(cp) {
    return {
      tag:      cp.tag      || cp.subtag || '',
      message:  cp.message  || '',
      location: cp.city     || cp.location || cp.country_name || '',
      time:     cp.checkpoint_time || cp.created_at || ''
    };
  }).filter(function(cp) { return !!cp.message; });
  // AfterShip returns oldest-first ✓ no reversal needed

  return {
    ok:            true,
    provider:      'aftership',
    trackingNumber: trackingNumber,
    carrierId:     carrierId,
    tag:           trackingData.tag || '',
    events:        checkpoints,
    isDelivered:   trackingData.tag === 'Delivered',
    lastUpdatedAt: trackingData.updated_at || nowISO_()
  };
}

// Fetch live tracking from AfterShip
function callAftershipTracking_(trackingNumber, carrierId) {
  if (!shipHasProp_('AFTERSHIP_API_KEY')) return { ok: false, source: 'no_key' };
  var slug = AFTERSHIP_SLUGS[String(carrierId)];
  if (!slug) return { ok: false, source: 'unsupported' };
  try {
    var r = asRequest_('get',
      '/trackings?tracking_numbers=' + encodeURIComponent(trackingNumber) +
      '&slug=' + encodeURIComponent(slug) + '&limit=10',
      null);
    if (r.statusCode === 429) return { ok: false, source: 'rate_limit' };
    if (r.statusCode !== 200) return { ok: false, source: 'aftership_error', httpCode: r.statusCode };
    var list = r.body && r.body.data && r.body.data.trackings;
    var tracking = (list && list.length) ? list[0] : null;
    if (!tracking) return { ok: false, source: 'not_registered' };
    return asNormalize_(tracking, trackingNumber, carrierId);
  } catch(err) {
    return { ok: false, source: 'error', message: String(err) };
  }
}

// Register a new tracking with AfterShip — called from orderMarkShippedRpc
// Returns { ok, source, httpCode?, errorCode?, message? }
function registerAftershipTracking_(carrierId, trackingNumber, orderId) {
  if (!shipHasProp_('AFTERSHIP_API_KEY')) return { ok: false, source: 'no_key' };
  var slug = AFTERSHIP_SLUGS[String(carrierId)];
  if (!slug) return { ok: false, source: 'unsupported' };
  if (!trackingNumber) return { ok: false, source: 'no_tracking_number' };
  try {
    var body = {
      tracking_number: String(trackingNumber),
      slug:            slug,
      order_number:    String(orderId || ''),
      language:        'th'
    };
    var r = asRequest_('post', '/trackings', body);
    if (r.statusCode === 201) return { ok: true, source: 'created', httpCode: 201 };
    var firstErr = r.body && r.body.errors && r.body.errors[0];
    if (firstErr && firstErr.code === 'tracking_already_registered') return { ok: true, source: 'already_exists', httpCode: r.statusCode };
    var metaCode = r.body && r.body.meta && r.body.meta.code;
    if (metaCode === 4003) return { ok: true, source: 'already_exists', httpCode: r.statusCode };
    var errCode = (firstErr && firstErr.code) || metaCode || r.statusCode;
    var errMsg  = (firstErr && firstErr.message) || (r.body && r.body.meta && r.body.meta.message) || '';
    return { ok: false, source: 'aftership_error', httpCode: r.statusCode, errorCode: errCode, message: errMsg };
  } catch(err) {
    return { ok: false, source: 'error', message: String(err) };
  }
}

// Find AfterShip internal tracking ID from tracking number + slug
// Required for DELETE with AfterShip API 2026-01 (DELETE /trackings/:id)
function asFindTrackingId_(trackingNumber, slug) {
  var r = asRequest_('get',
    '/trackings?tracking_numbers=' + encodeURIComponent(String(trackingNumber)) +
    '&slug=' + encodeURIComponent(slug) + '&limit=10',
    null);
  if (r.statusCode !== 200) return null;
  var list = r.body && r.body.data && r.body.data.trackings;
  var tracking = (list && list.length) ? list[0] : null;
  return (tracking && tracking.id) ? tracking.id : null;
}

// Delete a tracking from AfterShip — called when admin deletes an order with auto-tracking
// AfterShip API 2026-01 requires DELETE /trackings/:id (internal ID, not tracking number)
// 404 = already gone = acceptable
function deleteAftershipTracking_(carrierId, trackingNumber) {
  if (!shipHasProp_('AFTERSHIP_API_KEY')) return { ok: true, source: 'no_key' };
  var slug = AFTERSHIP_SLUGS[String(carrierId)];
  if (!slug || !trackingNumber) return { ok: true, source: 'skipped' };
  try {
    var trackingId = asFindTrackingId_(String(trackingNumber), slug);
    if (!trackingId) return { ok: true, source: 'not_found' };
    var r = asRequest_('delete', '/trackings/' + encodeURIComponent(trackingId), null);
    if (r.statusCode === 200 || r.statusCode === 204 || r.statusCode === 404) return { ok: true, source: 'deleted', httpCode: r.statusCode };
    return { ok: false, source: 'aftership_error', httpCode: r.statusCode };
  } catch(err) {
    return { ok: false, source: 'error', message: String(err) };
  }
}

/* ========== SECTION 4: THAILAND POST ADAPTER ========== */

// Obtain bearer access token from Thailand Post static token
function thpAccessToken_() {
  var staticToken = shipProp_('THP_STATIC_TOKEN');
  if (!staticToken) throw new Error('ไม่พบ THP_STATIC_TOKEN ใน Script Properties');
  var resp = UrlFetchApp.fetch(SHIP_THP_BASE + '/authenticate/token', {
    method: 'post',
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Token ' + staticToken, 'Content-Type': 'application/json' },
    payload: JSON.stringify({})
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    throw new Error('Thailand Post authentication failed: HTTP ' + resp.getResponseCode());
  }
  var data; try { data = JSON.parse(resp.getContentText()); } catch(_) { data = {}; }
  var token = data.token || data.access_token || (data.response && data.response.token);
  if (!token) throw new Error('ไม่พบ access token ใน response ของ Thailand Post');
  return token;
}

// Parse THP date "DD/MM/YYYY HH:MM:SS+07:00" → ISO8601
// THP uses Buddhist Era (BE) year; converts to Gregorian (BE − 543)
function thpParseDate_(str) {
  if (!str) return '';
  var m = String(str).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})?/);
  if (!m) return String(str);
  var day = m[1], month = m[2], year = parseInt(m[3], 10);
  var time = m[4], tz = m[5] || '+07:00';
  if (year > 2400) year -= 543; // BE → Gregorian
  return year + '-' + month + '-' + day + 'T' + time + tz;
}

// Normalize Thailand Post items array → unified TrackingResult
// items are oldest-first (same as AfterShip) ✓
function thpNormalize_(items, trackingNumber) {
  var events = items.map(function(item) {
    return {
      tag:      THP_STATUS_TO_TAG[String(item.status || '')] || 'InTransit',
      message:  item.status_description || item.status_detail || '',
      location: item.location || '',
      time:     thpParseDate_(item.status_date || '')
    };
  });

  var lastStatus = items.length ? String(items[items.length - 1].status || '') : '';
  var tag = THP_STATUS_TO_TAG[lastStatus] || (events.length ? 'InTransit' : '');
  var isDelivered = (lastStatus === '501');
  var lastUpdatedAt = events.length ? events[events.length - 1].time : nowISO_();

  return {
    ok:            true,
    provider:      'thaipost',
    trackingNumber: trackingNumber,
    carrierId:     'thaipost',
    tag:           tag,
    events:        events,
    isDelivered:   isDelivered,
    lastUpdatedAt: lastUpdatedAt
  };
}

// Fetch live tracking from Thailand Post API
function callThaipostTracking_(trackingNumber) {
  if (!shipHasProp_('THP_STATIC_TOKEN')) return { ok: false, source: 'no_key' };
  try {
    var accessToken = thpAccessToken_();
    var resp = UrlFetchApp.fetch(SHIP_THP_BASE + '/track', {
      method: 'post',
      muteHttpExceptions: true,
      headers: {
        'Authorization':  'Token ' + accessToken,
        'Content-Type':   'application/json'
      },
      payload: JSON.stringify({ status: 'all', language: 'TH', barcode: [String(trackingNumber)] })
    });
    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
      return { ok: false, source: 'thaipost_error', httpCode: resp.getResponseCode() };
    }
    var data; try { data = JSON.parse(resp.getContentText()); } catch(_) { data = {}; }
    if (!data.status) return { ok: false, source: 'thaipost_error', message: data.message || '' };
    var items = (data.response && data.response.items && data.response.items[String(trackingNumber)]) || [];
    return thpNormalize_(items, trackingNumber);
  } catch(err) {
    return { ok: false, source: 'error', message: String(err) };
  }
}

/* ========== SECTION 5: ETRACKING ADAPTER ========== */

function etHeaders_() {
  return {
    'Etrackings-Api-Key':    shipProp_('ETRACK_API_KEY'),
    'Etrackings-Key-Secret': shipProp_('ETRACK_KEY_SECRET'),
    'Accept-Language':       'th',
    'Content-Type':          'application/json'
  };
}

// Normalize ETracking response → unified TrackingResult
// ETracking timelines and details are newest-first; reverse to oldest-first
function etNormalize_(raw, trackingNumber, carrierId) {
  var data = (raw && raw.data) ? raw.data : {};
  var overallStatus = String(data.status || '');
  var tag = ETRACK_STATUS_TO_TAG[overallStatus] || 'InTransit';
  var isDelivered = (overallStatus === 'ON_DELIVERED');
  var lastUpdatedAt = data.lastUpdatedStatusAt || nowISO_();

  var events = [];
  var timelines = Array.isArray(data.timelines) ? data.timelines : [];
  for (var i = 0; i < timelines.length; i++) {
    var details = Array.isArray(timelines[i].details) ? timelines[i].details : [];
    for (var j = 0; j < details.length; j++) {
      var d = details[j];
      events.push({
        tag:      ETRACK_STATUS_TO_TAG[String(d.status || '')] || 'InTransit',
        message:  d.description || '',
        location: '',
        time:     d.dateTime || ''
      });
    }
  }
  // ETracking returns newest-first → reverse to oldest-first (matches AfterShip convention)
  events.reverse();

  return {
    ok:            true,
    provider:      'etracking',
    trackingNumber: trackingNumber,
    carrierId:     carrierId,
    tag:           tag,
    events:        events,
    isDelivered:   isDelivered,
    lastUpdatedAt: lastUpdatedAt
  };
}

// Fetch live tracking from ETracking API
function callEtrackTracking_(trackingNumber, carrierId) {
  var slug = ETRACK_SLUGS[String(carrierId)];
  if (!slug) return { ok: false, source: 'carrier_not_supported' };
  if (!shipHasProp_('ETRACK_API_KEY')) return { ok: false, source: 'no_key' };
  try {
    var resp = UrlFetchApp.fetch(SHIP_ETRACK_BASE + '/tracks/find', {
      method: 'post',
      muteHttpExceptions: true,
      headers: etHeaders_(),
      payload: JSON.stringify({ trackingNo: String(trackingNumber), courier: slug })
    });
    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
      return { ok: false, source: 'etracking_error', httpCode: resp.getResponseCode() };
    }
    var raw; try { raw = JSON.parse(resp.getContentText()); } catch(_) { raw = {}; }
    if (!raw.meta || raw.meta.code !== 200) {
      return { ok: false, source: 'etracking_error', message: raw.meta ? raw.meta.message : '' };
    }
    return etNormalize_(raw, trackingNumber, carrierId);
  } catch(err) {
    return { ok: false, source: 'error', message: String(err) };
  }
}

// Delete a tracking from ETracking — called when admin deletes an order or rolls back status
// Uses ETRACK_SLUGS (hardcoded) so it works even if the shipping row has been deleted
// 404 = already gone = acceptable
function deleteEtrackingTracking_(carrierId, trackingNumber) {
  if (!shipHasProp_('ETRACK_API_KEY')) return { ok: true, source: 'no_key' };
  var slug = ETRACK_SLUGS[String(carrierId)];
  if (!slug || !trackingNumber) return { ok: true, source: 'skipped' };
  try {
    var resp = UrlFetchApp.fetch(
      SHIP_ETRACK_BASE + '/tracks/' + encodeURIComponent(slug) + '/' + encodeURIComponent(String(trackingNumber)),
      { method: 'delete', headers: etHeaders_(), muteHttpExceptions: true }
    );
    var code = resp.getResponseCode();
    if (code === 200 || code === 204 || code === 404) return { ok: true, source: 'deleted', httpCode: code };
    return { ok: false, source: 'etracking_error', httpCode: code };
  } catch(err) {
    return { ok: false, source: 'error', message: String(err) };
  }
}

/* ========== SECTION 6: PROVIDER SELECTION & ORCHESTRATION ========== */

// Enforce carrier-provider compatibility rules:
// - 'thaipost' provider → only for carrierId === 'thaipost'
// - 'etracking' provider → NOT for carrierId === 'thaipost' (ETracking doesn't support ThaiPost)
// - 'aftership' → allowed for all carriers
function validateProviderCarrier_(provider, carrierId) {
  if (!provider || provider === 'aftership') return true;
  if (provider === 'thaipost') return String(carrierId) === 'thaipost';
  if (provider === 'etracking') return String(carrierId) !== 'thaipost';
  return false;
}

// Call the correct adapter and return a unified TrackingResult or error object
function fetchTracking_(trackingNumber, carrierId, provider) {
  if (!validateProviderCarrier_(provider, carrierId)) {
    return { ok: false, source: 'provider_carrier_mismatch', events: [], tag: '', isDelivered: false };
  }
  var result;
  if (provider === 'thaipost') {
    result = callThaipostTracking_(trackingNumber);
  } else if (provider === 'etracking') {
    result = callEtrackTracking_(trackingNumber, carrierId);
  } else {
    result = callAftershipTracking_(trackingNumber, carrierId);
  }
  if (!result.ok) {
    return { ok: false, source: result.source || 'error', events: [], tag: '', isDelivered: false };
  }
  return result;
}

/* ========== SECTION 7: DELIVERED CACHE ========== */

// Returns the delivered_cache object if it exists, null otherwise
function getDeliveredCache_(trackingJson) {
  if (!trackingJson || !trackingJson.delivered_cache) return null;
  return trackingJson.delivered_cache;
}

// Persist the delivered tracking result inside the order's tracking_json (encrypted)
// Also updates order status to 'delivered' and appends status_history entry
function saveDeliveredCache_(sh, rowNo, row, trackingJson, unifiedResult, currentStatus) {
  try {
    var now = nowISO_();
    var lastEventTime = (unifiedResult.events && unifiedResult.events.length)
      ? unifiedResult.events[unifiedResult.events.length - 1].time  // events are oldest-first; last = most recent
      : now;

    trackingJson.delivered_cache = {
      provider:    unifiedResult.provider,
      tag:         'Delivered',
      events:      unifiedResult.events,
      deliveredAt: lastEventTime,
      cachedAt:    now
    };

    // Write encrypted tracking_json back to sheet
    var trackingColIdx = ORDER_COLS.indexOf('tracking_json') + 1;
    sh.getRange(rowNo, trackingColIdx).setValue(encryptField_(JSON.stringify(trackingJson)));

    // Update order status only when currently 'shipped' (don't re-write if already 'delivered')
    if (currentStatus === 'shipped') {
      var histColIdx = ORDER_COLS.indexOf('status_history_json') + 1;
      var history = [];
      try { history = JSON.parse(String(row[ORDER_COLS.indexOf('status_history_json')] || '[]')); } catch(_) { history = []; }

      var providerLabel = { aftership: 'AfterShip', thaipost: 'ไปรษณีย์ไทย', etracking: 'ETracking' }[unifiedResult.provider] || unifiedResult.provider;
      history.push({ status: 'delivered', timestamp: now, note: 'ยืนยันจาก ' + providerLabel + ' อัตโนมัติ' });

      sh.getRange(rowNo, ORDER_COLS.indexOf('status') + 1).setValue('delivered');
      sh.getRange(rowNo, ORDER_COLS.indexOf('updated_at') + 1).setValue(now);
      sh.getRange(rowNo, histColIdx).setValue(JSON.stringify(history));
    }

    try { rebuildSnap_(); } catch(_) {}
  } catch(_) {
    // Never let cache write failures break the tracking response
  }
}

/* ========== SECTION 8: PUBLIC RPC — getCarrierTrackingRpc ========== */

/**
 * Customer-facing RPC to fetch live shipment tracking.
 * Security: rate-limited (10 req/min per token), token expiry checked,
 * equivalent protection to getOrderByTokenRpc.
 */
function getCarrierTrackingRpc(orderToken, trackingNumber, carrierId) {
  // Abort if key rotation is in progress
  if (checkRotateLock_()) return { ok: true, events: [], source: 'rotate_lock' };

  if (!orderToken) return { ok: true, events: [], source: 'invalid_token' };

  // Rate limit: 10 requests per minute per token prefix (identical to getOrderByTokenRpc)
  var rateKey = RATE_TRACKING_PREFIX + String(orderToken).slice(0, 16);
  var rl = checkRateLimit_(rateKey, 10, 60);
  if (rl.blocked) return { ok: false, error: 'คำขอมากเกินไป กรุณารอสักครู่' };
  recordFailedAttempt_(rateKey, 10, 60); // count every access, not just failures

  try {
    var vt = validateOrderToken_(orderToken, { scope:'tracking', maxRate:10, rateWindow:60 });
    if (!vt.ok) {
      if (vt.code === 'TOKEN_EXPIRED') return { ok:false, error:vt.error };
      return { ok:true, events:[], source:'invalid_token' };
    }
    var sh = vt.sh;
    var rowNo = vt.rowNo;
    var row = vt.row;

    // Decrypt tracking_json
    var trackingJson = null;
    try {
      var rawTj = row[ORDER_COLS.indexOf('tracking_json')];
      var decrypted = rawTj ? decryptField_(String(rawTj)) : '';
      trackingJson = decrypted ? JSON.parse(decrypted) : null;
    } catch(_) { trackingJson = null; }

    if (!trackingJson) return { ok: true, events: [], source: 'no_tracking_data' };

    // Return delivered cache immediately — no API call needed
    var cache = getDeliveredCache_(trackingJson);
    if (cache) {
      return { ok: true, tag: cache.tag, events: cache.events, source: 'cached', isDelivered: true };
    }

    // Resolve tracking params (stored values are trusted; client params are fallback only)
    var tn       = trackingJson.tracking_number || String(trackingNumber || '');
    var cid      = trackingJson.carrier_id      || String(carrierId || '');
    var provider = trackingJson.tracking_provider || 'aftership'; // default for backward compat

    if (!tn) return { ok: true, events: [], source: 'no_tracking_number' };

    // Fetch live tracking from selected provider
    var result = fetchTracking_(tn, cid, provider);
    if (!result.ok) {
      return { ok: true, events: [], source: result.source || 'error' };
    }

    // Persist delivered state to avoid future API calls
    var currentStatus = String(row[ORDER_COLS.indexOf('status')] || '');
    if (result.isDelivered) {
      saveDeliveredCache_(sh, rowNo, row, trackingJson, result, currentStatus);
    }

    return {
      ok:          true,
      tag:         result.tag,
      events:      result.events,
      source:      result.provider,
      isDelivered: result.isDelivered
    };

  } catch(err) {
    return { ok: true, events: [], source: 'error', error: String(err) };
  }
}

/* ========== SECTION 9: ADMIN API KEY RPC ========== */

// --- AfterShip ---

// Best-effort audit for a carrier-key change. Resolves the session via
// getSession_ (global). Never logs the key value itself.
function auditProviderKey_(token, action, provider, rpcName) {
  var _s = getSession_(token);
  auditLog_(action, { category:['configuration'], type:['change'],
    outcome:'success', level:'warning', route:'system', rpc:rpcName,
    userId: (_s && _s.userId) || null, sessionId: token,
    meta:{ provider: provider } }, (_s && _s.logCtx) || null);
}

function saveAftershipKeyRpc(token, apiKey) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    PropertiesService.getScriptProperties().setProperty('AFTERSHIP_API_KEY', String(apiKey || '').trim());
    auditProviderKey_(token, 'shipping.provider_key.update', 'aftership', 'saveAftershipKeyRpc');
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err) }; }
}

function clearAftershipKeyRpc(token) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    PropertiesService.getScriptProperties().deleteProperty('AFTERSHIP_API_KEY');
    auditProviderKey_(token, 'shipping.provider_key.clear', 'aftership', 'clearAftershipKeyRpc');
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err) }; }
}

// --- Thailand Post ---

function saveThaipostTokenRpc(token, staticToken) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  var val = String(staticToken || '').trim();
  if (!val) return { ok: false, error: 'กรุณาระบุ Static Token' };
  try {
    PropertiesService.getScriptProperties().setProperty('THP_STATIC_TOKEN', val);
    auditProviderKey_(token, 'shipping.provider_key.update', 'thaipost', 'saveThaipostTokenRpc');
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err) }; }
}

function clearThaipostTokenRpc(token) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    PropertiesService.getScriptProperties().deleteProperty('THP_STATIC_TOKEN');
    auditProviderKey_(token, 'shipping.provider_key.clear', 'thaipost', 'clearThaipostTokenRpc');
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err) }; }
}

// --- ETracking ---

function saveEtrackKeyRpc(token, apiKey, keySecret) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  var k = String(apiKey || '').trim();
  var s = String(keySecret || '').trim();
  if (!k || !s) return { ok: false, error: 'กรุณาระบุ API Key และ Key Secret' };
  try {
    var sp = PropertiesService.getScriptProperties();
    sp.setProperty('ETRACK_API_KEY',    k);
    sp.setProperty('ETRACK_KEY_SECRET', s);
    auditProviderKey_(token, 'shipping.provider_key.update', 'etracking', 'saveEtrackKeyRpc');
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err) }; }
}

function clearEtrackKeyRpc(token) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var sp = PropertiesService.getScriptProperties();
    sp.deleteProperty('ETRACK_API_KEY');
    sp.deleteProperty('ETRACK_KEY_SECRET');
    auditProviderKey_(token, 'shipping.provider_key.clear', 'etracking', 'clearEtrackKeyRpc');
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err) }; }
}
