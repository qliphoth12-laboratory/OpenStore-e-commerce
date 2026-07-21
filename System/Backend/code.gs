/** Minimal Product Store (single-sheet + Drive images) */

var SYSTEM_VERSION = 'v1.1.0';

const SP = PropertiesService.getScriptProperties();
const SHEET_ID        = SP.getProperty('SHEET_ID');
const DRIVE_FOLDER_ID = SP.getProperty('DRIVE_FOLDER_ID');
const SHEET_NAME_PROD = 'product';
const SHEET_NAME_STORE = 'store';

const SHEET_NAME_SHIPPING = 'shipping';
const SHEET_NAME_PROMOTIONS = 'promotions';
const SHEET_NAME_PAYMENT = 'payment';

/* ---------- cache / storage keys ---------- */
const CACHE_PROD_SNAP    = 'PROD_SNAPSHOT_CACHE';
const CACHE_PROD_TS      = 'PROD_SNAPSHOT_TS';
const CACHE_SITE_CFG     = 'SITE_CONFIG_CACHE';
const CACHE_SITE_CFG_TS  = 'SITE_CONFIG_CACHE_TS';
const CACHE_PROMO_LIST   = 'PROMO_LIST_CACHE';
const CACHE_DRIVE_TS_CHECK = 'PROD_DRIVE_TS_CHECKED'; // sentinel: Drive check was done recently
const DRIVE_TS_CHECK_TTL   = 30;                       // seconds — max staleness from direct Sheet edits
const CACHE_SHIPPING_LIST  = 'SHIPPING_LIST_CACHE';    // cached shipping companies list
const CACHE_PROD_SNAP_META = 'PROD_SNAP_META';         // present only when chunked snapshot is used
const CACHE_PROD_SNAP_PART = 'PROD_SNAP_PART_';        // prefix for chunk keys: PROD_SNAP_PART_0, _1, ...
const CACHE_PROD_SNAP_VALID_UNTIL = 'PROD_SNAP_VALID_UNTIL'; // exact schedule-aware validity boundary
const PROD_SNAP_MAX_TTL     = 600;                     // seconds
const SNAP_CHUNK_SIZE       = 90000;                   // 90 KB per chunk — safe margin below 100 KB CacheService limit
const STORE_KEY_SITE_CFG = 'site_config';
const CACHE_PAYMENT_CFG  = 'PAYMENT_CONFIG_CACHE';
const PAYMENT_ROW_ID     = 'payment_config';

/* ---------- Drive subfolder names ---------- */
const FOLDER_PRODUCT = 'product';  // public — product images
const FOLDER_SLIP    = 'slip';     // private — payment slips (admin only)
const FOLDER_STORE   = 'store';    // public — store brand images
const FOLDER_GIFT    = 'gift';     // public — free gift item images

/* ---------- Gift / sheets ---------- */
const SHEET_NAME_GIFT_ITEMS = 'gift_items';
const SHEET_NAME_GIFT_RULES = 'gift_rules';
const CACHE_GIFT_RULES_LIST = 'GIFT_RULES_LIST_CACHE';
const CACHE_GIFT_ITEMS_LIST = 'GIFT_ITEMS_LIST_CACHE';

/* ---------- auth / session constants ---------- */
const SHEET_NAME_USERS    = 'users';
const SESS_TTL            = 21600;          // CacheService 6 h (max 21600)
const SESS_PREFIX         = 'SESS_';
const LOGIN_OTP_PREFIX    = 'LOGIN_OTP_';   // key = LOGIN_OTP_{email}
const LOGIN_OTP_TTL       = 600;            // 10 min
const EMAIL_CHG_OTP_PREFIX = 'EMAIL_CHG_OTP_'; // key = EMAIL_CHG_OTP_{userId}

const RATE_LOGIN_PREFIX    = 'RATE_LOGIN_';
const RATE_ORDTOK_PREFIX   = 'RATE_ORDTOK_';
const RATE_OTP_SEND_PREFIX = 'RATE_OTP_SEND_';   // per-email login-OTP send throttle
const OTP_SEND_MAX         = 4;                  // max OTP emails per window
const OTP_SEND_WINDOW_SEC  = 600;                // 10 min window
const ROTATE_LOCK_KEY       = 'KEY_ROTATE_LOCK';
const ROTATE_LOCK_TIMEOUT   = 15 * 60 * 1000; // 15 นาที safety timeout

/* ---------- security helpers — OTP v2 / session hashing ---------- */
const OTP_CACHE_PREFIX        = 'OTP_v2_';      // CacheService key prefix for all OTPs
const RATE_OTP_VERIFY_PREFIX  = 'RATE_OTP_';    // rate-limit key prefix for OTP verify
const SESSION_HASH_SECRET_KEY = 'SESSION_HASH_SECRET'; // ScriptProperties key for HMAC secret
/* PII fields to encrypt in orders sheet (PDPA) */
const PII_FIELDS_ORDER = ['customer_name','customer_phone','customer_contact','token',
                          'shipping_name','shipping_address','shipping_district',
                          'shipping_amphoe','shipping_province','shipping_postal_code',
                          'tracking_json'];

/* ---------- utils ---------- */
function uuid_(){ return Utilities.getUuid(); }
function nowISO_(){ return new Date().toISOString(); }
function assertConfig_(){
  if(!SHEET_ID) throw new Error('Missing SHEET_ID (run setupAll)');
  if(!DRIVE_FOLDER_ID) throw new Error('Missing DRIVE_FOLDER_ID (run setupAll)');
}
function getStoreName_() {
  try {
    var raw = getSiteConfigFromSheet_();
    if (raw && raw.json) {
      var cfg = JSON.parse(raw.json);
      if (cfg && cfg.siteTitle) return cfg.siteTitle;
    }
  } catch(_) {}
  return 'Open Storefront';
}
/* ---------- OTP email helpers ---------- */
// Mask an email for UI display: keep ≤3 chars of the local part, hide the rest.
function maskEmail_(email) {
  var e = String(email || '');
  var at = e.indexOf('@');
  if (at < 1) return '***';
  var u = e.slice(0, at);
  return (u.length > 3 ? u.slice(0, 3) : u) + '***@' + e.slice(at + 1);
}
// Minimal HTML escaper for otp/email bodies (no escaper existed in backend).
function _escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Send an OTP email whose inbox PREVIEW / notification snippet does NOT reveal
// the code. A hidden HTML preheader fills the snippet with a generic line and
// zero-width filler pushes the code out of the ~100-char preview; the plain-text
// fallback likewise leads with the generic line so the code sits well below it.
// The code is only visible once the email is actually opened.
// opts: { ttlText?, warnLines?[] }. Returns MailApp remaining daily quota.
function sendOtpEmail_(to, subjectLabel, otp, opts) {
  opts = opts || {};
  var lead = 'คุณได้ขอรหัสยืนยัน กรุณาเปิดอีเมลนี้เพื่อดูรหัส OTP ของคุณ';
  var ttlText = opts.ttlText || 'รหัสนี้จะหมดอายุใน 10 นาที';
  var warnLines = opts.warnLines || ['หากคุณไม่ได้ทำรายการนี้ กรุณาเพิกเฉยข้อความนี้'];

  // Plain-text fallback (non-HTML clients): generic lead first, code far below.
  var textBody = lead + '\n\n\n\nรหัส OTP: ' + otp + '\n\n' + ttlText + '\n' + warnLines.join('\n');

  // Zero-width filler keeps the real content (the code) out of the snippet.
  var filler = '';
  for (var i = 0; i < 80; i++) filler += '&zwnj;&nbsp;';
  var html =
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
    +   'font-size:1px;line-height:1px;color:#ffffff;opacity:0">' + _escapeHtml_(lead) + filler + '</div>'
    + '<div style="font-family:\'Segoe UI\',Tahoma,sans-serif;color:#111827;font-size:14px;line-height:1.6">'
    +   '<p style="margin:0 0 16px">' + _escapeHtml_(lead) + '</p>'
    +   '<p style="margin:0 0 16px;font-size:30px;font-weight:800;letter-spacing:6px;color:#111827">' + _escapeHtml_(otp) + '</p>'
    +   '<p style="margin:0;color:#6b7280;font-size:12px">' + _escapeHtml_(ttlText)
    +     '<br>' + warnLines.map(_escapeHtml_).join('<br>') + '</p>'
    + '</div>';

  MailApp.sendEmail({
    to: to,
    subject: '[' + getStoreName_() + '] ' + subjectLabel,
    body: textBody,
    htmlBody: html
  });
  return MailApp.getRemainingDailyQuota();
}

function ss_(){ return SpreadsheetApp.openById(SP.getProperty('SHEET_ID')); }
function fileTs_(id){ try{ return DriveApp.getFileById(id).getLastUpdated().getTime(); }catch(_){ return 0; } }
function publicUrl_(fileId){ return 'https://drive.google.com/uc?export=view&id=' + fileId; }

/* ---------- sheet helpers ---------- */
// Defensive fallback: derive sale_mode from the legacy active/sale_* columns
// when a row's sale_mode cell is blank. New rows always write sale_mode
// directly, so this only fires for unexpected/blank data.
//   active===false || sale_enabled===false → 'disabled'
//   active===true && (sale_starts_at || sale_ends_at)  → 'scheduled'
//   else                                                 → 'always'
function _computeSaleModeFromLegacy_(active, saleEnabled, saleStartsAt, saleEndsAt) {
  var isActive = active !== false && String(active).toUpperCase() !== 'FALSE';
  var isSaleEnabled = saleEnabled === '' || saleEnabled === undefined
    ? true
    : (saleEnabled !== false && String(saleEnabled).toUpperCase() !== 'FALSE');
  if (!isActive || !isSaleEnabled) return 'disabled';
  if (String(saleStartsAt||'').trim() || String(saleEndsAt||'').trim()) return 'scheduled';
  return 'always';
}

function sheetProd_(){
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_PROD) || ss.insertSheet(SHEET_NAME_PROD);
  // sale_mode (col 20) is the single source of truth for sale status.
  // active, sale_enabled, sale_no_end_date remain in the sheet for historical
  // compatibility but are no longer read by active code paths.
  const head = ['id','title','desc','price','badge','image_drive_file_id','image_url','created_at','updated_at','active','variants_json','extra_images_json','weight_grams','allowed_shipping_ids','stock','sale_enabled','sale_starts_at','sale_ends_at','sale_no_end_date','sale_mode'];
  const firstCell = sh.getLastColumn() > 0 ? sh.getRange(1,1).getValue() : '';
  const curCols = sh.getLastColumn();
  if(firstCell !== 'id'){
    sh.clear();
    sh.getRange(1,1,1,head.length).setValues([head]);
  } else if(curCols < head.length){
    // เพิ่ม column ที่ขาดอยู่ ถ้ามีการเพิ่ม field ใหม่ในอนาคต
    sh.getRange(1, curCols+1, 1, head.length - curCols).setValues([head.slice(curCols)]);
  }
  return sh;
}
function sheetShipping_(){
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_SHIPPING) || ss.insertSheet(SHEET_NAME_SHIPPING);
  const head = ['id','name','active','methods_json','carrier_id','tracking_url_template','tracking_provider'];
  const firstCell = sh.getLastColumn() > 0 ? sh.getRange(1,1).getValue() : '';
  const curCols = sh.getLastColumn();
  if(firstCell !== 'id'){
    sh.clear();
    sh.getRange(1,1,1,head.length).setValues([head]);
  } else if(curCols < head.length){
    sh.getRange(1, curCols+1, 1, head.length - curCols).setValues([head.slice(curCols)]);
  }
  return sh;
}
function sheetPromotions_(){
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_PROMOTIONS) || ss.insertSheet(SHEET_NAME_PROMOTIONS);
  const head = ['promotion_id','name','description','discount_type','discount_value',
                'target_type','target_json','starts_at','ends_at','enabled',
                'created_at','updated_at','created_by','updated_by','deleted_at','no_end_date',
                'application_mode','condition_type','condition_json','discount_scope'];
  const firstCell = sh.getLastColumn() > 0 ? sh.getRange(1,1).getValue() : '';
  const curCols = sh.getLastColumn();
  if (firstCell !== 'promotion_id') {
    sh.clear();
    sh.getRange(1,1,1,head.length).setValues([head]);
  } else if (curCols < head.length) {
    sh.getRange(1, curCols+1, 1, head.length - curCols).setValues([head.slice(curCols)]);
  }
  return sh;
}
function sheetRowOfId_(id){
  const sh=sheetProd_(); const n=sh.getLastRow(); if(n<2) return -1;
  const ids=sh.getRange(2,1,n-1,1).getValues().map(r=>String(r[0]));
  const i=ids.indexOf(String(id)); return (i<0)? -1 : (2+i);
}

/* ---------- snapshot (product) ---------- */
// Chunked snapshot stores each rebuild under a fresh version tag so readers
// can never assemble a mix of old+new chunks during a concurrent rebuild.
// META is written LAST and points to one consistent keyset; old chunks are
// cleaned up only after the META switch, so an in-flight reader on the prior
// META either completes its read or falls through to rebuildSnap_.
// Read the product snapshot straight from CacheService without ever rebuilding.
// Returns the array on a cache hit, or null on miss/corruption.
function readSnapCache_() {
  const cache = CacheService.getScriptCache();
  // Snapshots created before schedule-aware caching have no marker. Rebuild
  // them once instead of trusting a price that may have crossed a boundary.
  const validUntil = Number(cache.get(CACHE_PROD_SNAP_VALID_UNTIL) || 0);
  if (!validUntil || Date.now() >= validUntil) return null;
  // Try chunked storage first.
  const metaRaw = cache.get(CACHE_PROD_SNAP_META);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      if (meta && meta.chunked && meta.count > 0) {
        // Versioned scheme (current): keys are PROD_SNAP_PART_<version>_<i>.
        // Legacy scheme (no version): keys are PROD_SNAP_PART_<i>.
        const prefix = CACHE_PROD_SNAP_PART + (meta.version ? meta.version + '_' : '');
        const keys = [];
        for (let i = 0; i < meta.count; i++) keys.push(prefix + i);
        const got = cache.getAll(keys) || {};
        let json = '';
        let complete = true;
        for (let i = 0; i < meta.count; i++) {
          const v = got[prefix + i];
          if (v === undefined) { complete = false; break; }
          json += v;
        }
        if (complete) { try { return JSON.parse(json); } catch(_) {} }
      }
    } catch(_) {}
  }
  // Fall back to single-key format.
  const raw = cache.get(CACHE_PROD_SNAP);
  if (raw) { try { return JSON.parse(raw); } catch(_) { /* corrupt */ } }
  return null;
}

function getSnap_() {
  const cached = readSnapCache_();
  if (cached) return cached;
  // Cache miss or corruption: rebuild and return fresh data.
  return rebuildSnap_();
}

// Direct promotions are baked into the product snapshot, so that snapshot must
// become unreadable when the next direct promotion starts or ends.
function _nextDirectPromotionBoundaryMs_(now, promotions) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now || Date.now());
  const promos = Array.isArray(promotions) ? promotions : listPromotionsFromSheet_(false);
  let next = Infinity;
  for (let i = 0; i < promos.length; i++) {
    const promo = promos[i];
    if (!promo || promo.deleted_at || !promo.enabled || !_promoIsDirect_(promo)) continue;
    const startsMs = Date.parse(String(promo.starts_at || ''));
    if (!isNaN(startsMs) && startsMs > nowMs && startsMs < next) next = startsMs;
    if (!promo.no_end_date) {
      const endsMs = Date.parse(String(promo.ends_at || ''));
      // Schedule status remains active at ends_at and becomes ended just after it.
      const endedBoundary = isNaN(endsMs) ? NaN : endsMs + 1;
      if (!isNaN(endedBoundary) && endedBoundary > nowMs && endedBoundary < next) next = endedBoundary;
    }
  }
  return isFinite(next) ? next : null;
}

function _productSnapshotCachePolicy_(now) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now || Date.now());
  const maxValidUntil = nowMs + PROD_SNAP_MAX_TTL * 1000;
  const nextBoundary = _nextDirectPromotionBoundaryMs_(nowMs);
  const validUntil = nextBoundary == null ? maxValidUntil : Math.min(maxValidUntil, nextBoundary);
  // CacheService uses whole seconds. The timestamp marker still enforces the
  // exact millisecond boundary if the physical entry survives slightly longer.
  const ttlSeconds = Math.max(1, Math.min(PROD_SNAP_MAX_TTL, Math.ceil((validUntil - nowMs) / 1000)));
  return { validUntil: validUntil, ttlSeconds: ttlSeconds };
}

function setSnap_(arr) {
  const cache = CacheService.getScriptCache();
  const json  = JSON.stringify(arr);
  const policy = _productSnapshotCachePolicy_(new Date());
  // Publish this marker last so a partially-written snapshot is never accepted.
  try { cache.remove(CACHE_PROD_SNAP_VALID_UNTIL); } catch(_) {}
  if (json.length <= SNAP_CHUNK_SIZE) {
    try { cache.remove(CACHE_PROD_SNAP_META); } catch(_) {}  // clear stale meta if switching back
    try { cache.put(CACHE_PROD_SNAP, json, policy.ttlSeconds); } catch(_) {}
    try { cache.put(CACHE_PROD_SNAP_VALID_UNTIL, String(policy.validUntil), policy.ttlSeconds); } catch(_) {}
    return;
  }
  // Chunked path: write under a fresh version, then atomically swap META, then
  // clean up the old version's chunks. Concurrent readers either see the old
  // META (and read old chunks) or the new META (and read new chunks) — never
  // a Frankenstein mix.
  const prevMetaRaw = cache.get(CACHE_PROD_SNAP_META);
  try { cache.remove(CACHE_PROD_SNAP); } catch(_) {}  // clear old single-key
  const n = Math.ceil(json.length / SNAP_CHUNK_SIZE);
  const version = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  for (let i = 0; i < n; i++) {
    try { cache.put(CACHE_PROD_SNAP_PART + version + '_' + i, json.slice(i * SNAP_CHUNK_SIZE, (i + 1) * SNAP_CHUNK_SIZE), policy.ttlSeconds); } catch(_) {}
  }
  try { cache.put(CACHE_PROD_SNAP_META, JSON.stringify({ chunked: true, count: n, version: version }), policy.ttlSeconds); } catch(_) {}
  try { cache.put(CACHE_PROD_SNAP_VALID_UNTIL, String(policy.validUntil), policy.ttlSeconds); } catch(_) {}
  // Reclaim the previous version's chunks. Safe to do only after META is in
  // place — readers that already loaded the old META still see their chunks
  // because we never overwrite a versioned key.
  if (prevMetaRaw) {
    try {
      const pm = JSON.parse(prevMetaRaw);
      if (pm && pm.chunked && pm.version && pm.version !== version) {
        const oldKeys = [];
        for (let oi = 0; oi < pm.count; oi++) oldKeys.push(CACHE_PROD_SNAP_PART + pm.version + '_' + oi);
        try { cache.removeAll(oldKeys); } catch(_) {}
      } else if (pm && pm.chunked && !pm.version) {
        // Legacy unversioned chunks left over from before this upgrade.
        const legacyKeys = [];
        for (let li = 0; li < pm.count; li++) legacyKeys.push(CACHE_PROD_SNAP_PART + li);
        try { cache.removeAll(legacyKeys); } catch(_) {}
      }
    } catch(_) {}
  }
}

function rebuildSnap_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    // Another process holds the lock and is already rebuilding. Reading the
    // sheet here without the lock risks a torn snapshot, so return whatever is
    // cached instead. If the cache is genuinely empty we fall through and
    // rebuild unlocked as a last resort (better stale-free data than none).
    const cached = readSnapCache_();
    if (cached) return cached;
  }
  try {
    const sh = sheetProd_();
    const n = sh.getLastRow();
    const rows = (n<2)? [] : sh.getRange(2,1,n-1,20).getValues().map(r=>{
      var saleMode = String(r[19]||'').trim().toLowerCase();
      if (saleMode !== 'disabled' && saleMode !== 'always' && saleMode !== 'scheduled') {
        // Defensive fallback if backfill hasn't run on this row yet.
        saleMode = _computeSaleModeFromLegacy_(r[9], r[15], r[16], r[17]);
      }
      return {
        id:String(r[0]||''), title:String(r[1]||''), desc:String(r[2]||''),
        price:Number(r[3]||0),
        badge:String(r[4]||''), image_drive_file_id:String(r[5]||''), image_url:String(r[6]||''),
        created_at:String(r[7]||''), updated_at:String(r[8]||''),
        variants:(()=>{
          try {
            const base = Number(r[3]||0);
            return JSON.parse(String(r[10]||'[]')).map(g => ({
              ...g,
              options: (g.options||[]).map(o => ({
                ...o,
                price: o.price !== undefined ? Number(o.price)
                     : (o.delta !== undefined ? base + Number(o.delta||0) : base),
                weight_grams: Number(o.weight_grams || 0),
                stock: o.stock !== undefined ? Number(o.stock) : undefined
              }))
            }));
          } catch(_){ return []; }
        })(),
        extra_images:(()=>{ try{ return JSON.parse(String(r[11]||'[]')); }catch(_){ return []; } })(),
        weight_grams:Number(r[12]||0),
        allowed_shipping_ids:(()=>{ try{ return JSON.parse(String(r[13]||'[]')); }catch(_){ return []; } })(),
        stock:(function(){ var v=Number(r[14]); return isNaN(v) ? -1 : v; })(),
        sale_starts_at: String(r[16]||''),
        sale_ends_at: String(r[17]||''),
        sale_mode: saleMode
      };
    });
    applyPromotionsToProducts_(rows, new Date());
    applySaleStatusToProducts_(rows, new Date());
    setSnap_(rows);
    const sheetTs = fileTs_(SP.getProperty('SHEET_ID'));
    try { CacheService.getScriptCache().put(CACHE_PROD_TS, String(sheetTs), 600); } catch(_) {}
    try { CacheService.getScriptCache().put(CACHE_DRIVE_TS_CHECK, '1', DRIVE_TS_CHECK_TTL); } catch(_) {}
    return rows;
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// Patch product/variant stock in the cached snapshot in-place without re-reading
// the sheet. updates: [{ product_id, prodStock, variants }]  where variants is the
// raw variants array (with updated `stock` values). Falls back to cache invalidation
// if anything goes wrong — `syncSnapIfStale_` will rebuild on the next read.
function _patchSnapshotStock_(updates) {
  if (!Array.isArray(updates) || !updates.length) return;
  try {
    var snap = getSnap_();
    if (!Array.isArray(snap) || !snap.length) return;
    var byId = {};
    for (var i = 0; i < snap.length; i++) byId[String(snap[i].id)] = snap[i];
    var patched = false;
    for (var u = 0; u < updates.length; u++) {
      var upd = updates[u];
      var prod = byId[String(upd.product_id)];
      if (!prod) continue;
      if (typeof upd.prodStock === 'number') { prod.stock = upd.prodStock; patched = true; }
      if (Array.isArray(upd.variants) && Array.isArray(prod.variants)) {
        // Pre-index destination groups by name, and each group's options by label,
        // for O(1) lookups instead of O(n) .filter() chains. Index is per-product,
        // built only when an update touches variants.
        var destGroupByName = {};
        for (var gi = 0; gi < prod.variants.length; gi++) {
          var dg = prod.variants[gi];
          if (!dg || !dg.name) continue;
          var optByLabel = {};
          var dgOpts = dg.options || [];
          for (var oi = 0; oi < dgOpts.length; oi++) {
            var o = dgOpts[oi];
            if (o && o.label !== undefined) optByLabel[o.label] = o;
          }
          destGroupByName[dg.name] = optByLabel;
        }
        for (var sgi = 0; sgi < upd.variants.length; sgi++) {
          var srcGroup = upd.variants[sgi];
          if (!srcGroup) continue;
          var destOpts = destGroupByName[srcGroup.name];
          if (!destOpts) continue;
          var srcOpts = srcGroup.options || [];
          for (var soi = 0; soi < srcOpts.length; soi++) {
            var srcOpt = srcOpts[soi];
            if (!srcOpt) continue;
            var destOpt = destOpts[srcOpt.label];
            if (destOpt && srcOpt.stock !== undefined) {
              destOpt.stock = Number(srcOpt.stock);
              patched = true;
            }
          }
        }
      }
    }
    if (patched) setSnap_(snap);
  } catch (err) {
    // Fallback: drop the cache so next reader rebuilds from the sheet.
    try {
      var cache = CacheService.getScriptCache();
      cache.remove(CACHE_PROD_SNAP);
      cache.remove(CACHE_PROD_SNAP_META);
      cache.remove(CACHE_PROD_SNAP_VALID_UNTIL);
      for (var ci = 0; ci < 32; ci++) cache.remove(CACHE_PROD_SNAP_PART + ci);
    } catch(_) {}
    Logger.log('_patchSnapshotStock_ fallback to invalidate: ' + err);
  }
}

function syncSnapIfStale_() {
  const cache = CacheService.getScriptCache();
  // Batch the cache reads into one round-trip (was up to 4 sequential .get()
  // calls per storefront doGet on the slow path). getAll omits missing keys, so
  // `=== undefined` distinguishes absence from a stored empty-string value.
  const got = cache.getAll([CACHE_PROD_SNAP_META, CACHE_PROD_SNAP, CACHE_PROD_SNAP_VALID_UNTIL, CACHE_DRIVE_TS_CHECK, CACHE_PROD_TS]) || {};
  const validUntil = Number(got[CACHE_PROD_SNAP_VALID_UNTIL] || 0);
  const snapExists = validUntil > Date.now()
    && (got[CACHE_PROD_SNAP_META] !== undefined || got[CACHE_PROD_SNAP] !== undefined);
  // Fast path: snap present AND recent Drive-check sentinel valid -> skip DriveApp call.
  // Sentinel TTL = 30 s; staleness window applies only to direct Sheet edits — app-mediated
  // writes call rebuildSnap_() directly and invalidate this sentinel.
  if (snapExists && got[CACHE_DRIVE_TS_CHECK] !== undefined) return;
  // Slow path: check Drive timestamp.
  const driveTs  = fileTs_(SP.getProperty('SHEET_ID'));
  const cachedTs = Number(got[CACHE_PROD_TS] || 0);
  if (!snapExists || driveTs > cachedTs) {
    rebuildSnap_();  // rebuildSnap_ sets CACHE_DRIVE_TS_CHECK after writing the snap
  } else {
    try { cache.put(CACHE_DRIVE_TS_CHECK, '1', DRIVE_TS_CHECK_TTL); } catch(_) {}
  }
}

/* ---------- web app ---------- */
/** GAS template include helper — used by admin HTML files via <?!= include('admin-shared') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doGet(e) {
  // ---- routing สั้น ๆ ----
  const pathInfo = (e && e.pathInfo) ? String(e.pathInfo) : '';
  const qPage    = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : '';
  const seg = (pathInfo || qPage || '').replace(/^\/+|\/+$/g, '').toLowerCase();

  let view = 'index';
  if (seg === 'product' || seg === 'products') view = 'product';
  else if (seg === 'order'    || seg === 'orders')   view = 'order';
  else if (seg === 'order-view') view = 'order-view';
  else if (seg === 'payment') view = 'payment';
  else if (seg === 'shipping' || seg === 'shippings') view = 'shipping-page';
  else if (seg === 'editstore' || seg === 'edit-store') view = 'edit-store';
  else if (seg === 'login')                            view = 'login';
  else if (seg === 'user' || seg === 'users')          view = 'user';
  else if (seg === 'system')                           view = 'system';
  else if (seg === 'privacy-policy' || seg === 'privacy_policy') view = 'privacy-policy';
  else if (seg === 'term-and-service' || seg === 'term_and_service') view = 'term_and_service';
  else if (seg === 'legal')                            view = 'legal';
  else if (seg === 'promotion' || seg === 'promotions') view = 'promotion';
  else if (seg === 'gift' || seg === 'gifts') view = 'gift';
  else if (seg === 'qa-integration' || seg === 'integration-dashboard') view = 'integration-dashboard';
  else if (seg === 'print-order' || seg === 'print_order') view = 'print-order';
  else if (!seg || seg === 'index') view = 'index';
  else {
    enqueueLog_('web.404', { category:['web'], type:['error'], outcome:'failure',
      route: seg, method:'GET' }, null);
    return ContentService.createTextOutput('404 Not Found: ' + seg)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  try {
    const t = HtmlService.createTemplateFromFile(view);
    const bundle = buildConfigWithProducts_();

    t.siteCfgJs    = JSON.stringify(bundle.config);
    t.siteCfgMeta  = JSON.stringify({ cfgTs: bundle.cfgTs, prodTs: bundle.prodTs });
    try { t.execUrl = ScriptApp.getService().getUrl(); } catch(_) { t.execUrl = ''; }
    t.orderToken   = (e && e.parameter && e.parameter.token) ? String(e.parameter.token) : '';

    // Public views can be embedded; admin/login pages use DEFAULT (blocks external iframes)
    var publicViews = ['index', 'order-view', 'privacy-policy', 'term_and_service'];
    var frameMode = publicViews.indexOf(view) >= 0
      ? HtmlService.XFrameOptionsMode.ALLOWALL
      : HtmlService.XFrameOptionsMode.DEFAULT;
    // Page-view logging is NOT done here — it would add latency to every page
    // serve. The client fires logPageViewRpc asynchronously after render.
    return t.evaluate()
      .setTitle('Open Storefront')
      .setXFrameOptionsMode(frameMode);
  } catch (err) {
    enqueueLog_('web.render_error', { category:['web'], type:['error'], outcome:'failure',
      level:'error', route: seg, urlPath: view, method:'GET' }, null);
    return ContentService.createTextOutput('404 Not Found: missing ' + view + '.html')
      .setMimeType(ContentService.MimeType.TEXT);
  }
}


function ping(){ DriveApp.getRootFolder(); return {ok:true}; } // auth warm-up

/* ---------- Drive helpers ---------- */
function uploadImageFromBase64_(base64, filename, contentType, folderId, makePublic){
  if (!folderId) throw new Error('folderId required — upload refused to prevent root Drive fallback');
  const bytes = Utilities.base64Decode(base64.split(',').pop());
  const blob  = Utilities.newBlob(bytes, contentType||'image/jpeg', filename||('product-'+Date.now()+'.jpg'));
  const file  = DriveApp.getFolderById(folderId).createFile(blob);
  if (makePublic !== false) {
    try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(_){}
  }
  return file.getId();
}
function deleteDriveFileSafe_(fileId){
  if(!fileId) return;
  try{ DriveApp.getFileById(fileId).setTrashed(true); }catch(_){}
}

// Resolve the per-store subfolder id for `name`, creating it once if missing.
// Hardened against the duplicate-folder bug:
//   1. the resolved id is persisted in Script Properties (FOLDER_ID_<name>) so
//      later executions skip the name search and never create a second folder;
//   2. the resolve/create path is serialized with a script lock so two
//      concurrent uploads can't both find "none" and both create;
//   3. when duplicates already exist the OLDEST is chosen deterministically and
//      pinned — so the set stops drifting.
// NOTE: this only stops NEW duplicates. Files already scattered across existing
// duplicate folders keep serving because the parent-folder checks accept any
// folder matching the name (see _allFolderIdsByName_).
function getOrCreateFolder_(name) {
  const mainId = SP.getProperty('DRIVE_FOLDER_ID');
  if (!mainId) throw new Error('DRIVE_FOLDER_ID not configured');

  var propKey = 'FOLDER_ID_' + name;
  var savedId = SP.getProperty(propKey);
  if (savedId && _folderUsable_(savedId)) return savedId;

  const mainFolder = DriveApp.getFolderById(mainId);
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(10000); } catch (_) {}
  try {
    // Re-check inside the lock — another execution may have just resolved it.
    savedId = SP.getProperty(propKey);
    if (savedId && _folderUsable_(savedId)) return savedId;
    var id = _oldestFolderByName_(mainFolder, name) || mainFolder.createFolder(name).getId();
    SP.setProperty(propKey, id);
    return id;
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (_) {} }
  }
}

// True if folderId points to a live (non-trashed) folder.
function _folderUsable_(folderId) {
  try { return !DriveApp.getFolderById(folderId).isTrashed(); }
  catch (_) { return false; }
}

// Oldest (earliest-created) child folder matching `name`, or '' if none.
// Deterministic tiebreak so duplicates resolve to one canonical id.
function _oldestFolderByName_(parentFolder, name) {
  var it = parentFolder.getFoldersByName(name);
  var best = null, bestT = Infinity;
  while (it.hasNext()) {
    var f = it.next();
    var t = f.getDateCreated().getTime();
    if (t < bestT) { bestT = t; best = f; }
  }
  return best ? best.getId() : '';
}

// ALL (non-trashed) child folder ids matching `name` under DRIVE_FOLDER_ID.
// Used by parent-folder allowlists so files in pre-existing duplicate folders
// still serve even though new uploads go to the single pinned folder.
function _allFolderIdsByName_(name) {
  var ids = [];
  try {
    var mainId = SP.getProperty('DRIVE_FOLDER_ID');
    if (!mainId) return ids;
    var it = DriveApp.getFolderById(mainId).getFoldersByName(name);
    while (it.hasNext()) ids.push(it.next().getId());
  } catch (_) {}
  return ids;
}
var _folderIdCache_ = {};
function getFolderIdCached_(name) {
  if (_folderIdCache_[name]) return _folderIdCache_[name];
  var id = getOrCreateFolder_(name);
  _folderIdCache_[name] = id;
  return id;
}

/* ---------- row helpers ---------- */
// Normalize a sale_mode value coming from client/payload. Unknown → 'always'.
function _normalizeSaleMode_(v) {
  var s = String(v||'').trim().toLowerCase();
  if (s === 'disabled' || s === 'always' || s === 'scheduled') return s;
  return 'always';
}

function appendProd_(obj){
  const sh=sheetProd_(); const id=uuid_(); const now=nowISO_();
  var saleMode = _normalizeSaleMode_(obj.sale_mode);
  var sw = (saleMode === 'scheduled')
    ? _normalizeSchedule_({ starts_at: obj.sale_starts_at, ends_at: obj.sale_ends_at, no_end_date: !obj.sale_ends_at })
    : { starts_at: '', ends_at: '', no_end_date: true };
  // Legacy cols are kept in lockstep with sale_mode purely so old reports
  // (or external sheet viewers) see consistent values. They are NOT read by code.
  var legacyActive       = saleMode !== 'disabled';
  var legacySaleEnabled  = saleMode !== 'disabled' ? 'TRUE' : 'FALSE';
  var legacyNoEndDate    = sw.no_end_date ? 'TRUE' : 'FALSE';
  sh.appendRow([id,
    sanitizeSheetCell_(obj.title||''),
    sanitizeSheetCell_(obj.desc||''),
    Number(obj.price||0),
    sanitizeSheetCell_(obj.badge||''),
    obj.image_drive_file_id||'',
    sanitizeSheetCell_(obj.image_url||''),
    now, now, legacyActive,
    JSON.stringify(obj.variants||[]),
    JSON.stringify(obj.extra_images||[]),
    Number(obj.weight_grams||0),
    JSON.stringify(obj.allowed_shipping_ids||[]),
    (obj.stock !== undefined ? Number(obj.stock) : -1),
    legacySaleEnabled,
    sw.starts_at || '',
    sw.ends_at || '',
    legacyNoEndDate,
    saleMode]);
  rebuildSnap_(); return id;
}

/** ---------- Site Config storage helpers ---------- */

// Read site config row from store sheet. Returns { json, ts } or null.
function getSiteConfigFromSheet_() {
  const sh = sheetStore_();
  const n = sh.getLastRow();
  if (n < 2) return null;
  const rows = sh.getRange(2, 1, n - 1, 4).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === STORE_KEY_SITE_CFG) {
      const json = String(rows[i][2] || '');   // stored in 'url' column
      const ts   = rows[i][3] ? new Date(rows[i][3]).getTime() : 0;
      return { json: json, ts: ts };
    }
  }
  return null;
}

// Write site config JSON to store sheet. Returns timestamp (ms).
function saveSiteConfigToSheet_(json) {
  const sh = sheetStore_();
  const n = sh.getLastRow();
  let rowNo = -1;
  if (n >= 2) {
    const keys = sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0]));
    const i = keys.indexOf(STORE_KEY_SITE_CFG);
    if (i >= 0) rowNo = 2 + i;
  }
  const now = nowISO_();
  if (rowNo >= 2) {
    sh.getRange(rowNo, 1, 1, 4).setValues([[STORE_KEY_SITE_CFG, '', json, now]]);
  } else {
    sh.appendRow([STORE_KEY_SITE_CFG, '', json, now]);
  }
  return new Date(now).getTime();
}

// Populate CacheService with site config object + timestamp.
function setCachedSiteConfig_(cfg, ts) {
  const cache = CacheService.getScriptCache();
  try {
    cache.put(CACHE_SITE_CFG, JSON.stringify(cfg), 600);
    cache.put(CACHE_SITE_CFG_TS, String(ts || Date.now()), 600);
  } catch(_) {}
}

// Read site config: cache → sheet → legacy Script Properties migration → {}.
function readSiteConfig_() {
  // 1. Try CacheService
  const cache = CacheService.getScriptCache();
  const raw = cache.get(CACHE_SITE_CFG);
  if (raw) {
    try { return JSON.parse(raw); } catch(_) { /* corrupt, fall through */ }
  }
  // 2. Try store sheet
  const fromSheet = getSiteConfigFromSheet_();
  if (fromSheet && fromSheet.json) {
    try {
      const cfg = JSON.parse(fromSheet.json);
      setCachedSiteConfig_(cfg, fromSheet.ts);
      return cfg;
    } catch(_) {}
  }
  // 3. Nothing found
  return {};
}

// Write site config JSON to sheet + refresh cache atomically.
function writeSiteConfig_(json) {
  if (typeof json !== 'string') json = JSON.stringify(json || {});
  const lock = LockService.getScriptLock();
  lock.tryLock(5000);
  try {
    const ts = saveSiteConfigToSheet_(json);
    let cfg; try { cfg = JSON.parse(json); } catch(_) { cfg = {}; }
    setCachedSiteConfig_(cfg, ts);
    return { ok: true, ts: ts, bytes: json.length };
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// Returns site config timestamp (ms) from cache or sheet.
function getSiteConfigTs_() {
  const cached = CacheService.getScriptCache().get(CACHE_SITE_CFG_TS);
  if (cached) return Number(cached);
  const fromSheet = getSiteConfigFromSheet_();
  return fromSheet ? fromSheet.ts : 0;
}

// Owner-only escape hatch for debug/recovery — writes raw site config JSON with
// NO schema validation. The `payment` key is stripped before writing because
// payment data lives in its own sheet and must only be mutated via
// savePaymentConfigRpc (which is OTP-gated). Not called by any UI page; intended
// for manual use from the Apps Script editor. Every call is logged for audit.
function setSiteConfigJsonForce(token, json) {
  var sess = requireOwner_(token);
  if (!sess) return { ok: false, error: 'เฉพาะเจ้าของระบบเท่านั้น' };
  var sanitized = json;
  try {
    var parsed = JSON.parse(String(json || '{}'));
    if (parsed && typeof parsed === 'object') {
      delete parsed.payment;
      sanitized = JSON.stringify(parsed);
    }
  } catch(_) {
    return { ok:false, error:'INVALID_JSON' };
  }
  Logger.log('[AUDIT] setSiteConfigJsonForce by ' + ((sess && sess.email) || 'owner')
    + ' at ' + nowISO_() + ' (' + sanitized.length + ' bytes)');
  return writeSiteConfig_(sanitized);
}

// Canonical default site config — seeded into the `store` sheet on first-time setup
// (see setupAll_) and used as the base config so the storefront/editor always start from a
// complete config. Branding/theme only: products, payment, and shipping_companies are
// managed in their own sheets and injected by buildConfigWithProducts_ at serve time, so
// they are intentionally omitted here. The frontend DEFAULT_CONFIG fallbacks in index.html
// and edit-store.html mirror this object (minus their preview-only `products` arrays).
function getDefaultSiteConfig_() {
  return {
    siteTitle: "Qliphoth-12 Laboratory",
    siteDescription: "รวมสินค้าอนิเมะน่ารัก พร้อมส่ง",
    headerContactUrl: "mailto:hello@example.com",
    promptpay_number: "",
    promptpay_account_name: "",
    order_token_expires_days: 120,
    mascotSize: 300,
    mascotDisplayMode: "fullwidth",
    contact_platforms: ["facebook", "line", "twitter"],
    logoImage: "https://i.ibb.co/1fbYS2kV/616831250-122101507461223868-6906263587877060857-n.jpg",
    logoImageDriveFileId: "",
    bannerImage: "https://pbs.twimg.com/media/GxK2IrHbwAAdz3p?format=jpg&name=4096x4096",
    bannerImageDriveFileId: "",
    bannerTitle: "Qliphoth-12 Laboratory Shop Template",
    bannerSubtitle: "ร้านค้าของ Qliphoth-12 Laboratory",
    productsTitle: "รายการสินค้า",
    bannerParallax: { enabled: true, strength: 0.46, scale: 1.08, start: "bottom" },
    theme: {
      bg: "#ffffff",
      bgImage: "https://pbs.twimg.com/media/GgbB2mfa8AMKPgh?format=jpg&name=4096x4096", bgImageDriveFileId: "", bgSize: "cover", bgRepeat: "no-repeat", bgPosition: "center", bgAttachment: "fixed",
      brand: { logoSize: 48, gap: 5, nudgeY: -4 },
      text: "#ffffff",
      headerText: "#eedec8",
      headerLinkHover: "#ffffff",
      headerUnderline: "#ffffff",
      headerUnderlineH: 1,
      bannerTitle: "#ffffff",
      bannerSub: "#b5b5b5",
      productsTitle: "#faf7eb",
      cardTitle: "#f7e8cf",
      cardDesc: "#e8e8e8",
      price: "#fff8c7",
      oldPrice: "#c7c7c7",
      navBtnBg: "#f2e5cf",
      navBtnText: "#fff0d1",
      navBtnBorder: "#fff2d6",
      navBtnOpacity: 0,
      navBtnBorderW: 1,
      navBtnHoverBg: "#ffffff",
      navBtnHoverText: "#363636",
      navBtnHoverBorder: "#ffffff",
      navBtnHoverOpacity: 0.95,
      navBtnHoverBorderW: 1,
      sidebarBg: "#0c0c0d",
      sidebarOpacity: 0.95,
      sidebarBlur: 4,
      sidebarNameColor: "#ffffff",
      sidebarDescColor: "#a0aec0",
      sidebarHoverColor: "#f5f5f5",
      sidebarDividerColor: "#374151",
      sidebarPillColor: "#e5e7eb",
      sidebarPillOpacity: 0.85,
      sidebarPillBg: "#1f2937",
      sidebarPillBorderColor: "#374151",
      sidebarPillBorderWidth: 0,
      sidebarPillHoverText: "#000000",
      sidebarPillHoverBorder: "#ffffff",
      sidebarPillHoverBorderW: 0,
      sidebarPillHoverOpacity: 1,
      headerBg: "linear-gradient(to bottom,   rgba(0,0,0,.65) 0%,   rgba(0,0,0,.45) 40%,   rgba(0,0,0,.15) 75%,   rgba(0,0,0,0) 100%)",
      bannerMask: "linear-gradient(to right, rgba(15, 23, 42, 0.75) 0%, rgba(15, 23, 42, 0.55) 40%, rgba(15, 23, 42, 0.15) 75%, rgba(15, 23, 42, 0) 100%)",
      bannerParallax: { enabled: false, strength: 0.35, scale: 1.08, start: "bottom" },
      cardBg: "#414348",
      cardBorder: "#b8b8b8",
      cardOpacity: 0.3,
      cardBorderW: 1,
      cardHoverBg: "#000000",
      cardHoverOpacity: 0.3,
      cardHoverBorder: "#e5e7eb",
      cardHoverBorderW: 1,
      accent: "#ffffff",
      ctaBg: "#111827",
      ctaText: "#fbeac6",
      ctaBorder: "#fde5c4",
      ctaOpacity: 0,
      ctaBorderW: 1,
      ctaHoverBg: "#191a1a",
      ctaHoverText: "#ffffff",
      ctaHoverBorder: "#ffffff",
      ctaHoverOpacity: 0.95,
      ctaHoverBorderW: 1,
      addBg: "#19191a",
      addText: "#ffffff",
      addBorder: "#2f3032",
      addOpacity: 0.95,
      addBorderW: 1,
      addHoverBg: "#000000",
      addHoverText: "#fff0d6",
      addHoverBorder: "#ffecd1",
      addHoverOpacity: 0,
      addHoverBorderW: 1,
      detail: {
        bg: "#ffffff", bgOpacity: 0.95,
        border: "#e5e7eb", borderW: 1,
        radius: 18, shadow: "0 20px 60px rgba(0,0,0,.20)",
        text: "#000000",
        close: { bg: "#111827", bgOpacity: 1, opacity: 1, color: "#ffffff", hoverBg: "#111827", hoverBgOpacity: 0.1, hoverOpacity: 1, filter: "none" },
        variant: {
          bg: "#111827", bgOpacity: 0.05, text: "#111827", border: "#d1d5db", borderW: 1, opacity: 1,
          hoverBg: "#111827", hoverBgOpacity: 0.05, hoverText: "#111827", hoverBorder: "#9ca3af", hoverBorderW: 1, hoverOpacity: 1,
          selectedBg: "#111827", selectedBgOpacity: 1, selectedText: "#ffffff", selectedBorder: "#111827", selectedBorderW: 1, selectedOpacity: 1
        },
        qty: {
          bg: "#1c1e21", bgOpacity: 0.2, text: "#0b0e14", numText: "#111827", border: "#cbd5e1", borderW: 1, opacity: 1,
          hoverBg: "#111827", hoverBgOpacity: 0.1, hoverText: "#111827", hoverBorder: "#94a3b8", hoverBorderW: 1, hoverOpacity: 1
        },
        add: {
          bg: "#374151", bgOpacity: 1, text: "#ffffff", border: "#374151", borderW: 1, opacity: 1,
          hoverBg: "#000000", hoverBgOpacity: 0, hoverText: "#111827", hoverBorder: "#111827", hoverBorderW: 1, hoverOpacity: 1,
          height: 40, radius: 12
        },
        groupBox: { bg: "#ffffff", bgOpacity: 1, border: "#dedede", label: "#111827" },
        price: { color: "#ef4444" },
        badge: { bg: "#374151", text: "#ffffff" },
        stock: { text: "#6b7280", dot: "#9ca3af", lowText: "#c2410c", lowDot: "#f97316" }
      },
      sortBg: "#2b2b2b",
      sortOpacity: 0.25,
      sortText: "#ffffff",
      sortHoverText: "#ffd780",
      sortHoverBg: "rgba(0, 0, 0, 0.06)",
      sortActiveBg: "#111827",
      sortActiveText: "#ffffff",
      sortPressedBg: "#0f172a",
      sortPressedText: "#ffffff",
      sortFocusRing: "rgba(17, 24, 39, 0.25)",
      footerBg: "#000000",
      footerText: "#9aa1ad",
      footerLink: "#e5e7eb",
      footerBorder: "#000000",
      promoCard: {
        badgeBg: "#ffffff",
        badgeText: "#000000",
        badgeBorderRadius: "999px",
        containerBg: "#ffffff",
        containerBorder: "#575757",
        containerBorderRadius: "12px",
        containerText: "#566c8f",
        containerMutedText: "#94a3b8",
        saleColor: "#5b83ae",
        saveColor: "#16a34a",
        cardCdText: "#ffffff",
        cardCdBg: "transparent",
        cardCdIcon: "#ffffff",
        boxCdText: "#7a7a7a",
        boxCdBg: "transparent",
        boxCdIcon: "#545454",
        countdownText: "#ffffff",
        countdownBg: "transparent"
      }
    },
    footer: {
      showYear: true,
      showBrand: true,
      note: "All rights reserved.",
      socials: [
        { label: "Instagram", href: "https://www.instagram.com/", icon: "bi-instagram" },
        { label: "Twitter/X", href: "https://x.com/", icon: "bi-twitter-x" }
      ]
    },
    ctaButtons: [
      { label: "ดูสินค้า", href: "#shop", icon: "bi-bag" },
      { label: "เพจของเรา", href: "https://www.facebook.com/qliphoth12lab", icon: "bi-facebook" },
      { label: "ติดต่อร้าน", href: "https://www.facebook.com/qliphoth12lab", icon: "bi-envelope" }
    ],
    productTags: [
      { id: 'new',      label: 'ใหม่',       bg: 'rgba(22,163,74,.85)',  text: '#ffffff' },
      { id: 'hot',      label: 'ฮอต',        bg: 'rgba(225,29,72,.85)',  text: '#ffffff' },
      { id: 'sale',     label: 'ลดราคา',     bg: 'rgba(234,88,12,.85)',  text: '#ffffff' },
      { id: 'promo',    label: 'โปร',        bg: 'rgba(147,51,234,.85)', text: '#ffffff' },
      { id: 'lim',      label: 'จำกัด',      bg: 'rgba(37,99,235,.85)',  text: '#ffffff' },
      { id: 'preorder', label: 'พรีออเดอร์', bg: 'rgba(17,24,39,.82)',   text: '#ffffff' },
      { id: 'lowstock', label: 'ใกล้หมด',    bg: 'rgba(194,65,12,.80)',  text: '#ffffff' }
    ],
    floatingOverlays: [
      { src: "https://i.ibb.co/67q7bpVC/Illustration20-1.png", top: 20, left: 90, width: 130, scope: "page-positioned", driveFileId: "", anim: { type: "sway", deg: 5, duration: 6500 } },
      { src: "https://i.ibb.co/TxYQWHcT/Sending.gif", top: 75, left: 10, width: 300, scope: "page-fixed", driveFileId: "", anim: { type: "wave", amp: 150, duration: 6500, delay: 50 } }
    ],
    legal: {
      controllerName: "",
      legalEntityName: "",
      contactEmail: "",
      contactPhone: "",
      primaryContactUrl: "",
      businessAddress: "",
      privacy: { version: "1.0", effectiveDate: "", lastUpdated: "" },
      terms: { effectiveDate: "" }
    }
  };
}

// Deep merge: values in `b` win over `a`; arrays are replaced wholesale.
// Mirrors mergeDeepPreferRight in index.html / edit-store.html.
function deepMergePreferRight_(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return b.slice();
  if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
    var out = {};
    for (var ka in a) if (Object.prototype.hasOwnProperty.call(a, ka)) out[ka] = a[ka];
    for (var kb in b) if (Object.prototype.hasOwnProperty.call(b, kb)) out[kb] = deepMergePreferRight_(a[kb], b[kb]);
    return out;
  }
  return (b === undefined) ? a : b;
}

function buildConfigWithProducts_() {
  // ให้ snapshot ทันสมัยก่อน
  syncSnapIfStale_();

  // 1) ดึง site config จาก sheet-backed cache แล้ว merge ทับ default ที่เป็น base
  //    (กันกรณี deployment เก่าที่ยังไม่ได้ seed — storefront/editor จะได้ค่า default ครบเสมอ)
  const stored = readSiteConfig_();
  const cfg = (stored && Object.keys(stored).length)
    ? deepMergePreferRight_(getDefaultSiteConfig_(), stored)
    : getDefaultSiteConfig_();

  // 2) ดึง products จาก CacheService snapshot (รวดเร็ว ไม่อ่านชีตตรง ๆ)
  const products = getSnap_();
  const prodTs   = Number(CacheService.getScriptCache().get(CACHE_PROD_TS) || 0);
  const cfgTs    = getSiteConfigTs_();

  // 3) ฝังลงใน cfg.products (ทับของเดิมถ้ามี). Storefront sees only sellable items.
  cfg.products = products.filter(function(p){
    return p.sale_status === 'active';
  });

  // 4) ฝัง shipping companies จาก sheet
  try { cfg.shipping_companies = getShippingCached_(); } catch(_) { cfg.shipping_companies = []; }

  // 5) ฝัง payment config จาก sheet `payment` (เดิมเก็บใน cfg.payment ของ site_config,
  //    ย้ายไป sheet แยกแล้ว — ฝังกลับลง cfg.payment เพื่อรักษา wire format เดิม
  //    ที่ order-view.html ใช้อ่าน)
  //    Whitelist เฉพาะ field ที่ client ใช้แสดง QR — ตัด id/updated_at/updated_by (อีเมล admin)
  //    ไม่ให้หลุดลง server-cfg ของทุกหน้า (รวม storefront สาธารณะ) และไฟล์ export ของ edit-store
  try {
    var _pp = readPaymentConfig_();
    cfg.payment = {
      promptpay_number: _pp.promptpay_number || '',
      promptpay_name:   _pp.promptpay_name   || '',
      bg_drive_id:      _pp.bg_drive_id      || '',
      bg_url:           _pp.bg_url           || '',
      qr_x:    _pp.qr_x    !== undefined ? _pp.qr_x    : 50,
      qr_y:    _pp.qr_y    !== undefined ? _pp.qr_y    : 50,
      qr_size: _pp.qr_size !== undefined ? _pp.qr_size : 25
    };
  } catch(_) { cfg.payment = {}; }

  // 6) flag for the client: whether to fetch a third-party IP observation (ipify).
  //    Mutates the in-memory copy only — not persisted back to the store sheet.
  try { cfg.logIpObservation = isIpObservationEnabled_(); } catch(_) { cfg.logIpObservation = false; }

  return {
    ok: true,
    config: cfg,          // object พร้อมใช้
    cfgTs,                // เวลาแก้ site config ล่าสุด
    prodTs,               // เวลา snapshot product ล่าสุด
    bytes: JSON.stringify(cfg).length
  };
}

/** RPC ให้ client เรียกเอา bundle ได้ทันที (ไม่ต้องประกอบซ้ำฝั่ง client) */
function getSiteConfigBundle() {
  return buildConfigWithProducts_();
}

/** Lightweight RPC — คืนเฉพาะ brand fields สำหรับ revalidation (อ่านจาก CacheService เท่านั้น) */
function getBrandInfoRpc() {
  try {
    var cfg = readSiteConfig_();
    return { ok: true, siteTitle: cfg.siteTitle || '', logoImage: cfg.logoImage || '', logoImageDriveFileId: cfg.logoImageDriveFileId || '' };
  } catch(err) { return { ok: false, error: String(err) }; }
}

/** ใช้ในปุ่ม Publish ฝั่ง client */
function publishSiteConfig(token, obj) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  // Merge into existing config instead of full overwrite — preserves subkeys
  // managed by dedicated RPCs (legal) that edit-store.html never touches.
  // Payment lives in its own sheet now and must not be reintroduced into site_config.
  var existing = readSiteConfig_();
  var merged = Object.assign({}, obj || {});
  if (existing.legal) merged.legal = existing.legal;
  delete merged.payment;
  return writeSiteConfig_(JSON.stringify(merged));
}

function savePaymentConfigRpc(token, payload) {
  // Owner-only: the OTP flow (verifyPaymentOtpAndSaveRpc) already passes the owner
  // token through; any direct caller must satisfy the same trust level. Non-owner
  // admins cannot redirect PromptPay payments by calling this RPC directly.
  const sess = requireOwner_(token);
  if (!sess) return { ok: false, error: 'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    const p = payload || {};
    // --- INPUT VALIDATION ---
    if (p.promptpay_number !== undefined && String(p.promptpay_number).trim() !== '') {
      var ppn = String(p.promptpay_number).trim().replace(/[^0-9]/g, '');
      if (!/^\d{10,15}$/.test(ppn)) return { ok:false, error:'หมายเลข PromptPay ต้องเป็นตัวเลข 10-15 หลัก' };
      p.promptpay_number = ppn;
    }
    if (p.promptpay_name) {
      var ppnR = normalizePlainText_(p.promptpay_name, { maxLen:VLEN.SHORT, fieldName:'ชื่อ PromptPay', allowEmpty:true });
      if (!ppnR.ok) return { ok:false, error:ppnR.error };
      p.promptpay_name = ppnR.value;
    }
    // --- END VALIDATION ---
    const cur = readPaymentConfig_();
    let bgDriveId = cur.bg_drive_id || '';
    let bgUrl     = cur.bg_url      || '';
    if (p.bg_image && p.bg_image.mode === 'file') {
      const newId = uploadValidatedImage_(p.bg_image.base64, p.bg_image.filename||'payment-bg.jpg', p.bg_image.contentType||'image/jpeg', getFolderIdCached_(FOLDER_STORE), true, { maxBytes:5*1024*1024, allowGif:false });
      if (bgDriveId && bgDriveId !== newId) deleteDriveFileSafe_(bgDriveId);
      bgDriveId = newId; bgUrl = publicUrl_(newId);
    } else if (p.bg_image && p.bg_image.mode === 'remove') {
      if (bgDriveId) deleteDriveFileSafe_(bgDriveId);
      bgDriveId = ''; bgUrl = '';
    }
    const merged = {
      promptpay_number: p.promptpay_number !== undefined ? String(p.promptpay_number||'') : (cur.promptpay_number||''),
      promptpay_name:   p.promptpay_name   !== undefined ? String(p.promptpay_name  ||'') : (cur.promptpay_name  ||''),
      bg_drive_id: bgDriveId, bg_url: bgUrl,
      qr_x:    p.qr_x    !== undefined ? Number(p.qr_x)    : (cur.qr_x    !== undefined ? cur.qr_x    : 50),
      qr_y:    p.qr_y    !== undefined ? Number(p.qr_y)    : (cur.qr_y    !== undefined ? cur.qr_y    : 50),
      qr_size: p.qr_size !== undefined ? Number(p.qr_size) : (cur.qr_size !== undefined ? cur.qr_size : 25)
    };
    var __pcResult = writePaymentConfig_(merged, sess.email || '');
    if (__pcResult && __pcResult.ok) {
      enqueueLog_('payment.config.update', { category:['configuration'], type:['change'],
        outcome:'success', route:'payment', rpc:'savePaymentConfigRpc',
        userId:sess.userId, sessionId:token,
        meta:{ has_promptpay: !!merged.promptpay_number } }, sess.logCtx);
    }
    return __pcResult;
  } catch(err) { return { ok:false, error:String(err) }; }
}

function getPaymentConfigRpc(token) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    return { ok:true, payment: readPaymentConfig_() };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- Legal Config (privacy policy + terms metadata) ---------- */
function getLegalConfigRpc(token) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    const cfg = readSiteConfig_();
    return { ok:true, legal: cfg.legal || {} };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function saveLegalConfigRpc(token, payload) {
  var sess = requireOwner_(token);
  if (!sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    const p = payload || {};
    function s(v, max) {
      return String(v == null ? '' : v).slice(0, max || 500).trim();
    }
    var primaryContactUrlRaw = s(p.primaryContactUrl, VLEN.URL);
    if (primaryContactUrlRaw) {
      var urlR = normalizeUrl_(primaryContactUrlRaw, { fieldName:'ช่องทางการติดต่อหลัก' });
      if (!urlR.ok) return { ok:false, error: urlR.error };
      primaryContactUrlRaw = urlR.value;
    }
    const legal = {
      controllerName:     s(p.controllerName,    200),
      legalEntityName:    s(p.legalEntityName,   200),
      contactEmail:       s(p.contactEmail,      200),
      contactPhone:       s(p.contactPhone,      50),
      primaryContactUrl:  primaryContactUrlRaw,
      businessAddress:    s(p.businessAddress,   500),
      privacy: {
        version:       s(p.privacy && p.privacy.version,       50),
        effectiveDate: s(p.privacy && p.privacy.effectiveDate, 50),
        lastUpdated:   s(p.privacy && p.privacy.lastUpdated,   50)
      },
      terms: {
        effectiveDate: s(p.terms && p.terms.effectiveDate, 50)
      }
    };
    let cfg = readSiteConfig_();
    cfg.legal = legal;
    var __r = writeSiteConfig_(JSON.stringify(cfg));
    if (__r && __r.ok) {
      auditLog_('legal.config.update', { category:['configuration'], type:['change'],
        outcome:'success', route:'legal', rpc:'saveLegalConfigRpc',
        userId:sess.userId, sessionId:token }, sess.logCtx);
    }
    return __r;
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- System Info & Config (owner-only save) ---------- */
function getSystemInfoRpc(token) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var isOwner = isOwner_(token);
    var sheetId  = SP.getProperty('SHEET_ID')        || '';
    var folderId = SP.getProperty('DRIVE_FOLDER_ID') || '';
    var encKey        = SP.getProperty('DATA_ENCRYPT_KEY')|| '';
    var aftershipKey  = SP.getProperty('AFTERSHIP_API_KEY')  || '';
    var thaipostToken = SP.getProperty('THP_STATIC_TOKEN')  || '';
    var etrackKey     = SP.getProperty('ETRACK_API_KEY')    || '';
    var sheetOk = false, folderOk = false;
    try { SpreadsheetApp.openById(sheetId);  sheetOk  = true; } catch(_) {}
    try { DriveApp.getFolderById(folderId);  folderOk = true; } catch(_) {}
    var triggerOk = false;
    try { triggerOk = ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'tickSync'; }); } catch(_) {}
    var usersCount = 0;
    try { usersCount = Math.max(0, sheetUsers_().getLastRow() - 1); } catch(_) {}
    var execUrl = '';
    try { execUrl = ScriptApp.getService().getUrl(); } catch(_) {}
    var ownerEmail = getOwnerEmail_();
    function mask(s) {
      if (!s) return '';
      return s.length <= 12 ? s.slice(0,4) + '\u2026' : s.slice(0,8) + '\u2026' + s.slice(-4);
    }
    return {
      ok: true, isOwner: isOwner,
      version: SYSTEM_VERSION,
      ownerEmail: isOwner ? ownerEmail : mask(ownerEmail),
      health: {
        sheetId:  { ok: sheetOk,        value: isOwner ? sheetId  : mask(sheetId)  },
        folderId: { ok: folderOk,        value: isOwner ? folderId : mask(folderId) },
        encKey:     { ok: !!encKey,        value: encKey ? '\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf' : '' },
        trigger:    { ok: triggerOk },
        users:      { ok: usersCount > 0,  count: usersCount },
        rotateLock: { ok: !checkRotateLock_(), locked: !!checkRotateLock_() }
      },
      execUrl: execUrl,
      config: isOwner ? {
        sheetId: sheetId, folderId: folderId, ownerEmail: ownerEmail,
        encKeyMasked: encKey ? encKey.slice(0,4) + '…' + encKey.slice(-4) : '',
        encKeyOk: !!encKey,
        aftershipKeyMasked:  aftershipKey  ? mask(aftershipKey)  : '',
        aftershipKeyOk:      !!aftershipKey,
        thaipostTokenMasked: thaipostToken ? mask(thaipostToken) : '',
        thaipostTokenOk:     !!thaipostToken,
        etrackKeyMasked:     etrackKey     ? mask(etrackKey)     : '',
        etrackKeyOk:         !!etrackKey
      } : null
    };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function sendSystemOtpRpc(token) {
  var sess = requireOwner_(token);
  if (!sess) return { ok:false, error:'\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e40\u0e08\u0e49\u0e32\u0e02\u0e2d\u0e07\u0e23\u0e30\u0e1a\u0e1a\u0e40\u0e17\u0e48\u0e32\u0e19\u0e31\u0e49\u0e19' };
  try {
    var otp = otpIssue_('system_config', sess.userId, {}, 600);
    var quota = sendOtpEmail_(sess.email, 'รหัส OTP ตั้งค่าระบบ', otp);
    return { ok:true, maskedEmail:maskEmail_(sess.email), remainingQuota:quota };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function verifySystemOtpAndSaveRpc(token, otp, payload) {
  var sess = requireOwner_(token);
  if (!sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    var otpResult = otpVerify_('system_config', sess.userId, otp, 600, null);
    if (!otpResult.ok) return { ok:false, error:otpResult.error };
    var p = payload || {};
    // --- INPUT VALIDATION ---
    if (p.sheetId) {
      var sid = String(p.sheetId).trim();
      if (!/^[a-zA-Z0-9_\-]{10,100}$/.test(sid)) return { ok:false, error:'SHEET_ID รูปแบบไม่ถูกต้อง' };
      p.sheetId = sid;
    }
    if (p.folderId) {
      var fid = String(p.folderId).trim();
      if (!/^[a-zA-Z0-9_\-]{10,100}$/.test(fid)) return { ok:false, error:'DRIVE_FOLDER_ID รูปแบบไม่ถูกต้อง' };
      p.folderId = fid;
    }
    // --- END VALIDATION ---
    if (p.sheetId)  SP.setProperty('SHEET_ID',        p.sheetId);
    if (p.folderId) SP.setProperty('DRIVE_FOLDER_ID', p.folderId);
    // ownerEmail ไม่อนุญาตเปลี่ยนผ่าน UI — ต้องแก้ใน Script Properties โดยตรง
    auditLog_('system.config.update', { category:['configuration'], type:['change'],
      outcome:'success', level:'warning', route:'system', rpc:'verifySystemOtpAndSaveRpc',
      userId:sess.userId, sessionId:token,
      meta:{ sheet_id_changed: !!p.sheetId, folder_id_changed: !!p.folderId } }, sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- Rotation Lock helpers ---------- */
function acquireRotateLock_(userId) {
  var raw = SP.getProperty(ROTATE_LOCK_KEY);
  if (raw) {
    try {
      var existing = JSON.parse(raw);
      if (Date.now() - existing.startedAt < ROTATE_LOCK_TIMEOUT) return false;
    } catch(_) {}
  }
  SP.setProperty(ROTATE_LOCK_KEY, JSON.stringify({
    startedAt: Date.now(), userId: userId, total: 0, processed: 0
  }));
  return true;
}
function releaseRotateLock_() { SP.deleteProperty(ROTATE_LOCK_KEY); }
function checkRotateLock_() {
  var raw = SP.getProperty(ROTATE_LOCK_KEY);
  if (!raw) return null;
  try {
    var lock = JSON.parse(raw);
    if (Date.now() - lock.startedAt < ROTATE_LOCK_TIMEOUT) return lock;
    SP.deleteProperty(ROTATE_LOCK_KEY);
    return null;
  } catch(_) { return null; }
}
function updateRotateLockProgress_(total, processed) {
  var raw = SP.getProperty(ROTATE_LOCK_KEY);
  if (!raw) return;
  try {
    var lock = JSON.parse(raw);
    lock.total = total; lock.processed = processed;
    SP.setProperty(ROTATE_LOCK_KEY, JSON.stringify(lock));
  } catch(_) {}
}

function getRotateLockStatusRpc() {
  var lock = checkRotateLock_();
  if (!lock) return { ok:true, locked:false };
  return { ok:true, locked:true, total:lock.total || 0, processed:lock.processed || 0 };
}

function releaseRotateLockRpc(token) {
  var sess = requireOwner_(token);
  if (!sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  releaseRotateLock_();
  auditLog_('key.rotate.lock_release', { category:['configuration'], type:['change'],
    outcome:'success', level:'warning', route:'system', rpc:'releaseRotateLockRpc',
    userId:sess.userId, sessionId:token }, sess.logCtx);
  return { ok:true };
}

/* ---------- Key Rotation OTP ---------- */
function sendKeyRotateOtpRpc(token) {
  var sess = requireOwner_(token);
  if (!sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    var otp = otpIssue_('key_rotate', sess.userId, {}, 600);
    var quota = sendOtpEmail_(sess.email, 'รหัส OTP หมุนเวียน Encryption Key', otp, {
      warnLines: [
        '⚠️ การดำเนินการนี้จะ re-encrypt ข้อมูลลูกค้าทั้งหมดในระบบ',
        'หากคุณไม่ได้ทำรายการนี้ กรุณาเพิกเฉยข้อความนี้'
      ]
    });
    return { ok:true, maskedEmail:maskEmail_(sess.email), remainingQuota:quota };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function verifyAndRotateKeyRpc(token, otp) {
  var sess = requireOwner_(token);
  if (!sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    // Verify OTP
    var otpResult = otpVerify_('key_rotate', sess.userId, otp, 600, null);
    if (!otpResult.ok) return { ok:false, error:otpResult.error };

    // Acquire rotation lock
    if (!acquireRotateLock_(sess.userId)) {
      return { ok:false, error:'ระบบกำลัง rotate key อยู่แล้ว กรุณารอสักครู่' };
    }
    enqueueLog_('key.rotate.start', { category:['configuration'], type:['change'],
      outcome:'unknown', level:'warning', route:'system', rpc:'verifyAndRotateKeyRpc',
      userId:sess.userId, sessionId:token }, sess.logCtx);
    try {
      // Encrypted column indices in orders sheet (0-based)
      var encCols = [4, 5, 7, 8, 9, 10, 11, 12, 21, 22, 25];
      var oldKey  = SP.getProperty('DATA_ENCRYPT_KEY') || '';
      var newKey  = (uuid_() + uuid_()).replace(/-/g, '');

      function _dec(value, key) {
        if (!value || String(value).indexOf('enc:') !== 0) return value;
        if (!key) return value;
        var parts = String(value).split(':');
        if (parts.length < 3) return value;
        var iv = parts[1], encHex = parts[2];
        var keyBytes = Utilities.newBlob(key).getBytes();
        var encrypted = [];
        for (var i = 0; i < encHex.length; i += 2) encrypted.push(parseInt(encHex.slice(i,i+2),16));
        var block = null, decrypted = [];
        for (var i = 0; i < encrypted.length; i++) {
          var bi = Math.floor(i/32), off = i%32;
          if (off === 0) block = Utilities.computeHmacSha256Signature(Utilities.newBlob(iv+bi).getBytes(), keyBytes);
          decrypted.push((encrypted[i] ^ block[off]) & 0xff);
        }
        try { return Utilities.newBlob(decrypted).getDataAsString('UTF-8'); } catch(_) { return value; }
      }
      function _enc(plaintext, key) {
        if (!plaintext) return plaintext;
        if (!key) return plaintext;
        var bytes = Utilities.newBlob(String(plaintext), 'UTF-8').getBytes();
        var iv = uuid_().replace(/-/g,'').slice(0,16);
        var keyBytes = Utilities.newBlob(key).getBytes();
        var block = null, encrypted = [];
        for (var i = 0; i < bytes.length; i++) {
          var bi = Math.floor(i/32), off = i%32;
          if (off === 0) block = Utilities.computeHmacSha256Signature(Utilities.newBlob(iv+bi).getBytes(), keyBytes);
          encrypted.push((bytes[i] ^ block[off]) & 0xff);
        }
        var hex = encrypted.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
        // Format v2 — append the authentication tag, same as encryptField_.
        return 'enc:' + iv + ':' + hex + ':' + _encFieldMac_(iv, hex, keyBytes);
      }

      var sh = sheetOrders_();
      var lastRow = sh.getLastRow();
      if (lastRow < 2) {
        SP.setProperty('DATA_ENCRYPT_KEY', newKey);
        _invalidateEncryptKeyCache_();
        enqueueLog_('key.rotate.done', { category:['configuration'], type:['change'],
          outcome:'success', level:'warning', route:'system', rpc:'verifyAndRotateKeyRpc',
          userId:sess.userId, sessionId:token, meta:{ rows_processed:0 } }, sess.logCtx);
        return { ok:true, rowsProcessed:0 };
      }
      var numCols = sh.getLastColumn();
      var rows = sh.getRange(2, 1, lastRow - 1, numCols).getValues();

      updateRotateLockProgress_(rows.length, 0);
      var rowsProcessed = 0;
      for (var r = 0; r < rows.length; r++) {
        var changed = false;
        for (var c = 0; c < encCols.length; c++) {
          var col = encCols[c];
          if (col >= rows[r].length) continue;
          var rawVal = String(rows[r][col] || '');
          var plain  = _dec(rawVal, oldKey);
          if (!plain) continue;
          rows[r][col] = _enc(plain, newKey);
          changed = true;
        }
        if (changed) rowsProcessed++;
        if (r % 20 === 0) updateRotateLockProgress_(rows.length, rowsProcessed);
      }

      // Write all re-encrypted rows back, then update key
      sh.getRange(2, 1, rows.length, numCols).setValues(rows);
      SP.setProperty('DATA_ENCRYPT_KEY', newKey);
      _invalidateEncryptKeyCache_();
      enqueueLog_('key.rotate.done', { category:['configuration'], type:['change'],
        outcome:'success', level:'warning', route:'system', rpc:'verifyAndRotateKeyRpc',
        userId:sess.userId, sessionId:token, meta:{ rows_processed:rowsProcessed } }, sess.logCtx);
      return { ok:true, rowsProcessed:rowsProcessed };
    } finally {
      releaseRotateLock_();
    }
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- Payment OTP ---------- */
function paymentOtpKey_(userId) { return 'PAYMENT_OTP_' + String(userId); }

function paymentOtpPayloadHash_(payload) {
  var p = payload || {};
  var bg = p.bg_image || {};
  var stable = {
    promptpay_number: String(p.promptpay_number || '').trim().replace(/[^0-9]/g, ''),
    promptpay_name: String(p.promptpay_name || '').trim(),
    qr_x: Math.round(Number(p.qr_x || 0) * 10) / 10,
    qr_y: Math.round(Number(p.qr_y || 0) * 10) / 10,
    qr_size: Number(p.qr_size || 0),
    bg_mode: String(bg.mode || '')
  };
  return otpPayloadHash_(stable);
}

function sendPaymentOtpRpc(token, payload) {
  const sess = requireOwner_(token);
  if (!sess) return { ok: false, error: 'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    const email = sess.email;
    if (!email) return { ok:false, error:'ไม่สามารถระบุอีเมลผู้ดูแลระบบได้' };

    var payloadHash = paymentOtpPayloadHash_(payload);

    const masked = maskEmail_(email);

    // ป้องกัน double-send: ถ้าเพิ่งส่งไปไม่ถึง 60 วินาที และ payload เหมือนเดิม ไม่ส่งซ้ำ
    var existingRecord = otpLoad_('payment_config', sess.userId);
    if (existingRecord && existingRecord.sentAt &&
        (Date.now() - Number(existingRecord.sentAt)) < 60000 &&
        Date.now() < Number(existingRecord.expires || 0) &&
        existingRecord.payloadHash === payloadHash) {
      return { ok:true, maskedEmail: masked, remainingQuota: MailApp.getRemainingDailyQuota(), reused: true };
    }

    var otp = otpIssue_('payment_config', sess.userId, { sentAt: Date.now(), payloadHash: payloadHash }, 600);

    var quota = sendOtpEmail_(email, 'รหัส OTP ยืนยันการตั้งค่า PromptPay', otp);

    return { ok:true, maskedEmail: masked, remainingQuota: quota };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function verifyPaymentOtpAndSaveRpc(token, otp, payload) {
  var sess = requireOwner_(token);
  if (!sess) return { ok: false, error: 'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    var payloadHash = paymentOtpPayloadHash_(payload);
    var otpResult = otpVerify_('payment_config', sess.userId, otp, 600, function(record) {
      if (record.payloadHash !== payloadHash)
        return 'ข้อมูลการชำระเงินเปลี่ยนแปลง กรุณาขอรหัสใหม่';
      return null;
    });
    if (!otpResult.ok) return { ok:false, error:otpResult.error };
    return savePaymentConfigRpc(token, payload);
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- RPC: product ---------- */
function productListRpc(tokenOrOpts, optsArg){
  // Overload: if first arg is a string → admin call (token, opts)
  //           if first arg is an object → public call (opts)
  var token = null;
  var opts;
  if (typeof tokenOrOpts === 'string') {
    token = tokenOrOpts;
    opts  = optsArg || {};
    if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  } else {
    opts = tokenOrOpts || {};
  }
  syncSnapIfStale_();
  const q = String(opts.q||'').toLowerCase();
  const sort = opts.sort || 'new';
  const includeAll = token ? !!opts.includeAll : false; // only admin can use includeAll

  let items = getSnap_();
  if(!includeAll) items = items.filter(x => x.sale_status === 'active');

  if(q){
    items = items.filter(p =>
      [p.title||'', p.desc||'', p.badge||'']
        .some(s => String(s).toLowerCase().includes(q))
    );
  }

  if(sort==='name-asc')       items.sort((a,b)=>String(a.title).localeCompare(String(b.title)));
  else if(sort==='name-desc') items.sort((a,b)=>String(b.title).localeCompare(String(a.title)));
  else if(sort==='price-asc') items.sort((a,b)=>Number(a.price)-Number(b.price));
  else if(sort==='price-desc')items.sort((a,b)=>Number(b.price)-Number(a.price));
  else                        items = items.slice().reverse(); // "ล่าสุด"

  const off = Number(opts.offset||0);
  const lim = Number(opts.limit||items.length);

  return {
    ok: true,
    items: items.slice(off, off+lim),
    total: items.length,
    // สำคัญสำหรับ cache ฝั่ง client:
    snapshotTs: Number(CacheService.getScriptCache().get(CACHE_PROD_TS) || 0)
  };
}

function productGetRpc(id, token){
  syncSnapIfStale_();
  const r=getSnap_().find(x=>String(x.id)===String(id));
  if (!r) return {ok:false, error:'not found'};
  // Public callers only see purchasable products (mirrors productListRpc's filter);
  // an admin token unlocks disabled/scheduled/draft records for the admin panel.
  if (r.sale_status !== 'active' && !(token && requireAdmin_(token))) {
    return {ok:false, error:'not found'};
  }
  return {ok:true, record:r};
}
function productCreateRpc(token, payload){
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  assertConfig_();
  const p=payload||{};
  // --- INPUT VALIDATION ---
  var titleR = normalizePlainText_(p.title, { maxLen:VLEN.SHORT, fieldName:'ชื่อสินค้า' });
  if (!titleR.ok) return { ok:false, error:titleR.error };
  p.title = titleR.value;
  var descR = normalizeMultilineText_(p.desc||'', { maxLen:VLEN.MEDIUM, fieldName:'คำอธิบาย', allowEmpty:true });
  if (!descR.ok) return { ok:false, error:descR.error };
  p.desc = descR.value;
  if (p.badge) {
    var badgeR = normalizePlainText_(p.badge, { maxLen:VLEN.SHORT, fieldName:'badge', allowEmpty:true });
    if (!badgeR.ok) return { ok:false, error:badgeR.error };
    p.badge = badgeR.value;
  }
  if (p.image && p.image.mode==='url') {
    var iuR = normalizeUrl_(p.image.url||'', { fieldName:'image.url' });
    if (!iuR.ok) return { ok:false, error:iuR.error };
    p.image.url = iuR.value;
  }
  if (Array.isArray(p.variants)) {
    var variantsR = sanitizeVariantGroups_(p.variants);
    if (!variantsR.ok) return { ok:false, error:variantsR.error };
    p.variants = variantsR.value;
    if (p.variants.length) {
      var derivedPrice = deriveVariantProductPrice_(p.variants, p.price);
      if (derivedPrice === null) return { ok:false, error:'ไม่สามารถคำนวณราคาสินค้าจาก Variant ได้' };
      p.price = derivedPrice;
    }
  }
  if (Array.isArray(p.extra_images)) {
    for (var ei=0; ei<p.extra_images.length; ei++) {
      var eimg = p.extra_images[ei];
      if (eimg && eimg.mode==='url') {
        var eiR = normalizeUrl_(eimg.url||'', { fieldName:'extra_images['+ei+'].url' });
        if (!eiR.ok) return { ok:false, error:eiR.error };
        eimg.url = eiR.value;
      }
    }
  }
  var _createStock = p.stock !== undefined ? _normStockValue_(p.stock) : -1;
  if (_createStock === null) return { ok:false, error:'จำนวนสต็อกไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม ≥ 0 หรือเว้นว่าง)' };
  // --- END VALIDATION ---
  if (_normalizeSaleMode_(p.sale_mode) !== 'disabled' && !(p.allowed_shipping_ids||[]).length) {
    return { ok:false, error:'สินค้าที่เปิดขายต้องกำหนดวิธีการจัดส่งอย่างน้อย 1 วิธี' };
  }
  // NOTE: we intentionally do NOT reject when allowed_shipping_ids points only at
  // inactive methods — the product is still creatable, but `getProductSaleStatus_`
  // will surface it as non-'active' via `_isProductPublishable_`, and the order
  // path (submitOrderRpc) blocks the actual purchase.
  let driveId='', url='';
  if(p.image?.mode==='file'){
    driveId=uploadValidatedImage_(p.image.base64, p.image.filename, p.image.contentType, getFolderIdCached_(FOLDER_PRODUCT), true, { maxBytes:5*1024*1024, allowGif:false });
    url=publicUrl_(driveId);
  }else if(p.image?.mode==='url'){
    url=String(p.image.url||'');
  }
  const varResult=processVariants_(p.variants||[], []);
  const extraResult=processExtraImages_(p.extra_images||[], []);
  // Sale mode + schedule. Schedule is only meaningful when mode='scheduled'.
  var saleMode = _normalizeSaleMode_(p.sale_mode);
  var swStarts = '', swEnds = '';
  if (saleMode === 'scheduled') {
    var swIn = _normalizeSchedule_({
      starts_at: p.sale_starts_at,
      ends_at: p.sale_ends_at,
      no_end_date: !p.sale_ends_at
    });
    var swCheck = _validateScheduleWindow_(swIn.starts_at, swIn.ends_at, swIn.no_end_date);
    if (!swCheck.ok) return { ok:false, error: swCheck.error };
    swStarts = swIn.starts_at; swEnds = swIn.ends_at;
  }
  const id=appendProd_({
    title:p.title, desc:p.desc, price:p.price,
    badge:p.badge, image_drive_file_id:driveId, image_url:url,
    variants:varResult.variants, extra_images:extraResult.images,
    weight_grams:p.weight_grams, allowed_shipping_ids:p.allowed_shipping_ids,
    stock: _createStock,
    sale_mode: saleMode,
    sale_starts_at: swStarts,
    sale_ends_at: swEnds
  });
  enqueueLog_('product.create', { category:['database'], type:['creation'],
    outcome:'success', route:'product', rpc:'productCreateRpc',
    userId:_sess.userId, sessionId:token,
    meta:{ resource_type:'product', resource_id_hash: hashForLog_(id, 'p_') } }, _sess.logCtx);
  return {ok:true, id};
}

function productUpdateRpc(token, id, patch){
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  assertConfig_();
  const sh = sheetProd_();
  const rowNo = sheetRowOfId_(id);
  if (rowNo < 0) return { ok:false, error:'not found' };

  const v = sh.getRange(rowNo,1,1,20).getValues()[0];
  var existingMode = String(v[19]||'').trim().toLowerCase();
  if (existingMode !== 'disabled' && existingMode !== 'always' && existingMode !== 'scheduled') {
    existingMode = _computeSaleModeFromLegacy_(v[9], v[15], v[16], v[17]);
  }
  let rec = {
    id:v[0], title:v[1], desc:v[2], price:v[3],
    badge:v[4], image_drive_file_id:v[5], image_url:v[6],
    created_at:v[7], updated_at:v[8],
    variants:(()=>{ try{ return JSON.parse(String(v[10]||'[]')); }catch(_){ return []; } })(),
    extra_images:(()=>{ try{ return JSON.parse(String(v[11]||'[]')); }catch(_){ return []; } })(),
    weight_grams:Number(v[12]||0),
    allowed_shipping_ids:(()=>{ try{ return JSON.parse(String(v[13]||'[]')); }catch(_){ return []; } })(),
    stock:(function(){ var s=Number(v[14]); return isNaN(s) ? -1 : s; })(),
    sale_starts_at: String(v[16]||''),
    sale_ends_at: String(v[17]||''),
    sale_mode: existingMode
  };

  // --- INPUT VALIDATION ---
  if (patch.title !== undefined) {
    var titleR = normalizePlainText_(patch.title, { maxLen:VLEN.SHORT, fieldName:'ชื่อสินค้า' });
    if (!titleR.ok) return { ok:false, error:titleR.error };
    patch.title = titleR.value;
  }
  if (patch.desc !== undefined) {
    var descR = normalizeMultilineText_(patch.desc||'', { maxLen:VLEN.MEDIUM, fieldName:'คำอธิบาย', allowEmpty:true });
    if (!descR.ok) return { ok:false, error:descR.error };
    patch.desc = descR.value;
  }
  if (patch.badge !== undefined && patch.badge !== '') {
    var badgeR = normalizePlainText_(patch.badge, { maxLen:VLEN.SHORT, fieldName:'badge', allowEmpty:true });
    if (!badgeR.ok) return { ok:false, error:badgeR.error };
    patch.badge = badgeR.value;
  }
  if (patch.image && patch.image.mode==='url') {
    var iuR = normalizeUrl_(patch.image.url||'', { fieldName:'image.url' });
    if (!iuR.ok) return { ok:false, error:iuR.error };
    patch.image.url = iuR.value;
  }
  if (Array.isArray(patch.variants)) {
    var variantsR = sanitizeVariantGroups_(patch.variants);
    if (!variantsR.ok) return { ok:false, error:variantsR.error };
    patch.variants = variantsR.value;
  }
  if (Array.isArray(patch.extra_images)) {
    for (var ei=0; ei<patch.extra_images.length; ei++) {
      var eimg = patch.extra_images[ei];
      if (eimg && eimg.mode==='url') {
        var eiR = normalizeUrl_(eimg.url||'', { fieldName:'extra_images['+ei+'].url' });
        if (!eiR.ok) return { ok:false, error:eiR.error };
        eimg.url = eiR.value;
      }
    }
  }

  // Keep product.price authoritative for variant products without changing the
  // RPC payload shape. Recompute when variants are submitted, or when a caller
  // tries to patch only the root price of an existing variant product.
  var variantsForDerivedPrice = Array.isArray(patch.variants) ? patch.variants : rec.variants;
  if (Array.isArray(variantsForDerivedPrice) && variantsForDerivedPrice.length &&
      (patch.variants !== undefined || patch.price !== undefined)) {
    var derivedPrice = deriveVariantProductPrice_(variantsForDerivedPrice, rec.price);
    if (derivedPrice === null) {
      if (patch.variants !== undefined) return { ok:false, error:'ไม่สามารถคำนวณราคาสินค้าจาก Variant ได้' };
      // Do not let a price-only patch corrupt a legacy variant record that cannot
      // be derived. Preserve its current root price until its variants are edited.
      delete patch.price;
    } else {
      patch.price = derivedPrice;
    }
  }
  // --- END VALIDATION ---

  // แตะรูปเฉพาะกรณีส่ง image มา และ "เปลี่ยนจริง"
  if (patch && patch.image){
    const hadDrive   = !!rec.image_drive_file_id;
    const oldDriveId = rec.image_drive_file_id || '';
    const oldUrl     = rec.image_url || '';

    if (patch.image.mode === 'url'){
      const newUrl = String(patch.image.url||'').trim();
      const sameAsOldUrl   = newUrl === oldUrl;
      const sameAsOldDrive = oldDriveId && newUrl.indexOf(oldDriveId) >= 0;
      if (!(sameAsOldUrl || sameAsOldDrive)){
        rec.image_url = newUrl;
        rec.image_drive_file_id = '';
        if (hadDrive) deleteDriveFileSafe_(oldDriveId);
      }
    }else if (patch.image.mode === 'file'){
      const base64 = String(patch.image.base64||'');
      if (!base64) return { ok:false, error:'image.base64 required' };
      const contentType = String(patch.image.contentType||'image/jpeg');
      const filename = String(patch.image.filename || ('product-' + Date.now() + '.jpg'));
      const newId = uploadValidatedImage_(base64, filename, contentType, getFolderIdCached_(FOLDER_PRODUCT), true, { maxBytes:5*1024*1024, allowGif:false });
      rec.image_drive_file_id = newId;
      rec.image_url = publicUrl_(newId);
      if (oldDriveId && oldDriveId !== newId) deleteDriveFileSafe_(oldDriveId);
    }
  }

  // ฟิลด์อื่น ๆ
  if (patch.title     !== undefined) rec.title = String(patch.title);
  if (patch.desc      !== undefined) rec.desc  = String(patch.desc);
  if (patch.price     !== undefined) rec.price = Number(patch.price);
  if (patch.badge     !== undefined) rec.badge = String(patch.badge);
  if (patch.weight_grams          !== undefined) rec.weight_grams = Number(patch.weight_grams||0);
  if (patch.allowed_shipping_ids  !== undefined) rec.allowed_shipping_ids = Array.isArray(patch.allowed_shipping_ids) ? patch.allowed_shipping_ids : [];
  if (patch.stock                 !== undefined) rec.stock = (patch.stock === '' || patch.stock == null) ? -1 : Number(patch.stock);
  if (patch.variants  !== undefined) {
    var varResult=processVariants_(patch.variants, rec.variants);
    rec.variants=varResult.variants;
    varResult.toDelete.forEach(function(fid){ deleteDriveFileSafe_(fid); });
  }
  if (patch.extra_images !== undefined) {
    var extraResult=processExtraImages_(patch.extra_images, rec.extra_images);
    rec.extra_images=extraResult.images;
    extraResult.toDelete.forEach(function(fid){ deleteDriveFileSafe_(fid); });
  }

  // Sale mode patch — single source of truth
  if (patch.sale_mode !== undefined) rec.sale_mode = _normalizeSaleMode_(patch.sale_mode);
  if (rec.sale_mode === 'scheduled') {
    if (patch.sale_starts_at !== undefined || patch.sale_ends_at !== undefined) {
      var swPatch = _normalizeSchedule_({
        starts_at: patch.sale_starts_at !== undefined ? patch.sale_starts_at : rec.sale_starts_at,
        ends_at:   patch.sale_ends_at   !== undefined ? patch.sale_ends_at   : rec.sale_ends_at,
        no_end_date: !(patch.sale_ends_at !== undefined ? patch.sale_ends_at : rec.sale_ends_at)
      });
      var swCheck = _validateScheduleWindow_(swPatch.starts_at, swPatch.ends_at, swPatch.no_end_date);
      if (!swCheck.ok) return { ok:false, error: swCheck.error };
      rec.sale_starts_at = swPatch.starts_at || '';
      rec.sale_ends_at   = swPatch.ends_at   || '';
    }
  } else {
    // For 'always' and 'disabled', schedule fields are ignored.
    if (patch.sale_mode !== undefined) {
      rec.sale_starts_at = '';
      rec.sale_ends_at   = '';
    }
  }

  if (rec.sale_mode !== 'disabled' && !(rec.allowed_shipping_ids||[]).length) {
    return { ok:false, error:'สินค้าที่เปิดขายต้องกำหนดวิธีการจัดส่งอย่างน้อย 1 วิธี' };
  }

  // Legacy cols stay in lockstep so external sheet viewers stay readable.
  var legacyActive       = rec.sale_mode !== 'disabled';
  var legacySaleEnabled  = rec.sale_mode !== 'disabled' ? 'TRUE' : 'FALSE';
  var legacyNoEndDate    = !rec.sale_ends_at;

  rec.updated_at = nowISO_();
  sh.getRange(rowNo,2,1,19).setValues([[
    sanitizeSheetCell_(rec.title),
    sanitizeSheetCell_(rec.desc),
    rec.price,
    sanitizeSheetCell_(rec.badge),
    rec.image_drive_file_id,
    sanitizeSheetCell_(rec.image_url),
    rec.created_at, rec.updated_at, legacyActive,
    JSON.stringify(rec.variants||[]),
    JSON.stringify(rec.extra_images||[]),
    Number(rec.weight_grams||0),
    JSON.stringify(rec.allowed_shipping_ids||[]),
    (rec.stock !== undefined ? Number(rec.stock) : -1),
    legacySaleEnabled,
    rec.sale_starts_at || '',
    rec.sale_ends_at || '',
    legacyNoEndDate ? 'TRUE' : 'FALSE',
    rec.sale_mode
  ]]);

  rebuildSnap_();
  // คืน record ที่อัปเดตแล้วจาก snapshot ที่ rebuild เสร็จ
  // เพื่อหลีกเลี่ยง race condition เมื่อ client เรียก productGetRpc แยกต่างหาก
  var updatedSnap = getSnap_().filter(function(x){ return String(x.id) === String(rec.id); });
  enqueueLog_('product.update', { category:['database'], type:['change'],
    outcome:'success', route:'product', rpc:'productUpdateRpc',
    userId:_sess.userId, sessionId:token,
    meta:{ resource_type:'product', resource_id_hash: hashForLog_(rec.id, 'p_') } }, _sess.logCtx);
  return { ok:true, id: rec.id, record: updatedSnap.length ? updatedSnap[0] : null };
}

function productDeleteRpc(token, id){
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  const rowNo=sheetRowOfId_(id); if(rowNo<0) return {ok:false, error:'not found'};
  const sh=sheetProd_(); const v=sh.getRange(rowNo,1,1,15).getValues()[0];
  const driveId=String(v[5]||'');
  const variants=(()=>{ try{ return JSON.parse(String(v[10]||'[]')); }catch(_){ return []; } })();
  const extraImgs=(()=>{ try{ return JSON.parse(String(v[11]||'[]')); }catch(_){ return []; } })();
  sh.deleteRow(rowNo);
  if(driveId) deleteDriveFileSafe_(driveId);
  variants.forEach(function(g){
    (g.options||[]).forEach(function(o){ if(o.image_file_id) deleteDriveFileSafe_(o.image_file_id); });
  });
  extraImgs.forEach(function(img){ if(img.drive_file_id) deleteDriveFileSafe_(img.drive_file_id); });
  rebuildSnap_();
  enqueueLog_('product.delete', { category:['database'], type:['deletion'],
    outcome:'success', route:'product', rpc:'productDeleteRpc',
    userId:_sess.userId, sessionId:token,
    meta:{ resource_type:'product', resource_id_hash: hashForLog_(id, 'p_') } }, _sess.logCtx);
  return {ok:true, id};
}

function productBulkDeleteRpc(token, ids){
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'no ids' };
  var deleted = [], notFound = [];
  // ลบทีละ id — ลบจากท้ายขึ้นบนเพื่อกัน row shift
  var rowNos = ids.map(function(id){ return { id: id, row: sheetRowOfId_(id) }; })
                   .filter(function(x){ return x.row >= 0; })
                   .sort(function(a,b){ return b.row - a.row; });
  ids.forEach(function(id){ if (!rowNos.find(function(x){ return String(x.id)===String(id); })) notFound.push(id); });
  var sh = sheetProd_();
  rowNos.forEach(function(x){
    var v = sh.getRange(x.row,1,1,15).getValues()[0];
    var driveId = String(v[5]||'');
    var variants=(function(){ try{ return JSON.parse(String(v[10]||'[]')); }catch(_){ return []; } })();
    var extraImgs=(function(){ try{ return JSON.parse(String(v[11]||'[]')); }catch(_){ return []; } })();
    sh.deleteRow(x.row);
    if(driveId) deleteDriveFileSafe_(driveId);
    variants.forEach(function(g){
      (g.options||[]).forEach(function(o){ if(o.image_file_id) deleteDriveFileSafe_(o.image_file_id); });
    });
    extraImgs.forEach(function(img){ if(img.drive_file_id) deleteDriveFileSafe_(img.drive_file_id); });
    deleted.push(x.id);
  });
  rebuildSnap_();
  auditLog_('product.bulk_delete', { category:['database'], type:['deletion'],
    outcome:'success', route:'product', rpc:'productBulkDeleteRpc',
    userId:_sess.userId, sessionId:token,
    meta:{ resource_type:'product', count: deleted.length,
           resource_id_hashes: deleted.slice(0, 50).map(function(id){ return hashForLog_(id, 'p_'); }) } },
    _sess.logCtx);
  return { ok: true, deleted: deleted, notFound: notFound };
}

/* ---------- Variant image processing ---------- */
function processVariants_(newVariants, oldVariants){
  var toDelete=[];
  var variants=(newVariants||[]).map(function(g){
    var opts=(g.options||[]).map(function(opt){
      var o={label:opt.label, price:Number(opt.price||0), weight_grams:Number(opt.weight_grams||0), stock:(opt.stock !== undefined ? Number(opt.stock) : -1)};
      if(g.type==='image'){
        if(opt.imageUpload && opt.imageUpload.base64){
          var fid=uploadValidatedImage_(opt.imageUpload.base64, opt.imageUpload.filename, opt.imageUpload.contentType, getFolderIdCached_(FOLDER_PRODUCT), true, { maxBytes:5*1024*1024, allowGif:false });
          if(opt.old_image_file_id) toDelete.push(opt.old_image_file_id);
          o.image_file_id=fid;
        } else if(opt.image_file_id){
          o.image_file_id=opt.image_file_id;
        } else if(opt.image){
          o.image=opt.image; // legacy URL
        }
      }
      return o;
    });
    return {name:g.name, type:g.type, options:opts};
  });
  return {variants:variants, toDelete:toDelete};
}

/* ---------- Extra images processing ---------- */
function processExtraImages_(newImgs, oldImgs){
  var toDelete=[];
  var oldIds=(oldImgs||[]).map(function(i){ return i.drive_file_id||''; }).filter(Boolean);
  var images=(newImgs||[]).map(function(img){
    if(img.mode==='file'){
      var fid=uploadValidatedImage_(img.base64, img.filename, img.contentType, getFolderIdCached_(FOLDER_PRODUCT), true, { maxBytes:5*1024*1024, allowGif:false });
      return {drive_file_id:fid, url:publicUrl_(fid)};
    }else if(img.mode==='url'){
      return {drive_file_id:'', url:String(img.url||'')};
    }else if(img.mode==='keep'){
      return {drive_file_id:img.drive_file_id||'', url:img.url||''};
    }
    return null;
  }).filter(Boolean);
  var newIds=images.map(function(i){ return i.drive_file_id||''; }).filter(Boolean);
  oldIds.forEach(function(id){ if(newIds.indexOf(id)<0) toDelete.push(id); });
  return {images:images, toDelete:toDelete};
}

/* ---------- Product image lookup by IDs (public, no admin auth) ---------- */
function getProductImagesByIdsRpc(productIds) {
  try {
    const ids = Array.isArray(productIds) ? productIds.map(String) : [];
    if (!ids.length) return { ok: true, images: {} };
    const snap = getSnap_();
    const images = {};
    snap.forEach(function(prod) {
      if (ids.indexOf(String(prod.id)) >= 0) {
        images[String(prod.id)] = {
          image_drive_file_id: prod.image_drive_file_id || '',
          image_url: prod.image_url || ''
        };
      }
    });
    return { ok: true, images: images };
  } catch(err) { return { ok: false, error: String(err) }; }
}

/* ---------- Stock management RPCs ---------- */
function getStockSummaryRpc(token) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  syncSnapIfStale_();
  var prods = getSnap_();
  return { ok:true, products: prods.map(function(p) {
    return {
      id: p.id, title: p.title, stock: p.stock,
      image_url: p.image_url, image_drive_file_id: p.image_drive_file_id,
      variants: (p.variants||[]).map(function(g) {
        return {
          name: g.name,
          options: (g.options||[]).map(function(o) { return { label: o.label, stock: (o.stock !== undefined ? o.stock : -1) }; })
        };
      })
    };
  })};
}

// Normalize a stock input: ''/null = unlimited (-1); otherwise a whole number ≥ -1.
// Returns null for anything invalid (NaN, fractions, < -1).
function _normStockValue_(v) {
  if (v === '' || v == null) return -1;
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < -1) return null;
  return n;
}

function updateStockRpc(token, updates) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  if (!Array.isArray(updates) || !updates.length) return { ok:false, error:'updates required' };
  // Validate every value before touching the sheet — reject the whole batch on bad input.
  for (var vi = 0; vi < updates.length; vi++) {
    var uu = updates[vi] || {};
    if (uu.stock !== undefined && _normStockValue_(uu.stock) === null)
      return { ok:false, error:'จำนวนสต็อกไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม ≥ 0 หรือเว้นว่าง)' };
    if (uu.variantStocks && typeof uu.variantStocks === 'object') {
      for (var vk in uu.variantStocks) {
        if (uu.variantStocks.hasOwnProperty(vk) && _normStockValue_(uu.variantStocks[vk]) === null)
          return { ok:false, error:'จำนวนสต็อกตัวเลือกไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม ≥ 0 หรือเว้นว่าง)' };
      }
    }
  }
  // Same lock as submitOrderRpc's commit phase — without it an admin stock save
  // racing an order commit is last-write-wins (oversell / phantom restock).
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
  var sh = sheetProd_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok:false, error:'no products' };
  var allIds = sh.getRange(2,1,lastRow-1,1).getValues().map(function(r){ return String(r[0]); });
  updates.forEach(function(u) {
    var rowIdx = allIds.indexOf(String(u.productId));
    if (rowIdx < 0) return;
    var rowNo = rowIdx + 2;
    var row = sh.getRange(rowNo,1,1,15).getValues()[0];
    // Update product-level stock
    if (u.stock !== undefined) {
      sh.getRange(rowNo, 15).setValue(_normStockValue_(u.stock));
    }
    // Update variant option stocks
    if (u.variantStocks && typeof u.variantStocks === 'object') {
      var variants = (function(){ try{ return JSON.parse(String(row[10]||'[]')); }catch(_){ return []; } })();
      var changed = false;
      variants.forEach(function(g) {
        (g.options||[]).forEach(function(o) {
          if (u.variantStocks.hasOwnProperty(o.label)) {
            o.stock = _normStockValue_(u.variantStocks[o.label]);
            changed = true;
          }
        });
      });
      if (changed) sh.getRange(rowNo, 11).setValue(JSON.stringify(variants));
    }
  });
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
  rebuildSnap_();
  auditLog_('stock.update', { category:['database'], type:['change'],
    outcome:'success', route:'product', rpc:'updateStockRpc',
    userId:_sess.userId, sessionId:token,
    meta:{ resource_type:'product', count: updates.length } }, _sess.logCtx);
  return { ok:true };
}

/* ---------- Image dataURL for frontend cache ---------- */

/* Public — serves product & store subfolders + main folder (backward compat) */
function getFileDataUrlRpc(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    var allowedIds = [SP.getProperty('DRIVE_FOLDER_ID')]   // legacy: ไฟล์เก่าก่อนมี subfolder
      .concat(_allFolderIdsByName_(FOLDER_PRODUCT))         // accept any duplicate of the same name
      .concat(_allFolderIdsByName_(FOLDER_STORE))
      .concat(_allFolderIdsByName_(FOLDER_GIFT));
    var parentId = null;
    var parents = file.getParents();
    if (parents.hasNext()) parentId = parents.next().getId();
    if (!parentId || allowedIds.indexOf(parentId) < 0)
      return { ok:false, error:'ไม่อนุญาต' };
    var blob = file.getBlob();
    var b64  = Utilities.base64Encode(blob.getBytes());
    return { ok:true, dataUrl:'data:'+(blob.getContentType()||'image/jpeg')+';base64,'+b64 };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* Admin only — serves all subfolders including slip */
function getAdminFileDataUrlRpc(token, fileId) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var file = DriveApp.getFileById(fileId);
    var allowedIds = [SP.getProperty('DRIVE_FOLDER_ID')]   // legacy
      .concat(_allFolderIdsByName_(FOLDER_PRODUCT))         // accept any duplicate of the same name
      .concat(_allFolderIdsByName_(FOLDER_SLIP))
      .concat(_allFolderIdsByName_(FOLDER_STORE))
      .concat(_allFolderIdsByName_(FOLDER_GIFT));
    var parentId = null;
    var parents = file.getParents();
    if (parents.hasNext()) parentId = parents.next().getId();
    if (!parentId || allowedIds.indexOf(parentId) < 0)
      return { ok:false, error:'ไม่อนุญาต' };
    var blob = file.getBlob();
    var b64  = Utilities.base64Encode(blob.getBytes());
    return { ok:true, dataUrl:'data:'+(blob.getContentType()||'image/jpeg')+';base64,'+b64 };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* Customer slip viewer — order token + status = 'paid' required */
function getSlipByOrderTokenRpc(orderToken, slipFileId) {
  try {
    if (!slipFileId) return { ok:false, error:'ข้อมูลไม่ครบ' };
    assertConfig_();
    var vt = validateOrderToken_(orderToken, { scope:'read_slip', maxRate:20, rateWindow:60 });
    if (!vt.ok) return { ok:false, error:vt.error };

    const storedSlipId = String(vt.row[ORDER_COLS.indexOf('slip_drive_file_id')] || '');
    // fileId ต้องตรงกับ slip ของ order นี้เท่านั้น
    if (!storedSlipId || storedSlipId !== String(slipFileId))
      return { ok:false, error:'ไม่อนุญาต' };

    // ตรวจสอบว่าไฟล์อยู่ใน slip folder จริง (รับทุกโฟลเดอร์ชื่อ slip รวมที่ซ้ำ)
    var file = DriveApp.getFileById(slipFileId);
    var slipFolderIds = _allFolderIdsByName_(FOLDER_SLIP);
    var parentId = null;
    var parents = file.getParents();
    if (parents.hasNext()) parentId = parents.next().getId();
    if (slipFolderIds.indexOf(parentId) < 0) return { ok:false, error:'ไม่อนุญาต' };

    var blob = file.getBlob();
    var b64  = Utilities.base64Encode(blob.getBytes());
    return { ok:true, dataUrl:'data:'+(blob.getContentType()||'image/jpeg')+';base64,'+b64 };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- Setup & housekeeping ---------- */
/* ---------- Store sheet (logo / banner / bg images) ---------- */
function sheetStore_() {
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_STORE) || ss.insertSheet(SHEET_NAME_STORE);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['key', 'drive_file_id', 'url', 'updated_at']);
    sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  }
  return sh;
}

/* ---------- Payment config sheet (single row, columnar) ---------- */
const PAYMENT_HEADERS = ['id','promptpay_number','promptpay_name','bg_drive_id','bg_url','qr_x','qr_y','qr_size','updated_at','updated_by'];

function sheetPayment_() {
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_PAYMENT) || ss.insertSheet(SHEET_NAME_PAYMENT);
  if (sh.getLastRow() === 0) {
    sh.appendRow(PAYMENT_HEADERS);
    sh.getRange(1, 1, 1, PAYMENT_HEADERS.length).setFontWeight('bold');
  }
  if (sh.getLastRow() < 2) {
    sh.appendRow([PAYMENT_ROW_ID, '', '', '', '', 50, 50, 25, '', '']);
  }
  return sh;
}

function _paymentRowToObj_(row) {
  return {
    promptpay_number: String(row[1] || ''),
    promptpay_name:   String(row[2] || ''),
    bg_drive_id:      String(row[3] || ''),
    bg_url:           String(row[4] || ''),
    qr_x:    (row[5] === '' || row[5] === null || row[5] === undefined) ? 50 : Number(row[5]),
    qr_y:    (row[6] === '' || row[6] === null || row[6] === undefined) ? 50 : Number(row[6]),
    qr_size: (row[7] === '' || row[7] === null || row[7] === undefined) ? 25 : Number(row[7]),
    updated_at: String(row[8] || ''),
    updated_by: String(row[9] || '')
  };
}

function readPaymentConfig_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_PAYMENT_CFG);
  if (cached) { try { return JSON.parse(cached); } catch(_) {} }
  const sh = sheetPayment_();
  const row = sh.getRange(2, 1, 1, PAYMENT_HEADERS.length).getValues()[0];
  const obj = _paymentRowToObj_(row);
  try { cache.put(CACHE_PAYMENT_CFG, JSON.stringify(obj), 600); } catch(_) {}
  return obj;
}

function writePaymentConfig_(obj, actorEmail) {
  const sh = sheetPayment_();
  const now = nowISO_();
  const row = [
    PAYMENT_ROW_ID,
    String(obj.promptpay_number || ''),
    String(obj.promptpay_name || ''),
    String(obj.bg_drive_id || ''),
    String(obj.bg_url || ''),
    (obj.qr_x    !== undefined && obj.qr_x    !== '') ? Number(obj.qr_x)    : 50,
    (obj.qr_y    !== undefined && obj.qr_y    !== '') ? Number(obj.qr_y)    : 50,
    (obj.qr_size !== undefined && obj.qr_size !== '') ? Number(obj.qr_size) : 25,
    now,
    String(actorEmail || '')
  ];
  // promptpay_number ต้องเก็บเป็นข้อความ (plain text) ไม่งั้น Sheets จะแปลงเลขที่ขึ้นต้น
  sh.getRange(2, 2).setNumberFormat('@');
  sh.getRange(2, 1, 1, PAYMENT_HEADERS.length).setValues([row]);
  try { CacheService.getScriptCache().remove(CACHE_PAYMENT_CFG); } catch(_) {}
  return { ok: true, updated_at: now };
}

/* ---------- Users sheet ---------- */
function sheetUsers_() {
  const ss = ss_();
  var sh = ss.getSheetByName(SHEET_NAME_USERS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME_USERS);
    sh.appendRow(['id','email','password_hash','salt','role','otp_required','created_at','updated_at','session_key_hash','session_expires_at']);
    sh.getRange(1,1,1,10).setFontWeight('bold');
  } else {
    var cur = sh.getLastColumn();
    if (cur < 9) { sh.getRange(1,9).setValue('session_key_hash').setFontWeight('bold'); cur = 9; }
    if (cur < 10) { sh.getRange(1,10).setValue('session_expires_at').setFontWeight('bold'); }
    // Migration: rename legacy 'session_key' header to 'session_key_hash' (idempotent)
    if (String(sh.getRange(1,9).getValue()) === 'session_key') {
      sh.getRange(1,9).setValue('session_key_hash').setFontWeight('bold');
    }
  }
  return sh;
}

/* ---------- Password helpers ---------- */
function genSalt_() {
  return Utilities.getUuid().replace(/-/g,'').slice(0,16);
}
function hashPassword_(password, salt) {
  var raw = String(password||'') + ':' + String(salt||'');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
}

/* PBKDF2-HMAC-SHA256 — slow password hashing (replaces single-round SHA-256) */
function pbkdf2_(password, salt, iterations, keyLen) {
  var pwd = Utilities.newBlob(String(password)).getBytes();
  var slt = Utilities.newBlob(String(salt)).getBytes();
  function hmac(key, data) { return Utilities.computeHmacSha256Signature(data, key); }
  var block = slt.concat([0,0,0,1]);
  var u = hmac(pwd, block);
  var result = u.slice(0);
  for (var i = 1; i < iterations; i++) {
    u = hmac(pwd, u);
    for (var j = 0; j < result.length; j++) result[j] ^= u[j];
  }
  return result.slice(0, keyLen).map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
}
/* Hash format: "v2:ITERATIONS:HEXHASH" (new) or "v2:HEXHASH" (legacy = 100000 iters) */
// 10000 iterations: reduced from 100000 — GAS charges ~0.1-1ms per Utilities.computeHmacSha256Signature
// call so 100k iters cost 10-60s. 10k stays under 3s and is adequate for this trust boundary
// (data never leaves Google infra; attacker needs Sheet access first anyway).
// Existing hashes (100000 iters stored as "v2:100000:..." or legacy "v2:HASH") trigger
// needsUpgrade=true automatically and are re-hashed on the user's next login.
var PBKDF2_ITERATIONS = 10000;
function hashPasswordV2_(password, salt) {
  return 'v2:' + PBKDF2_ITERATIONS + ':' + pbkdf2_(String(password), String(salt), PBKDF2_ITERATIONS, 32);
}
/* Parse stored v2 hash → { iterations, hash } */
function parseV2Hash_(stored) {
  // "v2:10000:HEXHASH" or legacy "v2:HEXHASH" (64-char hex, no colon inside)
  var body = stored.slice(3); // strip "v2:"
  var colon = body.indexOf(':');
  if (colon > 0 && /^\d+$/.test(body.slice(0, colon))) {
    return { iterations: parseInt(body.slice(0, colon), 10), hash: body.slice(colon + 1) };
  }
  return { iterations: 100000, hash: body }; // legacy format
}

/* ========== SECURITY HELPERS (session HMAC / OTP v2 / upload validation / order token) ========== */

/* ---------- Session key HMAC helpers ---------- */

function getOrCreateSessionHashSecret_() {
  var secret = SP.getProperty(SESSION_HASH_SECRET_KEY);
  if (secret) return secret;
  var newSecret = (uuid_() + uuid_()).replace(/-/g, ''); // 64-hex random
  SP.setProperty(SESSION_HASH_SECRET_KEY, newSecret);
  return newSecret;
}

// Returns HMAC-SHA256(rawKey, secret) as 64-hex lowercase.
// Returns '' if rawKey is falsy (used when clearing a session).
function hashSessionKey_(rawKey) {
  if (!rawKey) return '';
  var secret     = getOrCreateSessionHashSecret_();
  var secretBytes = Utilities.newBlob(secret).getBytes();
  var keyBytes    = Utilities.newBlob(String(rawKey)).getBytes();
  var sig = Utilities.computeHmacSha256Signature(keyBytes, secretBytes);
  return sig.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
}

/* ---------- Order token storage ---------- */
// NOTE: Order tokens are intentionally stored encrypted-at-rest in the orders sheet.
// Do not replace this with hashing: order-view validation requires reversible backend decryption.
// Hash-based token storage is not used for order tokens in this project.

function encryptOrderToken_(rawToken) {
  if (!SP.getProperty('DATA_ENCRYPT_KEY')) {
    SP.setProperty('DATA_ENCRYPT_KEY', (uuid_()+uuid_()).replace(/-/g,''));
  }
  return encryptField_(String(rawToken || ''));
}

function decryptOrderTokenCell_(value) {
  return String(decryptField_(String(value || '')) || '');
}

/* ---------- OTP v2 unified helpers ---------- */

function otpCacheKey_(action, userId) {
  return OTP_CACHE_PREFIX + String(action) + '_' + String(userId);
}

// Returns SHA-256 of JSON.stringify(payload) as 64-hex. Used to bind an OTP to a payload.
function otpPayloadHash_(payload) {
  var json  = JSON.stringify(payload || {});
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
}

// Issues a 6-digit OTP, writes the record to CacheService, returns the OTP string.
// extraFields: optional object merged into the record (e.g., { newEmail, payloadHash, sentAt }).
function otpIssue_(action, userId, extraFields, ttlSeconds) {
  var ttl    = ttlSeconds || 600;
  var otp    = Math.floor(100000 + Math.random() * 900000).toString();
  var now    = Date.now();
  var record = Object.assign({
    otp: otp, action: String(action), userId: String(userId),
    createdAt: now, expires: now + ttl * 1000, attempts: 0
  }, extraFields || {});
  CacheService.getScriptCache().put(otpCacheKey_(action, userId), JSON.stringify(record), ttl);
  return otp;
}

// Reads and parses the OTP record from CacheService. Returns null if absent or corrupt.
function otpLoad_(action, userId) {
  var raw = CacheService.getScriptCache().get(otpCacheKey_(action, userId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(_) { return null; }
}

// Increments attempts on a record and writes it back with its remaining TTL.
function otpFail_(action, userId, record) {
  record.attempts = (record.attempts || 0) + 1;
  var remainingSecs = Math.max(1, Math.ceil((record.expires - Date.now()) / 1000));
  CacheService.getScriptCache().put(otpCacheKey_(action, userId), JSON.stringify(record), remainingSecs);
  return record;
}

// Deletes the OTP record from CacheService (call on success or permanent failure).
function otpConsume_(action, userId) {
  CacheService.getScriptCache().remove(otpCacheKey_(action, userId));
}

// Central OTP verification with attempt counting, rate limiting, expiry, and optional binding.
// bindingFn(record) → null (pass) | errorString (fail). Pass null to skip binding check.
// Returns { ok:true, record } on success, or { ok:false, error:string } on failure.
function otpVerify_(action, userId, providedOtp, ttlSeconds, bindingFn) {
  var rateKey = RATE_OTP_VERIFY_PREFIX + String(action) + '_' + String(userId);
  var rl = checkRateLimit_(rateKey, 5, 600);
  if (rl.blocked) {
    return { ok:false, error:'ล็อกชั่วคราว กรุณารอ ' + rl.waitSeconds + ' วินาทีแล้วลองใหม่' };
  }
  var record = otpLoad_(action, userId);
  if (!record) return { ok:false, error:'ไม่พบรหัส OTP กรุณาขอรหัสใหม่' };
  if (Date.now() > Number(record.expires || 0)) {
    otpConsume_(action, userId);
    return { ok:false, error:'รหัส OTP หมดอายุแล้ว กรุณาขอรหัสใหม่' };
  }
  if ((record.attempts || 0) >= 5) {
    otpConsume_(action, userId);
    return { ok:false, error:'พยายามเกินกำหนด รหัส OTP ถูกยกเลิก กรุณาขอรหัสใหม่' };
  }
  if (String(providedOtp).trim() !== String(record.otp)) {
    recordFailedAttempt_(rateKey, 5, 600);
    record = otpFail_(action, userId, record);
    if ((record.attempts || 0) >= 5) otpConsume_(action, userId);
    return { ok:false, error:'รหัส OTP ไม่ถูกต้อง (' + Math.max(0, 5 - record.attempts) + ' ครั้งที่เหลือ)' };
  }
  // Binding check (optional) — treated like wrong OTP to avoid information leakage
  if (typeof bindingFn === 'function') {
    var bindErr = bindingFn(record);
    if (bindErr) {
      recordFailedAttempt_(rateKey, 5, 600);
      record = otpFail_(action, userId, record);
      if ((record.attempts || 0) >= 5) otpConsume_(action, userId);
      return { ok:false, error: bindErr };
    }
  }
  clearRateLimit_(rateKey);
  otpConsume_(action, userId);
  return { ok:true, record:record };
}

/* ---------- File upload validation helpers ---------- */

// Inspects the first bytes of a decoded image to detect its true MIME type.
// bytes = Java byte array (values are signed; use & 0xff for unsigned comparisons).
function detectMimeFromMagicBytes_(bytes) {
  if (!bytes || bytes.length < 4) return null;
  var b = function(i){ return bytes[i] & 0xff; };
  if (b(0)===0xFF && b(1)===0xD8 && b(2)===0xFF) return 'image/jpeg';
  if (b(0)===0x89 && b(1)===0x50 && b(2)===0x4E && b(3)===0x47) return 'image/png';
  if (b(0)===0x47 && b(1)===0x49 && b(2)===0x46) return 'image/gif';
  // WebP: RIFF????WEBP
  if (bytes.length >= 12 &&
      b(0)===0x52 && b(1)===0x49 && b(2)===0x46 && b(3)===0x46 &&
      b(8)===0x57 && b(9)===0x45 && b(10)===0x42 && b(11)===0x50) return 'image/webp';
  return null;
}

// Validates a base64 image payload: size, magic bytes, and allowed MIME types.
// opts: { maxBytes, allowGif, allowedMimes? }
// Returns { ok:true, bytes, detectedMime, cleanBase64 } or { ok:false, error }.
function validateImageUpload_(base64, opts) {
  var o       = opts || {};
  var maxBytes = o.maxBytes || (5 * 1024 * 1024);
  var allowGif = !!o.allowGif;
  var cleanBase64 = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanBase64) return { ok:false, error:'ไม่มีข้อมูลไฟล์' };
  var byteEst = Math.round(cleanBase64.length * 0.75);
  if (byteEst > maxBytes) {
    return { ok:false, error:'ไฟล์ใหญ่เกิน (' + Math.round(byteEst/1024) + ' KB) สูงสุด ' + Math.round(maxBytes/1024) + ' KB' };
  }
  // Decode only the first 24 base64 chars (~18 bytes) — enough for all magic patterns.
  var header;
  try { header = Utilities.base64Decode(cleanBase64.slice(0, 24)); }
  catch(_) { return { ok:false, error:'ไม่สามารถอ่านไฟล์ได้' }; }
  var detectedMime = detectMimeFromMagicBytes_(header);
  if (!detectedMime) {
    return { ok:false, error:'ไม่รองรับรูปแบบไฟล์นี้ (รองรับเฉพาะ JPEG, PNG, WebP' + (allowGif ? ', GIF' : '') + ')' };
  }
  var allowed = (o.allowedMimes || ['image/jpeg','image/png','image/webp']).slice();
  if (allowGif && allowed.indexOf('image/gif') < 0) allowed.push('image/gif');
  if (allowed.indexOf(detectedMime) < 0) {
    return { ok:false, error:'ไม่อนุญาตรูปแบบไฟล์นี้: ' + detectedMime };
  }
  return { ok:true, bytes:byteEst, detectedMime:detectedMime, cleanBase64:cleanBase64 };
}

// Strips dangerous characters from a filename and limits its length.
function sanitizeFilename_(name) {
  var s = String(name || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_');
  // Collapse double extensions (e.g. "shell.php.jpg" → "shell_php.jpg")
  s = s.replace(/(\.[a-zA-Z0-9]{1,8})\.[a-zA-Z0-9]{1,8}$/, function(_, last){ return '_' + last.slice(1) + last; });
  s = s.replace(/[^a-zA-Z0-9._\-]/g, '_');
  return s.slice(0, 100) || ('file-' + Date.now());
}

// Validates then uploads an image. Uses detectedMime (not caller-supplied contentType).
// Throws an Error with a Thai message on validation failure.
function uploadValidatedImage_(base64, filename, contentType, folderId, makePublic, opts) {
  var v = validateImageUpload_(base64, opts);
  if (!v.ok) throw new Error(v.error);
  var safeName = sanitizeFilename_(filename || ('img-' + Date.now() + '.bin'));
  return uploadImageFromBase64_(v.cleanBase64, safeName, v.detectedMime, folderId, makePublic);
}

/* ---------- Order token validation helper ---------- */

// Validates an order token and returns the associated row/record.
// opts: { scope, maxRate?, rateWindow? }
// Scopes: 'read_full', 'read_status', 'upload_slip', 'read_slip', 'tracking'
// Returns { ok:true, sh, rowNo, row, record, tokenStr }
//      or { ok:false, error:string, code:string }
function validateOrderToken_(rawToken, opts) {
  var o     = opts || {};
  var scope = String(o.scope || 'read_full');
  var scopePrefixMap = { read_full:'RF', read_status:'RS', upload_slip:'US', read_slip:'SL', tracking:'TR', read_gifts:'RG' };
  var pfx     = scopePrefixMap[scope] || 'XX';
  var maxRate = o.maxRate  || (scope === 'upload_slip' ? 10 : 20);
  var rateWin = o.rateWindow || 60;
  var tokenStr = String(rawToken || '');
  if (!tokenStr) return { ok:false, error:'invalid token', code:'INVALID_TOKEN' };

  var rateKey = RATE_ORDTOK_PREFIX + pfx + '_' + tokenStr.slice(0, 16);
  var rl = checkRateLimit_(rateKey, maxRate, rateWin);
  if (rl.blocked) return { ok:false, error:'คำขอมากเกินไป กรุณารอสักครู่', code:'RATE_LIMITED' };

  var sh = sheetOrders_();
  var n  = sh.getLastRow();
  if (n < 2) { recordFailedAttempt_(rateKey, maxRate, rateWin); return { ok:false, error:'ไม่พบคำสั่งซื้อ', code:'NOT_FOUND' }; }
  var tokenColIdx = ORDER_COLS.indexOf('token') + 1;
  if (sh.getLastColumn() < tokenColIdx) { recordFailedAttempt_(rateKey, maxRate, rateWin); return { ok:false, error:'ไม่พบคำสั่งซื้อ', code:'NOT_FOUND' }; }
  var tokens = sh.getRange(2, tokenColIdx, n - 1, 1).getValues()
                 .map(function(r){ return String(r[0] || ''); });
  var idx = -1;
  for (var tiEnc = 0; tiEnc < tokens.length; tiEnc++) {
    var storedToken = decryptOrderTokenCell_(tokens[tiEnc]);
    if (storedToken === tokenStr) {
      idx = tiEnc;
      break;
    }
  }
  // Only count failed lookups toward rate limit (brute-force protection, not legitimate reads)
  if (idx < 0) { recordFailedAttempt_(rateKey, maxRate, rateWin); return { ok:false, error:'ไม่พบคำสั่งซื้อ', code:'NOT_FOUND' }; }

  var rowNo   = idx + 2;
  var numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
  var row     = sh.getRange(rowNo, 1, 1, numCols).getValues()[0];
  while (row.length < ORDER_COLS.length) row.push('');
  var record = rowToOrder_(row);

  // Expiry check — enforced for all scopes
  if (record.token_expires_at && Date.now() > new Date(record.token_expires_at).getTime()) {
    return { ok:false, error:'ลิงก์หมดอายุแล้ว กรุณาติดต่อร้านค้า', code:'TOKEN_EXPIRED' };
  }

  // Revoked check — reserved for future use; column doesn't exist yet, fallback false
  // var revoked = !!record.revoked;
  // if (revoked) return { ok:false, error:'ลิงก์ถูกยกเลิกแล้ว', code:'TOKEN_REVOKED' };

  // Scope-specific status gate
  var status = String(record.status || '');
  if (scope === 'upload_slip') {
    // Allowlist: customer can upload a slip only while the order is awaiting payment
    // or has an unapproved slip. Block approved/shipped/delivered/cancelled and any
    // unknown status so a leaked token cannot move a downstream order back to 'paid'.
    if (status !== 'unpaid' && status !== 'paid') {
      return { ok:false, error:'ไม่สามารถอัปโหลดสลิปได้ เนื่องจากคำสั่งซื้อนี้ถูกดำเนินการแล้ว', code:'STATUS_LOCKED' };
    }
  } else if (scope === 'read_slip') {
    if (status !== 'paid') return { ok:false, error:'ไม่อนุญาต', code:'WRONG_STATUS' };
  }

  return { ok:true, sh:sh, rowNo:rowNo, row:row, record:record, tokenStr:tokenStr };
}

/* ---------- Rate limiting via CacheService ---------- */
function checkRateLimit_(key, maxAttempts, lockSeconds) {
  var raw = CacheService.getScriptCache().get(key);
  var data = raw ? (function(){ try{return JSON.parse(raw);}catch(_){return{count:0,lockUntil:0};} })() : {count:0,lockUntil:0};
  if (data.lockUntil && Date.now() < data.lockUntil) {
    return { blocked:true, waitSeconds: Math.ceil((data.lockUntil - Date.now()) / 1000) };
  }
  return { blocked:false, count: data.count || 0 };
}
function recordFailedAttempt_(key, maxAttempts, lockSeconds) {
  var raw = CacheService.getScriptCache().get(key);
  var data = raw ? (function(){ try{return JSON.parse(raw);}catch(_){return{count:0,lockUntil:0};} })() : {count:0,lockUntil:0};
  data.count = (data.count || 0) + 1;
  if (data.count >= maxAttempts) { data.lockUntil = Date.now() + lockSeconds * 1000; data.count = 0; }
  CacheService.getScriptCache().put(key, JSON.stringify(data), 3600);
}
function clearRateLimit_(key) { CacheService.getScriptCache().remove(key); }

/* ---------- Field-level encryption (PDPA) — HMAC-CTR stream cipher ---------- */
// The encryption key never changes within a single script execution, so read
// it from Script Properties at most once per request and memoize it. A bulk
// order read decrypts ~8 fields/row — without this each one hit ScriptProperties.
var _ENC_KEY_CACHE_ = undefined;
function getEncryptKey_() {
  if (_ENC_KEY_CACHE_ === undefined) {
    try { _ENC_KEY_CACHE_ = SP.getProperty('DATA_ENCRYPT_KEY') || ''; }
    catch(_) { _ENC_KEY_CACHE_ = ''; }
  }
  return _ENC_KEY_CACHE_;
}
// Invalidate the memoized key — call after a key rotation writes a new value.
function _invalidateEncryptKeyCache_() { _ENC_KEY_CACHE_ = undefined; }

// Authentication tag: HMAC-SHA256 over the ciphertext payload (iv + ':' + encHex),
// truncated to 128 bits (32 hex chars). Lets decrypt detect tampering / a swapped
// or corrupted ciphertext instead of silently returning garbage.
function _encFieldMac_(iv, encHex, keyBytes) {
  var sig = Utilities.computeHmacSha256Signature(
    Utilities.newBlob('mac:' + iv + ':' + encHex).getBytes(), keyBytes);
  var hex = '';
  for (var i = 0; i < sig.length && hex.length < 32; i++) {
    hex += ('0' + (sig[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

function encryptField_(plaintext) {
  if (!plaintext) return plaintext;
  var key = getEncryptKey_();
  if (!key) return plaintext;
  var bytes = Utilities.newBlob(String(plaintext), 'UTF-8').getBytes();
  var iv = uuid_().replace(/-/g,'').slice(0, 16);
  var keyBytes = Utilities.newBlob(key).getBytes();
  var block = null, encrypted = [];
  for (var i = 0; i < bytes.length; i++) {
    var blockIdx = Math.floor(i / 32), offset = i % 32;
    if (offset === 0) block = Utilities.computeHmacSha256Signature(Utilities.newBlob(iv + blockIdx).getBytes(), keyBytes);
    encrypted.push((bytes[i] ^ block[offset]) & 0xff);
  }
  var encHex = encrypted.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
  // Format v2: enc:<iv>:<encHex>:<mac>. v1 (enc:<iv>:<encHex>, no mac) still decrypts.
  return 'enc:' + iv + ':' + encHex + ':' + _encFieldMac_(iv, encHex, keyBytes);
}
function decryptField_(value) {
  if (!value || String(value).indexOf('enc:') !== 0) return value;
  var key = getEncryptKey_();
  if (!key) return value;
  var parts = String(value).split(':');
  if (parts.length < 3) return value;
  var iv = parts[1], encHex = parts[2];
  var keyBytes = Utilities.newBlob(key).getBytes();
  // Verify the authentication tag when present (format v2). A mismatch means the
  // ciphertext was tampered with, swapped between rows, or corrupted — surface it
  // rather than returning silently-wrong plaintext.
  if (parts.length >= 4 && parts[3]) {
    var expectedMac = _encFieldMac_(iv, encHex, keyBytes);
    if (parts[3] !== expectedMac) {
      try { Logger.log('decryptField_ MAC verification FAILED — ciphertext tampered or corrupted'); } catch(_) {}
      return value;
    }
  }
  var encrypted = [];
  for (var i = 0; i < encHex.length; i += 2) encrypted.push(parseInt(encHex.slice(i, i+2), 16));
  var block = null, decrypted = [];
  for (var i = 0; i < encrypted.length; i++) {
    var blockIdx = Math.floor(i / 32), offset = i % 32;
    if (offset === 0) block = Utilities.computeHmacSha256Signature(Utilities.newBlob(iv + blockIdx).getBytes(), keyBytes);
    decrypted.push((encrypted[i] ^ block[offset]) & 0xff);
  }
  try { return Utilities.newBlob(decrypted).getDataAsString('UTF-8'); } catch(_) { return value; }
}

/* ========== INPUT VALIDATION HELPERS ========== */

/* ---------- Field-length constants ---------- */
var VLEN = {
  SHORT:  200,   // name, badge, label, variant group name, carrier name
  MEDIUM: 2000,  // product description
  LONG:   1000,  // notes, history note
  URL:    2048,
  EMAIL:  254,
  PHONE:  20,
  POSTAL: 10,
  ENUM:   100,
  KEY:    100    // store key, carrier_id, Drive ID pattern
};

/* ---------- stripControlChars_(value) ----------
 * Removes U+0000–U+0008, U+000B–U+000C, U+000E–U+001F, U+007F, U+0080–U+009F.
 * Keeps \t (U+0009) and \n (U+000A) — callers decide whether to strip those.
 */
function stripControlChars_(value) {
  return String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}

/* ---------- rejectHtmlTags_(value, fieldName) ----------
 * Returns Thai error string if value contains HTML-like tags; null if clean.
 */
function rejectHtmlTags_(value, fieldName) {
  if (/<[a-zA-Z\/!][^>]*>/.test(String(value))) {
    return (fieldName || 'ฟิลด์') + ': ไม่อนุญาตให้ใช้ HTML tags';
  }
  return null;
}

/* ---------- assertMaxLength_(value, limit, fieldName) ----------
 * Returns Thai error string if value exceeds limit chars; null if within limit.
 */
function assertMaxLength_(value, limit, fieldName) {
  var s = String(value);
  if (s.length > limit) {
    return (fieldName || 'ฟิลด์') + ': ยาวเกิน ' + limit + ' ตัวอักษร (ปัจจุบัน ' + s.length + ')';
  }
  return null;
}

/* ---------- sanitizeSheetCell_(value) ----------
 * Formula-injection prevention for STRING columns only.
 * If value starts with =, +, -, @, tab, or newline → prefix with ' (apostrophe).
 * The apostrophe is the standard Google Sheets "force literal text" trick.
 * Encrypted values (enc: prefix) are returned unchanged.
 * NEVER call this for number, boolean, or JSON columns.
 */
function sanitizeSheetCell_(value) {
  var s = String(value);
  if (s.indexOf('enc:') === 0) return s;
  if (/^[=+\-@\t\n]/.test(s)) return "'" + s;
  return s;
}

/* ---------- normalizePlainText_(value, opts) ----------
 * Single-line plain text: trim → strip ALL control chars (incl \n) → reject HTML → length.
 * opts: { maxLen, fieldName, allowEmpty }
 */
function normalizePlainText_(value, opts) {
  var o = opts || {};
  var maxLen     = o.maxLen    || VLEN.SHORT;
  var fieldName  = o.fieldName || 'ฟิลด์';
  var allowEmpty = !!o.allowEmpty;

  var s = String(value == null ? '' : value).trim();
  s = s.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');
  s = s.trim();

  if (!s && !allowEmpty) return { ok:false, error: fieldName + ': ห้ามว่าง' };

  var htmlErr = rejectHtmlTags_(s, fieldName);
  if (htmlErr) return { ok:false, error: htmlErr };

  var lenErr = assertMaxLength_(s, maxLen, fieldName);
  if (lenErr) return { ok:false, error: lenErr };

  return { ok:true, value: s };
}

/* ---------- normalizeMultilineText_(value, opts) ----------
 * Multi-line plain text: strips control chars but preserves \n; normalises \r\n → \n.
 * opts: same as normalizePlainText_
 */
function normalizeMultilineText_(value, opts) {
  var o = opts || {};
  var maxLen     = o.maxLen    || VLEN.MEDIUM;
  var fieldName  = o.fieldName || 'ฟิลด์';
  var allowEmpty = !!o.allowEmpty;

  var s = String(value == null ? '' : value);
  s = stripControlChars_(s);        // strips everything except \t and \n
  s = s.replace(/\r/g, '');         // strip \r; \n already kept
  s = s.trim();

  if (!s && !allowEmpty) return { ok:false, error: fieldName + ': ห้ามว่าง' };

  var htmlErr = rejectHtmlTags_(s, fieldName);
  if (htmlErr) return { ok:false, error: htmlErr };

  var lenErr = assertMaxLength_(s, maxLen, fieldName);
  if (lenErr) return { ok:false, error: lenErr };

  return { ok:true, value: s };
}

/* ---------- validateEmailStrict_(value) ---------- */
function validateEmailStrict_(value) {
  var s = String(value || '').trim().toLowerCase();
  return /^[a-zA-Z0-9]([a-zA-Z0-9._%+\-]*[a-zA-Z0-9])?@[a-zA-Z0-9][a-zA-Z0-9\-]*(\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,63}$/.test(s)
      && s.indexOf('..') < 0;
}

/* ---------- normalizeEmail_(value) ---------- */
function normalizeEmail_(value) {
  var s = String(value == null ? '' : value).trim().toLowerCase();
  s = s.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');
  if (!s) return { ok:false, error: 'อีเมล: ห้ามว่าง' };
  var lenErr = assertMaxLength_(s, VLEN.EMAIL, 'อีเมล');
  if (lenErr) return { ok:false, error: lenErr };
  if (!validateEmailStrict_(s)) return { ok:false, error: 'อีเมลไม่ถูกต้อง' };
  return { ok:true, value: s };
}

/* ---------- normalizeUrl_(value, opts) ----------
 * Only http:// and https:// allowed. Empty string → ok (optional field).
 * opts: { allowTemplate:bool, fieldName:string }
 *   allowTemplate: if true, {T} placeholder is permitted (tracking URL templates)
 */
function normalizeUrl_(value, opts) {
  var o = opts || {};
  var allowTemplate = !!o.allowTemplate;
  var fieldName     = o.fieldName || 'URL';
  var s = String(value == null ? '' : value).trim();
  if (!s) return { ok:true, value: '' };

  s = s.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');

  var lenErr = assertMaxLength_(s, VLEN.URL, fieldName);
  if (lenErr) return { ok:false, error: lenErr };

  if (!/^https?:\/\//i.test(s)) {
    return { ok:false, error: fieldName + ': ต้องขึ้นต้นด้วย http:// หรือ https://' };
  }
  if (/[\r\n]/.test(s) || /%0[aAdD]/.test(s)) {
    return { ok:false, error: fieldName + ': มีอักขระต้องห้าม' };
  }
  if (!allowTemplate && /[{}]/.test(s)) {
    return { ok:false, error: fieldName + ': มีวงเล็บปีกกาที่ไม่อนุญาต' };
  }
  return { ok:true, value: s };
}

/* ---------- normalizePhone_(value) ---------- */
function normalizePhone_(value) {
  var s = String(value == null ? '' : value).trim();
  s = s.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');
  var hasPlus = s.charAt(0) === '+';
  s = s.replace(/[^0-9]/g, '');
  if (hasPlus) s = '+' + s;
  if (!s) return { ok:false, error: 'เบอร์โทรศัพท์: ห้ามว่าง' };
  var lenErr = assertMaxLength_(s, VLEN.PHONE, 'เบอร์โทรศัพท์');
  if (lenErr) return { ok:false, error: lenErr };
  var digits = s.replace(/^\+/, '');
  if (digits.length < 7) return { ok:false, error: 'เบอร์โทรศัพท์: สั้นเกินไป' };
  return { ok:true, value: s };
}

/* ---------- normalizePostalCode_(value) ---------- */
function normalizePostalCode_(value) {
  var s = String(value == null ? '' : value).trim().replace(/[^0-9]/g, '');
  if (!s) return { ok:false, error: 'รหัสไปรษณีย์: ห้ามว่าง' };
  if (!/^\d{5}$/.test(s)) return { ok:false, error: 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก' };
  return { ok:true, value: s };
}

/* ---------- normalizeEnum_(value, allowed, fieldName) ---------- */
function normalizeEnum_(value, allowed, fieldName) {
  var s = String(value == null ? '' : value).trim();
  s = s.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');
  var name = fieldName || 'ฟิลด์';
  var lenErr = assertMaxLength_(s, VLEN.ENUM, name);
  if (lenErr) return { ok:false, error: lenErr };
  if (allowed.indexOf(s) < 0) {
    return { ok:false, error: name + ': ค่า "' + s + '" ไม่ถูกต้อง (อนุญาต: ' + allowed.join(', ') + ')' };
  }
  return { ok:true, value: s };
}

/* ---------- Variant validation and derived pricing ---------- */
function deriveVariantProductPrice_(variants, basePrice) {
  if (!Array.isArray(variants) || !variants.length) return null;
  var rootPrice = Number(basePrice || 0);
  var effectiveMin = isFinite(rootPrice) ? rootPrice : 0;

  // Pricing throughout checkout/promotions is last-group-wins. An absolute
  // option price replaces the prior group price; legacy delta prices are based
  // on the product root price. Tracking the minimum per group yields the minimum
  // purchasable combination without building a potentially huge cartesian set.
  for (var gi=0; gi<variants.length; gi++) {
    var options = variants[gi] && Array.isArray(variants[gi].options) ? variants[gi].options : [];
    if (!options.length) return null;
    var groupMin = Infinity;
    for (var oi=0; oi<options.length; oi++) {
      var opt = options[oi] || {};
      var price;
      if (opt.price !== undefined && opt.price !== null && String(opt.price).trim() !== '') {
        price = Number(opt.price);
      } else if (opt.delta !== undefined && opt.delta !== null && String(opt.delta).trim() !== '') {
        price = rootPrice + Number(opt.delta);
      } else {
        price = effectiveMin;
      }
      if (!isFinite(price) || price <= 0) return null;
      if (price < groupMin) groupMin = price;
    }
    effectiveMin = groupMin;
  }
  return isFinite(effectiveMin) && effectiveMin > 0 ? effectiveMin : null;
}

function sanitizeVariantGroups_(groups) {
  if (!Array.isArray(groups)) return { ok:false, error:'variants ต้องเป็น array' };
  var cleanGroups = [];
  var seenGroupNames = {};
  for (var i=0; i<groups.length; i++) {
    var groupR = sanitizeVariantGroup_(groups[i]);
    if (!groupR.ok) return groupR;
    var groupKey = '$' + String(groupR.value.name).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(seenGroupNames, groupKey)) {
      return { ok:false, error:'ชื่อกลุ่ม variant "' + groupR.value.name + '" ซ้ำกัน' };
    }
    seenGroupNames[groupKey] = true;
    cleanGroups.push(groupR.value);
  }
  return { ok:true, value:cleanGroups };
}

function sanitizeVariantGroup_(g) {
  if (!g || typeof g !== 'object') return { ok:false, error: 'variant group ไม่ถูกต้อง' };

  var nameR = normalizePlainText_(g.name, { maxLen:VLEN.SHORT, fieldName:'variant.name' });
  if (!nameR.ok) return nameR;

  var typeR = normalizeEnum_(g.type || 'text', ['color','image','text'], 'variant.type');
  if (!typeR.ok) return typeR;

  if (!Array.isArray(g.options) || g.options.length === 0) {
    return { ok:false, error: 'variant "' + nameR.value + '": ต้องมี options อย่างน้อย 1 รายการ' };
  }
  if (g.options.length > 100) {
    return { ok:false, error: 'variant "' + nameR.value + '": options เกิน 100 รายการ' };
  }

  var cleanOptions = [];
  var seenOptionLabels = {};
  for (var i = 0; i < g.options.length; i++) {
    var opt = g.options[i];
    if (!opt || typeof opt !== 'object') return { ok:false, error: 'variant option ที่ ' + i + ': ไม่ถูกต้อง' };
    var labelR = normalizePlainText_(opt.label, { maxLen:VLEN.SHORT, fieldName:'variant.option.label' });
    if (!labelR.ok) return labelR;
    var optionKey = '$' + String(labelR.value).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(seenOptionLabels, optionKey)) {
      return { ok:false, error:'variant "' + nameR.value + '": ชื่อตัวเลือก "' + labelR.value + '" ซ้ำกัน' };
    }
    seenOptionLabels[optionKey] = true;
    if (opt.price === undefined || opt.price === null || String(opt.price).trim() === '') {
      return { ok:false, error: 'variant "' + nameR.value + '" ตัวเลือกที่ ' + (i + 1) + ': กรุณาระบุราคา' };
    }
    var optionPrice = Number(opt.price);
    if (!isFinite(optionPrice) || optionPrice <= 0) {
      return { ok:false, error: 'variant "' + nameR.value + '" ตัวเลือกที่ ' + (i + 1) + ': ราคาต้องมากกว่า 0' };
    }
    var optionStock = opt.stock !== undefined ? _normStockValue_(opt.stock) : -1;
    if (optionStock === null) {
      return { ok:false, error: 'variant "' + nameR.value + '" ตัวเลือกที่ ' + (i + 1) + ': สต็อกต้องเป็นจำนวนเต็ม ≥ 0 หรือเว้นว่าง' };
    }
    var cleanOpt = {
      label:        labelR.value,
      price:        optionPrice,
      weight_grams: Number(opt.weight_grams || 0),
      stock:        optionStock
    };
    // Image fields validated downstream by uploadValidatedImage_ — pass through
    if (opt.image_file_id)     cleanOpt.image_file_id     = opt.image_file_id;
    if (opt.image)             cleanOpt.image             = opt.image;
    if (opt.imageUpload)       cleanOpt.imageUpload       = opt.imageUpload;
    if (opt.old_image_file_id) cleanOpt.old_image_file_id = opt.old_image_file_id;
    cleanOptions.push(cleanOpt);
  }

  return { ok:true, value: { name:nameR.value, type:typeR.value, options:cleanOptions } };
}

/* ---------- sanitizeShippingCompany_(c) ----------
 * Schema validation for a shipping company record.
 */
function sanitizeShippingCompany_(c) {
  if (!c || typeof c !== 'object') return { ok:false, error: 'shipping company ไม่ถูกต้อง' };

  var nameR = normalizePlainText_(c.name, { maxLen:VLEN.SHORT, fieldName:'shipping.name' });
  if (!nameR.ok) return nameR;

  var carrierId = String(c.carrier_id || 'other').trim();
  if (!/^[a-zA-Z0-9_\-]{1,50}$/.test(carrierId)) {
    return { ok:false, error: 'shipping.carrier_id: ต้องเป็น alphanumeric/dash/underscore สูงสุด 50 ตัว' };
  }

  var urlR = normalizeUrl_(c.tracking_url_template || '', { allowTemplate:true, fieldName:'shipping.tracking_url_template' });
  if (!urlR.ok) return urlR;

  var providerStr = String(c.tracking_provider != null ? c.tracking_provider : '');
  var TRACKING_PROVIDERS = ['aftership','thaipost','etracking',''];
  if (TRACKING_PROVIDERS.indexOf(providerStr) < 0) {
    return { ok:false, error: 'shipping.tracking_provider: ค่า "' + providerStr + '" ไม่ถูกต้อง (อนุญาต: aftership, thaipost, etracking, หรือ ว่าง)' };
  }

  if (!Array.isArray(c.methods)) {
    return { ok:false, error: 'shipping "' + nameR.value + '": methods ต้องเป็น array' };
  }

  var cleanMethods = [];
  for (var i = 0; i < c.methods.length; i++) {
    var m = c.methods[i];
    if (!m || typeof m !== 'object') return { ok:false, error: 'shipping method ที่ ' + i + ': ไม่ถูกต้อง' };
    var mNameR = normalizePlainText_(m.name, { maxLen:VLEN.SHORT, fieldName:'shipping.method.name' });
    if (!mNameR.ok) return mNameR;
    var modeR = normalizeEnum_(m.mode || 'flat', ['flat','weight'], 'shipping.method.mode');
    if (!modeR.ok) return modeR;
    var cleanMethod = {
      id:     m.id || uuid_(),
      name:   mNameR.value,
      active: m.active !== false,
      mode:   modeR.value
    };
    if (m.flat_rate  !== undefined) cleanMethod.flat_rate  = Number(m.flat_rate);
    if (Array.isArray(m.brackets)) cleanMethod.brackets    = m.brackets;
    cleanMethods.push(cleanMethod);
  }

  return {
    ok: true,
    value: {
      id:                    c.id || uuid_(),
      name:                  nameR.value,
      active:                c.active !== false,
      methods:               cleanMethods,
      carrier_id:            carrierId,
      tracking_url_template: urlR.value,
      tracking_provider:     providerStr
    }
  };
}

/* ---------- sanitizeOrderStatusEntry_(entry) ---------- */
function sanitizeOrderStatusEntry_(entry) {
  var ORDER_STATUSES = ['unpaid','paid','approved','shipped','delivered','cancelled','rejected'];
  var statusR = normalizeEnum_(entry.status, ORDER_STATUSES, 'status');
  if (!statusR.ok) return statusR;
  var note = '';
  if (entry.note) {
    var noteR = normalizeMultilineText_(entry.note, { maxLen:VLEN.LONG, fieldName:'note', allowEmpty:true });
    if (!noteR.ok) return noteR;
    note = noteR.value;
  }
  return { ok:true, value:{ status:statusR.value, note:note, timestamp: entry.timestamp || nowISO_() } };
}

/* ========== END INPUT VALIDATION HELPERS ========== */

/* ---------- Session helpers ---------- */
function createSession_(userId, email, role, clientCtx) {
  var sessionKey = (uuid_()+uuid_()).replace(/-/g,''); // 64-hex
  var expiresAt  = new Date(Date.now() + SESS_TTL * 1000).toISOString();
  setUserSessionKey_(userId, sessionKey, expiresAt);
  var rec = { email:email, role:role, sessionKey:sessionKey, expiresAt:expiresAt };
  // Trimmed client context (login-time IP/UA/timezone) for admin audit logs —
  // ephemeral in cache only, never written to the users sheet.
  var lc = sessionLogCtx_(clientCtx);
  if (lc) rec.logCtx = lc;
  CacheService.getScriptCache().put(
    SESS_PREFIX + userId,
    JSON.stringify(rec),
    SESS_TTL
  );
  return userId + '.' + sessionKey;
}
function getSession_(token) {
  if (!token) return null;
  var dot = token.indexOf('.');
  if (dot < 0) return null;
  var userId     = token.slice(0, dot);
  var sessionKey = token.slice(dot + 1);
  if (!userId || !sessionKey) return null;

  // Fast path: cache
  var raw = CacheService.getScriptCache().get(SESS_PREFIX + userId);
  if (raw) {
    try {
      var c = JSON.parse(raw);
      if (c.sessionKey !== sessionKey) return null; // stale/replaced
      if (c.expiresAt && Date.now() > new Date(c.expiresAt).getTime()) return null; // expired
      return { userId:userId, email:c.email, role:c.role, logCtx:c.logCtx||null };
    } catch(_) {}
  }

  // Slow path: DB (column 9 stores HMAC hash of session key, not plaintext)
  var user = getUserById_(userId);
  if (!user || !user.session_key) return null;
  var expectedHash = hashSessionKey_(sessionKey);
  if (user.session_key !== expectedHash) return null;
  if (user.session_expires_at && Date.now() > new Date(user.session_expires_at).getTime()) return null; // expired in DB
  CacheService.getScriptCache().put(
    SESS_PREFIX + userId,
    JSON.stringify({ email:user.email, role:user.role, sessionKey:sessionKey, expiresAt:user.session_expires_at }),
    SESS_TTL
  );
  // Slow-path rebuild from the users sheet — the sheet never stores logCtx, so
  // admin logs fall back to null client context until the admin re-logs in.
  return { userId:userId, email:user.email, role:user.role, logCtx:null };
}
function requireAdmin_(token) {
  var sess = getSession_(token);
  return (sess && sess.role === 'admin') ? sess : null;
}

/* ---------- Owner helpers ---------- */
function getOwnerEmail_() {
  try { return Session.getEffectiveUser().getEmail().toLowerCase(); } catch(_) { return ''; }
}
function isOwner_(token) {
  var sess = getSession_(token);
  if (!sess) return false;
  var ownerEmail = getOwnerEmail_();
  return !!(ownerEmail && String(sess.email).toLowerCase() === ownerEmail);
}
function requireOwner_(token) {
  var sess = getSession_(token);
  if (!sess) return null;
  var ownerEmail = getOwnerEmail_();
  if (!ownerEmail || String(sess.email).toLowerCase() !== ownerEmail) return null;
  return sess;
}

/* ---------- Default admin bootstrap ---------- */
function getUserByEmail_(email) {
  var sh = sheetUsers_();
  var n = sh.getLastRow();
  if (n < 2) return null;
  var rows = sh.getRange(2,1,n-1,Math.max(sh.getLastColumn(), 1)).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][1]).toLowerCase() === String(email).toLowerCase()) {
      return { id:String(rows[i][0]), email:String(rows[i][1]),
               password_hash:String(rows[i][2]), salt:String(rows[i][3]),
               role:String(rows[i][4]||'admin'),
               otp_required:(rows[i][5]===true||rows[i][5]==='true'),
               session_key:String(rows[i][8]||''),
               session_expires_at:String(rows[i][9]||''),
               _rowNo: i+2 };
    }
  }
  return null;
}
function getUserById_(id) {
  var sh = sheetUsers_();
  var n = sh.getLastRow();
  if (n < 2) return null;
  var rows = sh.getRange(2,1,n-1,Math.max(sh.getLastColumn(), 1)).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      return { id:String(rows[i][0]), email:String(rows[i][1]),
               role:String(rows[i][4]||'admin'),
               otp_required:(rows[i][5]===true||rows[i][5]==='true'),
               session_key:String(rows[i][8]||''),
               session_expires_at:String(rows[i][9]||''),
               _rowNo: i+2 };
    }
  }
  return null;
}
function setUserSessionKey_(userId, sessionKey, expiresAt) {
  var user = getUserById_(userId);
  if (!user) return false;
  var sh = sheetUsers_();
  var hashToStore = sessionKey ? hashSessionKey_(sessionKey) : '';
  sh.getRange(user._rowNo, 9).setValue(hashToStore);
  sh.getRange(user._rowNo, 10).setValue(expiresAt || '');
  return true;
}
/* ---------- First-time admin setup (replaces default-password bootstrap) ---------- */
function checkSetupNeededRpc() {
  var sh = sheetUsers_();
  var needed = sh.getLastRow() < 2;
  if (!needed) return { ok:true, needed: false };
  return { ok:true, needed: true, ownerEmail: getOwnerEmail_() };
}
function setupFirstAdminRpc(email, password) {
  var sh = sheetUsers_();
  if (sh.getLastRow() >= 2) return { ok:false, error:'ระบบมีผู้ดูแลระบบอยู่แล้ว' };
  var ownerEmail = getOwnerEmail_();
  if (!ownerEmail) return { ok:false, error:'ไม่สามารถระบุอีเมลเจ้าของ Script ได้' };
  email = String(email||'').trim().toLowerCase();
  if (email !== ownerEmail) return { ok:false, error:'อีเมลต้องตรงกับเจ้าของ Script เท่านั้น' };
  if (!password || String(password).length < 8) return { ok:false, error:'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' };
  var salt = genSalt_();
  var hash = hashPasswordV2_(String(password), salt);
  sh.appendRow([uuid_(), email, hash, salt, 'admin', false, nowISO_(), nowISO_(), '', '']);
  // Note: logging is normally disabled at first-time setup, so this is usually
  // a no-op — added for completeness if an owner enables logging beforehand.
  auditLog_('admin.setup.first', { category:['iam'], type:['user','creation'],
    outcome:'success', level:'warning', route:'login', rpc:'setupFirstAdminRpc',
    meta:{ resource_type:'user', email_hash: hashForLog_(email, 'e_'), role:'admin' } }, null);
  return { ok:true };
}

function getStoreImagesRpc() {
  try {
    const sh = sheetStore_();
    const n = sh.getLastRow();
    if (n < 2) return { ok: true, images: {} };
    const rows = sh.getRange(2, 1, n - 1, 4).getValues();
    const images = {};
    rows.forEach(r => {
      const key = String(r[0] || '');
      if (key) images[key] = { drive_file_id: String(r[1] || ''), url: String(r[2] || '') };
    });
    return { ok: true, images };
  } catch (err) { return { ok: false, error: String(err) }; }
}

function saveStoreImageRpc(token, key, imageObj) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  assertConfig_();
  try {
    if (!key) return { ok: false, error: 'key required' };
    // --- INPUT VALIDATION ---
    var cleanKey = String(key).trim();
    if (!/^[a-zA-Z0-9_\-]{1,50}$/.test(cleanKey)) {
      return { ok:false, error:'key ไม่ถูกต้อง: ต้องเป็น alphanumeric/underscore/dash สูงสุด 50 ตัว' };
    }
    key = cleanKey;
    if (imageObj && imageObj.mode === 'url') {
      var suR = normalizeUrl_(imageObj.url||'', { fieldName:'imageObj.url' });
      if (!suR.ok) return { ok:false, error:suR.error };
      imageObj.url = suR.value;
    }
    // --- END VALIDATION ---
    const sh = sheetStore_();
    const n = sh.getLastRow();
    let rowNo = -1, oldDriveId = '';
    if (n >= 2) {
      const keys = sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0]));
      const i = keys.indexOf(String(key));
      if (i >= 0) { rowNo = 2 + i; oldDriveId = String(sh.getRange(rowNo, 2).getValue() || ''); }
    }
    let driveId = '', url = '';
    if (imageObj.mode === 'file') {
      var allowGif = String(key).startsWith('status_img_');
      try {
        driveId = uploadValidatedImage_(
          imageObj.base64,
          imageObj.filename || ('store-' + key + '-' + Date.now() + '.jpg'),
          imageObj.contentType || 'image/jpeg',
          getFolderIdCached_(FOLDER_STORE),
          true,
          { maxBytes: 5*1024*1024, allowGif: allowGif }
        );
      } catch(uploadErr) {
        return { ok: false, error: String(uploadErr) };
      }
      url = publicUrl_(driveId);
      if (oldDriveId && oldDriveId !== driveId) deleteDriveFileSafe_(oldDriveId);
    } else if (imageObj.mode === 'url') {
      url = String(imageObj.url || '');
      driveId = '';
      if (oldDriveId) deleteDriveFileSafe_(oldDriveId);
    } else {
      return { ok: false, error: 'mode must be "file" or "url"' };
    }
    const now = nowISO_();
    if (rowNo >= 2) {
      sh.getRange(rowNo, 1, 1, 4).setValues([[sanitizeSheetCell_(key), driveId, sanitizeSheetCell_(url), now]]);
    } else {
      sh.appendRow([sanitizeSheetCell_(key), driveId, sanitizeSheetCell_(url), now]);
    }
    auditLog_('store.image.update', { category:['database'], type:['change'],
      outcome:'success', route:'editstore', rpc:'saveStoreImageRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'store_image', store_key: safeLogString_(key, 50), mode: safeLogString_(imageObj && imageObj.mode, 10) } },
      _sess.logCtx);
    return { ok: true, drive_file_id: driveId, url };
  } catch (err) { return { ok: false, error: String(err) }; }
}

function deleteStoreImageRpc(token, fileId) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  return deleteStoreImagesRpc(token, [fileId]);
}

// รับ array ของ fileId — ลบทีเดียวใน call เดียวกัน ป้องกัน race condition
function deleteStoreImagesRpc(token, fileIds) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).filter(Boolean).map(String);
    if (!ids.length) return { ok: true };

    // ลบ Drive files ทั้งหมด
    ids.forEach(function(fid) { deleteDriveFileSafe_(fid); });

    // ลบ rows ในชีต store ที่อ้างถึง drive_file_id เหล่านี้ (อ่านครั้งเดียว ลบจากบนลงล่าง)
    const sh = sheetStore_();
    const n = sh.getLastRow();
    if (n >= 2) {
      const driveIds = sh.getRange(2, 2, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
      // รวบรวม row numbers ที่ต้องลบ แล้วลบจากล่างขึ้นบนเพื่อกัน index เลื่อน
      const toDelete = [];
      ids.forEach(function(fid) {
        const i = driveIds.indexOf(fid);
        if (i >= 0) toDelete.push(2 + i);
      });
      toDelete.sort(function(a, b) { return b - a; }); // ลบจากแถวล่างขึ้นบน
      toDelete.forEach(function(rowNo) { sh.deleteRow(rowNo); });
    }

    auditLog_('store.image.delete', { category:['database'], type:['deletion'],
      outcome:'success', route:'editstore', rpc:'deleteStoreImagesRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'store_image', count: ids.length } }, _sess.logCtx);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
}

/* ============================================================================
 * ACTIVITY LOG SYSTEM — best-effort traffic & activity logging
 * ----------------------------------------------------------------------------
 * Optional production logging mode. OFF by default — a fresh open-source install
 * logs nothing until the owner enables it (system.html or LOGGING_ENABLED prop).
 *
 * Pipeline: enqueueLog_() -> lock-free sharded CacheService queue ->
 * processLogQueue_() (driven by tickSync) -> immutable JSONL part files in Drive
 * /log/archive + per-part SHA-256 manifest. cleanupLogArchive_() trashes folders
 * older than 90d.
 *
 * NETWORK METADATA: Google Apps Script does not expose raw request metadata to
 * script code, so source.ip / source.port / source.mac are ALWAYS null. When
 * present, client.ip is fetched by the *client* from a third-party provider
 * (ipify) and sent back — it is labelled 'third_party_observed_client_fetched',
 * NOT a server-verified IP. The /log folder holds personal data and must stay
 * private. Passwords, OTPs, full tokens, full PII and full payloads are never
 * logged; sensitive identifiers are HMAC-hashed via hashForLog_().
 * ========================================================================== */

/* ---- log constants ---- */
const FOLDER_LOG          = 'log';
const FOLDER_LOG_ARCHIVE  = 'archive';
const FOLDER_LOG_FAILED   = 'failed';
// Lock-free queue: ONE event per cache key — LOGQ3_<bucket>_<slot>.
// bucket = floor(now/1000/LOG_Q_BUCKET_SEC); slot = a free slot in 0..LOG_Q_SLOTS-1.
// Each writer does a bare cache.put of its single event line — no read-modify-
// write of a shared accumulator — so concurrent writers can never clobber each
// other's data. The writer probes a few random slots for an empty one; the only
// residual loss is two writers racing onto the same empty slot, made negligible
// by sizing LOG_Q_SLOTS well above the events-per-bucket count.
const LOG_Q_PREFIX            = 'LOGQ3_';     // per-event cache key prefix
const LOG_Q_SLOTS             = 256;          // per-bucket key grid (was LOG_Q_SHARDS)
const LOG_Q_PROBE_TRIES       = 5;            // empty-slot probe attempts before counting a drop
const LOG_Q_BUCKET_SEC        = 15;           // queue time-bucket width (seconds)
const LOG_LAST_BUCKET         = 'LOG_LAST_BUCKET';        // ScriptProperty — last flushed bucket index
const LOG_MAX_CATCHUP_BUCKETS = 240;          // cap flush backlog (~1 h at 15 s buckets)
const LOG_CACHE_TTL           = 21600;        // 6 h — CacheService max
const LOG_MAX_EVENT_BYTES     = 4096;         // single event line cap (chars)
const LOG_RETENTION_DAYS      = 90;
const LOG_CLEANUP_LAST_RUN    = 'LOG_CLEANUP_LAST_RUN';   // ScriptProperty (ms)
const LOG_FLUSH_LAST_RUN      = 'LOG_FLUSH_LAST_RUN';     // ScriptProperty (ms)
const LOG_DROP_COUNTER        = 'LOG_DROP_COUNT';         // CacheService key
const LOG_HASH_SECRET_KEY     = 'LOG_HASH_SECRET';        // ScriptProperty
const ECS_VERSION             = '9.4.0';
const LOG_ENVIRONMENT         = 'production';
const LOG_FLUSH_MIN_INTERVAL_MS = 5 * 60 * 1000;          // flush closed buckets every ~5 min
const LOG_PAGEVIEW_SAMPLE_RATE  = 1.0;                    // 1.0 = log every page view
const LOG_CLEANUP_INTERVAL_MS   = 24 * 60 * 60 * 1000;    // cleanup at most once/day

/* ---- log config helpers ---- */
// Logging is opt-in: enabled ONLY when the property is exactly 'true'.
function isLoggingEnabled_() { return SP.getProperty('LOGGING_ENABLED') === 'true'; }
// Third-party IP observation is a separate opt-in sub-toggle, also default OFF.
function isIpObservationEnabled_() { return SP.getProperty('LOG_IP_OBSERVATION') === 'true'; }
// Per-install HMAC secret so hashed identifiers are not rainbow-table reversible.
function getLogHashSecret_() {
  var s = SP.getProperty(LOG_HASH_SECRET_KEY);
  if (s) return s;
  var ns = (uuid_() + uuid_()).replace(/-/g, '');
  SP.setProperty(LOG_HASH_SECRET_KEY, ns);
  return ns;
}

/* ---- sanitization & hashing ---- */
function safeLogString_(v, maxLen) {
  if (v === null || v === undefined) return '';
  var s = String(v).replace(/[\x00-\x1F\x7F]/g, ' ');
  maxLen = maxLen || 256;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}
function _logToIntOrNull_(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
function _logToNumOrNull_(v) { var n = Number(v); return isNaN(n) ? null : n; }
// HMAC-SHA256(value) -> short prefixed token. Used for user/session/client/order ids.
function hashForLog_(value, prefix) {
  if (value === null || value === undefined || value === '') return null;
  if (!isLoggingEnabled_()) return null;   // logging ปิด = ไม่อ่าน/สร้าง secret, ไม่คำนวณ HMAC ทิ้งเปล่า
  try {
    var sig = Utilities.computeHmacSha256Signature(
      Utilities.newBlob(String(value)).getBytes(),
      Utilities.newBlob(getLogHashSecret_()).getBytes());
    var hex = sig.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
    return (prefix || 'h_') + hex.slice(0, 16);
  } catch(_) { return null; }
}
function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ('0'+(b&0xff).toString(16)).slice(-2); }).join('');
}
// Whitelist + length-limit untrusted client log context. Never trust raw input.
function sanitizeClientLogContext_(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  var out = {
    client_ts:           safeLogString_(ctx.client_ts, 40),
    client_id:           safeLogString_(ctx.client_id, 80),
    page_url:            safeLogString_(ctx.page_url, 300),
    page_path:           safeLogString_(ctx.page_path, 120),
    referrer:            safeLogString_(ctx.referrer, 300),
    user_agent:          safeLogString_(ctx.user_agent, 400),
    language:            safeLogString_(ctx.language, 40),
    timezone:            safeLogString_(ctx.timezone, 60),
    timezone_offset_min: _logToIntOrNull_(ctx.timezone_offset_min),
    screen_w:            _logToIntOrNull_(ctx.screen_w),
    screen_h:            _logToIntOrNull_(ctx.screen_h),
    dpr:                 _logToNumOrNull_(ctx.dpr),
    viewport_w:          _logToIntOrNull_(ctx.viewport_w),
    viewport_h:          _logToIntOrNull_(ctx.viewport_h)
  };
  if (ctx.ip_observation && typeof ctx.ip_observation === 'object') {
    var o = ctx.ip_observation;
    out.ip_observation = {
      ok:           !!o.ok,
      provider:     safeLogString_(o.provider, 40),
      provider_url: safeLogString_(o.provider_url, 120),
      started_at:   safeLogString_(o.started_at, 40),
      fetched_at:   safeLogString_(o.fetched_at, 40),
      public_ip:    safeLogString_(o.public_ip, 64),
      http_status:  _logToIntOrNull_(o.http_status),
      trust_level:  safeLogString_(o.trust_level, 60)
    };
  }
  return out;
}

// Trim a sanitized client log context to the subset worth keeping for a whole
// 6h session. Drops page_url/referrer/path (login-page specific) and client_ts
// (stale for later actions — server @timestamp is authoritative). context_source
// marks the IP as login-time, not per-action. Returns null if nothing usable.
function sessionLogCtx_(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  var out = { context_source: 'session_login' };
  if (ctx.client_id)                   out.client_id = ctx.client_id;
  if (ctx.user_agent)                  out.user_agent = ctx.user_agent;
  if (ctx.language)                    out.language = ctx.language;
  if (ctx.timezone)                    out.timezone = ctx.timezone;
  if (ctx.timezone_offset_min != null) out.timezone_offset_min = ctx.timezone_offset_min;
  if (ctx.ip_observation)              out.ip_observation = ctx.ip_observation;
  return out;
}

/* ---- date helpers ---- */
function _logPad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
function _logYmd_(iso) {  // YYYYMMDD (UTC)
  var d = iso ? new Date(iso) : new Date();
  return '' + d.getUTCFullYear() + _logPad_(d.getUTCMonth()+1,2) + _logPad_(d.getUTCDate(),2);
}
function _logDateUtc_(iso) {  // YYYY-MM-DD (UTC)
  var d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.getUTCFullYear() + '-' + _logPad_(d.getUTCMonth()+1,2) + '-' + _logPad_(d.getUTCDate(),2);
}

/* ---- event builder ---- */
// buildLogEvent_(action, options, clientCtx) -> ECS-inspired record.
// options: { level, kind, category[], type[], outcome, route, rpc, method,
//            urlPath, userId, sessionId, userAgent, meta{} }
function buildLogEvent_(eventAction, options, clientCtx) {
  options = options || {};
  var nowIso = new Date().toISOString();
  var clientIp = null, networkSource = 'unavailable', ipObserver = null, ipObs = null;
  if (isIpObservationEnabled_() && clientCtx && clientCtx.ip_observation
      && clientCtx.ip_observation.ok && clientCtx.ip_observation.public_ip) {
    clientIp = clientCtx.ip_observation.public_ip;
    networkSource = 'third_party_observed_client_fetched';
    ipObserver = clientCtx.ip_observation.provider || 'ipify';
    ipObs = {
      provider:     clientCtx.ip_observation.provider || 'ipify',
      provider_url: clientCtx.ip_observation.provider_url || '',
      fetched_at:   clientCtx.ip_observation.fetched_at || '',
      http_status:  clientCtx.ip_observation.http_status,
      trust_level:  'third_party_observed_client_fetched'
    };
  }
  var ev = {
    '@timestamp':          nowIso,
    'ecs.version':         ECS_VERSION,
    'log.level':           options.level || 'info',
    'event.kind':          options.kind || 'event',
    'event.category':      options.category || [],
    'event.type':          options.type || [],
    'event.action':        String(eventAction),
    'event.outcome':       options.outcome || 'unknown',
    'event.id':            '',   // assigned under the enqueue lock
    'service.name':        'open-storefront',
    'service.type':        'google-apps-script',
    'service.environment': LOG_ENVIRONMENT,
    'server.address':      'apps_script_webapp',
    // GAS does not expose raw network metadata to script code — always null:
    'source.ip':           null,
    'source.port':         null,
    'source.mac':          null,
    'url.path':            safeLogString_(options.urlPath || (clientCtx && clientCtx.page_path) || options.route || '', 120),
    'http.request.method': options.method || 'RPC',
    'user.id_hash':        options.userId ? hashForLog_(options.userId, 'u_') : null,
    'session.id_hash':     options.sessionId ? hashForLog_(options.sessionId, 's_') : null,
    'user_agent.original': safeLogString_(options.userAgent || (clientCtx && clientCtx.user_agent) || '', 400),
    'client.ip':             clientIp,
    'labels.network_source': networkSource,
    'labels.ip_observer':    ipObserver,
    'labels.privacy_class':  'personal_data_log',
    'open_storefront':       {}
  };
  var os = { route: safeLogString_(options.route || '', 60), rpc: safeLogString_(options.rpc || '', 60) };
  if (clientCtx) {
    os.client_id_hash  = clientCtx.client_id ? hashForLog_(clientCtx.client_id, 'c_') : null;
    os.client_ts       = clientCtx.client_ts || null;
    os.client_timezone = clientCtx.timezone || null;
    // 'request' = ctx collected for this very RPC; 'session_login' = ctx taken
    // from the session, observed when the admin logged in (not per-action).
    os.context_source  = clientCtx.context_source || 'request';
    if (ipObs) os.ip_observation = ipObs;
  }
  if (options.meta && typeof options.meta === 'object') {
    for (var k in options.meta) {
      if (options.meta.hasOwnProperty(k)) os[k] = options.meta[k];
    }
  }
  ev.open_storefront = os;
  // event.id is assigned by enqueueLog_ (a uuid — globally unique, no counter).
  // Per-event integrity hashing was removed: tamper-evidence is provided by the
  // per-part-file SHA-256 + prev-hash chain written in the manifest.
  return ev;
}

/* ---- enqueue (hot path — lock-free, must be fast and must never throw) ---- */
function enqueueLog_(eventAction, options, clientCtx) {
  try {
    if (!isLoggingEnabled_()) return;
    options = options || {};
    // Sampling applies ONLY to web.page_view. Security/admin/order/payment never sampled.
    if (eventAction === 'web.page_view' && LOG_PAGEVIEW_SAMPLE_RATE < 1.0
        && Math.random() >= LOG_PAGEVIEW_SAMPLE_RATE) return;

    var ev = buildLogEvent_(eventAction, options, clientCtx || null);
    // Globally-unique event id — a uuid, no shared counter, no lock needed.
    ev['event.id'] = 'LOG-' + _logYmd_(ev['@timestamp']) + '-' + uuid_().replace(/-/g, '').slice(0, 18);
    var line = JSON.stringify(ev);
    if (line.length > LOG_MAX_EVENT_BYTES) {
      // Drop non-critical bulk fields; keep the security-relevant core.
      ev.open_storefront = { route: ev.open_storefront.route, rpc: ev.open_storefront.rpc, truncated: true };
      ev['user_agent.original'] = safeLogString_(ev['user_agent.original'], 120);
      line = JSON.stringify(ev);
      // Still too big — drop the event. Never slice() (that produced corrupt JSON).
      if (line.length > LOG_MAX_EVENT_BYTES) return;
    }

    // Lock-free: one event per cache key. No ScriptLock, no read-modify-write of
    // a shared accumulator — so concurrent writers cannot clobber each other.
    // Probe a few random slots for an empty one, then bare-put this single line.
    var cache  = CacheService.getScriptCache();
    var bucket = Math.floor(Date.now() / 1000 / LOG_Q_BUCKET_SEC);
    var stored = false;
    for (var attempt = 0; attempt < LOG_Q_PROBE_TRIES; attempt++) {
      var slot = Math.floor(Math.random() * LOG_Q_SLOTS);
      var key  = LOG_Q_PREFIX + bucket + '_' + slot;
      if (cache.get(key)) continue;            // slot occupied — probe another
      cache.put(key, line, LOG_CACHE_TTL);     // bare put of this single event
      stored = true;
      break;
    }
    if (!stored) {
      // Every probed slot was occupied — the bucket is saturated. Count the drop.
      try {
        var dc = (parseInt(cache.get(LOG_DROP_COUNTER) || '0', 10) || 0) + 1;
        cache.put(LOG_DROP_COUNTER, String(dc), LOG_CACHE_TTL);
      } catch(_) {}
    }
  } catch(_) {
    // Logging must never throw into business code.
  }
}

// Best-effort audit log — fail-open wrapper. A logging failure can never break,
// roll back, or change the result of the business action that called it.
// Always call this AFTER the main action has completed successfully.
function auditLog_(action, options, ctx) {
  try { enqueueLog_(action, options, ctx || null); } catch (_) {}
}

/* ---- Drive folder helpers ---- */
function getOrCreateSubfolder_(parentFolder, name) {
  // Pick the oldest existing match deterministically (so duplicates resolve to
  // one canonical folder) and only create when truly none exist. Runs under the
  // flush worker's lock / one-time setup, so no extra lock is taken here.
  var id = _oldestFolderByName_(parentFolder, name);
  if (id) return DriveApp.getFolderById(id);
  return parentFolder.createFolder(name);
}
function getLogFolder_() { return DriveApp.getFolderById(getFolderIdCached_(FOLDER_LOG)); }
function ensureLogFolders_() {
  var logFolder = getLogFolder_();             // creates /log under DRIVE_FOLDER_ID
  getOrCreateSubfolder_(logFolder, FOLDER_LOG_ARCHIVE);
  getOrCreateSubfolder_(logFolder, FOLDER_LOG_FAILED);
  return logFolder.getId();
}

/* ---- flush worker (driven by tickSync) ---- */
// Drains all CLOSED queue buckets (a bucket is closed once the next bucket has
// started) into immutable Drive part files. The closed-bucket range is claimed
// under a short lock — taken only by the flush worker, never by the hot path —
// so a concurrent tickSync cannot re-flush the same buckets.
function processLogQueue_() {
  if (!isLoggingEnabled_()) return;

  // Throttle: flush at most once per interval (avoids tiny files every minute).
  var lastRun = Number(SP.getProperty(LOG_FLUSH_LAST_RUN) || 0);
  if (Date.now() - lastRun < LOG_FLUSH_MIN_INTERVAL_MS) return;

  var cache = CacheService.getScriptCache();
  var fromBucket, toBucket;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;   // another worker is flushing — skip this tick
  try {
    var curBucket  = Math.floor(Date.now() / 1000 / LOG_Q_BUCKET_SEC);
    // First run ever (property unset): start one bucket back so the first
    // closed bucket is flushed and LOG_LAST_BUCKET gets seeded.
    var rawLast    = SP.getProperty(LOG_LAST_BUCKET);
    var lastBucket = rawLast ? Number(rawLast) : (curBucket - 2);
    toBucket = curBucket - 1;                 // only flush CLOSED buckets
    if (lastBucket >= toBucket) return;        // nothing closed since last flush
    fromBucket = Math.max(lastBucket + 1, toBucket - LOG_MAX_CATCHUP_BUCKETS + 1);
    // Claim the range now so a concurrent worker won't re-read it.
    SP.setProperty(LOG_LAST_BUCKET, String(toBucket));
    SP.setProperty(LOG_FLUSH_LAST_RUN, String(Date.now()));
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }

  // ---- Drive I/O happens OUTSIDE the lock so enqueues are never blocked ----
  var runId = 'LOGW-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

  var keys = [];
  for (var b = fromBucket; b <= toBucket; b++) {
    for (var s = 0; s < LOG_Q_SLOTS; s++) keys.push(LOG_Q_PREFIX + b + '_' + s);
  }
  var lines = [];
  // getAll in batches of 100 to stay well within CacheService limits.
  for (var ki = 0; ki < keys.length; ki += 100) {
    var got = cache.getAll(keys.slice(ki, ki + 100)) || {};
    for (var gk in got) {
      if (!got.hasOwnProperty(gk)) continue;
      var split = String(got[gk]).split('\n');
      for (var sp = 0; sp < split.length; sp++) if (split[sp]) lines.push(split[sp]);
    }
  }
  if (!lines.length) { try { cache.removeAll(keys); } catch(_) {} return; }

  // Group lines by UTC date of @timestamp.
  var byDate = {};
  for (var L = 0; L < lines.length; L++) {
    var ts = null;
    try { ts = JSON.parse(lines[L])['@timestamp']; } catch(_) {}
    var d = _logDateUtc_(ts);
    (byDate[d] = byDate[d] || []).push(lines[L]);
  }

  try {
    var archive = getOrCreateSubfolder_(getLogFolder_(), FOLDER_LOG_ARCHIVE);
    for (var date in byDate) {
      if (byDate.hasOwnProperty(date)) _logWriteDatePart_(archive, date, byDate[date], runId);
    }
    try { cache.removeAll(keys); } catch(_) {}   // success — free the frozen parts
  } catch (driveErr) {
    // Emergency spool: dump the whole frozen batch to /log/failed, then free
    // cache so it never grows unbounded.
    try {
      var failed = getOrCreateSubfolder_(getLogFolder_(), FOLDER_LOG_FAILED);
      failed.createFile('failed-' + runId + '.jsonl.txt', lines.join('\n') + '\n', 'text/plain');
      try { cache.removeAll(keys); } catch(_) {}
    } catch(_) {
      // Even the spool failed — leave cache parts to expire via TTL (accepted loss).
    }
  }
}

// Writes one immutable part file + one per-part manifest file for a single date.
// O(1): the part sequence number and the prev-part hash come from ScriptProperties
// instead of scanning the day folder / re-reading a growing manifest file.
// The manifest for a day is the set of <date>.manifest-NNNNNN.jsonl.txt files
// (one line each); a reader concatenates them in sequence order.
function _logWriteDatePart_(archiveFolder, date, dateLines, runId) {
  var dayFolder = getOrCreateSubfolder_(archiveFolder, date);
  var seqKey = 'LOG_PARTSEQ_' + date;
  var shaKey = 'LOG_LASTSHA_' + date;
  var seq    = (Number(SP.getProperty(seqKey) || 0) || 0) + 1;

  var partName = date + '.part-' + _logPad_(seq, 6) + '.jsonl.txt';
  var content  = dateLines.join('\n') + '\n';
  var partFile = dayFolder.createFile(partName, content, 'text/plain');
  var sha      = sha256Hex_(content);
  var prevSha  = SP.getProperty(shaKey) || '';

  var manifestLine = JSON.stringify({
    date:             date,
    seq:              seq,
    part_file_name:   partName,
    part_file_id:     partFile.getId(),
    created_at:       new Date().toISOString(),
    record_count:     dateLines.length,
    bytes:            content.length,
    sha256:           sha,
    hash_alg:         'SHA-256',
    prev_part_sha256: prevSha,
    worker_run_id:    runId
  });
  dayFolder.createFile(date + '.manifest-' + _logPad_(seq, 6) + '.jsonl.txt', manifestLine + '\n', 'text/plain');

  // Advance the per-date counters only after both files are written.
  SP.setProperty(seqKey, String(seq));
  SP.setProperty(shaKey, sha);
}

/* ---- daily retention cleanup (driven by tickSync, at most once/24h) ---- */
function cleanupLogArchive_() {
  if (!isLoggingEnabled_()) return;
  var lastRun = Number(SP.getProperty(LOG_CLEANUP_LAST_RUN) || 0);
  if (Date.now() - lastRun < LOG_CLEANUP_INTERVAL_MS) return;   // no Drive scan every tick
  SP.setProperty(LOG_CLEANUP_LAST_RUN, String(Date.now()));

  var trashed = 0;
  try {
    var archive = getOrCreateSubfolder_(getLogFolder_(), FOLDER_LOG_ARCHIVE);
    var cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    var it = archive.getFolders();
    while (it.hasNext()) {
      var f = it.next();
      var nm = f.getName();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nm)) continue;          // skip unparseable names
      var p = nm.split('-');
      var folderTime = Date.UTC(+p[0], +p[1] - 1, +p[2]);
      if (isNaN(folderTime)) continue;
      if (folderTime < cutoff) {
        try {
          f.setTrashed(true);
          trashed++;
          // Drop the per-date counters so ScriptProperties don't accumulate.
          SP.deleteProperty('LOG_PARTSEQ_' + nm);
          SP.deleteProperty('LOG_LASTSHA_' + nm);
        } catch(_) {}
      }
    }
  } catch(_) { return; }
  // Single summary event — never log inside the loop (avoids log storms).
  if (trashed > 0) {
    enqueueLog_('log.cleanup.done', {
      category: ['process'], type: ['deletion'], outcome: 'success',
      meta: { folders_trashed: trashed, retention_days: LOG_RETENTION_DAYS }
    }, null);
  }
}

/* ---- logging config RPCs (owner-only) ---- */
function getLoggingConfigRpc(token) {
  if (!requireOwner_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  return {
    ok: true,
    loggingEnabled: isLoggingEnabled_(),
    ipObservation:  isIpObservationEnabled_(),
    dropCount:      parseInt(CacheService.getScriptCache().get(LOG_DROP_COUNTER) || '0', 10) || 0,
    lastFlush:      Number(SP.getProperty(LOG_FLUSH_LAST_RUN) || 0),
    lastCleanup:    Number(SP.getProperty(LOG_CLEANUP_LAST_RUN) || 0)
  };
}
function saveLoggingConfigRpc(token, payload) {
  var sess = requireOwner_(token);
  if (!sess) return { ok: false, error: 'AUTH_REQUIRED' };
  payload = payload || {};
  function _auditLoggingChange() {
    auditLog_('logging.config.update', { category:['configuration'], type:['change'],
      outcome:'success', level:'warning', route:'system', rpc:'saveLoggingConfigRpc',
      userId:sess.userId, sessionId:token,
      meta:{ logging_enabled: !!payload.loggingEnabled, ip_observation: !!payload.ipObservation } },
      sess.logCtx);
  }
  // Disabling: audit BEFORE the flag flips, while logging is still active.
  if (!payload.loggingEnabled) _auditLoggingChange();
  SP.setProperty('LOGGING_ENABLED',    payload.loggingEnabled ? 'true' : 'false');
  SP.setProperty('LOG_IP_OBSERVATION', payload.ipObservation  ? 'true' : 'false');
  if (payload.loggingEnabled) {
    try { ensureLogFolders_(); } catch(_) {}
    // Enabling: audit AFTER the flag flips, so the record isn't dropped.
    _auditLoggingChange();
  }
  return { ok: true, loggingEnabled: isLoggingEnabled_(), ipObservation: isIpObservationEnabled_() };
}
// Public, no-auth — exposes only two booleans so pages without injected site
// config (e.g. login.html) can decide whether to fetch a third-party IP.
function getLogPublicConfigRpc() {
  return { ok: true, loggingEnabled: isLoggingEnabled_(), ipObservation: isIpObservationEnabled_() };
}

// Public, no-auth — async page-view beacon. The client calls this AFTER the
// page has rendered so page serving (doGet) carries no logging latency.
// enqueueLog_ is a no-op when logging is disabled and applies its own sampling.
function logPageViewRpc(route, clientCtx) {
  try {
    enqueueLog_('web.page_view', {
      category: ['web'], type: ['access'], outcome: 'success',
      route: safeLogString_(route, 60), method: 'GET'
    }, sanitizeClientLogContext_(clientCtx));
  } catch(_) {}
  return { ok: true };
}

// Best-effort session-context beacon. Admin pages call this on load with a fresh
// client context; if the client-reported IP differs from the one observed at
// login it emits a `session.ip_changed` audit event. ADVISORY ONLY — the IP is
// client-fetched (ipify) and fully spoofable; this is a tripwire, not a control.
// Mutates nothing and never blocks; the whole body is wrapped so it cannot throw.
function reportSessionContextRpc(token, clientCtx) {
  try {
    var sess = getSession_(token);
    if (!sess) return { ok: false };   // unauthenticated — nothing to compare
    var cur = sanitizeClientLogContext_(clientCtx);
    var loginCtx = sess.logCtx || null;
    var loginIp = loginCtx && loginCtx.ip_observation && loginCtx.ip_observation.public_ip;
    var curIp   = cur && cur.ip_observation && cur.ip_observation.public_ip;
    // Log strictly only when BOTH IPs are present and differ — a missing logCtx,
    // IP observation off, or a failed ipify fetch must not produce a false signal.
    if (loginIp && curIp && loginIp !== curIp) {
      enqueueLog_('session.ip_changed', {
        category:['authentication'], type:['change'], outcome:'unknown',
        level:'warning', route:'admin', rpc:'reportSessionContextRpc',
        userId: sess.userId, sessionId: token,
        meta: {
          login_ip: loginIp, observed_ip: curIp,
          ip_observed: 'client_fetched_unverified',
          user_agent_changed: !!(loginCtx.user_agent && cur && cur.user_agent
                                  && loginCtx.user_agent !== cur.user_agent)
        }
      }, cur);
    }
    return { ok: true };
  } catch(_) { return { ok: false }; }
}

/* ---------- Setup & housekeeping ---------- */
// setupAll_ / setupTimeDrivenSync_ ขึ้นต้นด้วย _ → google.script.run เรียกจาก client ไม่ได้
// แต่รันได้ตรงจาก GAS editor ผ่าน Run menu ตามปกติ
function setupAll_(){
  let sid=SP.getProperty('SHEET_ID');
  if(!sid){
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      sid = active.getId();
      SP.setProperty('SHEET_ID', sid);
      Logger.log('[SETUP] ใช้ Spreadsheet ที่ผูกกับ script (container-bound): ' + sid);
    } else {
      sid = SpreadsheetApp.create('Open Storefront').getId();
      SP.setProperty('SHEET_ID', sid);
      Logger.log('[SETUP] สร้าง Spreadsheet ใหม่: ' + sid);
    }
  }
  let fid=SP.getProperty('DRIVE_FOLDER_ID');
  if(!fid){ fid=DriveApp.createFolder('open-storefront-uploads').getId(); SP.setProperty('DRIVE_FOLDER_ID', fid); }
  sheetProd_(); sheetOrders_(); sheetShipping_(); sheetStore_(); sheetUsers_(); sheetPromotions_(); sheetPayment_();
  // Seed the canonical default site config on a fresh deployment — never overwrite an existing one.
  if (!getSiteConfigFromSheet_()) {
    writeSiteConfig_(JSON.stringify(getDefaultSiteConfig_()));
    Logger.log('[SETUP] Seeded default site_config.');
  }
  // Seed default status images into store sheet (skip rows that already exist).
  (function seedStatusImages_() {
    const defaults = [
      { key: 'status_img_preparing', drive_file_id: '1tIbFL2Ml_3cIIbRu6rLSPgywQXuM7jGC', url: 'https://i.ibb.co/XZ46CpPb/Prepareing.gif' },
      { key: 'status_img_delivered', drive_file_id: '198FGsZ53Cwn03OqJW6pF_5ZIZDgOZjiY', url: 'https://i.ibb.co/N6869dhy/Send-done.gif'    },
      { key: 'status_img_shipping',  drive_file_id: '1Md44s-0vSKOOzDMq1bpnWfq6JmbnP0MZ', url: 'https://i.ibb.co/5g1Smy5X/Sending.gif'      },
    ];
    const sh = sheetStore_();
    const n = sh.getLastRow();
    const existingKeys = n >= 2
      ? sh.getRange(2, 1, n - 1, 1).getValues().flat()
      : [];
    const now = new Date().toISOString();
    defaults.forEach(function(row) {
      if (!existingKeys.includes(row.key)) {
        sh.appendRow([row.key, row.drive_file_id, row.url, now]);
        Logger.log('[SETUP] Seeded store row: ' + row.key);
      }
    });
  })();
  rebuildSnap_(); setupTimeDrivenSync_();
  try { ensureLogFolders_(); } catch(e){ Logger.log('[SETUP] ensureLogFolders_ failed: ' + e); }
  if (!SP.getProperty('DATA_ENCRYPT_KEY')) {
    SP.setProperty('DATA_ENCRYPT_KEY', (uuid_()+uuid_()).replace(/-/g,''));
    Logger.log('[SETUP] DATA_ENCRYPT_KEY generated. Store this key securely.');
  }
  return {ok:true, SHEET_ID:sid, DRIVE_FOLDER_ID:fid, sheetUrl:'https://docs.google.com/spreadsheets/d/'+sid};
}
function setupTimeDrivenSync_(){
  ScriptApp.getProjectTriggers().forEach(t=>{ if(t.getHandlerFunction?.()==='tickSync') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tickSync').timeBased().everyMinutes(1).create();
  return {ok:true};
}
// Public entry point — run once from the GAS editor to initialize the system.
// Blocked by Script Property 'SETUP_COMPLETED' after first successful run.
function setupAll() {
  if (SP.getProperty('SETUP_COMPLETED') === 'true') {
    Logger.log('[SETUP] Already completed — skipping.');
    return { ok: false, error: 'SETUP_ALREADY_COMPLETED' };
  }
  var result = setupAll_();
  if (result && result.ok) {
    SP.setProperty('SETUP_COMPLETED', 'true');
    Logger.log('[SETUP] Done. Flag set.');
  }
  return result;
}
// Dev-only: clear the SETUP_COMPLETED flag so setupAll() can run again.
// Trailing underscore keeps this off the GAS Run menu and google.script.run.
function devResetSetupFlag_() {
  SP.deleteProperty('SETUP_COMPLETED');
  Logger.log('[DEV] SETUP_COMPLETED flag cleared.');
  return { ok: true };
}
function tickSync(){
  syncSnapIfStale_();
  try { processLogQueue_(); }  catch(_){}
  try { cleanupLogArchive_(); } catch(_){}
}
function adminResyncSnapshot(token){ if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' }; rebuildSnap_(); return {ok:true}; }
function adminDeactivateOrphanedProductsRpc(token) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var companies = readShippingFromSheet_();
    var activeMethodIds = new Set();
    companies.forEach(function(c) {
      if (c.active === false) return;
      (c.methods || []).forEach(function(m) {
        if (m.active !== false && m.id) activeMethodIds.add(m.id);
      });
    });
    var count = deactivateProductsWithNoValidShipping_(activeMethodIds);
    // This RPC runs on every product.html refresh — only log when it actually
    // deactivated something, so a no-op refresh adds no audit-log overhead.
    if (count > 0) {
      auditLog_('product.auto_deactivate', { category:['database'], type:['change'],
        outcome:'success', route:'product', rpc:'adminDeactivateOrphanedProductsRpc',
        userId:_sess.userId, sessionId:token,
        meta:{ resource_type:'product', count: count } }, _sess.logCtx);
    }
    return { ok: true, deactivated: count };
  } catch(err) {
    return { ok: false, error: String(err) };
  }
}

/* ========== ORDER SYSTEM ========== */

const SHEET_NAME_ORDERS = 'orders';
// Col 7 (index 6) was 'customer_facebook' in the old schema — renamed to 'customer_contact_platform'.
// customer_contact, token, slip_drive_file_id are appended as new columns (22-24).
const ORDER_COLS = [
  'order_id','created_at','updated_at','status',
  'customer_name','customer_phone','customer_contact_platform',
  'shipping_name','shipping_address','shipping_district','shipping_amphoe','shipping_province','shipping_postal_code',
  'customer_notes','shipping_fee','subtotal','total','shipping_method_id',
  'items_json','status_history_json','shipping_info_json',
  'customer_contact','token','slip_drive_file_id','token_expires_at',
  'tracking_json','fulfillment_shipping_json','order_discount_json'
];

function sheetOrders_() {
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_ORDERS) || ss.insertSheet(SHEET_NAME_ORDERS);
  const firstCell = sh.getLastColumn() > 0 ? sh.getRange(1,1).getValue() : '';
  const curCols = sh.getLastColumn();
  if (firstCell !== 'order_id') {
    sh.clear();
    sh.getRange(1,1,1,ORDER_COLS.length).setValues([ORDER_COLS]);
  } else if (curCols < ORDER_COLS.length) {
    sh.getRange(1, curCols+1, 1, ORDER_COLS.length - curCols).setValues([ORDER_COLS.slice(curCols)]);
    // Rename legacy col 7 header
    if (String(sh.getRange(1,7).getValue()) === 'customer_facebook') {
      sh.getRange(1,7).setValue('customer_contact_platform');
    }
  }
  return sh;
}

function genOrderId_() {
  const d = new Date();
  const ymd = d.getFullYear().toString() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0');
  const rnd = Math.random().toString(36).substr(2,6).toUpperCase();
  return 'ORD-' + ymd + '-' + rnd;
}

// 64 hex characters = 256-bit entropy — effectively unguessable
function genToken_() {
  return (uuid_() + uuid_()).replace(/-/g, '');
}

// Mirror of frontend _calcShippingFee — used server-side for zero-trust calculation
function calcBackendShippingFee_(method, totalWeightGrams) {
  if (!method) return 0;
  if (method.mode === 'flat') return Number(method.flat_rate || 0);
  var brackets = method.brackets || [];
  if (!brackets.length) return 0;
  var w = totalWeightGrams;
  // Sort ascending and treat `to_g` as inclusive: "0-500g" includes 500g.
  var sorted = brackets.slice().sort(function(a, b){ return Number(a.from_g) - Number(b.from_g); });
  if (w < Number(sorted[0].from_g)) return Number(sorted[0].price || 0);
  for (var i = 0; i < sorted.length; i++) {
    var b = sorted[i];
    if (w >= Number(b.from_g) && w <= Number(b.to_g)) {
      return Number(b.price || 0);
    }
  }
  // Weight fell in a gap between brackets (misconfigured tiers, e.g. 0-500 / 600-1000
  // with w=550): snap to the next bracket ABOVE the weight instead of silently
  // charging the top tier. Mirrored in index.html `_calcShippingFee` — keep in sync.
  for (var gi = 0; gi < sorted.length; gi++) {
    if (w <= Number(sorted[gi].to_g)) return Number(sorted[gi].price || 0);
  }
  return Number(sorted[sorted.length - 1].price || 0);
}

/* ========== PROMOTION SYSTEM ========== */
// Storage: sheet `promotions` (see sheetPromotions_)
// Pricing rule: final price = Math.max(0, Math.round(base - discount))
// Promotion is snapshotted into orders.items_json at submit time so old orders
// stay correct even if the promotion is later edited or deleted.

function buildVariantKey_(sel) {
  if (!sel || typeof sel !== 'object') return '';
  var keys = Object.keys(sel).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(keys[i] + '=' + String(sel[keys[i]] || ''));
  }
  return parts.join('|');
}

function calcPromotionPrice_(basePrice, promo) {
  var base = Math.round(Number(basePrice) || 0);
  if (!promo) return { unit_base_price: base, unit_discount_amount: 0, unit_final_price: base };
  var raw;
  if (promo.discount_type === 'percent') {
    raw = base * (1 - Number(promo.discount_value) / 100);
  } else {
    raw = base - Number(promo.discount_value);
  }
  var finalP = Math.max(0, Math.round(raw));
  return {
    unit_base_price: base,
    unit_discount_amount: base - finalP,
    unit_final_price: finalP
  };
}

function getPromotionStatus_(promo, now) {
  if (!promo || promo.deleted_at) return 'disabled';
  var enabled = !(promo.enabled === false || String(promo.enabled).toUpperCase() === 'FALSE');
  var status = _getScheduleStatus_(enabled, promo.starts_at, promo.ends_at, !!promo.no_end_date, now);
  return status === 'ended' ? 'expired' : status;
}

function promoMatchesTarget_(promo, productId, variantKey) {
  var t = promo.target_type;
  var arr = Array.isArray(promo.target) ? promo.target : [];
  if (t === 'all') return true;
  if (t === 'product') {
    return arr.some(function(x){ return String(x.product_id) === String(productId); });
  }
  if (t === 'variant') {
    return arr.some(function(x){
      return String(x.product_id) === String(productId)
          && String(x.variant_key || '') === String(variantKey || '');
    });
  }
  return false;
}

function rowToPromotion_(r) {
  var target = [];
  try { target = JSON.parse(String(r[6] || '[]')) || []; } catch(_) { target = []; }
  // Blank schedule values must stay blank. Older code could stringify a
  // normalized null as the literal text "null" when no start date was set.
  var startsAt = String(r[7] || '').trim();
  var endsAt = String(r[8] || '').trim();
  if (startsAt === 'null' || startsAt === 'undefined') startsAt = '';
  if (endsAt === 'null' || endsAt === 'undefined') endsAt = '';
  // r[15] = no_end_date (added column). Legacy rows may not have it.
  var nedRaw = (r.length > 15) ? r[15] : '';
  var noEndDate;
  if (nedRaw === '' || nedRaw === undefined || nedRaw === null) {
    // Migration default: legacy promos with both dates -> false (preserve old expiration)
    var hasEnd = endsAt !== '';
    noEndDate = !hasEnd;
  } else {
    noEndDate = (nedRaw === true || String(nedRaw).toUpperCase() === 'TRUE');
  }
  // r[16]=application_mode, r[17]=condition_type, r[18]=condition_json (added columns).
  // Legacy rows lack these → default to unconditional ('direct') so existing behavior is preserved.
  var appMode = (r.length > 16) ? String(r[16] || '').trim().toLowerCase() : '';
  if (appMode !== 'conditional') appMode = 'direct';
  var condType = (r.length > 17) ? String(r[17] || '').trim() : '';
  var condJson = {};
  try { condJson = JSON.parse(String((r.length > 18 ? r[18] : '') || '{}')) || {}; } catch(_) { condJson = {}; }
  if (appMode !== 'conditional') { condType = ''; condJson = {}; }
  // r[19]=discount_scope (added column). Legacy rows lack it → 'item' (per-item discount,
  // the original behavior). Order-total scope is only meaningful for conditional promos;
  // force 'item' otherwise so a direct promo can never carry an order-total scope.
  var discScope = (r.length > 19) ? String(r[19] || '').trim().toLowerCase() : '';
  if (discScope !== 'order_total') discScope = 'item';
  if (appMode !== 'conditional') discScope = 'item';
  return {
    promotion_id:   String(r[0] || ''),
    name:           String(r[1] || ''),
    description:    String(r[2] || ''),
    discount_type:  String(r[3] || 'fixed'),
    discount_value: Number(r[4] || 0),
    target_type:    String(r[5] || 'all'),
    target:         target,
    starts_at:      startsAt,
    ends_at:        endsAt,
    // Sheets auto-converts the string 'FALSE'/'TRUE' to a native boolean on write,
    // so r[9] comes back as boolean false/true. Treat booleans explicitly — the old
    // `String(r[9] || 'TRUE')` path mis-read native `false` as 'TRUE' (falsy fallback).
    enabled:        (r[9] === false) ? false
                  : (r[9] === true)  ? true
                  : String(r[9] || 'TRUE').toUpperCase() === 'TRUE',
    created_at:     String(r[10] || ''),
    updated_at:     String(r[11] || ''),
    created_by:     String(r[12] || ''),
    updated_by:     String(r[13] || ''),
    deleted_at:     String(r[14] || ''),
    no_end_date:    noEndDate,
    application_mode: appMode,
    condition_type:   condType,
    condition_json:   condJson,
    discount_scope:   discScope
  };
}

function listPromotionsFromSheet_(includeDeleted) {
  var cache = CacheService.getScriptCache();
  if (!includeDeleted) {
    var raw = cache.get(CACHE_PROMO_LIST);
    if (raw) { try { return JSON.parse(raw); } catch(_) {} }
  }
  var sh = sheetPromotions_();
  var n  = sh.getLastRow();
  if (n < 2) {
    if (!includeDeleted) { try { cache.put(CACHE_PROMO_LIST, JSON.stringify([]), 60); } catch(_) {} }
    return [];
  }
  var rows = sh.getRange(2, 1, n - 1, 20).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var p = rowToPromotion_(rows[i]);
    if (!includeDeleted && p.deleted_at) continue;
    out.push(p);
  }
  out.sort(function(a, b){ return String(b.created_at).localeCompare(String(a.created_at)); });
  if (!includeDeleted) { try { cache.put(CACHE_PROMO_LIST, JSON.stringify(out), 60); } catch(_) {} }
  return out;
}

function invalidatePromoCache_() {
  try { CacheService.getScriptCache().remove(CACHE_PROMO_LIST); } catch(_) {}
}

// True if a promotion is enabled and within its active schedule window.
function _promoIsActive_(p, now) {
  var promoForStatus = { enabled: p.enabled ? 'TRUE' : 'FALSE', starts_at: p.starts_at, ends_at: p.ends_at, no_end_date: p.no_end_date, deleted_at: p.deleted_at };
  return getPromotionStatus_(promoForStatus, now) === 'active';
}

// Direct (unconditional) promos always apply when active; conditional promos only
// apply when their condition is satisfied by the cart. This predicate is the
// direct-only filter used for snapshot pricing and the Pass-A base subtotal.
function _promoIsDirect_(p) {
  return !!p && p.application_mode !== 'conditional';
}

// Order-total scope: a conditional promo whose discount is deducted once from the whole-order
// subtotal (never multiplied by qty, never resolved per line). Only conditional promos can
// carry this scope (enforced in validation + rowToPromotion_).
function _promoIsOrderTotal_(p) {
  return !!p && p.application_mode === 'conditional' && p.discount_scope === 'order_total';
}

// Order-total discount amount, applied ONCE to `subtotal` (never per unit).
// fixed  → flat baht; percent → subtotal * value/100. Rounded to whole baht and clamped to
// [0, subtotal] so the discount can never exceed the item subtotal or go negative.
function calcOrderTotalDiscount_(subtotal, promo) {
  var sub = Math.max(0, Math.round(Number(subtotal) || 0));
  if (!promo) return 0;
  var amt;
  if (promo.discount_type === 'percent') {
    amt = Math.round(sub * Number(promo.discount_value) / 100);
  } else {
    amt = Math.round(Number(promo.discount_value));
  }
  if (!isFinite(amt) || amt < 0) amt = 0;
  return Math.min(sub, amt);
}

// Among qualified conditional order-total promos, pick the single one giving the LARGEST
// discount on `subtotal` (no stacking — one order-total discount per order). Tiebreak: newest
// created_at. Returns { promo, amount } or null. `qualifiedIds` is the qualified-conditional set.
function resolveBestOrderTotalPromo_(promos, qualifiedIds, subtotal, now) {
  var best = null, bestAmt = 0;
  for (var i = 0; i < promos.length; i++) {
    var p = promos[i];
    if (!_promoIsOrderTotal_(p)) continue;
    if (!_promoIsActive_(p, now)) continue;
    if (!qualifiedIds[String(p.promotion_id)]) continue;
    var amt = calcOrderTotalDiscount_(subtotal, p);
    if (!best || amt > bestAmt ||
        (amt === bestAmt && String(p.created_at).localeCompare(String(best.created_at)) > 0)) {
      best = p; bestAmt = amt;
    }
  }
  return best ? { promo: best, amount: bestAmt } : null;
}

// Central winner resolver: BEST PRICE WINS per line. Among promos that are active,
// pass the optional `filterFn`, and match the (productId, variantKey) target, pick the
// one yielding the lowest unit_final_price for `basePrice`. Tiebreak: specificity
// (variant > product > all), then newest created_at. No stacking — one promo per line.
// Returns { promo, pricing } or null; `pricing` is the calcPromotionPrice_ result for
// the winner so callers never recompute (single source of price truth). A promo whose
// rounding yields zero discount can still win over "no promo" (final == base) — harmless.
function resolveBestPromotionForLine_(promos, productId, variantKey, basePrice, now, filterFn) {
  var rank = { variant: 3, product: 2, all: 1 };
  var best = null, bestPricing = null;
  for (var i = 0; i < promos.length; i++) {
    var p = promos[i];
    if (filterFn && !filterFn(p)) continue;
    if (!_promoIsActive_(p, now)) continue;
    if (!promoMatchesTarget_(p, productId, variantKey)) continue;
    var pricing = calcPromotionPrice_(basePrice, p);
    if (!best) { best = p; bestPricing = pricing; continue; }
    var d = pricing.unit_final_price - bestPricing.unit_final_price;
    if (d > 0) continue;
    if (d < 0) { best = p; bestPricing = pricing; continue; }
    var ra = rank[p.target_type] || 0, rb = rank[best.target_type] || 0;
    if (ra > rb || (ra === rb && String(p.created_at).localeCompare(String(best.created_at)) > 0)) {
      best = p; bestPricing = pricing;
    }
  }
  return best ? { promo: best, pricing: bestPricing } : null;
}

function validatePromotionPayload_(payload, isUpdate) {
  var p = payload || {};
  if (!isUpdate || p.name !== undefined) {
    var nameStr = String(p.name || '').trim();
    if (!nameStr) return { ok: false, error: 'ชื่อโปรโมชั่นห้ามว่าง' };
    if (nameStr.length > 200) return { ok: false, error: 'ชื่อโปรโมชั่นยาวเกินไป (สูงสุด 200 ตัวอักษร)' };
    p.name = nameStr;
  }
  if (p.description !== undefined) {
    p.description = String(p.description || '').slice(0, 1000);
  }
  if (!isUpdate || p.discount_type !== undefined) {
    if (['fixed','percent'].indexOf(String(p.discount_type)) < 0)
      return { ok: false, error: 'discount_type ต้องเป็น fixed หรือ percent' };
  }
  if (!isUpdate || p.discount_value !== undefined) {
    var dv = Number(p.discount_value);
    if (!isFinite(dv) || dv <= 0) return { ok: false, error: 'discount_value ต้องมากกว่า 0' };
    if (p.discount_type === 'percent' && dv > 100) return { ok: false, error: 'discount_value (percent) ต้องไม่เกิน 100' };
    p.discount_value = dv;
  }
  if (!isUpdate || p.target_type !== undefined) {
    if (['all','product','variant'].indexOf(String(p.target_type)) < 0)
      return { ok: false, error: 'target_type ต้องเป็น all/product/variant' };
  }
  // Discount scope: 'item' (per-unit discount on targeted products — default/legacy) or
  // 'order_total' (a single deduction from the whole-order subtotal). Order-total is only
  // valid for conditional promos and ignores product/variant targeting entirely.
  var effModeForScope = (p.application_mode !== undefined)
    ? String(p.application_mode || 'direct').trim().toLowerCase()
    : (isUpdate ? undefined : 'direct');
  if (!isUpdate || p.discount_scope !== undefined) {
    var scope = String(p.discount_scope || 'item').trim().toLowerCase();
    if (['item','order_total'].indexOf(scope) < 0)
      return { ok: false, error: 'discount_scope ต้องเป็น item หรือ order_total' };
    p.discount_scope = scope;
  }
  var effScope = (p.discount_scope !== undefined) ? p.discount_scope : 'item';
  if (effScope === 'order_total') {
    // Guard: order-total discounts require a qualifying condition. Reject any attempt to
    // attach order-total behavior to a direct (unconditional) promotion.
    if (effModeForScope !== undefined && effModeForScope !== 'conditional')
      return { ok: false, error: 'ส่วนลดท้ายบิลใช้ได้เฉพาะโปรโมชั่นแบบมีเงื่อนไข' };
    // Order-total applies to the whole cart — product/variant targeting is meaningless.
    p.target_type = 'all';
    p.target = [];
  }
  var targetArr = Array.isArray(p.target) ? p.target : [];
  if (effScope !== 'order_total' && p.target_type !== 'all' && targetArr.length === 0)
    return { ok: false, error: 'ต้องเลือก target อย่างน้อย 1 รายการ' };
  // Validate target entries against snapshot (skipped for order-total, which forced 'all')
  if (effScope !== 'order_total' && (p.target_type === 'product' || p.target_type === 'variant')) {
    var snap = getSnap_();
    var prodMap = {};
    snap.forEach(function(prod){ prodMap[String(prod.id)] = prod; });
    for (var i = 0; i < targetArr.length; i++) {
      var t = targetArr[i] || {};
      var prod = prodMap[String(t.product_id)];
      if (!prod) return { ok: false, error: 'สินค้าใน target ไม่พบ: ' + t.product_id };
      if (p.target_type === 'variant') {
        var vk = String(t.variant_key || '');
        if (!vk) return { ok: false, error: 'variant target ต้องระบุ variant_key' };
        // Build all valid variant_keys from this product's variants
        var validKeys = enumerateVariantKeys_(prod);
        if (validKeys.indexOf(vk) < 0)
          return { ok: false, error: 'variant_key ไม่ตรงกับ variant ของสินค้า ' + prod.title + ': ' + vk };
      }
    }
  }
  // Application mode + qualifying condition (mirrors gift-rule condition validation).
  // Direct (unconditional) mode is the default and forces an empty condition so legacy
  // rows and direct promos never carry stray condition data.
  if (!isUpdate || p.application_mode !== undefined) {
    var mode = String(p.application_mode || 'direct').trim().toLowerCase();
    if (['direct','conditional'].indexOf(mode) < 0)
      return { ok: false, error: 'application_mode ต้องเป็น direct หรือ conditional' };
    p.application_mode = mode;
  }
  // Resolve the effective mode for condition validation (merged payloads may omit it).
  var effMode = (p.application_mode !== undefined) ? p.application_mode : 'direct';
  if (effMode === 'conditional') {
    if (['min_subtotal','required_products','required_variants'].indexOf(String(p.condition_type)) < 0)
      return { ok: false, error: 'ประเภทเงื่อนไขไม่ถูกต้อง' };
    var cj = p.condition_json || {};
    if (typeof cj === 'string') { try { cj = JSON.parse(cj); } catch(_) { cj = {}; } }
    if (!cj || typeof cj !== 'object') cj = {};
    if (p.condition_type === 'min_subtotal') {
      var minSub = Number(cj.min_subtotal);
      if (!isFinite(minSub) || minSub <= 0) return { ok: false, error: 'ต้องระบุยอดซื้อขั้นต่ำมากกว่า 0' };
      cj = { min_subtotal: minSub, calculation_base: 'after_discount_before_shipping' };
    } else if (p.condition_type === 'required_products') {
      if (!Array.isArray(cj.required_products) || !cj.required_products.length)
        return { ok: false, error: 'ต้องเลือกสินค้าเงื่อนไขอย่างน้อย 1 รายการ' };
      cj.match_mode = (cj.match_mode === 'any') ? 'any' : 'all';
    } else if (p.condition_type === 'required_variants') {
      if (!Array.isArray(cj.required_variants) || !cj.required_variants.length)
        return { ok: false, error: 'ต้องเลือกตัวเลือกเงื่อนไขอย่างน้อย 1 รายการ' };
      cj.match_mode = (cj.match_mode === 'any') ? 'any' : 'all';
    }
    // Validate condition entries against the product snapshot + reject duplicates.
    if (p.condition_type === 'required_products' || p.condition_type === 'required_variants') {
      var csnap = getSnap_();
      var cProdMap = {};
      csnap.forEach(function(prod){ cProdMap[String(prod.id)] = prod; });
      if (p.condition_type === 'required_products') {
        var seenCP = {};
        var normReqP = [];
        for (var cpi = 0; cpi < cj.required_products.length; cpi++) {
          var rqp = cj.required_products[cpi] || {};
          var cpid = String(rqp.product_id || '');
          if (!cProdMap[cpid]) return { ok: false, error: 'สินค้าเงื่อนไขไม่พบ: ' + cpid };
          if (seenCP[cpid]) return { ok: false, error: 'มีสินค้าเงื่อนไขซ้ำกัน' };
          seenCP[cpid] = true;
          var mq = Number(rqp.min_qty);
          if (!isFinite(mq) || Math.floor(mq) !== mq || mq < 1)
            return { ok: false, error: 'จำนวนขั้นต่ำของสินค้าเงื่อนไขต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป' };
          normReqP.push({ product_id: cpid, min_qty: mq });
        }
        cj.required_products = normReqP;
      } else {
        var seenCV = {};
        var normReqV = [];
        for (var cvi = 0; cvi < cj.required_variants.length; cvi++) {
          var rqv = cj.required_variants[cvi] || {};
          var cvpid = String(rqv.product_id || '');
          var cvk = String(rqv.variant_key || '');
          var cvProd = cProdMap[cvpid];
          if (!cvProd) return { ok: false, error: 'สินค้าเงื่อนไขไม่พบ: ' + cvpid };
          if (!cvk) return { ok: false, error: 'เงื่อนไขตัวเลือกต้องระบุ variant_key' };
          if (enumerateVariantKeys_(cvProd).indexOf(cvk) < 0)
            return { ok: false, error: 'variant_key เงื่อนไขไม่ตรงกับสินค้า ' + cvProd.title + ': ' + cvk };
          var cvKey = cvpid + '|' + cvk;
          if (seenCV[cvKey]) return { ok: false, error: 'มีตัวเลือกเงื่อนไขซ้ำกัน' };
          seenCV[cvKey] = true;
          var mqv = Number(rqv.min_qty);
          if (!isFinite(mqv) || Math.floor(mqv) !== mqv || mqv < 1)
            return { ok: false, error: 'จำนวนขั้นต่ำของตัวเลือกเงื่อนไขต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป' };
          normReqV.push({ product_id: cvpid, variant_key: cvk, min_qty: mqv });
        }
        cj.required_variants = normReqV;
      }
    }
    p.condition_json = cj;
  } else if (effMode === 'direct') {
    // Direct mode: strip any condition so it can never accidentally gate the discount,
    // and force per-item scope (order-total is conditional-only).
    p.condition_type = '';
    p.condition_json = {};
    p.discount_scope = 'item';
  }

  if (!isUpdate || p.starts_at !== undefined || p.ends_at !== undefined || p.no_end_date !== undefined) {
    var sw = _normalizeSchedule_({ starts_at: p.starts_at, ends_at: p.ends_at, no_end_date: p.no_end_date });
    var swCheck = _validateScheduleWindow_(sw.starts_at, sw.ends_at, sw.no_end_date);
    if (!swCheck.ok) return swCheck;
    p.starts_at = sw.starts_at;
    p.ends_at = sw.ends_at || '';
    p.no_end_date = sw.no_end_date;
  }
  return { ok: true, value: p };
}

function enumerateVariantKeys_(product) {
  var groups = (product && product.variants) || [];
  if (!groups.length) return [''];
  // Cartesian product of (groupName -> [optionLabel, ...])
  var combos = [{}];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var name = String(g.name || '');
    var opts = (g.options || []).map(function(o){ return String(o.label || ''); });
    var next = [];
    for (var c = 0; c < combos.length; c++) {
      for (var o = 0; o < opts.length; o++) {
        var copy = {};
        for (var k in combos[c]) if (combos[c].hasOwnProperty(k)) copy[k] = combos[c][k];
        copy[name] = opts[o];
        next.push(copy);
      }
    }
    combos = next;
  }
  return combos.map(function(sel){ return buildVariantKey_(sel); });
}

// Returns true if interval [a1,a2] overlaps [b1,b2]
// If a2 or b2 is empty/null, treat as +Infinity (no end date)
function intervalsOverlap_(a1, a2, b1, b2) {
  var aStart = Date.parse(a1) || 0;
  var bStart = Date.parse(b1) || 0;
  var aEnd = (a2 && Date.parse(a2)) ? Date.parse(a2) : Infinity;
  var bEnd = (b2 && Date.parse(b2)) ? Date.parse(b2) : Infinity;
  return aStart <= bEnd && bStart <= aEnd;
}

function targetsOverlap_(p1, p2) {
  if (p1.target_type === 'all' || p2.target_type === 'all') return true;
  var arr1 = Array.isArray(p1.target) ? p1.target : [];
  var arr2 = Array.isArray(p2.target) ? p2.target : [];
  // product vs product/variant — overlap if same product_id
  // variant vs variant — overlap if same (product_id, variant_key)
  for (var i = 0; i < arr1.length; i++) {
    for (var j = 0; j < arr2.length; j++) {
      var a = arr1[i] || {}, b = arr2[j] || {};
      if (String(a.product_id) !== String(b.product_id)) continue;
      if (p1.target_type === 'product' || p2.target_type === 'product') return true;
      // both variant — must match variant_key
      if (String(a.variant_key || '') === String(b.variant_key || '')) return true;
    }
  }
  return false;
}

// Overlap protection only guards two DIRECT (unconditional) promos from both being
// enabled on the same target at once — under best-price resolution one of them could
// never win, so it would be permanently dead weight and confuse admins. Conditional
// promos are exempt: they only apply when their condition is met, and when several
// promos match a line the best-price resolver deterministically picks one (no
// stacking). This is what makes "buy A, discount B" possible even when B already has
// a direct promo. Returns the conflicting promotion object, or null if none.
function findOverlappingPromotion_(payload, excludePromoId) {
  if (payload && payload.application_mode === 'conditional') return null;
  // includeDeleted=true forces a fresh sheet read — the cached list can be up to
  // 60 s stale, which would let two near-simultaneous creates both pass this check.
  var others = listPromotionsFromSheet_(true);
  for (var i = 0; i < others.length; i++) {
    var o = others[i];
    if (o.deleted_at) continue; // legacy soft-deleted rows
    if (excludePromoId && String(o.promotion_id) === String(excludePromoId)) continue;
    if (!o.enabled) continue;
    if (o.application_mode === 'conditional') continue;
    if (!intervalsOverlap_(payload.starts_at, payload.ends_at, o.starts_at, o.ends_at)) continue;
    if (!targetsOverlap_(payload, o)) continue;
    return o;
  }
  return null;
}

// Structured error payload for an overlap rejection — promotion.html renders a
// message naming the conflicting promotion from `conflict`.
function promoOverlapError_(conflict) {
  return { ok: false, error: 'PROMO_OVERLAP',
    conflict: { promotion_id: conflict.promotion_id, name: conflict.name,
                starts_at: conflict.starts_at, ends_at: conflict.ends_at,
                no_end_date: !!conflict.no_end_date, target_type: conflict.target_type } };
}

// Inject `promotion` and effective `final_price` into product (and each variant option) in-place
function applyPromotionsToProducts_(products, now) {
  if (!Array.isArray(products) || !products.length) return products;
  // Read promotions ONCE per call (already cached for 60s by listPromotionsFromSheet_).
  // Then build per-call indices so we don't re-evaluate status / re-scan targets for
  // every product × every variant combo (was O(P×C×N); now O(P×C) small-candidate scan).
  // The winner per product/variant is chosen by resolveBestPromotionForLine_ (best price
  // wins) over the bucketed candidates — same rule as cart/order/preview.
  var promos = listPromotionsFromSheet_(false);
  var allPromos = [];
  var byProduct = {}; // pid -> [promo,...]   (created_at desc)
  var byVariant = {}; // pid|vk -> [promo,...] (created_at desc)
  for (var ai = 0; ai < promos.length; ai++) {
    var ap = promos[ai];
    var apStat = getPromotionStatus_({
      enabled: ap.enabled ? 'TRUE' : 'FALSE',
      starts_at: ap.starts_at, ends_at: ap.ends_at,
      no_end_date: ap.no_end_date, deleted_at: ap.deleted_at
    }, now);
    if (apStat !== 'active') continue;
    // Conditional promos depend on the whole cart, so they cannot be baked into the
    // per-product snapshot. They surface via the cart eligibility preview instead.
    if (ap.application_mode === 'conditional') continue;
    if (ap.target_type === 'all') {
      allPromos.push(ap);
    } else if (ap.target_type === 'product') {
      var pArr = Array.isArray(ap.target) ? ap.target : [];
      for (var aj = 0; aj < pArr.length; aj++) {
        var apid = String(pArr[aj] && pArr[aj].product_id || '');
        if (!apid) continue;
        (byProduct[apid] = byProduct[apid] || []).push(ap);
      }
    } else if (ap.target_type === 'variant') {
      var vArr = Array.isArray(ap.target) ? ap.target : [];
      for (var ak = 0; ak < vArr.length; ak++) {
        var t = vArr[ak] || {};
        var vpid = String(t.product_id || '');
        if (!vpid) continue;
        var vkey = vpid + '|' + String(t.variant_key || '');
        (byVariant[vkey] = byVariant[vkey] || []).push(ap);
      }
    }
  }
  function pickBest(productId, variantKey, basePrice) {
    var pidStr = String(productId);
    var candidates = (byVariant[pidStr + '|' + String(variantKey || '')] || [])
      .concat(byProduct[pidStr] || [], allPromos);
    if (!candidates.length) return null;
    return resolveBestPromotionForLine_(candidates, productId, variantKey, basePrice, now, null);
  }

  for (var pi = 0; pi < products.length; pi++) {
    var prod = products[pi];
    // root (no variants selected) — variantKey = ''
    var rootBest = pickBest(prod.id, '', prod.price);
    if (rootBest) {
      prod.promotion = publicPromoSummary_(rootBest.promo);
      prod.final_price = rootBest.pricing.unit_final_price;
      prod.discount_amount = rootBest.pricing.unit_discount_amount;
    } else {
      prod.promotion = null;
      prod.final_price = Math.round(Number(prod.price) || 0);
      prod.discount_amount = 0;
    }
    // Per-variant-option
    var groups = prod.variants || [];
    if (groups.length) {
      var combos = enumerateVariantCombos_(prod);
      prod.variant_promotions = {};
      for (var ci = 0; ci < combos.length; ci++) {
        var c = combos[ci];
        var vk = buildVariantKey_(c.sel);
        var vBest = pickBest(prod.id, vk, c.basePrice);
        var pricing = vBest ? vBest.pricing : calcPromotionPrice_(c.basePrice, null);
        prod.variant_promotions[vk] = {
          promotion: vBest ? publicPromoSummary_(vBest.promo) : null,
          unit_base_price: pricing.unit_base_price,
          unit_final_price: pricing.unit_final_price,
          unit_discount_amount: pricing.unit_discount_amount
        };
      }
    }
  }
  return products;
}

function enumerateVariantCombos_(product) {
  var groups = (product && product.variants) || [];
  var basePrice = Number(product.price || 0);
  if (!groups.length) return [{ sel: {}, basePrice: basePrice }];
  var combos = [{ sel: {}, optsChosen: [] }];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var name = String(g.name || '');
    var opts = g.options || [];
    var next = [];
    for (var c = 0; c < combos.length; c++) {
      for (var o = 0; o < opts.length; o++) {
        var sel = {};
        for (var k in combos[c].sel) if (combos[c].sel.hasOwnProperty(k)) sel[k] = combos[c].sel[k];
        sel[name] = String(opts[o].label || '');
        next.push({ sel: sel, optsChosen: combos[c].optsChosen.concat([opts[o]]) });
      }
    }
    combos = next;
  }
  return combos.map(function(c){
    // Variant base price = price of the matched options (last-wins, mirroring submitOrderRpc)
    var bp = basePrice;
    for (var i = 0; i < c.optsChosen.length; i++) {
      var op = c.optsChosen[i];
      if (op.price !== undefined) bp = Number(op.price);
      else if (op.delta !== undefined) bp = basePrice + Number(op.delta || 0);
    }
    return { sel: c.sel, basePrice: bp };
  });
}

/* ---------- Conditional promotion evaluation ---------- */
// A conditional promotion applies only when its `condition_json` is satisfied by the
// whole cart. The qualifying condition (what the customer must BUY) is independent of
// the discount target (what RECEIVES the discount). This single evaluator is used by
// both the cart preview RPC and order submission so they can never diverge.
//
// `ctx` shares the gift engine's shape:
//   { items:[{product_id, variant_key, qty}], subtotal_after_promo }
// where subtotal_after_promo = subtotal after DIRECT discounts, before shipping.
function evaluatePromotionQualified_(promo, ctx) {
  if (!promo) return false;
  if (promo.application_mode !== 'conditional') return true; // direct: always qualifies
  var ct = promo.condition_type;
  var cj = promo.condition_json || {};
  if (ct === 'min_subtotal') {
    var minSub = Number(cj.min_subtotal || 0);
    if (minSub <= 0) return false;
    return Number(ctx.subtotal_after_promo || 0) >= minSub;
  }
  if (ct === 'required_products') return _promoRequiredMet_(cj.required_products, cj.match_mode, ctx, false);
  if (ct === 'required_variants') return _promoRequiredMet_(cj.required_variants, cj.match_mode, ctx, true);
  return false;
}

// Shared all/any matcher for required_products & required_variants conditions.
// match_mode 'all' (default): every entry's min_qty must be met.
// match_mode 'any': at least one entry's min_qty must be met.
// Missing/legacy match_mode defaults to 'all'.
function _promoRequiredMet_(req, matchMode, ctx, isVariant) {
  req = Array.isArray(req) ? req : [];
  if (!req.length) return false;
  var anyMode = String(matchMode) === 'any';
  for (var i = 0; i < req.length; i++) {
    var rq = req[i] || {};
    var minQ = Number(rq.min_qty || 1); if (minQ <= 0) minQ = 1;
    var totalQ = 0;
    for (var j = 0; j < ctx.items.length; j++) {
      var item = ctx.items[j];
      var same = String(item.product_id) === String(rq.product_id)
              && (!isVariant || String(item.variant_key || '') === String(rq.variant_key || ''));
      if (same) totalQ += Number(item.qty || 0);
    }
    var met = totalQ >= minQ;
    if (anyMode) { if (met) return true; }   // any: first satisfied entry qualifies
    else { if (!met) return false; }         // all: any unmet entry disqualifies
  }
  return anyMode ? false : true;
}

// Centralized cart pricing pipeline shared by submitOrderRpc and the eligibility preview.
// `ctxItems`: [{ product_id, variant_key, qty, raw_unit_price, title }].
// Two passes so conditional discounts never depend on themselves (no circularity):
//   Pass A — price each line with DIRECT promos only -> subtotal_after_direct.
//   (evaluate conditional promos against that subtotal -> qualified set)
//   Pass B — re-resolve each line among {direct} ∪ {qualified conditional} by
//            BEST PRICE WINS (lowest final price; tiebreak variant > product > all,
//            then newest created_at; no stacking) -> final line prices & subtotal.
function resolveCartPromotions_(ctxItems, now) {
  now = now || new Date();
  ctxItems = Array.isArray(ctxItems) ? ctxItems : [];
  var promos = listPromotionsFromSheet_(false);

  // Pass A — direct-only base pricing
  var subtotalAfterDirect = 0;
  var passA = [];
  for (var i = 0; i < ctxItems.length; i++) {
    var it = ctxItems[i] || {};
    var qty = it.qty;
    if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('INVALID_NORMALIZED_CART_QTY');
    var directBest = resolveBestPromotionForLine_(promos, it.product_id, it.variant_key, it.raw_unit_price, now, _promoIsDirect_);
    var dPricing = directBest ? directBest.pricing : calcPromotionPrice_(it.raw_unit_price, null);
    subtotalAfterDirect += dPricing.unit_final_price * qty;
    passA.push({ it: it, qty: qty });
  }

  var ctx = {
    items: ctxItems.map(function(x){
      var normalizedQty = (x || {}).qty;
      if (!Number.isSafeInteger(normalizedQty) || normalizedQty < 1) throw new Error('INVALID_NORMALIZED_CART_QTY');
      return {
        product_id: String((x || {}).product_id),
        variant_key: String((x || {}).variant_key || ''),
        qty: normalizedQty,
        title: (x || {}).title
      };
    }),
    subtotal_after_promo: subtotalAfterDirect,
    subtotal_before_shipping: subtotalAfterDirect
  };

  // Qualified conditional promos for this cart
  var qualifiedIds = {};
  for (var q = 0; q < promos.length; q++) {
    var cp = promos[q];
    if (cp.application_mode !== 'conditional') continue;
    if (!_promoIsActive_(cp, now)) continue;
    if (evaluatePromotionQualified_(cp, ctx)) qualifiedIds[String(cp.promotion_id)] = true;
  }
  var combinedFilter = function(p){
    if (!p) return false;
    if (_promoIsOrderTotal_(p)) return false;                     // order-total never applies per line
    if (p.application_mode !== 'conditional') return true;         // direct always eligible
    return !!qualifiedIds[String(p.promotion_id)];                 // conditional only if qualified
  };

  // Pass B — final per-line resolution among direct + qualified conditional
  var lines = [];
  var subtotal = 0;
  var appliedIds = {};
  for (var b = 0; b < passA.length; b++) {
    var row = passA[b];
    var bestB = resolveBestPromotionForLine_(promos, row.it.product_id, row.it.variant_key, row.it.raw_unit_price, now, combinedFilter);
    var promo = bestB ? bestB.promo : null;
    var pricing = bestB ? bestB.pricing : calcPromotionPrice_(row.it.raw_unit_price, null);
    var lineSub = pricing.unit_final_price * row.qty;
    subtotal += lineSub;
    if (promo) appliedIds[String(promo.promotion_id)] = true;
    lines.push({
      product_id: String(row.it.product_id),
      variant_key: String(row.it.variant_key || ''),
      qty: row.qty,
      unit_base_price: pricing.unit_base_price,
      unit_discount_amount: pricing.unit_discount_amount,
      unit_final_price: pricing.unit_final_price,
      subtotal: lineSub,
      promotion: promo || null
    });
  }

  // Order-total layer — applied ONCE to the post-line item subtotal, after per-line pricing.
  // Among qualified order-total conditional promos the single largest discount wins (no stacking).
  var orderTotalBest = resolveBestOrderTotalPromo_(promos, qualifiedIds, subtotal, now);
  var orderDiscount = null;
  if (orderTotalBest) {
    appliedIds[String(orderTotalBest.promo.promotion_id)] = true;
    orderDiscount = { promotion: orderTotalBest.promo, amount: orderTotalBest.amount };
  }
  var subtotalAfterOrderDiscount = subtotal - (orderDiscount ? orderDiscount.amount : 0);

  return {
    lines: lines,
    subtotal: subtotal,
    subtotal_after_direct: subtotalAfterDirect,
    order_discount: orderDiscount,
    subtotal_after_order_discount: subtotalAfterOrderDiscount,
    applied_promotion_ids: Object.keys(appliedIds),
    qualified_conditional_ids: Object.keys(qualifiedIds),
    promos: promos,
    ctx: ctx
  };
}

function publicPromoSummary_(p) {
  return {
    promotion_id: p.promotion_id,
    name: p.name,
    discount_type: p.discount_type,
    discount_value: p.discount_value,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    no_end_date: !!p.no_end_date,
    application_mode: p.application_mode || 'direct',
    condition_type: p.condition_type || '',
    discount_scope: p.discount_scope || 'item'
  };
}

/* ---------- Promotion RPCs ---------- */

function listPromotionsRpc(token, opts) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var promos = listPromotionsFromSheet_(false);
    var now = new Date();
    var withStatus = promos.map(function(p){
      var statusInput = { enabled: p.enabled ? 'TRUE' : 'FALSE', starts_at: p.starts_at, ends_at: p.ends_at, no_end_date: p.no_end_date, deleted_at: p.deleted_at };
      return Object.assign({}, p, { status: getPromotionStatus_(statusInput, now) });
    });
    var q = opts && opts.q ? String(opts.q).toLowerCase() : '';
    var statusFilter = opts && opts.status ? String(opts.status) : 'all';
    if (q) withStatus = withStatus.filter(function(p){ return String(p.name||'').toLowerCase().indexOf(q) >= 0; });
    if (statusFilter && statusFilter !== 'all') withStatus = withStatus.filter(function(p){ return p.status === statusFilter; });
    var total = withStatus.length;
    if (opts && opts.limit) {
      var off = Math.max(0, Number(opts.offset)||0);
      var lim = Math.min(100, Math.max(1, Number(opts.limit)));
      withStatus = withStatus.slice(off, off+lim);
    }
    return { ok: true, promotions: withStatus, total: total };
  } catch(err) { return { ok: false, error: String(err) }; }
}

function getPromotionRpc(token, promotionId) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var promos = listPromotionsFromSheet_(false);
    var match = promos.filter(function(p){ return String(p.promotion_id) === String(promotionId); })[0];
    if (!match) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    return { ok: true, promotion: match };
  } catch(err) { return { ok: false, error: String(err) }; }
}

function createPromotionRpc(token, payload) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var v = validatePromotionPayload_(payload || {}, false);
    if (!v.ok) return v;
    var p = v.value;
    // Serialize the overlap check + append: without the lock two concurrent creates
    // can both pass the check and persist overlapping direct promotions.
    var _createLock = LockService.getScriptLock();
    if (!_createLock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
    try {
    if (p.enabled !== false) {
      var _createConflict = findOverlappingPromotion_(p, null);
      if (_createConflict) return promoOverlapError_(_createConflict);
    }
    var sh = sheetPromotions_();
    var promoId = 'promo_' + uuid_().replace(/-/g, '').slice(0, 16);
    var now = nowISO_();
    sh.appendRow([
      promoId,
      sanitizeSheetCell_(p.name),
      sanitizeSheetCell_(p.description || ''),
      String(p.discount_type),
      Number(p.discount_value),
      String(p.target_type),
      JSON.stringify(p.target || []),
      String(p.starts_at || ''),
      String(p.ends_at || ''),
      (p.enabled === false) ? 'FALSE' : 'TRUE',
      now, now,
      '', // created_by — no longer maintained
      '', // updated_by — no longer maintained
      '', // deleted_at — no longer used (hard delete)
      p.no_end_date ? 'TRUE' : 'FALSE',
      String(p.application_mode || 'direct'),
      String(p.condition_type || ''),
      JSON.stringify(p.condition_json || {}),
      String(p.discount_scope || 'item')
    ]);
    } finally {
      try { _createLock.releaseLock(); } catch(_) {}
    }
    invalidatePromoCache_();
    rebuildSnap_();
    enqueueLog_('promotion.create', { category:['database'], type:['creation'],
      outcome:'success', route:'promotion', rpc:'createPromotionRpc',
      userId:sess.userId, sessionId:token,
      meta:{ resource_type:'promotion', resource_id_hash: hashForLog_(promoId, 'pr_') } }, sess.logCtx);
    return { ok: true, promotion_id: promoId };
  } catch(err) { return { ok: false, error: String(err.message || err) }; }
}

function updatePromotionRpc(token, promotionId, payload) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var sh = sheetPromotions_();
    var n = sh.getLastRow();
    if (n < 2) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    var ids = sh.getRange(2, 1, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(promotionId));
    if (idx < 0) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    var rowNo = idx + 2;
    var row = sh.getRange(rowNo, 1, 1, 20).getValues()[0];
    var existing = rowToPromotion_(row);

    var merged = Object.assign({}, existing, payload || {});
    var v = validatePromotionPayload_(merged, true);
    if (!v.ok) return v;
    var p = v.value;
    // Same serialization as createPromotionRpc — overlap check + write must be atomic.
    var _updateLock = LockService.getScriptLock();
    if (!_updateLock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
    try {
    if (p.enabled !== false) {
      var _updateConflict = findOverlappingPromotion_(p, promotionId);
      if (_updateConflict) return promoOverlapError_(_updateConflict);
    }

    var now = nowISO_();
    sh.getRange(rowNo, 2, 1, 19).setValues([[
      sanitizeSheetCell_(p.name),
      sanitizeSheetCell_(p.description || ''),
      String(p.discount_type),
      Number(p.discount_value),
      String(p.target_type),
      JSON.stringify(p.target || []),
      String(p.starts_at || ''),
      String(p.ends_at || ''),
      (p.enabled === false) ? 'FALSE' : 'TRUE',
      existing.created_at || now,
      now,
      '', // created_by — no longer maintained
      '', // updated_by — no longer maintained
      '', // deleted_at — no longer used (hard delete)
      p.no_end_date ? 'TRUE' : 'FALSE',
      String(p.application_mode || 'direct'),
      String(p.condition_type || ''),
      JSON.stringify(p.condition_json || {}),
      String(p.discount_scope || 'item')
    ]]);
    } finally {
      try { _updateLock.releaseLock(); } catch(_) {}
    }
    invalidatePromoCache_();
    rebuildSnap_();
    enqueueLog_('promotion.update', { category:['database'], type:['change'],
      outcome:'success', route:'promotion', rpc:'updatePromotionRpc',
      userId:sess.userId, sessionId:token,
      meta:{ resource_type:'promotion', resource_id_hash: hashForLog_(promotionId, 'pr_') } }, sess.logCtx);
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err.message || err) }; }
}

function togglePromotionRpc(token, promotionId, enabled) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var sh = sheetPromotions_();
    var n = sh.getLastRow();
    if (n < 2) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    var ids = sh.getRange(2, 1, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(promotionId));
    if (idx < 0) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    var rowNo = idx + 2;
    var row = sh.getRange(rowNo, 1, 1, 20).getValues()[0];
    var existing = rowToPromotion_(row);
    // Same serialization as createPromotionRpc — overlap check + write must be atomic.
    var _toggleLock = LockService.getScriptLock();
    if (!_toggleLock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
    try {
    if (enabled) {
      var _toggleConflict = findOverlappingPromotion_(existing, promotionId);
      if (_toggleConflict) return promoOverlapError_(_toggleConflict);
    }
    sh.getRange(rowNo, 10).setValue(enabled ? 'TRUE' : 'FALSE');
    sh.getRange(rowNo, 12).setValue(nowISO_());
    } finally {
      try { _toggleLock.releaseLock(); } catch(_) {}
    }
    invalidatePromoCache_();
    rebuildSnap_();
    auditLog_('promotion.toggle', { category:['database'], type:['change'],
      outcome:'success', route:'promotion', rpc:'togglePromotionRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'promotion', resource_id_hash: hashForLog_(promotionId, 'pr_'), enabled: !!enabled } },
      _sess.logCtx);
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err.message || err) }; }
}

// Hard delete: row is removed entirely. Old orders carry promotion snapshots
// in items_json so deletion never affects historical display.
function deletePromotionRpc(token, promotionId) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var sh = sheetPromotions_();
    var n = sh.getLastRow();
    if (n < 2) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    var ids = sh.getRange(2, 1, n - 1, 1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(promotionId));
    if (idx < 0) return { ok: false, error: 'ไม่พบโปรโมชั่น' };
    sh.deleteRow(idx + 2);
    invalidatePromoCache_();
    rebuildSnap_();
    auditLog_('promotion.delete', { category:['database'], type:['deletion'],
      outcome:'success', route:'promotion', rpc:'deletePromotionRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'promotion', resource_id_hash: hashForLog_(promotionId, 'pr_') } },
      _sess.logCtx);
    return { ok: true };
  } catch(err) { return { ok: false, error: String(err.message || err) }; }
}

/* ---------- items_json v2 normalizer ----------
 * items_json may contain product lines and gift lines.
 * Old entries without line_type are treated as products.
 * All readers go through _normalizeOrderItems_; all writers stamp line_type explicitly.
 */
function _normalizeOrderItems_(rawArr) {
  if (!Array.isArray(rawArr)) return [];
  return rawArr.map(function(it){
    if (!it || typeof it !== 'object') return null;
    var t = it.line_type === 'gift' ? 'gift' : 'product';
    if (it.line_type !== t) it = Object.assign({}, it, { line_type: t });
    return it;
  }).filter(Boolean);
}
function _splitOrderLines_(items) {
  var prods = [], gifts = [];
  _normalizeOrderItems_(items).forEach(function(it){
    if (it.line_type === 'gift') gifts.push(it); else prods.push(it);
  });
  return { products: prods, gifts: gifts };
}
function _getProductLinesFromItems_(items) { return _splitOrderLines_(items).products; }
function _getGiftLinesFromItems_(items)    { return _splitOrderLines_(items).gifts; }

// Read-modify-write of an order's items_json. Caller must hold ScriptLock.
// updaterFn(items) must return { items: <new array>, result?: any } or just <new array>.
function _updateOrderItemsJsonUnlocked_(orderId, updaterFn) {
  try {
    var sh = sheetOrders_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบคำสั่งซื้อ' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(orderId));
    if (idx < 0) return { ok:false, error:'ไม่พบคำสั่งซื้อ' };
    var rowNo = idx + 2;
    var raw = String(sh.getRange(rowNo, 19).getValue() || '[]');
    var items;
    try { items = _normalizeOrderItems_(JSON.parse(raw)); }
    catch (_) { return { ok:false, error:'items_json เสียหาย' }; }
    var ret = updaterFn(items);
    var newItems = Array.isArray(ret) ? ret : (ret && ret.items);
    if (!Array.isArray(newItems)) return { ok:false, error:'updater ต้องคืน array' };
    sh.getRange(rowNo, 19).setValue(JSON.stringify(newItems));
    sh.getRange(rowNo, 3).setValue(nowISO_()); // updated_at
    return { ok:true, result: ret && ret.result, rowNo: rowNo };
  } catch(err) {
    return { ok:false, error: String(err.message || err) };
  }
}

// Atomic read-modify-write of an order's items_json under LockService.
function _updateOrderItemsJson_(orderId, updaterFn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    return _updateOrderItemsJsonUnlocked_(orderId, updaterFn);
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

function rowToOrder_(r) {
  return {
    order_id:                  String(r[0]||''),
    created_at:                String(r[1]||''),
    updated_at:                String(r[2]||''),
    status:                    String(r[3]||'unpaid'),
    customer_name:             decryptField_(String(r[4]||'')),
    customer_phone:            decryptField_(String(r[5]||'')),
    customer_contact_platform: String(r[6]||''),
    shipping_name:             decryptField_(String(r[7]||'')),
    shipping_address:          decryptField_(String(r[8]||'')),
    shipping_district:         decryptField_(String(r[9]||'')),
    shipping_amphoe:           decryptField_(String(r[10]||'')),
    shipping_province:         decryptField_(String(r[11]||'')),
    shipping_postal_code:      decryptField_(String(r[12]||'')),
    customer_notes:            decryptField_(String(r[13]||'')),
    shipping_fee:              Number(r[14]||0),
    subtotal:                  Number(r[15]||0),
    total:                     Number(r[16]||0),
    shipping_method_id:        String(r[17]||''),
    items:          (function(){ try{ return _normalizeOrderItems_(JSON.parse(String(r[18]||'[]'))); }catch(_){ return []; } })(),
    status_history: (function(){ try{ return JSON.parse(String(r[19]||'[]')); }catch(_){ return []; } })(),
    shipping_info:  (function(){ try{ return JSON.parse(String(r[20]||'[]')); }catch(_){ return []; } })(),
    customer_contact:          decryptField_(String(r[21]||'')),
    token:                     decryptOrderTokenCell_(r[22]),
    slip_drive_file_id:        String(r[23]||''),
    token_expires_at:          String(r[24]||''),
    tracking:       (function(){ try{ var v = r[25] ? decryptField_(String(r[25])) : ''; return v ? JSON.parse(v) : null; }catch(_){ return null; } })(),
    // Actual fulfillment carrier override (plaintext JSON, no PII). null for legacy orders → callers fall back to shipping_info.
    fulfillment_shipping: (function(){ try{ var v = String(r[26]||''); return v ? JSON.parse(v) : null; }catch(_){ return null; } })(),
    // Order-total (whole-order) promotion discount snapshot (plaintext JSON, no PII).
    // null for legacy orders / orders with no order-total promo. Shape: { promotion, amount }.
    order_discount: (function(){ try{ var v = String(r[27]||''); return v ? JSON.parse(v) : null; }catch(_){ return null; } })()
  };
}

// Zero-trust order submission: frontend sends only IDs + qty + variants.
// All monetary values are calculated server-side from the product snapshot and shipping sheet.
// Idempotency cache for submitOrderRpc. Keyed by client_order_id (UUID from frontend).
// TTL 10 minutes — long enough to absorb retries from network drops or button re-clicks,
// short enough that the cache stays small. On hit we return the cached prior response
// with error:'DUPLICATE_ORDER' so the frontend can treat it as success.
var IDEMPOTENCY_PREFIX = 'IDEMPOTENCY_ORD_';
var IDEMPOTENCY_TTL    = 600;

// Public checkout resource limits. These are enforced before pricing, promotions,
// gifts, shipping, or sheet writes so hostile payloads cannot amplify GAS work.
var MAX_ORDER_LINES               = 100;
var MAX_QTY_PER_LINE              = 9999;
var MAX_QTY_PER_PRODUCT_VARIANT   = 9999;
var MAX_QTY_PER_PRODUCT           = 9999;
var MAX_TOTAL_ORDER_QTY           = 50000;
var MAX_SAFE_INTEGER_TEXT_        = '9007199254740991';

function parseBoundedPositiveInteger_(value, maxValue) {
  var n;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      return { ok:false, error:'INVALID_QTY' };
    }
    n = value;
  } else if (typeof value === 'string') {
    var s = value.trim();
    if (!/^[1-9]\d*$/.test(s)) return { ok:false, error:'INVALID_QTY' };
    // Reject unsafe decimal strings before Number() can round them.
    if (s.length > MAX_SAFE_INTEGER_TEXT_.length
        || (s.length === MAX_SAFE_INTEGER_TEXT_.length && s > MAX_SAFE_INTEGER_TEXT_)) {
      return { ok:false, error:'INVALID_QTY' };
    }
    n = Number(s);
    if (!Number.isSafeInteger(n) || n < 1) return { ok:false, error:'INVALID_QTY' };
  } else {
    return { ok:false, error:'INVALID_QTY' };
  }
  if (maxValue !== undefined && n > maxValue) {
    return { ok:false, error:'QTY_LIMIT_EXCEEDED', limit:maxValue };
  }
  return { ok:true, value:n };
}

function _isPlainObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.toString.call(value) === '[object Object]';
}

// Resolve a customer selection exclusively against the authoritative product schema.
// Every current variant group is required; unknown groups/options fail closed.
function resolveServerVariantSelection_(product, rawSelection) {
  var groups = product && Array.isArray(product.variants) ? product.variants : [];
  var selection = (rawSelection === undefined || rawSelection === null) ? {} : rawSelection;
  if (!_isPlainObject_(selection)) return { ok:false, error:'INVALID_VARIANT_OPTION' };

  var byName = {};
  for (var gi = 0; gi < groups.length; gi++) {
    var groupName = String((groups[gi] || {}).name || '');
    byName[groupName] = groups[gi];
  }
  var clientKeys = Object.keys(selection);
  for (var ck = 0; ck < clientKeys.length; ck++) {
    if (!Object.prototype.hasOwnProperty.call(byName, clientKeys[ck])) {
      return { ok:false, error:'INVALID_VARIANT_GROUP', variant_group:clientKeys[ck] };
    }
  }

  var basePrice = Number((product || {}).price || 0);
  var variantPrice = null;
  var variantWeight = null;
  var variantImgFileId = '';
  var variantImgUrl = '';
  var selected = {};
  var infoParts = [];
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i] || {};
    var name = String(group.name || '');
    if (!Object.prototype.hasOwnProperty.call(selection, name)
        || selection[name] === undefined || selection[name] === null || selection[name] === '') {
      return { ok:false, error:'VARIANT_SELECTION_REQUIRED', variant_group:name };
    }
    var chosen = selection[name];
    var options = Array.isArray(group.options) ? group.options : [];
    var option = null;
    for (var oi = 0; oi < options.length; oi++) {
      if (options[oi] && options[oi].label === chosen) { option = options[oi]; break; }
    }
    if (!option) return { ok:false, error:'INVALID_VARIANT_OPTION', variant_group:name };

    selected[name] = option.label;
    infoParts.push(name + ': ' + option.label);
    // Preserve the established checkout semantics for valid multi-group products.
    if (option.price !== undefined) variantPrice = Number(option.price);
    else if (option.delta !== undefined) variantPrice = basePrice + Number(option.delta || 0);
    if (Number(option.weight_grams) > 0) variantWeight = Number(option.weight_grams);
    if (!variantImgFileId && option.image_file_id) variantImgFileId = option.image_file_id;
    if (!variantImgUrl && option.image) variantImgUrl = option.image;
  }

  var rawUnitPrice = variantPrice !== null ? variantPrice : basePrice;
  var itemWeight = variantWeight !== null ? variantWeight : Number((product || {}).weight_grams || 0);
  var itemImgFileId = variantImgFileId || (product || {}).image_drive_file_id || '';
  var itemImgUrl = variantImgFileId
    ? (variantImgUrl || (product || {}).image_url || '')
    : (variantImgUrl || (product || {}).image_url || '');
  return {
    ok:true,
    selected_variants:selected,
    variant_key:buildVariantKey_(selected),
    variant_info:infoParts.join(', '),
    raw_unit_price:rawUnitPrice,
    item_weight:itemWeight,
    image_drive_file_id:itemImgFileId,
    image_url:itemImgUrl
  };
}

// Shared zero-trust cart boundary for submit + both public preview RPCs.
function normalizeOrderCart_(rawItems, productMap) {
  if (rawItems === undefined || rawItems === null) rawItems = [];
  if (!Array.isArray(rawItems)) return { ok:false, error:'INVALID_ITEMS' };
  if (!rawItems.length) return { ok:true, items:[], total_qty:0, by_product:{}, by_variant:{} };
  if (rawItems.length > MAX_ORDER_LINES) {
    return { ok:false, error:'TOO_MANY_ITEMS', limit:MAX_ORDER_LINES, actual:rawItems.length };
  }

  var out = [];
  var byProduct = {};
  var byVariant = {};
  var totalQty = 0;
  for (var i = 0; i < rawItems.length; i++) {
    var raw = rawItems[i];
    if (!_isPlainObject_(raw)) return { ok:false, error:'INVALID_ITEMS', item_index:i };
    var qtyR = parseBoundedPositiveInteger_(raw.qty, MAX_QTY_PER_LINE);
    if (!qtyR.ok) {
      var qtyError = { ok:false, error:qtyR.error, item_index:i, product_id:String(raw.product_id || '') };
      if (qtyR.limit !== undefined) qtyError.limit = qtyR.limit;
      return qtyError;
    }
    var productId = String(raw.product_id || '');
    var product = productMap && productMap[productId];
    if (!product) return { ok:false, error:'PRODUCT_NOT_FOUND', item_index:i, product_id:productId };
    var variantR = resolveServerVariantSelection_(product, raw.selected_variants);
    if (!variantR.ok) {
      return {
        ok:false, error:variantR.error, item_index:i, product_id:productId,
        variant_group:variantR.variant_group || ''
      };
    }

    var qty = qtyR.value;
    var variantAggregateKey = productId + '::' + variantR.variant_key;
    byVariant[variantAggregateKey] = (byVariant[variantAggregateKey] || 0) + qty;
    if (byVariant[variantAggregateKey] > MAX_QTY_PER_PRODUCT_VARIANT) {
      return {
        ok:false, error:'QTY_LIMIT_EXCEEDED', scope:'product_variant', item_index:i,
        product_id:productId, variant_key:variantR.variant_key,
        limit:MAX_QTY_PER_PRODUCT_VARIANT, actual:byVariant[variantAggregateKey]
      };
    }
    byProduct[productId] = (byProduct[productId] || 0) + qty;
    if (byProduct[productId] > MAX_QTY_PER_PRODUCT) {
      return {
        ok:false, error:'QTY_LIMIT_EXCEEDED', scope:'product', item_index:i,
        product_id:productId, limit:MAX_QTY_PER_PRODUCT, actual:byProduct[productId]
      };
    }
    totalQty += qty;
    if (totalQty > MAX_TOTAL_ORDER_QTY) {
      return {
        ok:false, error:'QTY_LIMIT_EXCEEDED', scope:'order', item_index:i,
        limit:MAX_TOTAL_ORDER_QTY, actual:totalQty
      };
    }

    out.push({
      prod:product,
      qty:qty,
      selectedVariants:variantR.selected_variants,
      variantKey:variantR.variant_key,
      rawUnitPrice:variantR.raw_unit_price,
      itemWeight:variantR.item_weight,
      variant_info:variantR.variant_info,
      itemImgFileId:variantR.image_drive_file_id,
      itemImgUrl:variantR.image_url
    });
  }
  return { ok:true, items:out, total_qty:totalQty, by_product:byProduct, by_variant:byVariant };
}

function _idempotencyKey_(clientOrderId) {
  return IDEMPOTENCY_PREFIX + String(clientOrderId).slice(0, 80);
}
function _idempotencyLookup_(clientOrderId) {
  if (!clientOrderId) return null;
  try {
    var raw = CacheService.getScriptCache().get(_idempotencyKey_(clientOrderId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(_) { return null; }
}
function _idempotencyStore_(clientOrderId, result) {
  if (!clientOrderId || !result) return;
  try {
    // Strip __timings before caching — debug-only, not part of the durable contract.
    var copy = Object.assign({}, result);
    delete copy.__timings;
    CacheService.getScriptCache().put(_idempotencyKey_(clientOrderId), JSON.stringify(copy), IDEMPOTENCY_TTL);
  } catch(_) {}
}

function submitOrderRpc(payload) {
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  // --- Phase 5 idempotency: short-circuit on duplicate client_order_id ---
  var __clientOrderId = payload && payload.client_order_id ? String(payload.client_order_id).trim() : '';
  if (__clientOrderId && !/^[A-Za-z0-9_\-]{8,80}$/.test(__clientOrderId)) __clientOrderId = ''; // ignore malformed
  if (__clientOrderId) {
    var __dup = _idempotencyLookup_(__clientOrderId);
    if (__dup) {
      var __dupResp = Object.assign({}, __dup, { ok:false, error:'DUPLICATE_ORDER' });
      try { Logger.log('submitOrderRpc DUPLICATE_ORDER hit for client_order_id=' + __clientOrderId); } catch(_) {}
      // Split-order responses carry `orders: [...]` with no top-level order_id —
      // log the first split order's id so the audit trail isn't an empty hash.
      var __dupLogId = __dup.order_id
        || (Array.isArray(__dup.orders) && __dup.orders.length ? __dup.orders[0].order_id : '');
      auditLog_('order.submit.duplicate', { category:['order'], type:['creation'],
        outcome:'unknown', route:'index', rpc:'submitOrderRpc',
        meta:{ order_id_hash: hashForLog_(__dupLogId, 'o_'),
               split_count: Array.isArray(__dup.orders) ? __dup.orders.length : undefined } },
        sanitizeClientLogContext_(payload && payload.client_log_context));
      return __dupResp;
    }
  }
  // --- Phase 1 timing diagnostics ---
  var __t0 = Date.now();
  var __tPrev = __t0;
  var __reqId = 'OREQ-' + __t0.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var __timings = [];
  var __t = function(label) {
    var nowMs = Date.now();
    __timings.push({ step: label, ms_step: nowMs - __tPrev, ms_total: nowMs - __t0 });
    __tPrev = nowMs;
  };
  var __debugTimings = false;
  try { __debugTimings = String(SP.getProperty('DEBUG_ORDER_TIMINGS') || '').toLowerCase() === 'true'; } catch(_) {}
  // Sanitized client log context (storefront passes payload.client_log_context).
  // Never persisted to the order — used only for the activity log event.
  var __logCtx = sanitizeClientLogContext_(payload && payload.client_log_context);
  var __finishTimings = function(result) {
    try {
      __t('return');
      Logger.log('[' + __reqId + '] submitOrderRpc timings (total ' + (Date.now() - __t0) + 'ms): ' + JSON.stringify(__timings));
      if (__debugTimings && result && typeof result === 'object') {
        result.__timings = { req_id: __reqId, total_ms: Date.now() - __t0, steps: __timings };
      }
    } catch(_) {}
    try {
      if (result && typeof result === 'object') {
        if (result.ok) {
          enqueueLog_('order.submit.success', { category:['order'], type:['creation'],
            outcome:'success', route:'index', rpc:'submitOrderRpc',
            meta:{ order_id_hash: hashForLog_(result.order_id, 'o_'),
                   order_token_hash: hashForLog_(result.token, 't_'),
                   gifts_attached: Array.isArray(result.gifts_attached) ? result.gifts_attached.length : 0 } }, __logCtx);
        } else {
          enqueueLog_('order.submit.fail', { category:['order'], type:['creation'],
            outcome:'failure', route:'index', rpc:'submitOrderRpc',
            meta:{ reason: safeLogString_(result.error, 80) } }, __logCtx);
        }
      }
    } catch(_) {}
    return result;
  };
  // --- end timing diagnostics ---
  try {
    assertConfig_();
    const sh  = sheetOrders_();
    const p   = payload || {};
    // --- INPUT VALIDATION ---
    var ALL_KNOWN_PLATFORMS = ['facebook','instagram','line','twitter','tiktok','other'];
    var platStr = String(p.customer_contact_platform||'');
    if (platStr !== '') {
      var siteCfgPlatform = readSiteConfig_();
      var allowedPlatforms = (Array.isArray(siteCfgPlatform.contact_platforms) && siteCfgPlatform.contact_platforms.length > 0)
        ? siteCfgPlatform.contact_platforms
        : ALL_KNOWN_PLATFORMS;
      var platR = normalizeEnum_(platStr, allowedPlatforms, 'ช่องทางติดต่อ');
      if (!platR.ok) return { ok:false, error:platR.error };
      p.customer_contact_platform = platR.value;
    }
    if (p.customer_notes) {
      var cnR = normalizeMultilineText_(p.customer_notes, { maxLen:VLEN.LONG, fieldName:'หมายเหตุ', allowEmpty:true });
      if (!cnR.ok) return { ok:false, error:cnR.error };
      p.customer_notes = cnR.value;
    }
    // Required customer + shipping fields — must be present + non-empty after trim.
    var plainPii = [
      { f:'customer_name',     ml:VLEN.SHORT,  fn:'ชื่อผู้สั่ง' },
      { f:'shipping_name',     ml:VLEN.SHORT,  fn:'ชื่อผู้รับ' },
      { f:'shipping_address',  ml:VLEN.MEDIUM, fn:'ที่อยู่' },
      { f:'shipping_district', ml:VLEN.SHORT,  fn:'ตำบล/แขวง' },
      { f:'shipping_amphoe',   ml:VLEN.SHORT,  fn:'อำเภอ/เขต' },
      { f:'shipping_province', ml:VLEN.SHORT,  fn:'จังหวัด' }
    ];
    for (var pfi = 0; pfi < plainPii.length; pfi++) {
      var pf = plainPii[pfi];
      var pfR = normalizePlainText_(p[pf.f], { maxLen:pf.ml, fieldName:pf.fn });
      if (!pfR.ok) return { ok:false, error:pfR.error };
      p[pf.f] = pfR.value;
    }
    var phR = normalizePhone_(p.customer_phone);
    if (!phR.ok) return { ok:false, error:phR.error };
    p.customer_phone = phR.value;
    var pcR = normalizePostalCode_(p.shipping_postal_code);
    if (!pcR.ok) return { ok:false, error:pcR.error };
    p.shipping_postal_code = pcR.value;
    if (p.customer_contact) {
      var ccR = normalizePlainText_(p.customer_contact, { maxLen:VLEN.SHORT, fieldName:'ข้อมูลติดต่อ', allowEmpty:true });
      if (!ccR.ok) return { ok:false, error:ccR.error };
      p.customer_contact = ccR.value;
    }
    // --- END VALIDATION ---
    __t('validation');
    const now = nowISO_();
    const orderId = genOrderId_();
    const token   = genToken_();

    // ====================================================================
    // PREPARE PHASE — pure compute, no sheet writes, no locks
    // ====================================================================

    // 1. Build product map from snapshot
    const snap = getSnap_();
    const prodMap = {};
    snap.forEach(function(prod){ prodMap[prod.id] = prod; });
    __t('snap_loaded');

    const submitNow = new Date();
    const inItems = (p.items === undefined || p.items === null) ? [] : p.items;

    // 2. Process items — one shared boundary validates qty + variants and derives every
    // price/weight/image field from the authoritative product snapshot.
    //    Variant resolution (price/weight/image) is done per line first; promotion pricing
    //    (direct + qualified conditional) is then computed for the whole cart at once via
    //    resolveCartPromotions_ — the SAME pipeline the eligibility preview uses, so preview
    //    and order can never diverge. Promotion is snapshotted into items_json so old orders
    //    remain stable even if the promotion is later edited or deleted.
    var normalizedCart = normalizeOrderCart_(inItems, prodMap);
    if (!normalizedCart.ok) return __finishTimings(normalizedCart);
    const preItems = normalizedCart.items;
    var totalWeightGrams = preItems.reduce(function(sum, item) {
      return sum + item.itemWeight * item.qty;
    }, 0);

    if (preItems.length === 0) return __finishTimings({ ok:false, error:'ไม่พบสินค้าที่ถูกต้องในคำสั่งซื้อ' });

    // Cart-level promotion resolution (direct + qualified conditional). Lines come back in
    // the same order as preItems.
    const cartPricing = resolveCartPromotions_(preItems.map(function(pi){
      return { product_id: pi.prod.id, variant_key: pi.variantKey, qty: pi.qty, raw_unit_price: pi.rawUnitPrice, title: pi.prod.title };
    }), submitNow);
    var subtotal = cartPricing.subtotal;
    // Order-total (whole-order) promotion discount — applied once to the item subtotal,
    // after per-line pricing and before shipping. Snapshot for persistence + response.
    var orderDiscountObj = cartPricing.order_discount;   // { promotion, amount } | null
    var orderDiscountAmount = orderDiscountObj ? Number(orderDiscountObj.amount || 0) : 0;
    var orderDiscountSnap = orderDiscountObj
      ? { promotion: publicPromoSummary_(orderDiscountObj.promotion), amount: orderDiscountAmount }
      : null;
    const outItems = preItems.map(function(pi, idx) {
      const ln = cartPricing.lines[idx] || {};
      const promo = ln.promotion || null;
      return {
        line_type:         'product',
        product_id:        pi.prod.id,
        title:             pi.prod.title,
        variant_info:      pi.variant_info,
        selected_variants: pi.selectedVariants,
        variant_key:       pi.variantKey,
        // Promotion-aware pricing snapshot
        unit_base_price:     ln.unit_base_price,
        unit_discount_amount: ln.unit_discount_amount,
        unit_final_price:    ln.unit_final_price,
        // Backward-compat: legacy display code reads `unit_price` and `subtotal`
        unit_price:        ln.unit_final_price,
        qty:               pi.qty,
        subtotal:          ln.subtotal,
        promotion:         promo ? publicPromoSummary_(promo) : null,
        image_drive_file_id: pi.itemImgFileId,
        image_url:           pi.itemImgUrl,
        _itemWeight:         pi.itemWeight
      };
    });
    __t('items_processed');

    // 2a. Sale Window check — reject items not currently sellable
    for (var swi = 0; swi < outItems.length; swi++) {
      var swProd = prodMap[outItems[swi].product_id];
      if (!swProd) continue;
      var swStatus = getProductSaleStatus_(swProd, submitNow);
      if (swStatus !== 'active') {
        var msg;
        if (swStatus === 'scheduled') msg = 'สินค้านี้ยังไม่เปิดขาย';
        else if (swStatus === 'ended') msg = 'สินค้านี้สิ้นสุดการขายแล้ว';
        else msg = 'สินค้านี้ไม่พร้อมจำหน่าย';
        return __finishTimings({
          ok:false, error:'SALE_NOT_ACTIVE',
          product_id: String(swProd.id),
          title: outItems[swi].title || String(swProd.id),
          sale_status: swStatus,
          message: msg + ': ' + (outItems[swi].title || swProd.id)
        });
      }
    }
    __t('sale_check');

    // 2b. Allowed-shipping validation (per product restrict list)
    var chosenMethodIds = new Set((Array.isArray(p.shipping_info) ? p.shipping_info : []).map(function(s){ return String(s.method_id||''); }));
    for (var vi = 0; vi < outItems.length; vi++) {
      var allowed = ((prodMap[outItems[vi].product_id] || {}).allowed_shipping_ids || []).map(String);
      if (!allowed.length) continue;
      if (!allowed.some(function(mid){ return chosenMethodIds.has(mid); })) {
        return __finishTimings({
          ok:false, error:'SHIPPING_INVALID',
          product_id: String(outItems[vi].product_id),
          title: outItems[vi].title,
          message: 'วิธีจัดส่งที่เลือกไม่รองรับสินค้า "' + outItems[vi].title + '"'
        });
      }
    }

    // 3. Shipping — cached read (was hot-path sheet read), compute fees by weight.
    //    methodMap only contains active companies + active methods so inactive ones
    //    cannot be silently used to place an order.
    const allShipping = getShippingCached_();
    const methodMap = {};
    allShipping.forEach(function(company) {
      if (!company || company.active === false) return;
      (company.methods || []).forEach(function(method) {
        if (method && method.active !== false && method.id) {
          methodMap[String(method.id)] = { method: method, company: company };
        }
      });
    });
    const inShipping = Array.isArray(p.shipping_info) ? p.shipping_info : [];
    // Reject the order if any requested method is missing/inactive — must happen
    // before any sheet writes or stock deduction.
    for (var smi = 0; smi < inShipping.length; smi++) {
      var smId = String((inShipping[smi] || {}).method_id || '');
      if (!smId || !methodMap[smId]) {
        return __finishTimings({
          ok:false, error:'SHIPPING_INVALID',
          method_id: smId,
          message: 'วิธีจัดส่งที่เลือกไม่พร้อมใช้งาน'
        });
      }
      // company_id must belong to the company that actually owns this method —
      // never trust the client's company_id for the saved snapshot.
      var smCompanyId = String((inShipping[smi] || {}).company_id || '');
      var actualCompanyId = String(methodMap[smId].company.id || '');
      if (!smCompanyId || smCompanyId !== actualCompanyId) {
        return __finishTimings({
          ok:false, error:'SHIPPING_INVALID',
          company_id: smCompanyId,
          method_id: smId,
          expected_company_id: actualCompanyId,
          message: 'บริษัทขนส่งไม่ตรงกับวิธีจัดส่งที่เลือก'
        });
      }
    }
    var shippingFee = 0;
    const outShipping = inShipping.map(function(s) {
      const entry = methodMap[String(s.method_id || '')];
      if (!entry) return null;
      const fee = calcBackendShippingFee_(entry.method, totalWeightGrams);
      shippingFee += fee;
      return {
        company_id:   entry.company.id,
        company_name: entry.company.name,
        method_id:    entry.method.id,
        method_name:  entry.method.name,
        fee:          fee
      };
    }).filter(Boolean);
    // Order-total discount nets the item subtotal (clamped ≥ 0 already), then shipping is added.
    const total = Math.max(0, subtotal - orderDiscountAmount) + shippingFee;
    const primaryMethodId = outShipping.length > 0 ? outShipping[0].method_id : '';

    // Client pricing snapshot validation (optional — only runs if payload sends it).
    // If client-displayed prices disagree with server-recomputed prices the order is
    // rejected with PRICE_CHANGED + an updated cart summary so the frontend can refresh
    // the user before they resubmit. Backend remains the source of truth — client values
    // are never persisted.
    if (p.client_pricing && typeof p.client_pricing === 'object') {
      var _cp = p.client_pricing;
      var _diff = [];
      var _cpItems = Array.isArray(_cp.items) ? _cp.items : [];
      if (_cpItems.length > MAX_ORDER_LINES) {
        return __finishTimings({
          ok:false, error:'TOO_MANY_ITEMS', field:'client_pricing.items',
          limit:MAX_ORDER_LINES, actual:_cpItems.length
        });
      }
      var _cpByKey = {};
      for (var _cpi = 0; _cpi < _cpItems.length; _cpi++) {
        var _cpItem = _cpItems[_cpi];
        if (!_isPlainObject_(_cpItem)) continue;
        var _cpPid = String(_cpItem.product_id || '');
        var _cpProd = prodMap[_cpPid];
        if (!_cpProd) continue;
        var _cpVariant = resolveServerVariantSelection_(_cpProd, _cpItem.selected_variants);
        if (!_cpVariant.ok) continue;
        var _cpKey = _cpPid + '::' + _cpVariant.variant_key;
        if (!_cpByKey[_cpKey]) _cpByKey[_cpKey] = _cpItem;
      }
      for (var _ci = 0; _ci < outItems.length; _ci++) {
        var _srv = outItems[_ci];
        var _srvVk = _srv.variant_key || '';
        var _cli = _cpByKey[String(_srv.product_id) + '::' + _srvVk] || null;
        if (!_cli) {
          _diff.push({ kind:'item_missing', product_id:_srv.product_id, variant_key:_srvVk, title:_srv.title });
          continue;
        }
        var _cliPrice = Math.round(Number(_cli.unit_final_price));
        if (isFinite(_cliPrice) && _cliPrice !== _srv.unit_final_price) {
          _diff.push({ kind:'item_price', product_id:_srv.product_id, variant_key:_srvVk, title:_srv.title, client:_cliPrice, server:_srv.unit_final_price });
        }
        var _srvPromoId = _srv.promotion ? _srv.promotion.promotion_id : null;
        var _cliPromoId = _cli.promotion_id || null;
        if (_cliPromoId !== _srvPromoId) {
          _diff.push({ kind:'item_promotion', product_id:_srv.product_id, variant_key:_srvVk, title:_srv.title, client:_cliPromoId, server:_srvPromoId });
        }
      }
      var _cpSub = Math.round(Number(_cp.subtotal));
      if (isFinite(_cpSub) && _cpSub !== subtotal) _diff.push({ kind:'subtotal', client:_cpSub, server:subtotal });
      var _cpFee = Math.round(Number(_cp.shipping_fee));
      if (isFinite(_cpFee) && _cpFee !== shippingFee) _diff.push({ kind:'shipping_fee', client:_cpFee, server:shippingFee });
      // Order-total discount (0 when absent, so a legacy/older client that omits it and had
      // no order-total promo still matches). A mismatch means the order-total promo changed.
      var _cpOrdDisc = (_cp.order_discount === undefined || _cp.order_discount === null)
        ? 0 : Math.round(Number(_cp.order_discount));
      if (isFinite(_cpOrdDisc) && _cpOrdDisc !== orderDiscountAmount)
        _diff.push({ kind:'order_discount', client:_cpOrdDisc, server:orderDiscountAmount });
      var _cpTot = Math.round(Number(_cp.total));
      if (isFinite(_cpTot) && _cpTot !== total) _diff.push({ kind:'total', client:_cpTot, server:total });

      if (_diff.length) {
        __t('price_changed');
        return __finishTimings({
          ok:false, error:'PRICE_CHANGED',
          diff: _diff,
          old_total: isFinite(_cpTot) ? _cpTot : null,
          new_total: total,
          updated_items: outItems.map(function(it){
            return {
              product_id: it.product_id, variant_key: it.variant_key || '', title: it.title,
              qty: it.qty,
              unit_base_price: it.unit_base_price,
              unit_final_price: it.unit_final_price,
              promotion: it.promotion || null,
              subtotal: it.subtotal
            };
          }),
          updated_subtotal: subtotal,
          updated_order_discount: orderDiscountAmount,
          updated_shipping_fee: shippingFee,
          updated_total: total
        });
      }
    }
    __t('shipping_done');

    // Token expiry from site config
    var siteCfg = readSiteConfig_();
    var expireDays = Number(siteCfg.order_token_expires_days);
    if (isNaN(expireDays) || expireDays < 0) expireDays = 90;
    var tokenExpiresAt = expireDays > 0
      ? new Date(Date.now() + expireDays * 86400000).toISOString()
      : '';

    // 4. Build draft orders (1 for non-split, N for split-by-carrier)
    // 2+ shipping methods ⇒ split shipping: every cart product must be assigned
    // (via item_product_ids) exactly once, to a method allowed for that product.
    var needsSplit = outShipping.length > 1;
    if (needsSplit) {
      var _shipInfo = Array.isArray(p.shipping_info) ? p.shipping_info : [];
      var _cartPids = {};
      outItems.forEach(function(it){ _cartPids[String(it.product_id)] = true; });
      var _assigned = {}; // product_id -> number of entries it was assigned to
      for (var _si = 0; _si < _shipInfo.length; _si++) {
        var _entry = _shipInfo[_si] || {};
        var _ids = _entry.item_product_ids;
        if (!Array.isArray(_ids) || _ids.length === 0) {
          return __finishTimings({ ok:false, error:'SHIPPING_INVALID',
            message:'การจัดส่งแบบแยกพัสดุต้องระบุสินค้าให้ครบทุกวิธีจัดส่ง' });
        }
        var _mid = String(_entry.method_id || '');
        for (var _ii = 0; _ii < _ids.length; _ii++) {
          var _pid = String(_ids[_ii]);
          if (!_cartPids[_pid]) {
            return __finishTimings({ ok:false, error:'SHIPPING_INVALID',
              product_id:_pid, message:'มีการระบุสินค้าที่ไม่อยู่ในตะกร้าให้กับวิธีจัดส่ง' });
          }
          _assigned[_pid] = (_assigned[_pid] || 0) + 1;
          var _allowed = ((prodMap[_pid] || {}).allowed_shipping_ids || []).map(String);
          if (_allowed.length && _allowed.indexOf(_mid) < 0) {
            return __finishTimings({ ok:false, error:'SHIPPING_INVALID',
              product_id:_pid, method_id:_mid,
              message:'สินค้าถูกกำหนดให้วิธีจัดส่งที่ไม่รองรับ' });
          }
        }
      }
      for (var _dp in _assigned) {
        if (_assigned[_dp] > 1) {
          return __finishTimings({ ok:false, error:'SHIPPING_INVALID',
            product_id:_dp, message:'สินค้าถูกกำหนดให้หลายวิธีจัดส่ง' });
        }
      }
      for (var _cp in _cartPids) {
        if (!_assigned[_cp]) {
          return __finishTimings({ ok:false, error:'SHIPPING_INVALID',
            product_id:_cp, message:'มีสินค้าที่ยังไม่ได้กำหนดวิธีจัดส่ง' });
        }
      }
    }
    var drafts = [];
    if (needsSplit) {
      (p.shipping_info || []).forEach(function(shipEntry) {
        var itemIds = (shipEntry.item_product_ids || []).map(String);
        var subItems = outItems.filter(function(item) { return itemIds.indexOf(String(item.product_id)) >= 0; });
        if (!subItems.length) return;
        var subSubtotal = subItems.reduce(function(s, i) { return s + i.subtotal; }, 0);
        var subWeight   = subItems.reduce(function(s, i) {
          return s + Number(i._itemWeight || (prodMap[i.product_id] || {}).weight_grams || 0) * i.qty;
        }, 0);
        var subMethodEntry = methodMap[String(shipEntry.method_id || '')];
        var subFee = subMethodEntry ? calcBackendShippingFee_(subMethodEntry.method, subWeight) : 0;
        drafts.push({
          orderId: genOrderId_(), token: genToken_(),
          items: subItems,
          subtotal: subSubtotal,
          fee: subFee,
          total: subSubtotal + subFee,
          primaryMethodId: subMethodEntry ? subMethodEntry.method.id : '',
          shippingArr: subMethodEntry ? [{
            company_id:   subMethodEntry.company.id,
            company_name: subMethodEntry.company.name,
            method_id:    subMethodEntry.method.id,
            method_name:  subMethodEntry.method.name,
            fee:          subFee
          }] : []
        });
      });
    } else {
      drafts.push({
        orderId: orderId, token: token,
        items: outItems,
        // Gross total here (subtotal + fee); the order-total discount is applied in the
        // unified allocation step below so split and non-split share one code path.
        subtotal: subtotal, fee: shippingFee, total: subtotal + shippingFee,
        primaryMethodId: primaryMethodId,
        shippingArr: outShipping
      });
    }

    // Allocate the whole-order discount across drafts proportionally by item subtotal, so no
    // draft can go negative and the allocated amounts sum to the full discount (remainder to
    // the last eligible draft). For the common single-draft order this assigns the full amount.
    drafts.forEach(function(d){ d.orderDiscount = null; });
    if (orderDiscountAmount > 0 && subtotal > 0) {
      var _allocRemaining = orderDiscountAmount;
      for (var _di = 0; _di < drafts.length; _di++) {
        var _d = drafts[_di];
        var _isLast = (_di === drafts.length - 1);
        var _alloc = _isLast
          ? _allocRemaining
          : Math.min(_d.subtotal, Math.round(orderDiscountAmount * _d.subtotal / subtotal));
        _alloc = Math.max(0, Math.min(_alloc, _d.subtotal, _allocRemaining));
        _allocRemaining -= _alloc;
        if (_alloc > 0) {
          _d.total = Math.max(0, _d.subtotal - _alloc) + _d.fee;
          _d.orderDiscount = { promotion: orderDiscountSnap.promotion, amount: _alloc };
        }
      }
    }

    // 5. Evaluate gift candidates ONCE per cart, then allocate each awarded gift
    // to exactly one draft. Per-draft evaluation would duplicate gifts on split
    // shipping (e.g. a min_subtotal rule firing on every draft whose subtotal
    // individually clears the threshold). Allocation rule:
    //   required_variants  → first draft containing the source (product_id + variant_key)
    //   required_products  → first draft containing the source product
    //   min_subtotal / other → drafts[0]
    drafts.forEach(function(d){ d.giftCandidates = []; });
    try {
      var cartItems = [];
      drafts.forEach(function(d) {
        (d.items || []).forEach(function(it){ cartItems.push(it); });
      });
      // Gift min_subtotal base = subtotal after DIRECT discounts only (conditional promo
      // discounts are excluded), matching previewGiftEligibilityRpc so gift preview and
      // gift submit never diverge. cartPricing.subtotal_after_direct is the whole-cart base.
      var giftBaseSubtotal = Number(cartPricing.subtotal_after_direct || 0);
      var cartCtx = { items: cartItems, subtotal_after_promo: giftBaseSubtotal, subtotal_before_shipping: giftBaseSubtotal };
      var awarded = evaluateGiftRulesForCart_(cartCtx, submitNow) || [];
      awarded.forEach(function(c) {
        var rule = c.rule || {};
        var cj = rule.condition_json || {};
        var targetIdx = -1;
        if (rule.condition_type === 'required_variants') {
          var rvs = cj.required_variants || [];
          for (var rvi = 0; rvi < rvs.length && targetIdx < 0; rvi++) {
            var rv = rvs[rvi];
            for (var di = 0; di < drafts.length; di++) {
              var hit = drafts[di].items.some(function(it) {
                return String(it.product_id) === String(rv.product_id)
                    && String(it.variant_key || '') === String(rv.variant_key || '');
              });
              if (hit) { targetIdx = di; break; }
            }
          }
        } else if (rule.condition_type === 'required_products') {
          var rps = cj.required_products || [];
          for (var rpi = 0; rpi < rps.length && targetIdx < 0; rpi++) {
            var rp = rps[rpi];
            for (var dj = 0; dj < drafts.length; dj++) {
              if (drafts[dj].items.some(function(it){ return String(it.product_id) === String(rp.product_id); })) {
                targetIdx = dj; break;
              }
            }
          }
        }
        if (targetIdx < 0) targetIdx = 0;
        drafts[targetIdx].giftCandidates.push(c);
      });
    } catch(giftErr) {
      Logger.log('[' + __reqId + '] gift candidate eval error: ' + giftErr);
    }
    __t('gift_candidates');

    // Pre-encrypt PII now, in the lock-free PREPARE phase. These values depend
    // only on the (already-validated) payload, not on any locked resource, and
    // are identical for every draft — encrypting here keeps the HMAC-heavy
    // crypto out of the commit lock so concurrent buyers contend less.
    var encPii = {
      customer_name:        encryptField_(p.customer_name||''),
      customer_phone:       encryptField_(p.customer_phone||''),
      shipping_name:        encryptField_(p.shipping_name||''),
      shipping_address:     encryptField_(p.shipping_address||''),
      shipping_district:    encryptField_(p.shipping_district||''),
      shipping_amphoe:      encryptField_(p.shipping_amphoe||''),
      shipping_province:    encryptField_(p.shipping_province||''),
      shipping_postal_code: encryptField_(p.shipping_postal_code||''),
      customer_notes:       encryptField_(p.customer_notes||''),
      customer_contact:     encryptField_(p.customer_contact||'')
    };
    __t('pii_encrypted');

    // ====================================================================
    // COMMIT PHASE — single lock covers product stock + gift stock + appendRow
    // ====================================================================
    var commitLock = LockService.getScriptLock();
    var __lockWaitStart = Date.now();
    if (!commitLock.tryLock(15000)) {
      __timings.push({ step: 'lock_wait_failed', ms_step: Date.now() - __lockWaitStart, ms_total: Date.now() - __t0 });
      __tPrev = Date.now();
      return __finishTimings({ ok:false, error:'SERVER_BUSY' });
    }
    __timings.push({ step: 'lock_acquired', ms_step: Date.now() - __lockWaitStart, ms_total: Date.now() - __t0 });
    __tPrev = Date.now();

    var snapshotUpdates = [];   // for post-lock _patchSnapshotStock_
    var appendedOrderIds = [];  // tracks successful appends for partial-failure logging
    var __successResp = null;   // built inside the lock so idempotency cache is written before release
    try {
      // 5-pre. Re-check idempotency inside the lock to close the race where two
      // concurrent requests with the same client_order_id both pass the top-level
      // cache check before either has had a chance to write.
      if (__clientOrderId) {
        var __dupInLock = _idempotencyLookup_(__clientOrderId);
        if (__dupInLock) {
          var __dupRespInLock = Object.assign({}, __dupInLock, { ok:false, error:'DUPLICATE_ORDER' });
          __t('duplicate_in_lock');
          return __finishTimings(__dupRespInLock);
        }
      }
      // 5a. Batched read: all product rows we need
      var prodSh = sheetProd_();
      var prodLastRow = prodSh.getLastRow();
      var prodSheetData = prodLastRow >= 2
        ? prodSh.getRange(2, 1, prodLastRow - 1, 15).getValues()
        : [];
      var prodIdToIdx = {};
      for (var pi = 0; pi < prodSheetData.length; pi++) prodIdToIdx[String(prodSheetData[pi][0])] = pi;

      // Map: pid → { rowNo, prodStock, variants(parsed), origVariantsJson, origProdStockCell }
      var neededProdIds = {};
      drafts.forEach(function(d){ d.items.forEach(function(it){ neededProdIds[String(it.product_id)] = true; }); });
      var prodStockMap = {};
      Object.keys(neededProdIds).forEach(function(pid) {
        var idx = prodIdToIdx[pid];
        if (idx === undefined) return;
        var row = prodSheetData[idx];
        var parsedVars;
        try { parsedVars = JSON.parse(String(row[10] || '[]')); } catch(_) { parsedVars = []; }
        prodStockMap[pid] = {
          rowNo: idx + 2,
          prodStock: (function(){ var x=Number(row[14]); return isNaN(x)?-1:x; })(),
          variants: parsedVars,
          origVariantsJson: String(row[10] || '[]'),
          origProdStockCell: row[14],
          touched: false
        };
      });

      // 5b. Verify stock for every item across all drafts before any writes.
      // effStock is a fixed snapshot read once per product/variant (not decremented between
      // lines here — actual deduction happens later in 5c), so duplicate lines for the same
      // product/variant must have their requested qty AGGREGATED and checked cumulatively.
      // Otherwise two lines that are each individually within stock (e.g. qty 3 + qty 3
      // against stock 3) would both pass this check independently even though their combined
      // demand oversells the product.
      var pendingDeducts = []; // {pid, type, gIdx, oIdx, qty}
      var requestedSoFar = {}; // stockKey -> cumulative qty requested so far in this submit
      for (var d1 = 0; d1 < drafts.length; d1++) {
          var dr = drafts[d1];
          for (var i1 = 0; i1 < dr.items.length; i1++) {
            var it = dr.items[i1];
            var pinfo = prodStockMap[String(it.product_id)];
            if (!pinfo) {
              __t('stock_product_missing');
              return __finishTimings({
                ok:false, error:'PRODUCT_NOT_FOUND', product_id:String(it.product_id)
              });
            }
            // Revalidate against the fresh sheet row while holding the lock. A product or
            // variant edit between prepare and commit must never fall back to product stock.
            var freshVariant = resolveServerVariantSelection_(
              { id:it.product_id, price:it.unit_base_price, variants:pinfo.variants },
              it.selected_variants
            );
            if (!freshVariant.ok) {
              __t('stock_variant_changed');
              return __finishTimings({
                ok:false, error:freshVariant.error, product_id:String(it.product_id),
                variant_group:freshVariant.variant_group || ''
              });
            }
            var sel = freshVariant.selected_variants;
            var effStock = pinfo.prodStock;
            var matchedG = -1, matchedO = -1;
          for (var gi2 = 0; gi2 < pinfo.variants.length; gi2++) {
            var sg = pinfo.variants[gi2];
            var chosen = sel[sg.name];
            if (!chosen) continue;
            for (var oi2 = 0; oi2 < (sg.options || []).length; oi2++) {
                if (sg.options[oi2].label === chosen) {
                  effStock = sg.options[oi2].stock === undefined ? -1 : Number(sg.options[oi2].stock);
                  matchedG = gi2; matchedO = oi2;
                  break;
              }
            }
          }
          var stockKey = String(it.product_id) + '::' + (matchedG >= 0 ? (matchedG + '.' + matchedO) : 'product');
          var cumulativeQty = (requestedSoFar[stockKey] || 0) + it.qty;
          requestedSoFar[stockKey] = cumulativeQty;
          if (effStock !== -1 && effStock < cumulativeQty) {
            __t('stock_insufficient');
            return __finishTimings({
              ok:false, error:'STOCK_INSUFFICIENT',
              outOfStockTitle: it.title,
              product_id: String(it.product_id),
              variant_key: it.variant_key || '',
              selected_variants: it.selected_variants || {},
              requested_qty: cumulativeQty,
              available_qty: Math.max(0, effStock)
            });
          }
          pendingDeducts.push({
            pid: String(it.product_id), type: matchedG >= 0 ? 'variant' : 'product',
            gIdx: matchedG, oIdx: matchedO, qty: it.qty, eff: effStock
          });
        }
      }

      // 5c. Apply product stock deductions in-memory, then batched write per touched row
      pendingDeducts.forEach(function(pd) {
        if (pd.eff === -1) return;
        var pinfo = prodStockMap[pd.pid];
        if (!pinfo) return;
        if (pd.type === 'variant') {
          var curr = Number(pinfo.variants[pd.gIdx].options[pd.oIdx].stock);
          pinfo.variants[pd.gIdx].options[pd.oIdx].stock = Math.max(0, curr - pd.qty);
        } else {
          pinfo.prodStock = Math.max(0, pinfo.prodStock - pd.qty);
        }
        pinfo.touched = true;
      });
      Object.keys(prodStockMap).forEach(function(pid) {
        var pinfo = prodStockMap[pid];
        if (!pinfo.touched) return;
        // One row write covering both stock cells (cols 11 + 15) — note these are non-adjacent
        prodSh.getRange(pinfo.rowNo, 11).setValue(JSON.stringify(pinfo.variants));
        prodSh.getRange(pinfo.rowNo, 15).setValue(pinfo.prodStock);
        snapshotUpdates.push({ product_id: pid, prodStock: pinfo.prodStock, variants: pinfo.variants });
      });
      __t('stock_done');

      // 5d. Gift stock — batched read for all candidate gifts, then deduct surviving ones
      var giftIdSet = {};
      drafts.forEach(function(d){
        (d.giftCandidates || []).forEach(function(c){ giftIdSet[String(c.gift.gift_id)] = true; });
      });
      var giftIds = Object.keys(giftIdSet);
      var giftSh = null, giftStockMap = {};
      if (giftIds.length > 0) {
        giftSh = sheetGiftItems_();
        var gN = giftSh.getLastRow();
        if (gN >= 2) {
          var gIds = giftSh.getRange(2, 1, gN - 1, 1).getValues().map(function(r){ return String(r[0]); });
          var gStocks = giftSh.getRange(2, 6, gN - 1, 1).getValues();
          giftIds.forEach(function(gid) {
            var idx = gIds.indexOf(gid);
            if (idx < 0) return;
            var stock = Number(gStocks[idx][0]);
            if (isNaN(stock)) stock = 0;
            giftStockMap[gid] = { rowNo: idx + 2, stock: stock, origStock: stock, deducted: 0 };
          });
        }
      }

      // Filter candidates by current stock; aggregate deductions across drafts.
      // Track skipped gifts so the success response can surface a warning instead
      // of silently dropping them (customer was promised the gift in the cart preview).
      drafts.forEach(function(d) {
        d.attachedGifts = [];
        d.skippedGifts  = [];
        (d.giftCandidates || []).forEach(function(c) {
          var gid = String(c.gift.gift_id);
          var ginfo = giftStockMap[gid];
          if (!ginfo) {
            d.skippedGifts.push({
              code:'GIFT_NOT_FOUND', gift_id:gid, gift_name:String(c.gift.name||''),
              requested_qty:Number(c.qty||1), available_qty:0
            });
            return;
          }
          if (ginfo.stock === -1) { // unlimited
            d.attachedGifts.push(c);
            return;
          }
          var need = ginfo.deducted + Number(c.qty || 1);
          if (ginfo.stock < need) {
            d.skippedGifts.push({
              code:'GIFT_OUT_OF_STOCK', gift_id:gid, gift_name:String(c.gift.name||''),
              requested_qty:Number(c.qty||1),
              available_qty:Math.max(0, ginfo.stock - ginfo.deducted)
            });
            return;
          }
          ginfo.deducted = need;
          d.attachedGifts.push(c);
        });
      });
      // Persist gift stock deductions (one setValue per gift row that changed)
      Object.keys(giftStockMap).forEach(function(gid) {
        var ginfo = giftStockMap[gid];
        if (ginfo.stock === -1 || ginfo.deducted === 0) return;
        giftSh.getRange(ginfo.rowNo, 6).setValue(ginfo.stock - ginfo.deducted);
      });
      __t('gift_done');

      // 5e. Append order rows. Wrap in try/catch so we can rollback if NO row was appended.
      try {
        for (var dx = 0; dx < drafts.length; dx++) {
          var d2 = drafts[dx];
          var finalItems = d2.items.slice();
          (d2.attachedGifts || []).forEach(function(c) {
            finalItems.push(_buildGiftLineSnapshot_(c.gift, c.rule, c.qty, 'auto', '', '', ''));
          });
          sh.appendRow([
            d2.orderId, now, now, 'unpaid',
            encPii.customer_name, encPii.customer_phone, sanitizeSheetCell_(p.customer_contact_platform||''),
            encPii.shipping_name, encPii.shipping_address, encPii.shipping_district,
            encPii.shipping_amphoe, encPii.shipping_province, encPii.shipping_postal_code,
            encPii.customer_notes,
            d2.fee, d2.subtotal, d2.total, d2.primaryMethodId,
            JSON.stringify(finalItems),
            JSON.stringify([{ status:'unpaid', timestamp:now }]),
            JSON.stringify(d2.shippingArr),
            encPii.customer_contact, encryptOrderToken_(d2.token), '', tokenExpiresAt,
            '', '', // tracking_json, fulfillment_shipping_json (set later when shipped)
            JSON.stringify(d2.orderDiscount || null)
          ]);
          appendedOrderIds.push(d2.orderId);
        }
      } catch (appendErr) {
        Logger.log('[' + __reqId + '] appendRow failure (appended ' + appendedOrderIds.length + '/' + drafts.length + '): ' + appendErr);
        if (appendedOrderIds.length === 0) {
          // Clean rollback: no orders persisted, restore product + gift stock from origin
          try {
            Object.keys(prodStockMap).forEach(function(pid) {
              var pinfo = prodStockMap[pid];
              if (!pinfo.touched) return;
              prodSh.getRange(pinfo.rowNo, 11).setValue(pinfo.origVariantsJson);
              prodSh.getRange(pinfo.rowNo, 15).setValue(pinfo.origProdStockCell);
            });
            Object.keys(giftStockMap).forEach(function(gid) {
              var ginfo = giftStockMap[gid];
              if (ginfo.stock === -1 || ginfo.deducted === 0) return;
              giftSh.getRange(ginfo.rowNo, 6).setValue(ginfo.origStock);
            });
          } catch(rollbackErr) {
            Logger.log('[' + __reqId + '] rollback failed: ' + rollbackErr);
          }
          snapshotUpdates = []; // nothing committed
          __t('rollback_done');
          return __finishTimings({ ok:false, error:'ORDER_FAILED' });
        }
        // Partial failure: at least one order persisted. Don't roll back stock — those
        // orders are real customer commitments. Surface ORDER_FAILED to the user; an
        // admin can audit via Logger output and the orders sheet.
        // Record an idempotency entry for the persisted order(s) so that a client
        // retry with the same client_order_id short-circuits (DUPLICATE_ORDER)
        // instead of re-committing stock and creating duplicate rows.
        var __partialResp = { ok:false, error:'ORDER_FAILED', partial: appendedOrderIds,
                              order_id: appendedOrderIds[0] || '' };
        if (__clientOrderId) { try { _idempotencyStore_(__clientOrderId, __partialResp); } catch(_) {} }
        // Fall through: snapshot patch + return failure.
        __t('append_partial_fail');
        try { _patchSnapshotStock_(snapshotUpdates); } catch(_) {}
        return __finishTimings(__partialResp);
      }
      __t('append_done');

      // Build success response + write idempotency cache INSIDE the lock so that
      // concurrent submitOrderRpc calls with the same client_order_id can observe
      // the entry on their in-lock re-check (closes the race window where two
      // requests both passed the top-level check before either stored its result).
      var __giftsAttached = [];
      var __giftsSkipped  = [];
      drafts.forEach(function(d) {
        (d.attachedGifts || []).forEach(function(c) {
          __giftsAttached.push({
            gift_id:             String(c.gift.gift_id || ''),
            gift_name:           String(c.gift.name || ''),
            qty:                 Number(c.qty || 1),
            image_url:           String(c.gift.image_url || ''),
            image_drive_file_id: String(c.gift.image_drive_file_id || '')
          });
        });
        (d.skippedGifts || []).forEach(function(s){ __giftsSkipped.push(s); });
      });
      var __warnings = __giftsSkipped.slice();

      if (drafts.length > 1) {
        __successResp = {
          ok:true,
          orders: drafts.map(function(d){
            return {
              order_id: d.orderId, token: d.token, created_at: now,
              item_product_ids: d.items.map(function(i){ return String(i.product_id); })
            };
          }),
          gifts_attached: __giftsAttached,
          gifts_skipped:  __giftsSkipped,
          warnings:       __warnings
        };
      } else {
        __successResp = {
          ok:true, order_id: drafts[0].orderId, created_at: now, token: drafts[0].token,
          gifts_attached: __giftsAttached,
          gifts_skipped:  __giftsSkipped,
          warnings:       __warnings
        };
      }
      if (__clientOrderId) _idempotencyStore_(__clientOrderId, __successResp);
    } finally {
      try { commitLock.releaseLock(); } catch(_) {}
    }

    // ====================================================================
    // POST-LOCK — patch snapshot cache (Phase 3); return result
    // ====================================================================
    try { _patchSnapshotStock_(snapshotUpdates); } catch(_) {}
    __t('snap_patched');

    return __finishTimings(__successResp);
  } catch(err) {
    try { Logger.log('[' + __reqId + '] submitOrderRpc error: ' + err); } catch(_) {}
    return __finishTimings({ ok:false, error:String(err) });
  }
}

function orderListRpc(token, opts) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  try {
    const sh = sheetOrders_();
    const n  = sh.getLastRow();
    if (n < 2) return { ok:true, items:[], total:0 };

    const numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    // Work on raw rows — filter & paginate BEFORE any decryption so a "20 order"
    // page only decrypts 20 rows, not the whole sheet.
    let rows = sh.getRange(2,1,n-1,numCols).getValues();

    // Status filter — column index 3 (`status`) is plaintext, no decryption needed.
    const status = opts && opts.status;
    if (status && status !== 'all') {
      rows = rows.filter(function(r){ return String(r[3]||'unpaid') === status; });
    }

    // Search — match plaintext order_id first; only decrypt the 3 search fields
    // (customer_name, customer_phone, shipping_name) when a query is supplied.
    const q = opts && opts.q ? String(opts.q).toLowerCase() : '';
    if (q) rows = rows.filter(function(r) {
      if (String(r[0]||'').toLowerCase().indexOf(q) >= 0) return true;
      return [decryptField_(String(r[4]||'')),
              decryptField_(String(r[5]||'')),
              decryptField_(String(r[7]||''))]
        .some(function(s){ return String(s||'').toLowerCase().indexOf(q) >= 0; });
    });

    rows.reverse(); // newest first
    const total = rows.length;
    const off = Number((opts&&opts.offset)||0);
    const lim = Number((opts&&opts.limit)||total);
    const pageRows = rows.slice(off, off+lim);

    // Decrypt ONLY the page slice. `lite` mode returns a small summary row used
    // by the order / print-order list tables (3 encrypted fields); otherwise a
    // full rowToOrder_ object (backward-compatible default).
    const wantLite = !!(opts && opts.lite);
    const items = pageRows.map(function(r) {
      while (r.length < ORDER_COLS.length) r.push('');
      if (!wantLite) return rowToOrder_(r);
      let itemCount = 0;
      try {
        const parsed = JSON.parse(String(r[18]||'[]'));
        if (Array.isArray(parsed)) {
          itemCount = parsed.filter(function(it){ return !it || it.line_type !== 'gift'; }).length;
        }
      } catch(_) {}
      return {
        order_id:       String(r[0]||''),
        created_at:     String(r[1]||''),
        updated_at:     String(r[2]||''),
        status:         String(r[3]||'unpaid'),
        customer_name:  decryptField_(String(r[4]||'')),
        customer_phone: decryptField_(String(r[5]||'')),
        shipping_name:  decryptField_(String(r[7]||'')),
        total:          Number(r[16]||0),
        item_count:     itemCount
      };
    });
    return { ok:true, items:items, total:total };
  } catch(err) {
    return { ok:false, error:String(err), items:[], total:0 };
  }
}

function orderGetRpc(token, orderId) {
  if (!requireAdmin_(token)) return { ok: false, error: 'AUTH_REQUIRED' };
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  try {
    const sh = sheetOrders_();
    const n  = sh.getLastRow();
    if (n < 2) return { ok:false, error:'not found' };
    const numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    const row = sh.getRange(2,1,n-1,numCols).getValues()
                  .find(function(r){ return String(r[0]) === String(orderId); });
    if (!row) return { ok:false, error:'not found' };
    while (row.length < ORDER_COLS.length) row.push('');
    return { ok:true, record:rowToOrder_(row) };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

function orderListByIdsRpc(token, orderIds) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  try {
    var ids = Array.isArray(orderIds) ? orderIds : [];
    if (!ids.length) return { ok:true, items:[] };
    if (ids.length > 200) return { ok:false, error:'เลือกได้สูงสุด 200 รายการต่อครั้ง' };
    var idSet = {};
    ids.forEach(function(id){ idSet[String(id)] = true; });
    var sh = sheetOrders_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:true, items:[] };
    var numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    var rows = sh.getRange(2,1,n-1,numCols).getValues();
    var items = [];
    for (var i=0; i<rows.length; i++) {
      var r = rows[i];
      if (!idSet[String(r[0])]) continue;
      while (r.length < ORDER_COLS.length) r.push('');
      items.push(rowToOrder_(r));
    }
    return { ok:true, items:items };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

/* Production summary — aggregates ordered quantities per product (with variant)
 * and per gift item across ALL orders. Read-only; reads only the items_json
 * column (not encrypted) so no PII decryption is needed. Does not alter any
 * order / pricing / promotion / gift logic. */
function orderProductionSummaryRpc(token, opts) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  try {
    var sh = sheetOrders_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:true, products:[], gifts:[], orderCount:0, totalProductUnits:0, totalGiftUnits:0 };
    var numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    var rows = sh.getRange(2,1,n-1,numCols).getValues();
    // Status filter — r[3] is plaintext; default to approved only
    var _validStatuses = ['unpaid','paid','approved','shipped','delivered','cancelled','rejected'];
    var allowedStatuses = (opts && Array.isArray(opts.statuses) && opts.statuses.length > 0)
      ? opts.statuses.map(String).filter(function(s){ return _validStatuses.indexOf(s) !== -1; })
      : [];
    if (!allowedStatuses.length) allowedStatuses = ['approved'];
    rows = rows.filter(function(r){ return allowedStatuses.indexOf(String(r[3]||'unpaid')) !== -1; });
    var prodMap = {}, giftMap = {}, orderCount = 0;
    rows.forEach(function(r) {
      var items;
      try { items = _normalizeOrderItems_(JSON.parse(String(r[18]||'[]'))); }
      catch(_) { items = []; }
      if (!items.length) return;
      orderCount++;
      items.forEach(function(it) {
        if (it.line_type === 'gift') {
          if (it.status === 'removed') return;
          var gk = String(it.gift_id || it.gift_name || '');
          if (!gk) return;
          if (!giftMap[gk]) giftMap[gk] = {
            gift_id:    String(it.gift_id||''),
            gift_name:  String(it.gift_name||''),
            image_drive_file_id: '',
            image_url:  '',
            qty:        0
          };
          var ge = giftMap[gk];
          if (!ge.image_drive_file_id && it.gift_image_drive_file_id) ge.image_drive_file_id = String(it.gift_image_drive_file_id);
          if (!ge.image_url && it.gift_image_url) ge.image_url = String(it.gift_image_url);
          ge.qty += Number(it.gift_qty || it.qty || 0) || 0;
        } else {
          var pk = String(it.product_id||'') + '||' + String(it.variant_key || it.variant_info || '');
          if (!prodMap[pk]) prodMap[pk] = {
            product_id:   String(it.product_id||''),
            title:        String(it.title||''),
            variant_info: String(it.variant_info||''),
            image_drive_file_id: '',
            image_url:    '',
            qty:          0
          };
          var pe = prodMap[pk];
          if (!pe.image_drive_file_id && it.image_drive_file_id) pe.image_drive_file_id = String(it.image_drive_file_id);
          if (!pe.image_url && it.image_url) pe.image_url = String(it.image_url);
          pe.qty += Number(it.qty || 0) || 0;
        }
      });
    });
    var products = Object.keys(prodMap).map(function(k){ return prodMap[k]; })
      .sort(function(a,b){ return b.qty - a.qty; });
    var gifts = Object.keys(giftMap).map(function(k){ return giftMap[k]; })
      .sort(function(a,b){ return b.qty - a.qty; });
    var totalProductUnits = products.reduce(function(s,p){ return s + p.qty; }, 0);
    var totalGiftUnits    = gifts.reduce(function(s,g){ return s + g.qty; }, 0);
    return { ok:true, products:products, gifts:gifts, orderCount:orderCount,
             totalProductUnits:totalProductUnits, totalGiftUnits:totalGiftUnits,
             filteredStatuses:allowedStatuses };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

function orderDeleteRpc(token, orderIds) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    if (!Array.isArray(orderIds) || !orderIds.length) return { ok:false, error:'ไม่มี ID ที่จะลบ' };
    var sh = sheetOrders_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:true, deleted:0 };
    // อ่าน order_id, slip_drive_file_id, tracking_json แยกกัน (efficient)
    var slipColIdx  = ORDER_COLS.indexOf('slip_drive_file_id') + 1; // 1-based
    var trackColIdx = ORDER_COLS.indexOf('tracking_json') + 1;      // 1-based
    var lastCol = sh.getLastColumn();
    var allIds   = sh.getRange(2, 1,           n-1, 1).getValues();
    var allSlips = slipColIdx > 0 && lastCol >= slipColIdx
      ? sh.getRange(2, slipColIdx, n-1, 1).getValues()
      : [];
    var allTrack = trackColIdx > 0 && lastCol >= trackColIdx
      ? sh.getRange(2, trackColIdx, n-1, 1).getValues()
      : [];
    var ids = orderIds.map(String);
    var rowNums = [];
    for (var i = 0; i < allIds.length; i++) {
      if (ids.indexOf(String(allIds[i][0])) !== -1) rowNums.push(i + 2);
    }
    // ลบไฟล์ใน Drive + AfterShip tracking ก่อนลบแถว (best-effort)
    rowNums.forEach(function(rNo) {
      var rowIdx = rNo - 2;
      // ลบสลิปจาก Drive
      try {
        var slipId = String((allSlips[rowIdx] && allSlips[rowIdx][0]) || '');
        if (slipId) DriveApp.getFileById(slipId).setTrashed(true);
      } catch(_) {}
      // ลบ tracking ตาม provider (aftership / etracking)
      try {
        var raw = String((allTrack[rowIdx] && allTrack[rowIdx][0]) || '');
        var tj = JSON.parse(decryptField_(raw) || '{}');
        var isAfterShip = tj.tracking_provider === 'aftership'
                       || (!tj.tracking_provider && tj.auto_tracking === true);
        var isEtracking = tj.tracking_provider === 'etracking';
        if (isAfterShip && tj.tracking_number && tj.carrier_id) {
          deleteAftershipTracking_(tj.carrier_id, tj.tracking_number);
        } else if (isEtracking && tj.tracking_number && tj.carrier_id) {
          deleteEtrackingTracking_(tj.carrier_id, tj.tracking_number);
        }
      } catch(_) {}
    });
    // ลบแถว (descending เพื่อไม่ให้ row shift)
    rowNums.sort(function(a,b){ return b - a; });
    rowNums.forEach(function(r){ sh.deleteRow(r); });
    auditLog_('order.delete', { category:['order'], type:['deletion'],
      outcome:'success', route:'order', rpc:'orderDeleteRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'order', deleted: rowNums.length,
             order_id_hashes: ids.slice(0, 50).map(function(id){ return hashForLog_(id, 'o_'); }) } },
      _sess.logCtx);
    return { ok:true, deleted: rowNums.length };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

// Token-based order lookup for customer-facing order view page
function getOrderByTokenRpc(token) {
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  try {
    var vt = validateOrderToken_(token, { scope:'read_full', maxRate:10, rateWindow:60 });
    if (!vt.ok) {
      enqueueLog_('order.view.token.fail', { category:['order'], type:['access'],
        outcome:'failure', route:'order-view', rpc:'getOrderByTokenRpc',
        meta:{ reason: safeLogString_(vt.code || vt.error, 60) } }, null);
      return { ok:false, error:vt.error, code:vt.code };
    }
    var record = Object.assign({}, vt.record);
    record.token = vt.tokenStr;
    // Never expose internal-only fulfillment fields (reason, changed_by, previous company)
    // to the customer — keep only the customer-safe "will ship via X" subset.
    record.fulfillment_shipping = _customerSafeFulfillment_(record.fulfillment_shipping);
    enqueueLog_('order.view.token.success', { category:['order'], type:['access'],
      outcome:'success', route:'order-view', rpc:'getOrderByTokenRpc',
      meta:{ order_id_hash: hashForLog_(record.order_id, 'o_') } }, null);
    return { ok:true, record:record };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

// Lightweight status-only lookup by token — returns { ok, status, order_id } with no PII
function getOrderStatusByTokenRpc(token) {
  try {
    var vt = validateOrderToken_(token, { scope:'read_status', maxRate:20, rateWindow:60 });
    if (!vt.ok) return { ok:false, error:vt.error };
    return { ok:true, status:vt.record.status, order_id:vt.record.order_id };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

// Customer uploads payment slip — auto-advances status to 'paid'
function uploadSlipRpc(token, base64, filename, contentType) {
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  try {
    if (!base64) return { ok:false, error:'ข้อมูลไม่ครบถ้วน' };
    assertConfig_();
    var vt = validateOrderToken_(token, { scope:'upload_slip', maxRate:10, rateWindow:60 });
    if (!vt.ok) return { ok:false, error:vt.error };
    const sh = vt.sh;
    const rowNo = vt.rowNo;
    const statusColIdx = ORDER_COLS.indexOf('status') + 1;
    const slipFolderId = getFolderIdCached_(FOLDER_SLIP);
    const orderId = vt.record.order_id || '';
    const slipFilename = (orderId || ('slip-' + Date.now())) + '.jpg';
    var fileId;
    try {
      fileId = uploadValidatedImage_(base64, slipFilename, contentType || 'image/jpeg',
        slipFolderId, false, { maxBytes: 5*1024*1024, allowGif: false });
    } catch(uploadErr) {
      return { ok:false, error:String(uploadErr) };
    }
    const slipColIdx  = ORDER_COLS.indexOf('slip_drive_file_id') + 1;
    const histColIdx  = ORDER_COLS.indexOf('status_history_json') + 1;
    const updColIdx   = ORDER_COLS.indexOf('updated_at') + 1;
    const now = nowISO_();
    const histRaw = sh.getRange(rowNo, histColIdx).getValue();
    var history = [];
    try { history = JSON.parse(String(histRaw||'[]')); } catch(_) { history = []; }
    history.push({ status:'paid', timestamp:now, note:'ลูกค้าอัปโหลดสลิปชำระเงิน' });
    sh.getRange(rowNo, slipColIdx).setValue(fileId);
    sh.getRange(rowNo, statusColIdx).setValue('paid');
    sh.getRange(rowNo, updColIdx).setValue(now);
    sh.getRange(rowNo, histColIdx).setValue(JSON.stringify(history));
    enqueueLog_('order.payment.slip.upload', { category:['order'], type:['change'],
      outcome:'success', route:'order-view', rpc:'uploadSlipRpc',
      meta:{ order_id_hash: hashForLog_(orderId, 'o_'), has_slip:true, order_status:'paid' } }, null);
    return { ok:true, file_id:fileId, url:publicUrl_(fileId) };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

/* ====================================================================
 * Order stock release / re-deduct (Reject / un-Reject)
 *
 * Invariant: an order whose status is in RELEASED_STATUSES holds NO stock —
 * its product lines and ACTIVE gift lines have been returned to inventory.
 * Any other status holds its stock (deducted at checkout).
 * ==================================================================== */
var RELEASED_STATUSES = ['rejected', 'cancelled'];
function _isStockReleasedStatus_(s) {
  return RELEASED_STATUSES.indexOf(String(s || '').toLowerCase()) !== -1;
}

// Split an order's items_json into stock-relevant product/gift lines.
// Gift lines count only when status === 'active' — 'removed' gifts already had
// their stock handled at removal time.
function _collectOrderStockLines_(items) {
  var products = [], gifts = [];
  (items || []).forEach(function(it) {
    if (!it) return;
    if (it.line_type === 'gift') {
      if (it.status === 'active' && it.gift_id) {
        gifts.push({ gift_id: String(it.gift_id), qty: Number(it.gift_qty || 1), name: String(it.gift_name || '') });
      }
    } else {
      products.push({
        product_id: String(it.product_id),
        selected_variants: it.selected_variants || {},
        qty: Number(it.qty || 0),
        title: String(it.title || '')
      });
    }
  });
  return { products: products, gifts: gifts };
}

// Resolve which stock cell a product line draws from. Mirrors submitOrderRpc's
// variant matching exactly so restore/deduct stays symmetric with checkout.
// pinfo = { prodStock, variants }. Returns { type, gIdx, oIdx, effStock }.
function _resolveItemStockTarget_(pinfo, selectedVariants) {
  var sel = selectedVariants || {};
  var effStock = pinfo.prodStock;
  var matchedG = -1, matchedO = -1;
  for (var gi = 0; gi < (pinfo.variants || []).length; gi++) {
    var sg = pinfo.variants[gi];
    var chosen = sel[sg.name];
    if (!chosen) continue;
    for (var oi = 0; oi < (sg.options || []).length; oi++) {
      if (sg.options[oi].label === chosen && sg.options[oi].stock !== undefined) {
        effStock = Number(sg.options[oi].stock);
        matchedG = gi; matchedO = oi;
        break;
      }
    }
  }
  return { type: matchedG >= 0 ? 'variant' : 'product', gIdx: matchedG, oIdx: matchedO, effStock: effStock };
}

// Apply a stock change for one order's lines. CALLER MUST HOLD THE SCRIPT LOCK.
// direction: 'deduct' (all-or-nothing; pre-checks every line) | 'restore'.
// Returns { ok:true, snapshotUpdates:[...] } or, for deduct only,
// { ok:false, error:'STOCK_INSUFFICIENT', shortages:[...] } having written nothing.
function _changeOrderStock_(items, direction) {
  var lines = _collectOrderStockLines_(items);
  var snapshotUpdates = [];

  // ---- products ----
  var prodSh = sheetProd_();
  var prodLastRow = prodSh.getLastRow();
  var prodSheetData = prodLastRow >= 2 ? prodSh.getRange(2, 1, prodLastRow - 1, 15).getValues() : [];
  var prodIdToIdx = {};
  for (var pi = 0; pi < prodSheetData.length; pi++) prodIdToIdx[String(prodSheetData[pi][0])] = pi;

  var prodStockMap = {};
  lines.products.forEach(function(ln) {
    if (prodStockMap[ln.product_id]) return;
    var idx = prodIdToIdx[ln.product_id];
    if (idx === undefined) return; // product master gone — restore/deduct skips it
    var row = prodSheetData[idx];
    var parsedVars;
    try { parsedVars = JSON.parse(String(row[10] || '[]')); } catch(_) { parsedVars = []; }
    prodStockMap[ln.product_id] = {
      rowNo: idx + 2,
      prodStock: (function(){ var x = Number(row[14]); return isNaN(x) ? -1 : x; })(),
      variants: parsedVars,
      touched: false
    };
  });

  // Aggregate per stock target so repeated lines on the same variant net correctly.
  var prodTargets = {}; // key -> { pid, type, gIdx, oIdx, cur, need, title }
  lines.products.forEach(function(ln) {
    var pinfo = prodStockMap[ln.product_id];
    if (!pinfo) return; // vanished product — nothing to track
    var t = _resolveItemStockTarget_(pinfo, ln.selected_variants);
    if (t.effStock === -1) return; // unlimited — skip both directions
    var key = t.type === 'variant' ? (ln.product_id + '|' + t.gIdx + '|' + t.oIdx) : (ln.product_id + '|__prod__');
    if (!prodTargets[key]) {
      prodTargets[key] = { pid: ln.product_id, type: t.type, gIdx: t.gIdx, oIdx: t.oIdx, cur: t.effStock, need: 0, title: ln.title };
    }
    prodTargets[key].need += ln.qty;
  });

  // ---- gifts ----
  var giftSh = null, giftStockMap = {};
  var giftNeed = {}; // gift_id -> { need, name }
  lines.gifts.forEach(function(g) {
    if (!giftNeed[g.gift_id]) giftNeed[g.gift_id] = { need: 0, name: g.name };
    giftNeed[g.gift_id].need += g.qty;
  });
  var giftIds = Object.keys(giftNeed);
  if (giftIds.length > 0) {
    giftSh = sheetGiftItems_();
    var gN = giftSh.getLastRow();
    if (gN >= 2) {
      var gIds = giftSh.getRange(2, 1, gN - 1, 1).getValues().map(function(r){ return String(r[0]); });
      var gStocks = giftSh.getRange(2, 6, gN - 1, 1).getValues();
      giftIds.forEach(function(gid) {
        var idx = gIds.indexOf(gid);
        if (idx < 0) return; // gift master gone — skip
        var stock = Number(gStocks[idx][0]);
        if (isNaN(stock)) stock = 0;
        giftStockMap[gid] = { rowNo: idx + 2, stock: stock };
      });
    }
  }

  // ---- deduct: pre-check every target, write nothing if anything is short ----
  if (direction === 'deduct') {
    var shortages = [];
    Object.keys(prodTargets).forEach(function(key) {
      var t = prodTargets[key];
      if (t.cur < t.need) {
        shortages.push({ kind: 'product', title: t.title, requested: t.need, available: Math.max(0, t.cur) });
      }
    });
    Object.keys(giftStockMap).forEach(function(gid) {
      var gm = giftStockMap[gid];
      if (gm.stock === -1) return; // unlimited
      var need = giftNeed[gid].need;
      if (gm.stock < need) {
        shortages.push({ kind: 'gift', title: giftNeed[gid].name, requested: need, available: Math.max(0, gm.stock) });
      }
    });
    if (shortages.length) return { ok: false, error: 'STOCK_INSUFFICIENT', shortages: shortages };
  }

  // ---- apply product writes ----
  // Restore is a plain `cur + need`: the deduct pre-check above guarantees a deduct
  // never actually clamps, so deduct/restore stay symmetric — UNLESS an admin manually
  // lowered stock while the order was active, in which case restore intentionally puts
  // back the full ordered qty (the manual edit, not this function, owns that delta).
  Object.keys(prodTargets).forEach(function(key) {
    var t = prodTargets[key];
    var pinfo = prodStockMap[t.pid];
    if (!pinfo) return;
    var next = direction === 'deduct' ? Math.max(0, t.cur - t.need) : (t.cur + t.need);
    if (t.type === 'variant') {
      pinfo.variants[t.gIdx].options[t.oIdx].stock = next;
    } else {
      pinfo.prodStock = next;
    }
    pinfo.touched = true;
  });
  Object.keys(prodStockMap).forEach(function(pid) {
    var pinfo = prodStockMap[pid];
    if (!pinfo.touched) return;
    prodSh.getRange(pinfo.rowNo, 11).setValue(JSON.stringify(pinfo.variants));
    prodSh.getRange(pinfo.rowNo, 15).setValue(pinfo.prodStock);
    snapshotUpdates.push({ product_id: pid, prodStock: pinfo.prodStock, variants: pinfo.variants });
  });

  // ---- apply gift writes ----
  Object.keys(giftStockMap).forEach(function(gid) {
    var gm = giftStockMap[gid];
    if (gm.stock === -1) return; // unlimited
    var need = giftNeed[gid].need;
    var next = direction === 'deduct' ? Math.max(0, gm.stock - need) : (gm.stock + need);
    giftSh.getRange(gm.rowNo, 6).setValue(next);
  });

  return { ok: true, snapshotUpdates: snapshotUpdates };
}

function orderUpdateStatusRpc(token, orderId, newStatus, note) {
  var _sess = requireAdmin_(token);
  if (!_sess) {
    enqueueLog_('auth.required', { category:['authentication'], type:['denied'],
      outcome:'failure', level:'warning', route:'order', rpc:'orderUpdateStatusRpc' }, null);
    return { ok: false, error: 'AUTH_REQUIRED' };
  }
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  // --- INPUT VALIDATION ---
  var ORDER_STATUSES = ['unpaid','paid','approved','shipped','delivered','cancelled','rejected'];
  var statusR = normalizeEnum_(newStatus, ORDER_STATUSES, 'สถานะ');
  if (!statusR.ok) return { ok:false, error:statusR.error };
  newStatus = statusR.value;
  if (note !== undefined && note !== null && note !== '') {
    var noteR = normalizeMultilineText_(String(note), { maxLen:VLEN.LONG, fieldName:'หมายเหตุ', allowEmpty:true });
    if (!noteR.ok) return { ok:false, error:noteR.error };
    note = noteR.value;
  }
  // --- END VALIDATION ---
  // Single lock covers the stock change + status write so a Reject/un-Reject is atomic.
  var _lock = LockService.getScriptLock();
  if (!_lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  var _stockChanged = null;       // 'restore' | 'deduct' once a stock write succeeds (for rollback)
  var _snapshotUpdates = [];      // patched post-lock
  var _orderItems = null;
  try {
    const sh  = sheetOrders_();
    const n   = sh.getLastRow();
    if (n < 2) return { ok:false, error:'not found' };
    const ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    const idx = ids.indexOf(String(orderId));
    if (idx < 0) return { ok:false, error:'not found' };
    const rowNo = idx + 2;
    const statusCol = ORDER_COLS.indexOf('status') + 1;

    // Stock transition: entering a released status restores stock; leaving it
    // re-deducts (atomically). Same-side transitions leave stock untouched.
    var oldStatus    = String(sh.getRange(rowNo, statusCol).getValue() || '').toLowerCase();
    var wasReleased  = _isStockReleasedStatus_(oldStatus);
    var willReleased = _isStockReleasedStatus_(newStatus);
    if (wasReleased !== willReleased) {
      const itemsCol = ORDER_COLS.indexOf('items_json') + 1;
      try { _orderItems = JSON.parse(String(sh.getRange(rowNo, itemsCol).getValue() || '[]')); } catch(_) { _orderItems = []; }
      var _dir = willReleased ? 'restore' : 'deduct';
      var _stockRes = _changeOrderStock_(_orderItems, _dir);
      if (!_stockRes.ok) {
        // Re-deduct blocked by insufficient stock — leave the status unchanged.
        return { ok:false, error:_stockRes.error, shortages:_stockRes.shortages || [] };
      }
      _stockChanged    = _dir;
      _snapshotUpdates = _stockRes.snapshotUpdates || [];
    }

    const histCol = ORDER_COLS.indexOf('status_history_json') + 1;
    const histRaw = sh.getRange(rowNo, histCol).getValue();
    var history = [];
    try { history = JSON.parse(String(histRaw||'[]')); } catch(_) { history = []; }
    const entry = { status:newStatus, timestamp:nowISO_() };
    if (note) entry.note = String(note);
    history.push(entry);
    const now = nowISO_();
    // When resetting to unpaid: delete existing slip from Drive and clear the field
    if (newStatus === 'unpaid') {
      const slipColIdx = ORDER_COLS.indexOf('slip_drive_file_id') + 1;
      const existingSlipId = String(sh.getRange(rowNo, slipColIdx).getValue() || '');
      if (existingSlipId) {
        try { DriveApp.getFileById(existingSlipId).setTrashed(true); } catch(_) {}
        sh.getRange(rowNo, slipColIdx).setValue('');
      }
    }
    // When rolling back to approved/paid/unpaid (before shipped): clear tracking_json
    // and unregister AfterShip tracking if applicable
    var PRE_SHIP_STATUSES = ['unpaid', 'paid', 'approved'];
    if (PRE_SHIP_STATUSES.indexOf(newStatus) >= 0) {
      var trackColIdx = ORDER_COLS.indexOf('tracking_json') + 1;
      if (trackColIdx > 0) {
        var rawTrack = String(sh.getRange(rowNo, trackColIdx).getValue() || '');
        if (rawTrack) {
          try {
            var tj = JSON.parse(decryptField_(rawTrack) || '{}');
            var isAfterShip = tj.tracking_provider === 'aftership'
                           || (!tj.tracking_provider && tj.auto_tracking === true);
            var isEtracking = tj.tracking_provider === 'etracking';
            if (isAfterShip && tj.tracking_number && tj.carrier_id) {
              deleteAftershipTracking_(tj.carrier_id, tj.tracking_number);
            } else if (isEtracking && tj.tracking_number && tj.carrier_id) {
              deleteEtrackingTracking_(tj.carrier_id, tj.tracking_number);
            }
          } catch(_) {}
          sh.getRange(rowNo, trackColIdx).setValue('');
        }
      }
    }
    try {
      sh.getRange(rowNo, ORDER_COLS.indexOf('updated_at')+1).setValue(now);
      sh.getRange(rowNo, statusCol).setValue(sanitizeSheetCell_(newStatus));
      sh.getRange(rowNo, histCol).setValue(JSON.stringify(history));
    } catch (writeErr) {
      // Status write failed after a stock change — undo the stock change so inventory
      // stays consistent with the (unchanged) order status.
      if (_stockChanged) {
        try {
          var _rb = _changeOrderStock_(_orderItems, _stockChanged === 'restore' ? 'deduct' : 'restore');
          _snapshotUpdates = (_rb && _rb.snapshotUpdates) || [];
        } catch(_) { _snapshotUpdates = []; }
      }
      throw writeErr;
    }
    enqueueLog_('order.status.update', { category:['order'], type:['change'],
      outcome:'success', route:'order', rpc:'orderUpdateStatusRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ order_id_hash: hashForLog_(orderId, 'o_'), order_status:newStatus } }, _sess.logCtx);
    return { ok:true, order_id:orderId, status:newStatus, updated_at:now };
  } catch(err) {
    return { ok:false, error:String(err) };
  } finally {
    try { _lock.releaseLock(); } catch(_) {}
    try { if (_snapshotUpdates && _snapshotUpdates.length) _patchSnapshotStock_(_snapshotUpdates); } catch(_) {}
  }
}

function orderUpdateFieldsRpc(token, orderId, patch) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  var _fieldsLock = LockService.getScriptLock();
  if (!_fieldsLock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    const sh  = sheetOrders_();
    const n   = sh.getLastRow();
    if (n < 2) return { ok:false, error:'not found' };
    const ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    const idx = ids.indexOf(String(orderId));
    if (idx < 0) return { ok:false, error:'not found' };
    const rowNo = idx + 2;
    const p = patch || {};
    // Read the current row once — needed to enforce the monetary lock and to compute
    // the order total from trusted, server-stored values (never from client input).
    const _curNumCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    var _curRow = sh.getRange(rowNo, 1, 1, _curNumCols).getValues()[0];
    while (_curRow.length < ORDER_COLS.length) _curRow.push('');
    const _curOrder = rowToOrder_(_curRow);
    const _pricingIsLocked = _pricingLocked_(_curOrder);
    // subtotal is never editable via this RPC.
    if (p.subtotal !== undefined) return { ok:false, error:'SUBTOTAL_IMMUTABLE' };
    // Monetary fields are frozen once the order has ever been paid (persists across rollback).
    if (_pricingIsLocked && (p.shipping_fee !== undefined || p.total !== undefined))
      return { ok:false, error:'PRICING_LOCKED' };
    // --- INPUT VALIDATION ---
    if (p.customer_notes !== undefined) {
      var cnR = normalizeMultilineText_(String(p.customer_notes||''), { maxLen:VLEN.LONG, fieldName:'หมายเหตุ', allowEmpty:true });
      if (!cnR.ok) return { ok:false, error:cnR.error };
      p.customer_notes = cnR.value;
    }
    var SHIP_ADDR_KEYS = ['shipping_name','shipping_address','shipping_district',
                          'shipping_amphoe','shipping_province','shipping_postal_code'];
    var hasAddrPatch = SHIP_ADDR_KEYS.some(function(k){ return p[k] !== undefined; });
    if (hasAddrPatch) {
      var _snR  = normalizePlainText_(p.shipping_name||'',     {maxLen:VLEN.SHORT,  fieldName:'ชื่อผู้รับ'});
      if (!_snR.ok)  return {ok:false, error:_snR.error};
      var _saR  = normalizePlainText_(p.shipping_address||'',  {maxLen:VLEN.MEDIUM, fieldName:'ที่อยู่'});
      if (!_saR.ok)  return {ok:false, error:_saR.error};
      var _sdR  = normalizePlainText_(p.shipping_district||'', {maxLen:VLEN.SHORT,  fieldName:'ตำบล/แขวง'});
      if (!_sdR.ok)  return {ok:false, error:_sdR.error};
      var _sxR  = normalizePlainText_(p.shipping_amphoe||'',   {maxLen:VLEN.SHORT,  fieldName:'อำเภอ/เขต'});
      if (!_sxR.ok)  return {ok:false, error:_sxR.error};
      var _spR  = normalizePlainText_(p.shipping_province||'', {maxLen:VLEN.SHORT,  fieldName:'จังหวัด'});
      if (!_spR.ok)  return {ok:false, error:_spR.error};
      var _spcR = normalizePostalCode_(p.shipping_postal_code||'');
      if (!_spcR.ok) return {ok:false, error:_spcR.error};
      p.shipping_name        = _snR.value;
      p.shipping_address     = _saR.value;
      p.shipping_district    = _sdR.value;
      p.shipping_amphoe      = _sxR.value;
      p.shipping_province    = _spR.value;
      p.shipping_postal_code = _spcR.value;
    }
    if (p.customer_phone !== undefined) {
      var _phR = normalizePhone_(p.customer_phone||'');
      if (!_phR.ok) return {ok:false, error:_phR.error};
      p.customer_phone = _phR.value;
    }
    // --- END VALIDATION ---
    // Shipping-fee edit (only reachable before payment — locked orders rejected above).
    // The client-supplied `total` is never trusted; recompute it on the backend from the
    // stored subtotal so total always equals subtotal + shipping_fee.
    if (p.shipping_fee !== undefined) {
      var _newFee = Number(p.shipping_fee);
      if (!isFinite(_newFee) || _newFee < 0) return { ok:false, error:'ค่าจัดส่งไม่ถูกต้อง' };
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_fee')+1).setValue(_newFee);
      sh.getRange(rowNo, ORDER_COLS.indexOf('total')+1).setValue(Number(_curOrder.subtotal || 0) + _newFee);
    }
    if (p.customer_notes !== undefined)
      sh.getRange(rowNo, ORDER_COLS.indexOf('customer_notes')+1).setValue(encryptField_(p.customer_notes));
    if (hasAddrPatch) {
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_name')+1)        .setValue(encryptField_(p.shipping_name));
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_address')+1)     .setValue(encryptField_(p.shipping_address));
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_district')+1)    .setValue(encryptField_(p.shipping_district));
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_amphoe')+1)      .setValue(encryptField_(p.shipping_amphoe));
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_province')+1)    .setValue(encryptField_(p.shipping_province));
      sh.getRange(rowNo, ORDER_COLS.indexOf('shipping_postal_code')+1) .setValue(encryptField_(p.shipping_postal_code));
      var _addrHist = [];
      try { _addrHist = JSON.parse(String(sh.getRange(rowNo, ORDER_COLS.indexOf('status_history_json')+1).getValue()||'[]')); } catch(_) {}
      _addrHist.push({ status:'address_updated', timestamp:nowISO_(), note:'แก้ไขที่อยู่จัดส่ง' });
      sh.getRange(rowNo, ORDER_COLS.indexOf('status_history_json')+1).setValue(JSON.stringify(_addrHist));
    }
    if (p.customer_phone !== undefined)
      sh.getRange(rowNo, ORDER_COLS.indexOf('customer_phone')+1).setValue(encryptField_(p.customer_phone));
    sh.getRange(rowNo, ORDER_COLS.indexOf('updated_at')+1).setValue(nowISO_());
    auditLog_('order.fields.update', { category:['order'], type:['change'],
      outcome:'success', route:'order', rpc:'orderUpdateFieldsRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'order', order_id_hash: hashForLog_(orderId, 'o_'),
             shipping_fee_changed: p.shipping_fee !== undefined,
             total_recomputed: p.shipping_fee !== undefined,
             notes_changed: p.customer_notes !== undefined,
             address_changed: hasAddrPatch,
             phone_changed: p.customer_phone !== undefined } }, _sess.logCtx);
    return { ok:true };
  } catch(err) {
    return { ok:false, error:String(err) };
  } finally {
    try { _fieldsLock.releaseLock(); } catch(_) {}
  }
}

// Record the ACTUAL fulfillment carrier the seller ships with — a separate concept from
// the customer's paid selection (shipping_method_id / shipping_info_json), which is never
// touched here. Does NOT recalculate price and does NOT change the order status.
// Allowed only for unpaid/paid/approved. Carrier/provider/URL are resolved on the backend
// from the shipping config and snapshotted so the order stays readable if config changes.
function orderUpdateFulfillmentShippingRpc(token, orderId, companyId, methodId, reason) {
  var _sess = requireAdmin_(token);
  if (!_sess) {
    enqueueLog_('auth.required', { category:['authentication'], type:['denied'],
      outcome:'failure', level:'warning', route:'order', rpc:'orderUpdateFulfillmentShippingRpc' }, null);
    return { ok: false, error: 'AUTH_REQUIRED' };
  }
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  var _lock = LockService.getScriptLock();
  if (!_lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    const sh  = sheetOrders_();
    const n   = sh.getLastRow();
    if (n < 2) return { ok:false, error:'not found' };
    const ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    const idx = ids.indexOf(String(orderId));
    if (idx < 0) return { ok:false, error:'not found' };
    const rowNo = idx + 2;
    // Read the latest order INSIDE the lock (status + existing override).
    const numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    var row = sh.getRange(rowNo, 1, 1, numCols).getValues()[0];
    while (row.length < ORDER_COLS.length) row.push('');
    const order = rowToOrder_(row);
    const curStatus = String(order.status || '');
    // Carrier override is allowed only before shipment.
    var ALLOWED = { unpaid:1, paid:1, approved:1 };
    if (!ALLOWED[curStatus]) return { ok:false, error:'STATUS_NOT_ALLOWED' };
    // Reason is mandatory once money is committed (paid/approved).
    var reasonR = normalizeMultilineText_(String(reason||''), { maxLen:VLEN.LONG, fieldName:'เหตุผล', allowEmpty:true });
    if (!reasonR.ok) return { ok:false, error:reasonR.error };
    var reasonVal = reasonR.value;
    if ((curStatus === 'paid' || curStatus === 'approved') && !reasonVal)
      return { ok:false, error:'REASON_REQUIRED' };
    // Validate company/method against the live shipping config, distinguishing a bad
    // company (COMPANY_INVALID) from a bad/foreign/inactive method (METHOD_INVALID).
    var companies = getShippingCached_();
    var company = null;
    for (var ci = 0; ci < companies.length; ci++) {
      if (String(companies[ci].id) === String(companyId)) { company = companies[ci]; break; }
    }
    if (!company || company.active === false) return { ok:false, error:'COMPANY_INVALID' };
    var methods = Array.isArray(company.methods) ? company.methods : [];
    var method = null;
    for (var mi = 0; mi < methods.length; mi++) {
      if (String(methods[mi].id) === String(methodId)) { method = methods[mi]; break; }
    }
    if (!method || method.active === false) return { ok:false, error:'METHOD_INVALID' };
    var now = nowISO_();
    // changed_from = previous override company if any, else the customer's original company.
    var prevOverride = order.fulfillment_shipping || null;
    var originalCompanyId = (Array.isArray(order.shipping_info) && order.shipping_info[0])
      ? String(order.shipping_info[0].company_id || '') : '';
    var changedFrom = prevOverride ? String(prevOverride.company_id || '') : originalCompanyId;
    // Carrier metadata resolved by the backend and snapshotted (never trusted from client).
    var fulfillment = {
      company_id:            String(company.id || ''),
      company_name:          String(company.name || ''),
      method_id:             String(method.id || ''),
      method_name:           String(method.name || ''),
      carrier_id:            String(company.carrier_id || 'other'),
      tracking_provider:     String(company.tracking_provider || ''),
      tracking_url_template: String(company.tracking_url_template || ''),
      changed_from_company_id: changedFrom,
      changed_at:            now,
      changed_by:            String(_sess.userId || ''),
      reason:                reasonVal
    };
    // Append a customer-safe history event WITHOUT changing the main order status.
    const histCol = ORDER_COLS.indexOf('status_history_json') + 1;
    var history = [];
    try { history = JSON.parse(String(sh.getRange(rowNo, histCol).getValue() || '[]')); } catch(_) { history = []; }
    history.push({ status:'shipping_carrier_changed', timestamp:now,
                   note:'เปลี่ยนบริษัทขนส่งเป็น ' + fulfillment.company_name });
    // Write ONLY the override + history + updated_at. Never touch shipping_method_id,
    // shipping_info_json, shipping_fee, subtotal, total, or status.
    sh.getRange(rowNo, ORDER_COLS.indexOf('fulfillment_shipping_json')+1).setValue(JSON.stringify(fulfillment));
    sh.getRange(rowNo, histCol).setValue(JSON.stringify(history));
    sh.getRange(rowNo, ORDER_COLS.indexOf('updated_at')+1).setValue(now);
    auditLog_('order.fulfillment.update', { category:['order'], type:['change'],
      outcome:'success', route:'order', rpc:'orderUpdateFulfillmentShippingRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'order', order_id_hash: hashForLog_(orderId, 'o_'),
             order_status: curStatus,
             from_company: safeLogString_(changedFrom, 40),
             to_company: safeLogString_(fulfillment.company_id, 40),
             carrier: safeLogString_(fulfillment.carrier_id, 40),
             has_reason: !!reasonVal } }, _sess.logCtx);
    // Re-read and return the updated record.
    var row2 = sh.getRange(rowNo, 1, 1, numCols).getValues()[0];
    while (row2.length < ORDER_COLS.length) row2.push('');
    return { ok:true, record: rowToOrder_(row2) };
  } catch(err) {
    return { ok:false, error:String(err) };
  } finally {
    try { _lock.releaseLock(); } catch(_) {}
  }
}

function orderMarkShippedRpc(token, orderId, trackingData) {
  var _sess = requireAdmin_(token);
  if (!_sess) {
    enqueueLog_('auth.required', { category:['authentication'], type:['denied'],
      outcome:'failure', level:'warning', route:'order', rpc:'orderMarkShippedRpc' }, null);
    return { ok: false, error: 'AUTH_REQUIRED' };
  }
  if (checkRotateLock_()) return { ok:false, error:'ROTATE_LOCK' };
  var _shipLock = LockService.getScriptLock();
  if (!_shipLock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    const sh  = sheetOrders_();
    const n   = sh.getLastRow();
    if (n < 2) return { ok:false, error:'not found' };
    const ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    const idx = ids.indexOf(String(orderId));
    if (idx < 0) return { ok:false, error:'not found' };
    const rowNo = idx + 2;
    const statusColIdx  = ORDER_COLS.indexOf('status') + 1;
    // Read the full order INSIDE the lock — status re-check + fulfillment/original carrier.
    const numCols = Math.min(ORDER_COLS.length, sh.getLastColumn());
    var srcRow = sh.getRange(rowNo, 1, 1, numCols).getValues()[0];
    while (srcRow.length < ORDER_COLS.length) srcRow.push('');
    const order = rowToOrder_(srcRow);
    const curStatus = String(order.status || '');
    // Allow shipping from 'approved' or re-shipping from 'shipped' (tracking-number fix).
    if (curStatus !== 'approved' && curStatus !== 'shipped') {
      return { ok:false, error:'ORDER_NOT_APPROVED' };
    }
    const td  = trackingData || {};
    // --- INPUT VALIDATION (only tracking_number + note come from the client) ---
    var tnRaw = String(td.tracking_number||'').trim().replace(/[\x00-\x1F\x7F\x80-\x9F]/g,'');
    var tnLenE = assertMaxLength_(tnRaw, 100, 'หมายเลขพัสดุ');
    if (tnLenE) return { ok:false, error:tnLenE };
    var noteVal = '';
    if (td.note) {
      var tnoteR = normalizeMultilineText_(td.note||'', { maxLen:VLEN.LONG, fieldName:'หมายเหตุ', allowEmpty:true });
      if (!tnoteR.ok) return { ok:false, error:tnoteR.error };
      noteVal = tnoteR.value;
    }
    // --- END VALIDATION ---
    const now = nowISO_();
    // Resolve the ACTUAL fulfillment carrier on the backend (never trusted from the client):
    // use the override if present, else the customer's original selection. carrier_id /
    // tracking_provider / tracking_url_template come from the live shipping config, with a
    // snapshot fallback if the company was later deleted from config.
    var ff = order.fulfillment_shipping || null;
    var firstShip = (Array.isArray(order.shipping_info) && order.shipping_info[0]) ? order.shipping_info[0] : null;
    var srcCompanyId = ff ? String(ff.company_id||'') : (firstShip ? String(firstShip.company_id||'') : '');
    var srcMethodId  = ff ? String(ff.method_id||'')  : (firstShip ? String(firstShip.method_id||'')  : '');
    var carrierId = 'other', carrierName = '', resolvedProvider = '', urlTemplate = '';
    var resolvedCarrier = resolveShippingCompanyMethod_(srcCompanyId, srcMethodId);
    if (resolvedCarrier) {
      carrierId       = String(resolvedCarrier.company.carrier_id || 'other');
      carrierName     = String(resolvedCarrier.company.name || '');
      resolvedProvider= String(resolvedCarrier.company.tracking_provider || '');
      urlTemplate     = String(resolvedCarrier.company.tracking_url_template || '');
    } else if (ff) {
      // Company deleted from config → use the metadata snapshotted at override time.
      carrierId        = String(ff.carrier_id || 'other');
      carrierName      = String(ff.company_name || '');
      resolvedProvider = String(ff.tracking_provider || '');
      urlTemplate      = String(ff.tracking_url_template || '');
    } else if (firstShip) {
      carrierName = String(firstShip.company_name || '');
    }
    if (!/^[a-zA-Z0-9_\-]{1,50}$/.test(carrierId)) carrierId = 'other';
    var trackingUrl = '';
    if (urlTemplate && tnRaw) {
      try { trackingUrl = urlTemplate.replace('{T}', encodeURIComponent(tnRaw)); } catch(_) { trackingUrl = ''; }
    }
    const trackingJson = {
      tracking_number:   tnRaw,
      carrier_id:        carrierId,
      carrier_name:      carrierName,
      tracking_url:      trackingUrl,
      shipped_at:        now,
      note:              noteVal,
      auto_tracking:     resolvedProvider !== '',   // backward compat for old readers
      tracking_provider: resolvedProvider,
      // Provenance: whether this shipment used the fulfillment override or the original selection.
      fulfillment_source: ff ? 'override' : 'original'
    };
    // Build history note
    var histNote = trackingJson.carrier_name;
    if (trackingJson.tracking_number) histNote += ' ' + trackingJson.tracking_number;
    // Append status_history
    const histCol = ORDER_COLS.indexOf('status_history_json') + 1;
    var history = [];
    try { history = JSON.parse(String(sh.getRange(rowNo, histCol).getValue() || '[]')); } catch(_) { history = []; }
    history.push({ status:'shipped', timestamp:now, note: histNote.trim() });
    // Write all fields
    sh.getRange(rowNo, statusColIdx).setValue('shipped');
    sh.getRange(rowNo, ORDER_COLS.indexOf('updated_at')+1).setValue(now);
    sh.getRange(rowNo, histCol).setValue(JSON.stringify(history));
    sh.getRange(rowNo, ORDER_COLS.indexOf('tracking_json')+1).setValue(encryptField_(JSON.stringify(trackingJson)));
    // Register / validate with tracking provider
    // AfterShip: register (push-based); ThaiPost/ETracking: validate call (pull-based — warns admin if API/key is broken)
    var aftershipResult;
    if (resolvedProvider === 'aftership') {
      aftershipResult = registerAftershipTracking_(
        trackingJson.carrier_id, trackingJson.tracking_number, orderId);
    } else if (resolvedProvider === 'thaipost') {
      var tpRes = callThaipostTracking_(trackingJson.tracking_number);
      aftershipResult = Object.assign({ provider: 'thaipost' },
        tpRes.ok ? { ok: true, source: 'thaipost' } : tpRes);
    } else if (resolvedProvider === 'etracking') {
      var etRes = callEtrackTracking_(trackingJson.tracking_number, trackingJson.carrier_id);
      aftershipResult = Object.assign({ provider: 'etracking' },
        etRes.ok ? { ok: true, source: 'etracking' } : etRes);
    } else {
      aftershipResult = { ok: true, source: resolvedProvider || 'skipped' };
    }
    // Re-read and return updated record
    var row = sh.getRange(rowNo, 1, 1, numCols).getValues()[0];
    while (row.length < ORDER_COLS.length) row.push('');
    enqueueLog_('order.mark.shipped', { category:['order'], type:['change'],
      outcome:'success', route:'order', rpc:'orderMarkShippedRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ order_id_hash: hashForLog_(orderId, 'o_'), order_status:'shipped',
             carrier: safeLogString_(carrierId, 40),
             fulfillment_source: trackingJson.fulfillment_source,
             has_tracking_no: !!trackingJson.tracking_number,
             tracking_provider: safeLogString_(resolvedProvider, 20) } }, _sess.logCtx);
    return { ok:true, record: rowToOrder_(row), aftership: aftershipResult };
  } catch(err) {
    return { ok:false, error:String(err) };
  } finally {
    try { _shipLock.releaseLock(); } catch(_) {}
  }
}

// getCarrierTrackingRpc, saveAftershipKeyRpc, clearAftershipKeyRpc,
// registerAftershipTracking_, deleteAftershipTracking_, and all AfterShip helpers
// have been moved to shipping.gs

/* ========== SHIPPING SYSTEM ========== */

function readShippingFromSheet_(){
  const sh = sheetShipping_();
  const n  = sh.getLastRow();
  if(n < 2) return [];
  const numCols = Math.min(7, sh.getLastColumn());
  return sh.getRange(2,1,n-1,numCols).getValues().map(r => {
    var col7 = r[6];
    // Migration: old boolean auto_tracking → new string tracking_provider
    var trackingProvider = '';
    if (typeof col7 === 'string' && col7 !== 'true' && col7 !== 'false') {
      trackingProvider = col7; // already new format
    } else if (col7 === true || col7 === 'true') {
      trackingProvider = 'aftership'; // backward compat default
    }
    return {
      id:                   String(r[0]||''),
      name:                 String(r[1]||''),
      active:               String(r[2]||'true') !== 'false' && r[2] !== false,
      methods:              (()=>{ try{ return JSON.parse(String(r[3]||'[]')); }catch(_){ return []; } })(),
      carrier_id:           String(r[4]||'other'),
      tracking_url_template:String(r[5]||''),
      tracking_provider:    trackingProvider
    };
  });
}

function invalidateShippingCache_() {
  try { CacheService.getScriptCache().remove(CACHE_SHIPPING_LIST); } catch(_) {}
}

function getShippingCached_() {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(CACHE_SHIPPING_LIST);
  if (raw) { try { return JSON.parse(raw); } catch(_) {} }
  const data = readShippingFromSheet_();
  try { cache.put(CACHE_SHIPPING_LIST, JSON.stringify(data), 600); } catch(_) {}
  return data;
}

// Resolve a shipping company + method by id from the shipping config.
// Returns { company, method } (raw config objects) or null if either is missing.
// Does not enforce active — callers decide (submit needs active; readback/label may not).
function resolveShippingCompanyMethod_(companyId, methodId) {
  var cid = String(companyId || '');
  var mid = String(methodId || '');
  if (!cid || !mid) return null;
  var companies = getShippingCached_();
  var company = null;
  for (var i = 0; i < companies.length; i++) {
    if (String(companies[i].id) === cid) { company = companies[i]; break; }
  }
  if (!company) return null;
  var methods = Array.isArray(company.methods) ? company.methods : [];
  var method = null;
  for (var j = 0; j < methods.length; j++) {
    if (String(methods[j].id) === mid) { method = methods[j]; break; }
  }
  if (!method) return null;
  return { company: company, method: method };
}

// Persistent monetary lock: an order whose money is frozen. Locked once the order has
// EVER reached paid/approved/shipped/delivered — even if later rolled back to unpaid —
// so shipping_fee/subtotal/total can never be edited after payment. Derived from status
// history (backward-compatible: paid orders already carry 'paid' in status_history).
function _pricingLocked_(order) {
  var LOCKED = { paid:1, approved:1, shipped:1, delivered:1 };
  if (order && LOCKED[String(order.status || '')]) return true;
  var hist = (order && Array.isArray(order.status_history)) ? order.status_history : [];
  for (var i = 0; i < hist.length; i++) {
    if (LOCKED[String(hist[i] && hist[i].status || '')]) return true;
  }
  return false;
}

// Strip internal-only fields from a fulfillment override before exposing it to the
// customer. Keeps only what is safe to show ("will ship via <company> <method>").
function _customerSafeFulfillment_(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    company_name: String(f.company_name || ''),
    method_name:  String(f.method_name || ''),
    carrier_id:   String(f.carrier_id || '')
  };
}

function getShippingRpc() {
  // Public: returns only shipping companies/methods. Provider key readiness +
  // masked keys must NOT be exposed here — they are admin metadata. See
  // getShippingProviderStatusRpc(token) for the admin-only variant.
  try {
    return { ok:true, companies: readShippingFromSheet_() };
  } catch(err) {
    return { ok:false, error:String(err), companies:[] };
  }
}

function getShippingProviderStatusRpc(token) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sp = PropertiesService.getScriptProperties();
    return {
      ok: true,
      hasAftershipKey:  !!(sp.getProperty('AFTERSHIP_API_KEY') || '').trim(),
      hasThaipostToken: !!(sp.getProperty('THP_STATIC_TOKEN')  || '').trim(),
      hasEtrackKey:     !!(sp.getProperty('ETRACK_API_KEY')    || '').trim()
    };
  } catch(err) {
    return { ok:false, error:String(err), hasAftershipKey:false, hasThaipostToken:false, hasEtrackKey:false };
  }
}

function deactivateProductsWithNoValidShipping_(activeMethodIds) {
  var sh = sheetProd_();
  var n  = sh.getLastRow();
  if (n < 2) return 0;
  var rows = sh.getRange(2, 1, n - 1, 20).getValues();
  var updates = [];
  for (var i = 0; i < rows.length; i++) {
    var saleMode = String(rows[i][19]||'').trim().toLowerCase();
    if (!saleMode) saleMode = _computeSaleModeFromLegacy_(rows[i][9], rows[i][15], rows[i][16], rows[i][17]);
    if (saleMode === 'disabled') continue;
    var raw = String(rows[i][13] || ''); // col 14 = allowed_shipping_ids
    if (!raw || raw === '[]') continue; // ไม่ได้จำกัด = ไม่ตรวจ
    var ids; try { ids = JSON.parse(raw); } catch(_) { continue; }
    if (!Array.isArray(ids) || !ids.length) continue;
    var hasValid = ids.some(function(id) { return activeMethodIds.has(String(id)); });
    if (!hasValid) updates.push(i + 2);
  }
  // Disable via sale_mode (col 20). Also keep legacy active (col 10) in lockstep.
  updates.forEach(function(rowNo) {
    sh.getRange(rowNo, 20).setValue('disabled');
    sh.getRange(rowNo, 10).setValue(false);
  });
  if (updates.length) rebuildSnap_();
  return updates.length;
}

function cleanupOrphanedShippingIds_(removedIds) {
  var sh = sheetProd_();
  var n  = sh.getLastRow();
  if (n < 2) return 0;
  var removed = new Set(removedIds.map(String));
  var col = sh.getRange(2, 14, n - 1, 1).getValues(); // col 14 = allowed_shipping_ids
  var updates = [];
  for (var i = 0; i < col.length; i++) {
    var raw = String(col[i][0] || '');
    if (!raw || raw === '[]') continue;
    var ids; try { ids = JSON.parse(raw); } catch(_) { continue; }
    if (!Array.isArray(ids) || !ids.length) continue;
    var filtered = ids.filter(function(id){ return !removed.has(String(id)); });
    if (filtered.length !== ids.length) updates.push({ rowNo: i + 2, val: JSON.stringify(filtered) });
  }
  updates.forEach(function(u){ sh.getRange(u.rowNo, 14).setValue(u.val); });
  if (updates.length) rebuildSnap_();
  return updates.length;
}

function _getActiveShippingMethodIds_() {
  var ids = new Set();
  try {
    getShippingCached_().forEach(function(c) {
      if (!c || c.active === false) return;
      (c.methods || []).forEach(function(m) {
        if (m && m.active !== false && m.id) ids.add(String(m.id));
      });
    });
  } catch(_) {}
  return ids;
}

function _hasAnyActiveShippingMethod_(allowedIds) {
  var active = _getActiveShippingMethodIds_();
  if (!active.size) return false;
  var arr = Array.isArray(allowedIds) ? allowedIds : [];
  return arr.some(function(id){ return active.has(String(id)); });
}

function saveShippingRpc(token, data) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    const arr = Array.isArray(data) ? data : [];
    const sh  = sheetShipping_();

    // --- INPUT VALIDATION ---
    var cleanArr = [];
    for (var sci = 0; sci < arr.length; sci++) {
      var scR = sanitizeShippingCompany_(arr[sci]);
      if (!scR.ok) return { ok:false, error:'บริษัทขนส่งที่ ' + (sci+1) + ': ' + scR.error };
      // preserve existing id (or generate new) outside the schema helper
      var cleaned = scR.value;
      cleaned.id = arr[sci].id || uuid_();
      cleanArr.push(cleaned);
    }
    // --- END VALIDATION ---

    // เก็บ method IDs เดิมก่อน overwrite
    const oldMethodIds = new Set();
    readShippingFromSheet_().forEach(function(c) {
      (c.methods || []).forEach(function(m) { if (m.id) oldMethodIds.add(m.id); });
    });

    // Clear old data without deleting physical rows. deleteRows() shrinks the
    // sheet grid, so a later write with more companies can make getRange()
    // exceed getMaxRows() (especially after repeated QA fixture saves).
    if(sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 7).clearContent();
    if(cleanArr.length > 0){
      var requiredRows = cleanArr.length + 1; // header + data
      if (sh.getMaxRows() < requiredRows) {
        sh.insertRowsAfter(sh.getMaxRows(), requiredRows - sh.getMaxRows());
      }
      const rows = cleanArr.map(function(c) { return [
        c.id,
        sanitizeSheetCell_(c.name),
        c.active !== false,
        JSON.stringify(c.methods || []),
        c.carrier_id,
        sanitizeSheetCell_(c.tracking_url_template || ''),
        c.tracking_provider || ''
      ]; });
      sh.getRange(2, 1, rows.length, 7).setValues(rows);
    }

    // หา IDs ที่ถูกลบ → cleanup products
    const newMethodIds = new Set();
    cleanArr.forEach(function(c) {
      (c.methods||[]).forEach(function(m){ if(m.id) newMethodIds.add(m.id); });
    });
    const removedIds = [...oldMethodIds].filter(function(id){ return !newMethodIds.has(id); });

    // ตรวจสอบสินค้าที่เปิดขายอยู่ แต่ไม่มีวิธีจัดส่งที่ active อีกต่อไป → ปิดอัตโนมัติ
    // ต้องทำ "ก่อน" cleanupOrphanedShippingIds_ เพราะ cleanup จะ strip id ที่ถูกลบออก
    // ทำให้ allowed_shipping_ids กลายเป็น [] ซึ่ง deactivate จะข้าม (treat as ไม่จำกัด)
    const activeMethodIds = new Set();
    cleanArr.forEach(function(c) {
      if (c.active === false) return;
      (c.methods||[]).forEach(function(m) { if (m.active !== false && m.id) activeMethodIds.add(m.id); });
    });
    var deactivatedProducts = deactivateProductsWithNoValidShipping_(activeMethodIds);

    // หลังปิดสินค้าแล้ว ค่อย strip id วิธีจัดส่งที่ถูกลบออกจาก allowed_shipping_ids
    var cleanedProducts = removedIds.length ? cleanupOrphanedShippingIds_(removedIds) : 0;
    invalidateShippingCache_();

    auditLog_('shipping.config.update', { category:['configuration'], type:['change'],
      outcome:'success', route:'shipping', rpc:'saveShippingRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ company_count: cleanArr.length, cleaned_products: cleanedProducts,
             deactivated_products: deactivatedProducts } }, _sess.logCtx);
    return { ok:true, count: cleanArr.length, cleanedProducts: cleanedProducts, deactivatedProducts: deactivatedProducts };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}

/* ========== ORDER TOKEN EXPIRY ========== */

function updateOrdersTokenExpiryRpc(token, expireDays) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    var days = Number(expireDays);
    if (isNaN(days) || days < 0) days = 90;
    var sh = sheetOrders_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok: true, updated: 0 };

    var createdColIdx  = ORDER_COLS.indexOf('created_at')       + 1;
    var expiresColIdx  = ORDER_COLS.indexOf('token_expires_at') + 1;

    var createdVals = sh.getRange(2, createdColIdx, n - 1, 1).getValues();
    var newExpires  = createdVals.map(function(r) {
      var createdMs = r[0] ? new Date(String(r[0])).getTime() : 0;
      if (!createdMs) return [''];
      if (days === 0) return [''];
      return [ new Date(createdMs + days * 86400000).toISOString() ];
    });

    sh.getRange(2, expiresColIdx, n - 1, 1).setValues(newExpires);
    auditLog_('order.token_expiry.update', { category:['configuration'], type:['change'],
      outcome:'success', route:'order', rpc:'updateOrdersTokenExpiryRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ expire_days: days, updated: newExpires.length } }, _sess.logCtx);
    return { ok: true, updated: newExpires.length };
  } catch(err) {
    return { ok: false, error: String(err) };
  }
}

/* ========== AUTH: LOGIN / SESSION ========== */

function loginRpc(email, password, clientCtx) {
  var ctx = sanitizeClientLogContext_(clientCtx);
  var emailHash = hashForLog_(String(email||'').toLowerCase(), 'e_');
  try {
    if (!email || !password) return { ok:false, error:'กรุณากรอกอีเมลและรหัสผ่าน' };
    // Rate limiting: 5 failed attempts → lock 5 minutes
    var rateKey = RATE_LOGIN_PREFIX + String(email).toLowerCase();
    var rl = checkRateLimit_(rateKey, 5, 300);
    if (rl.blocked) {
      enqueueLog_('rate_limit.block', { category:['authentication'], type:['denied'],
        outcome:'failure', route:'login', rpc:'loginRpc',
        meta:{ email_hash:emailHash, wait_seconds:rl.waitSeconds } }, ctx);
      return { ok:false, error:'ล็อกชั่วคราว กรุณารอ ' + rl.waitSeconds + ' วินาทีแล้วลองใหม่' };
    }

    var user = getUserByEmail_(email);
    if (!user) {
      recordFailedAttempt_(rateKey, 5, 300);
      enqueueLog_('admin.login.fail', { category:['authentication'], type:['start'],
        outcome:'failure', route:'login', rpc:'loginRpc',
        meta:{ email_hash:emailHash, reason:'unknown_email' } }, ctx);
      return { ok:false, error:'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
    }

    // Support v2 (PBKDF2, new "v2:ITER:HASH" or legacy "v2:HASH") and SHA-256
    var storedHash = String(user.password_hash);
    var isV2 = storedHash.indexOf('v2:') === 0;
    var passwordOk = false;
    var needsUpgrade = false;
    if (isV2) {
      var parsed = parseV2Hash_(storedHash);
      var computed = pbkdf2_(String(password), user.salt, parsed.iterations, 32);
      passwordOk = (computed === parsed.hash);
      // Upgrade if using legacy 100k-iteration format
      needsUpgrade = passwordOk && (parsed.iterations !== PBKDF2_ITERATIONS);
    } else {
      passwordOk = (hashPassword_(String(password), user.salt) === storedHash);
      needsUpgrade = passwordOk; // upgrade SHA-256 → PBKDF2
    }
    if (!passwordOk) {
      recordFailedAttempt_(rateKey, 5, 300);
      enqueueLog_('admin.login.fail', { category:['authentication'], type:['start'],
        outcome:'failure', route:'login', rpc:'loginRpc', userId:user.id,
        meta:{ email_hash:emailHash, reason:'bad_password' } }, ctx);
      return { ok:false, error:'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
    }
    clearRateLimit_(rateKey); // reset on success

    // Upgrade to current PBKDF2 iteration count on successful login
    if (needsUpgrade) {
      var newSalt = genSalt_();
      var newHash = hashPasswordV2_(String(password), newSalt);
      var sh = sheetUsers_();
      sh.getRange(user._rowNo, 3).setValue(newHash);
      sh.getRange(user._rowNo, 4).setValue(newSalt);
    }

    if (user.otp_required) {
      // Throttle OTP generation per email. The login rate-limit above only
      // counts FAILED logins, so a caller with valid credentials could
      // otherwise request unlimited OTP emails — spamming the inbox, burning
      // MailApp quota, and resetting the OTP-verify attempt counter each send.
      var otpSendKey = RATE_OTP_SEND_PREFIX + user.email.toLowerCase();
      var otpRl = checkRateLimit_(otpSendKey, OTP_SEND_MAX, OTP_SEND_WINDOW_SEC);
      if (otpRl.blocked) {
        enqueueLog_('rate_limit.block', { category:['authentication'], type:['denied'],
          outcome:'failure', route:'login', rpc:'loginRpc', userId:user.id,
          meta:{ email_hash:emailHash, reason:'otp_send_throttled', wait_seconds:otpRl.waitSeconds } }, ctx);
        return { ok:false, error:'ขอรหัส OTP บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' };
      }
      recordFailedAttempt_(otpSendKey, OTP_SEND_MAX, OTP_SEND_WINDOW_SEC); // count this send
      var otp     = Math.floor(100000 + Math.random() * 900000).toString();
      var otpKey  = LOGIN_OTP_PREFIX + user.email.toLowerCase();
      var expires = Date.now() + LOGIN_OTP_TTL * 1000;
      CacheService.getScriptCache().put(otpKey, JSON.stringify({otp:otp, expires:expires, email:user.email, role:user.role, id:user.id}), LOGIN_OTP_TTL);
      var masked = maskEmail_(user.email);
      sendOtpEmail_(user.email, 'รหัส OTP เข้าสู่ระบบ', otp);
      enqueueLog_('otp.send', { category:['authentication'], type:['info'],
        outcome:'success', route:'login', rpc:'loginRpc', userId:user.id,
        meta:{ email_hash:emailHash, channel:'email' } }, ctx);
      return { ok:true, otpRequired:true, maskedEmail:masked };
    }

    var token = createSession_(user.id, user.email, user.role, ctx);
    enqueueLog_('admin.login.success', { category:['authentication'], type:['start'],
      outcome:'success', route:'login', rpc:'loginRpc', userId:user.id, sessionId:token,
      meta:{ role:user.role } }, ctx);
    return { ok:true, otpRequired:false, token:token };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function loginVerifyOtpRpc(email, otp, clientCtx) {
  var ctx = sanitizeClientLogContext_(clientCtx);
  var emailHash = hashForLog_(String(email||'').toLowerCase(), 'e_');
  try {
    if (!email || !otp) return { ok:false, error:'ข้อมูลไม่ครบ' };
    var key = LOGIN_OTP_PREFIX + String(email).toLowerCase();
    var raw = CacheService.getScriptCache().get(key);
    if (!raw) return { ok:false, error:'ไม่พบรหัส OTP กรุณาเข้าสู่ระบบใหม่' };
    var data;
    try { data = JSON.parse(raw); } catch(_) { return { ok:false, error:'ข้อมูล OTP เสียหาย' }; }
    if (Date.now() > Number(data.expires || 0)) {
      CacheService.getScriptCache().remove(key);
      return { ok:false, error:'รหัส OTP หมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่' };
    }
    if (String(otp).trim() !== String(data.otp)) {
      data.attempts = (data.attempts || 0) + 1;
      if (data.attempts >= 5) {
        CacheService.getScriptCache().remove(key);
        enqueueLog_('otp.verify.fail', { category:['authentication'], type:['denied'],
          outcome:'failure', route:'login', rpc:'loginVerifyOtpRpc', userId:data.id,
          meta:{ email_hash:emailHash, reason:'attempts_exceeded' } }, ctx);
        return { ok:false, error:'พยายามเกินกำหนด รหัส OTP ถูกยกเลิก กรุณาเข้าสู่ระบบใหม่' };
      }
      // Re-put with the REMAINING ttl (like otpFail_) — a full LOGIN_OTP_TTL here
      // would slide the cache lifetime forward on every wrong guess.
      var _remainSec = Math.max(1, Math.ceil((Number(data.expires) - Date.now()) / 1000));
      CacheService.getScriptCache().put(key, JSON.stringify(data), Math.min(LOGIN_OTP_TTL, _remainSec));
      enqueueLog_('otp.verify.fail', { category:['authentication'], type:['denied'],
        outcome:'failure', route:'login', rpc:'loginVerifyOtpRpc', userId:data.id,
        meta:{ email_hash:emailHash, reason:'bad_otp', attempts:data.attempts } }, ctx);
      return { ok:false, error:'รหัส OTP ไม่ถูกต้อง (' + (5 - data.attempts) + ' ครั้งที่เหลือ)' };
    }
    CacheService.getScriptCache().remove(key);
    var userId = data.id;
    if (!userId) { var u = getUserByEmail_(data.email); userId = u ? u.id : null; }
    if (!userId) return { ok:false, error:'ไม่พบผู้ใช้' };
    var token = createSession_(userId, data.email, data.role || 'admin', ctx);
    enqueueLog_('otp.verify.success', { category:['authentication'], type:['start'],
      outcome:'success', route:'login', rpc:'loginVerifyOtpRpc', userId:userId, sessionId:token,
      meta:{ email_hash:emailHash, role:data.role || 'admin' } }, ctx);
    return { ok:true, token:token };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function validateSessionRpc(token) {
  try {
    var sess = getSession_(token);
    if (!sess) return { ok:false, error:'SESSION_INVALID' };
    return { ok:true, userId:sess.userId, email:sess.email, role:sess.role, isOwner:isOwner_(token) };
  } catch(_) { return { ok:false, error:'SESSION_INVALID' }; }
}

function logoutRpc(token) {
  try {
    if (token) {
      var dot = token.indexOf('.');
      if (dot > 0) {
        var userId = token.slice(0, dot);
        CacheService.getScriptCache().remove(SESS_PREFIX + userId);
        try { setUserSessionKey_(userId, ''); } catch(_) {}
        enqueueLog_('admin.logout', { category:['authentication'], type:['end'],
          outcome:'success', route:'login', rpc:'logoutRpc', userId:userId,
          sessionId:token }, null);
      }
    }
    return { ok:true };
  } catch(_) { return { ok:true }; }
}

/* ========== AUTH: USER MANAGEMENT ========== */

function userListRpc(token, opts) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetUsers_();
    var n  = sh.getLastRow();
    var ownerEmail = '';
    try { ownerEmail = Session.getEffectiveUser().getEmail(); } catch(_) {}
    if (n < 2) return { ok:true, users:[], total:0, ownerEmail:ownerEmail };
    var rows = sh.getRange(2,1,n-1,8).getValues();
    var users = rows.map(function(r) {
      return { id:String(r[0]), email:String(r[1]), role:String(r[4]||'admin'),
               otp_required:(r[5]===true||r[5]==='true'),
               created_at:String(r[6]||''), updated_at:String(r[7]||'') };
    });
    var q = opts && opts.q ? String(opts.q).toLowerCase() : '';
    if (q) users = users.filter(function(u){ return String(u.email||'').toLowerCase().indexOf(q) >= 0; });
    users.sort(function(a,b){ return String(b.created_at).localeCompare(String(a.created_at)); });
    var total = users.length;
    if (opts && opts.limit) {
      var off = Math.max(0, Number(opts.offset)||0);
      var lim = Math.min(100, Math.max(1, Number(opts.limit)));
      users = users.slice(off, off+lim);
    }
    return { ok:true, users:users, total:total, ownerEmail:ownerEmail };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function userCreateRpc(token, payload) {
  var _sess = requireOwner_(token);
  if (!_sess) {
    enqueueLog_('owner.required.fail', { category:['authentication'], type:['denied'],
      outcome:'failure', level:'warning', route:'user', rpc:'userCreateRpc' }, null);
    return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  }
  try {
    var p = payload || {};
    if (!p.email || !p.password) return { ok:false, error:'email และ password จำเป็น' };
    // --- INPUT VALIDATION ---
    var emailR = normalizeEmail_(p.email);
    if (!emailR.ok) return { ok:false, error:emailR.error };
    p.email = emailR.value;
    if (String(p.password).length < 8)   return { ok:false, error:'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' };
    if (String(p.password).length > 128) return { ok:false, error:'รหัสผ่านยาวเกิน 128 ตัวอักษร' };
    var ALLOWED_ROLES = ['admin'];
    var roleR = normalizeEnum_(p.role||'admin', ALLOWED_ROLES, 'role');
    if (!roleR.ok) return { ok:false, error:roleR.error };
    p.role = roleR.value;
    // --- END VALIDATION ---
    if (getUserByEmail_(p.email)) return { ok:false, error:'อีเมลนี้ถูกใช้งานแล้ว' };
    var salt = genSalt_();
    var hash = hashPasswordV2_(String(p.password), salt);
    var now  = nowISO_();
    sheetUsers_().appendRow([uuid_(), sanitizeSheetCell_(p.email), hash, salt,
                              sanitizeSheetCell_(p.role), !!p.otp_required, now, now]);
    enqueueLog_('user.create', { category:['iam'], type:['user','creation'],
      outcome:'success', route:'user', rpc:'userCreateRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'user', email_hash: hashForLog_(p.email, 'e_'), role:p.role } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function userUpdateRpc(token, id, patch) {
  var _sess = requireOwner_(token);
  if (!_sess) {
    enqueueLog_('owner.required.fail', { category:['authentication'], type:['denied'],
      outcome:'failure', level:'warning', route:'user', rpc:'userUpdateRpc' }, null);
    return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  }
  try {
    var sh = sheetUsers_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบผู้ใช้' };
    var rows = sh.getRange(2,1,n-1,8).getValues();
    var rowNo = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === String(id)) { rowNo = i+2; break; }
    }
    if (rowNo < 0) return { ok:false, error:'ไม่พบผู้ใช้' };
    var p = patch || {};
    var now = nowISO_();
    if (p.password !== undefined) {
      if (String(p.password).length < 8)   return { ok:false, error:'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' };
      if (String(p.password).length > 128) return { ok:false, error:'รหัสผ่านยาวเกิน 128 ตัวอักษร' };
      var salt = genSalt_();
      var hash = hashPasswordV2_(String(p.password), salt);
      sh.getRange(rowNo,3).setValue(hash);
      sh.getRange(rowNo,4).setValue(salt);
    }
    if (p.otp_required !== undefined) sh.getRange(rowNo,6).setValue(!!p.otp_required);
    sh.getRange(rowNo,8).setValue(now);
    enqueueLog_('user.update', { category:['iam'], type:['user','change'],
      outcome:'success', route:'user', rpc:'userUpdateRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'user', resource_id_hash: hashForLog_(id, 'u_'),
             password_changed: p.password !== undefined,
             otp_changed: p.otp_required !== undefined } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function userDeleteRpc(token, id) {
  var _sess = requireOwner_(token);
  if (!_sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    var ownerEmail = '';
    try { ownerEmail = Session.getEffectiveUser().getEmail().toLowerCase(); } catch(_) {}
    var sh = sheetUsers_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบผู้ใช้' };
    var rows = sh.getRange(2,1,n-1,8).getValues();
    var adminCount = rows.filter(function(r){ return String(r[4])==='admin'; }).length;
    var rowNo = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === String(id)) { rowNo = i+2; break; }
    }
    if (rowNo < 0) return { ok:false, error:'ไม่พบผู้ใช้' };
    var targetEmail = String(rows[rowNo-2][1]||'').toLowerCase();
    if (ownerEmail && targetEmail === ownerEmail) return { ok:false, error:'ไม่สามารถลบบัญชีเจ้าของ Script ได้' };
    var targetRole = String(rows[rowNo-2][4]||'admin');
    if (targetRole === 'admin' && adminCount <= 1) return { ok:false, error:'ไม่สามารถลบ admin คนสุดท้ายได้' };
    var targetId = String(rows[rowNo-2][0]);
    sh.deleteRow(rowNo);
    CacheService.getScriptCache().remove(SESS_PREFIX + targetId);
    auditLog_('user.delete', { category:['iam'], type:['user','deletion'],
      outcome:'success', level:'warning', route:'user', rpc:'userDeleteRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'user', resource_id_hash: hashForLog_(targetId, 'u_'),
             email_hash: hashForLog_(targetEmail, 'e_'), role: targetRole } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function userRequestEmailChangeOtpRpc(token, userId, newEmail) {
  var _sess = requireOwner_(token);
  if (!_sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    newEmail = String(newEmail||'').trim().toLowerCase();
    if (!newEmail || newEmail.indexOf('@') < 1) return { ok:false, error:'อีเมลไม่ถูกต้อง' };
    var existing = getUserByEmail_(newEmail);
    if (existing && existing.id !== String(userId)) return { ok:false, error:'อีเมลนี้ถูกใช้งานแล้ว' };
    var otp = otpIssue_('email_change', userId, { newEmail: newEmail }, LOGIN_OTP_TTL);
    sendOtpEmail_(newEmail, 'ยืนยันการเปลี่ยนอีเมล', otp);
    auditLog_('user.email_change.otp_send', { category:['iam'], type:['user','change'],
      outcome:'success', route:'user', rpc:'userRequestEmailChangeOtpRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'user', resource_id_hash: hashForLog_(userId, 'u_'),
             new_email_hash: hashForLog_(newEmail, 'e_') } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function userConfirmEmailChangeRpc(token, userId, newEmail, otp) {
  var _sess = requireOwner_(token);
  if (!_sess) return { ok:false, error:'เฉพาะเจ้าของระบบเท่านั้น' };
  try {
    var normalizedNewEmail = String(newEmail||'').trim().toLowerCase();
    var otpResult = otpVerify_('email_change', userId, otp, LOGIN_OTP_TTL, function(record) {
      if (record.newEmail !== normalizedNewEmail) return 'ข้อมูลอีเมลไม่ตรงกัน';
      return null;
    });
    if (!otpResult.ok) return { ok:false, error:otpResult.error };
    var confirmedEmail = otpResult.record.newEmail;
    var sh = sheetUsers_();
    var n  = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบผู้ใช้' };
    var rows = sh.getRange(2,1,n-1,8).getValues();
    var rowNo = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === String(userId)) { rowNo = i+2; break; }
    }
    if (rowNo < 0) return { ok:false, error:'ไม่พบผู้ใช้' };
    sh.getRange(rowNo,2).setValue(confirmedEmail);
    sh.getRange(rowNo,8).setValue(nowISO_());
    // Update session cache with new email (keyed by userId)
    var sess = getSession_(token);
    if (sess && sess.userId) {
      var raw2 = CacheService.getScriptCache().get(SESS_PREFIX + sess.userId);
      if (raw2) {
        try {
          var c2 = JSON.parse(raw2);
          c2.email = confirmedEmail;
          CacheService.getScriptCache().put(SESS_PREFIX + sess.userId, JSON.stringify(c2), SESS_TTL);
        } catch(_) {}
      }
    }
    auditLog_('user.email_change.confirm', { category:['iam'], type:['user','change'],
      outcome:'success', level:'warning', route:'user', rpc:'userConfirmEmailChangeRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'user', resource_id_hash: hashForLog_(userId, 'u_'),
             new_email_hash: hashForLog_(confirmedEmail, 'e_') } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ============================================================
 * SHARED SCHEDULE HELPERS  (Part 0)
 * Used by: Promotion, Product Sale Window, Gift Rule
 * ============================================================ */

// Coerce a raw schedule payload into normalized form.
// no_end_date defaults to TRUE when not provided (new behavior).
function _normalizeSchedule_(payload) {
  var p = payload || {};
  var startsAt = p.starts_at;
  var endsAt = p.ends_at;
  var noEnd;
  if (p.no_end_date === undefined || p.no_end_date === null || p.no_end_date === '') {
    // Default: if neither dates provided → no_end_date true; if ends_at provided → false
    noEnd = !(endsAt && String(endsAt).trim() !== '');
  } else {
    noEnd = (p.no_end_date === true || String(p.no_end_date).toUpperCase() === 'TRUE');
  }
  if (!startsAt || String(startsAt).trim() === '') startsAt = null;
  else startsAt = String(startsAt);
  if (!endsAt || String(endsAt).trim() === '') endsAt = null;
  else endsAt = String(endsAt);
  if (noEnd) endsAt = null;
  return { starts_at: startsAt, ends_at: endsAt, no_end_date: noEnd };
}

function _validateScheduleWindow_(startsAt, endsAt, noEndDate) {
  if (startsAt) {
    var sMs = Date.parse(String(startsAt));
    if (isNaN(sMs)) return { ok: false, error: 'รูปแบบวันที่เริ่มไม่ถูกต้อง' };
  }
  if (!noEndDate) {
    if (!endsAt || String(endsAt).trim() === '') {
      return { ok: false, error: 'ต้องระบุวันที่สิ้นสุด' };
    }
    var eMs = Date.parse(String(endsAt));
    if (isNaN(eMs)) return { ok: false, error: 'รูปแบบวันที่สิ้นสุดไม่ถูกต้อง' };
    if (startsAt && Date.parse(String(startsAt)) >= eMs) {
      return { ok: false, error: 'วันที่เริ่มต้องอยู่ก่อนวันสิ้นสุด' };
    }
  }
  return { ok: true };
}

// Returns: 'disabled' | 'scheduled' | 'active' | 'ended'
function _getScheduleStatus_(enabled, startsAt, endsAt, noEndDate, now) {
  if (!enabled) return 'disabled';
  var nowMs = (now instanceof Date ? now.getTime() : Date.parse(String(now || ''))) || Date.now();
  if (startsAt) {
    var sMs = Date.parse(String(startsAt));
    if (!isNaN(sMs) && nowMs < sMs) return 'scheduled';
  }
  if (!noEndDate && endsAt) {
    var eMs = Date.parse(String(endsAt));
    if (!isNaN(eMs) && nowMs > eMs) return 'ended';
  }
  return 'active';
}

/* ============================================================
 * PRODUCT SALE WINDOW
 * ============================================================ */

function _isProductPublishable_(product) {
  if (!product) return { ok: false, reason: 'missing' };
  if (!product.title || !String(product.title).trim()) return { ok: false, reason: 'no_title' };
  var basePriceOk = Number(product.price) > 0;
  var variantsOk = false;
  if (Array.isArray(product.variants) && product.variants.length) {
    variantsOk = product.variants.every(function(g){
      return (g.options || []).every(function(o){ return Number(o.price) > 0; });
    });
  }
  if (!basePriceOk && !variantsOk) return { ok: false, reason: 'no_price' };
  if (product.sale_mode !== 'disabled') {
    var allowed = product.allowed_shipping_ids || [];
    if (!allowed.length) return { ok: false, reason: 'no_shipping' };
    // If all of the product's allowed methods are currently inactive (company/method
    // toggled off in saveShippingRpc) the product can't actually be purchased, so
    // surface that as non-active sale_status here.
    if (!_hasAnyActiveShippingMethod_(allowed)) {
      return { ok: false, reason: 'no_active_shipping' };
    }
  }
  return { ok: true };
}

function getProductSaleStatus_(product, now) {
  if (!product) return 'disabled';
  var mode = product.sale_mode;
  if (!mode) {
    // Defensive fallback for any code path that constructs a product without going
    // through rebuildSnap_ (e.g. ad-hoc reads). Compute from legacy fields if present.
    mode = _computeSaleModeFromLegacy_(product.active, product.sale_enabled, product.sale_starts_at, product.sale_ends_at);
  }
  if (mode === 'disabled') return 'disabled';
  var pub = _isProductPublishable_(product);
  if (!pub.ok) return 'invalid';
  if (mode === 'always') return 'active';
  // 'scheduled': empty ends_at means no end date.
  var hasEnd = !!String(product.sale_ends_at||'').trim();
  return _getScheduleStatus_(true, product.sale_starts_at, product.sale_ends_at, !hasEnd, now);
}

function applySaleStatusToProducts_(products, now) {
  if (!Array.isArray(products) || !products.length) return products;
  for (var i = 0; i < products.length; i++) {
    products[i].sale_status = getProductSaleStatus_(products[i], now);
  }
  return products;
}

/* ============================================================
 * GIFT SYSTEM — sheets, helpers, RPCs
 * ============================================================ */

function sheetGiftItems_() {
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_GIFT_ITEMS) || ss.insertSheet(SHEET_NAME_GIFT_ITEMS);
  const head = ['gift_id','name','description','image_drive_file_id','image_url','stock','enabled','created_at','updated_at','created_by','updated_by','deleted_at'];
  const firstCell = sh.getLastColumn() > 0 ? sh.getRange(1,1).getValue() : '';
  const curCols = sh.getLastColumn();
  if (firstCell !== 'gift_id') {
    sh.clear();
    sh.getRange(1,1,1,head.length).setValues([head]);
  } else if (curCols < head.length) {
    sh.getRange(1, curCols+1, 1, head.length - curCols).setValues([head.slice(curCols)]);
  }
  return sh;
}

function sheetGiftRules_() {
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME_GIFT_RULES) || ss.insertSheet(SHEET_NAME_GIFT_RULES);
  const head = ['rule_id','name','description','gift_id','condition_type','condition_json','gift_qty','repeat_mode','starts_at','ends_at','no_end_date','enabled','priority','created_at','updated_at','created_by','updated_by','deleted_at'];
  const firstCell = sh.getLastColumn() > 0 ? sh.getRange(1,1).getValue() : '';
  const curCols = sh.getLastColumn();
  if (firstCell !== 'rule_id') {
    sh.clear();
    sh.getRange(1,1,1,head.length).setValues([head]);
  } else if (curCols < head.length) {
    sh.getRange(1, curCols+1, 1, head.length - curCols).setValues([head.slice(curCols)]);
  }
  return sh;
}

function ensureGiftSheets_() {
  sheetGiftItems_(); sheetGiftRules_();
}

function rowToGiftItem_(r) {
  return {
    gift_id: String(r[0]||''),
    name: String(r[1]||''),
    description: String(r[2]||''),
    image_drive_file_id: String(r[3]||''),
    image_url: String(r[4]||''),
    stock: (r[5] === '' || r[5] === null || r[5] === undefined || typeof r[5] === 'boolean') ? NaN : Number(r[5]),
    enabled: r[6] !== false && String(r[6]).toUpperCase() !== 'FALSE',
    created_at: String(r[7]||''),
    updated_at: String(r[8]||''),
    created_by: String(r[9]||''),
    updated_by: String(r[10]||''),
    deleted_at: String(r[11]||'')
  };
}

function rowToGiftRule_(r) {
  var conditionJson = {};
  try { conditionJson = JSON.parse(String(r[5]||'{}')) || {}; } catch(_) { conditionJson = {}; }
  var nedRaw = r[10];
  var noEnd;
  if (nedRaw === '' || nedRaw === undefined || nedRaw === null) {
    var hasEnd = String(r[9]||'').trim() !== '';
    noEnd = !hasEnd;
  } else {
    noEnd = (nedRaw === true || String(nedRaw).toUpperCase() === 'TRUE');
  }
  return {
    rule_id: String(r[0]||''),
    name: String(r[1]||''),
    description: String(r[2]||''),
    gift_id: String(r[3]||''),
    condition_type: String(r[4]||''),
    condition_json: conditionJson,
    // Preserve invalid legacy values so admin APIs can surface the real data.
    // Operational validation below decides whether the rule may be awarded.
    gift_qty: (function(){ if (typeof r[6] === 'boolean') return 0; var v=Number(r[6]); return isNaN(v) ? 0 : v; })(),
    repeat_mode: String(r[7]||'once_per_order'),
    starts_at: String(r[8]||''),
    ends_at: String(r[9]||''),
    no_end_date: noEnd,
    enabled: r[11] !== false && String(r[11]).toUpperCase() !== 'FALSE',
    priority: (function(){ var v=Number(r[12]); return isNaN(v) ? 0 : v; })(),
    created_at: String(r[13]||''),
    updated_at: String(r[14]||''),
    created_by: String(r[15]||''),
    updated_by: String(r[16]||''),
    deleted_at: String(r[17]||'')
  };
}

function listGiftItemsFromSheet_(includeDeleted) {
  var sh = sheetGiftItems_();
  var n = sh.getLastRow();
  if (n < 2) return [];
  var rows = sh.getRange(2, 1, n-1, 12).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var g = rowToGiftItem_(rows[i]);
    if (!includeDeleted && g.deleted_at) continue;
    out.push(g);
  }
  out.sort(function(a,b){ return String(b.created_at).localeCompare(String(a.created_at)); });
  return out;
}

function listGiftRulesFromSheet_(includeDeleted) {
  var sh = sheetGiftRules_();
  var n = sh.getLastRow();
  if (n < 2) return [];
  var rows = sh.getRange(2, 1, n-1, 18).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rowToGiftRule_(rows[i]);
    if (!includeDeleted && r.deleted_at) continue;
    out.push(r);
  }
  out.sort(function(a,b){ return Number(b.priority||0) - Number(a.priority||0); });
  return out;
}

function _giftIsPositiveInteger_(value) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean' || Array.isArray(value)) return false;
  var n = Number(value);
  return isFinite(n) && Math.floor(n) === n && n >= 1;
}

function _giftIsValidStock_(value) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean' || Array.isArray(value)) return false;
  var n = Number(value);
  return isFinite(n) && Math.floor(n) === n && (n === -1 || n >= 0);
}

function _giftIsPositiveNumber_(value) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean' || Array.isArray(value)) return false;
  var n = Number(value);
  return isFinite(n) && n > 0;
}

function _giftItemContractErrors_(gift) {
  var errors = [];
  if (!gift) return ['GIFT_NOT_FOUND'];
  if (!_giftIsValidStock_(gift.stock)) errors.push('GIFT_STOCK_MUST_BE_MINUS_ONE_OR_NON_NEGATIVE_INTEGER');
  return errors;
}

function _giftOperationalContext_() {
  var giftMap = {};
  listGiftItemsFromSheet_(false).forEach(function(g){ giftMap[String(g.gift_id)] = g; });
  var productMap = {};
  try {
    getSnap_().forEach(function(p){ productMap[String(p.id)] = p; });
  } catch(_) {}
  return { giftMap: giftMap, productMap: productMap };
}

function _giftRuleContractErrors_(rule, context) {
  var errors = [];
  var ctx = context || _giftOperationalContext_();
  var gift = ctx.giftMap[String((rule || {}).gift_id || '')];
  if (!gift) errors.push('GIFT_NOT_FOUND');
  else {
    var giftErrors = _giftItemContractErrors_(gift);
    for (var ge = 0; ge < giftErrors.length; ge++) errors.push(giftErrors[ge]);
  }

  var type = String((rule || {}).condition_type || '');
  var cj = (rule && rule.condition_json && typeof rule.condition_json === 'object') ? rule.condition_json : {};
  if (['min_subtotal','required_products','required_variants'].indexOf(type) < 0) {
    errors.push('GIFT_CONDITION_TYPE_INVALID');
  }
  if (!_giftIsPositiveInteger_((rule || {}).gift_qty)) errors.push('GIFT_QTY_MUST_BE_POSITIVE_INTEGER');

  if (type === 'min_subtotal') {
    if (!_giftIsPositiveNumber_(cj.min_subtotal)) errors.push('MIN_SUBTOTAL_MUST_BE_POSITIVE_NUMBER');
  }

  var refs = type === 'required_products' ? cj.required_products
    : (type === 'required_variants' ? cj.required_variants : null);
  if (refs !== null) {
    if (!Array.isArray(refs) || !refs.length) {
      errors.push(type === 'required_products' ? 'REQUIRED_PRODUCTS_EMPTY' : 'REQUIRED_VARIANTS_EMPTY');
    } else {
      var seen = {};
      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i] || {};
        var productId = String(ref.product_id || '');
        var product = ctx.productMap[productId];
        var prefix = type === 'required_products' ? 'REQUIRED_PRODUCT_' : 'REQUIRED_VARIANT_';
        if (!_giftIsPositiveInteger_(ref.min_qty)) errors.push(prefix + 'MIN_QTY_MUST_BE_POSITIVE_INTEGER:' + i);
        if (!product) errors.push(prefix + 'PRODUCT_NOT_FOUND:' + productId);

        var identity = productId;
        if (type === 'required_variants') {
          var variantKey = String(ref.variant_key || '');
          identity += '|' + variantKey;
          if (product && !(product.variants || []).length) {
            errors.push('REQUIRED_VARIANT_PRODUCT_HAS_NO_VARIANTS:' + productId);
          } else if (product && enumerateVariantKeys_(product).indexOf(variantKey) < 0) {
            errors.push('REQUIRED_VARIANT_KEY_INVALID:' + productId + ':' + variantKey);
          }
        }
        if (seen[identity]) errors.push(type === 'required_products' ? 'REQUIRED_PRODUCT_DUPLICATE:' + identity : 'REQUIRED_VARIANT_DUPLICATE:' + identity);
        seen[identity] = true;
      }
    }
  }
  return errors;
}

function _decorateGiftItemOperational_(gift) {
  var errors = _giftItemContractErrors_(gift);
  return Object.assign({}, gift, { operational: errors.length === 0, validation_errors: errors });
}

function _decorateGiftRuleOperational_(rule, context) {
  var errors = _giftRuleContractErrors_(rule, context);
  return Object.assign({}, rule, { operational: errors.length === 0, validation_errors: errors });
}

function _invalidateGiftCaches_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(CACHE_GIFT_ITEMS_LIST);
    cache.remove(CACHE_GIFT_RULES_LIST);
  } catch(_) {}
}

function _disableGiftRulesForGift_(giftId) {
  var sh = sheetGiftRules_();
  var n = sh.getLastRow();
  if (n < 2) return 0;
  var rows = sh.getRange(2, 1, n - 1, 18).getValues();
  var now = nowISO_();
  var disabled = 0;
  for (var i = 0; i < rows.length; i++) {
    var rowNo = i + 2;
    var ruleGiftId = String(rows[i][3] || '');
    var enabled = rows[i][11] === true || String(rows[i][11]).toUpperCase() === 'TRUE';
    var deletedAt = String(rows[i][17] || '');
    if (ruleGiftId !== String(giftId) || !enabled || deletedAt) continue;
    sh.getRange(rowNo, 12).setValue('FALSE');
    sh.getRange(rowNo, 15).setValue(now);
    disabled++;
  }
  if (disabled) _invalidateGiftCaches_();
  return disabled;
}

function getGiftItemById_(giftId) {
  var items = listGiftItemsFromSheet_(false);
  for (var i = 0; i < items.length; i++) {
    if (String(items[i].gift_id) === String(giftId)) return items[i];
  }
  return null;
}

function getGiftRuleStatus_(rule, now) {
  if (!rule || rule.deleted_at) return 'disabled';
  var status = _getScheduleStatus_(!!rule.enabled, rule.starts_at, rule.ends_at, !!rule.no_end_date, now);
  return status === 'ended' ? 'expired' : status;
}

function getActiveGiftRules_(now) {
  var rules = listGiftRulesFromSheet_(false);
  var context = _giftOperationalContext_();
  var out = [];
  for (var i = 0; i < rules.length; i++) {
    var decorated = _decorateGiftRuleOperational_(rules[i], context);
    if (decorated.operational && getGiftRuleStatus_(decorated, now) === 'active') out.push(decorated);
  }
  return out;
}

function formatGiftConditionSummary_(rule) {
  var cj = rule.condition_json || {};
  if (rule.condition_type === 'min_subtotal') {
    var min = Number(cj.min_subtotal || 0);
    return 'ซื้อครบ ' + min.toLocaleString('th-TH') + ' บาท';
  }
  if (rule.condition_type === 'required_products') {
    var arr = cj.required_products || [];
    return cj.match_mode === 'any'
      ? 'ซื้อสินค้าที่กำหนดอย่างใดอย่างหนึ่ง (จาก ' + arr.length + ' รายการ)'
      : 'ซื้อสินค้าที่กำหนดครบทั้ง ' + arr.length + ' รายการ';
  }
  if (rule.condition_type === 'required_variants') {
    var arr2 = cj.required_variants || [];
    return cj.match_mode === 'any'
      ? 'ซื้อรุ่น/ตัวเลือกที่กำหนดอย่างใดอย่างหนึ่ง (จาก ' + arr2.length + ' รายการ)'
      : 'ซื้อรุ่น/ตัวเลือกที่กำหนดครบ ' + arr2.length + ' รายการ';
  }
  return '';
}

function formatGiftConditionDetails_(rule, prodMap) {
  var cj = rule.condition_json || {};
  var products = prodMap || {};
  var out = [];
  var productTitle = function(productId) {
    var p = products[String(productId)];
    return p && p.title ? p.title : String(productId || '');
  };
  var productMedia = function(productId) {
    var p = products[String(productId)] || {};
    return {
      image_url: String(p.image_url || ''),
      image_drive_file_id: String(p.image_drive_file_id || '')
    };
  };

  if (rule.condition_type === 'min_subtotal') {
    var min = Number(cj.min_subtotal || 0);
    if (min > 0) out.push({ type: 'subtotal', title: 'ยอดซื้อขั้นต่ำ', amount: min });
    return out;
  }

  if (rule.condition_type === 'required_products') {
    (cj.required_products || []).forEach(function(rq) {
      var media = productMedia(rq.product_id);
      out.push({
        type: 'product',
        product_id: String(rq.product_id || ''),
        title: productTitle(rq.product_id),
        qty: Number(rq.min_qty || 1),
        image_url: media.image_url,
        image_drive_file_id: media.image_drive_file_id
      });
    });
    return out;
  }

  if (rule.condition_type === 'required_variants') {
    (cj.required_variants || []).forEach(function(rq) {
      var media = productMedia(rq.product_id);
      out.push({
        type: 'variant',
        product_id: String(rq.product_id || ''),
        title: productTitle(rq.product_id),
        variant_key: String(rq.variant_key || ''),
        qty: Number(rq.min_qty || 1),
        image_url: media.image_url,
        image_drive_file_id: media.image_drive_file_id
      });
    });
  }

  return out;
}

// The three evaluators return an integer MULTIPLIER: the number of complete
// times the cart satisfies the rule's threshold (0 = not eligible). Callers
// that only need a boolean still work because 0 is falsy and N>=1 is truthy.
// The 'per_threshold' repeat mode multiplies gift_qty by this value; the
// default 'once_per_order' mode clamps it to 1 (see evaluateGiftRulesForCart_).
function evaluateMinSubtotalGiftRule_(rule, ctx) {
  var cj = rule.condition_json || {};
  var minSub = Number(cj.min_subtotal || 0);
  if (minSub <= 0) return 0;
  // calculation_base default = after_discount_before_shipping
  var subtotal = Number(ctx.subtotal_after_promo || 0);
  return Math.floor(subtotal / minSub);
}

function evaluateRequiredProductsGiftRule_(rule, ctx) {
  var cj = rule.condition_json || {};
  var req = cj.required_products || [];
  if (!req.length) return 0;
  // match_mode 'all' (default): every entry must be met; multiplier = lowest (min) completed rounds.
  // match_mode 'any': at least one entry must be met; multiplier = SUM of completed rounds across
  // every qualifying entry (entries with 0 completed rounds contribute nothing).
  var anyMode = cj.match_mode === 'any';
  var mult = anyMode ? 0 : Infinity;
  for (var i = 0; i < req.length; i++) {
    var rq = req[i];
    var minQ = Number(rq.min_qty || 1);
    if (minQ <= 0) minQ = 1;
    var totalQ = 0;
    for (var j = 0; j < ctx.items.length; j++) {
      if (String(ctx.items[j].product_id) === String(rq.product_id)) totalQ += Number(ctx.items[j].qty || 0);
    }
    var times = Math.floor(totalQ / minQ);
    if (anyMode) {
      mult += times;                      // sum completed rounds from all qualifying entries
    } else {
      if (times < 1) return 0;            // any unmet entry disqualifies the rule
      if (times < mult) mult = times;     // lowest completed multiplier wins
    }
  }
  if (anyMode) return mult;               // 0 = no entry qualified
  return mult === Infinity ? 0 : mult;
}

function evaluateRequiredVariantsGiftRule_(rule, ctx) {
  var cj = rule.condition_json || {};
  var req = cj.required_variants || [];
  if (!req.length) return 0;
  var anyMode = cj.match_mode === 'any';
  var mult = anyMode ? 0 : Infinity;
  for (var i = 0; i < req.length; i++) {
    var rq = req[i];
    var minQ = Number(rq.min_qty || 1);
    if (minQ <= 0) minQ = 1;
    var totalQ = 0;
    for (var j = 0; j < ctx.items.length; j++) {
      if (String(ctx.items[j].product_id) === String(rq.product_id)
          && String(ctx.items[j].variant_key || '') === String(rq.variant_key || '')) {
        totalQ += Number(ctx.items[j].qty || 0);
      }
    }
    var times = Math.floor(totalQ / minQ);
    if (anyMode) {
      mult += times;
    } else {
      if (times < 1) return 0;
      if (times < mult) mult = times;
    }
  }
  if (anyMode) return mult;
  return mult === Infinity ? 0 : mult;
}

// Returns the completed-threshold multiplier (0 = not eligible).
function evaluateGiftRule_(rule, ctx, now) {
  if (rule.condition_type === 'min_subtotal') return evaluateMinSubtotalGiftRule_(rule, ctx);
  if (rule.condition_type === 'required_products') return evaluateRequiredProductsGiftRule_(rule, ctx);
  if (rule.condition_type === 'required_variants') return evaluateRequiredVariantsGiftRule_(rule, ctx);
  return 0;
}

function evaluateGiftRulesForCart_(ctx, now) {
  var rules = getActiveGiftRules_(now);
  var awarded = [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var mult = evaluateGiftRule_(rule, ctx, now);
    if (mult < 1) continue;
    var gift = getGiftItemById_(rule.gift_id);
    if (!gift || !gift.enabled || _giftItemContractErrors_(gift).length) continue;
    // per_threshold: grant gift_qty for every completed threshold.
    // once_per_order (default): fire at most once regardless of multiplier.
    var times = (rule.repeat_mode === 'per_threshold') ? mult : 1;
    awarded.push({ rule: rule, gift: gift, qty: (rule.gift_qty || 1) * times });
  }
  return awarded;
}

function reserveGiftStock_(giftId, qty) {
  if (!_giftIsPositiveInteger_(qty)) return false;
  var sh = sheetGiftItems_();
  var n = sh.getLastRow();
  if (n < 2) return false;
  var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
  var idx = ids.indexOf(String(giftId));
  if (idx < 0) return false;
  var rowNo = idx + 2;
  var stock = Number(sh.getRange(rowNo, 6).getValue());
  if (!_giftIsValidStock_(stock)) return false;
  if (stock !== -1 && stock < qty) return false;
  if (stock !== -1) sh.getRange(rowNo, 6).setValue(stock - qty);
  return true;
}

function restoreGiftStock_(giftId, qty) {
  if (!_giftIsPositiveInteger_(qty)) return false;
  var sh = sheetGiftItems_();
  var n = sh.getLastRow();
  if (n < 2) return false;
  var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
  var idx = ids.indexOf(String(giftId));
  if (idx < 0) return false;
  var rowNo = idx + 2;
  var stock = Number(sh.getRange(rowNo, 6).getValue());
  if (!_giftIsValidStock_(stock)) return false;
  if (stock === -1) return true;
  sh.getRange(rowNo, 6).setValue(stock + qty);
  return true;
}

// Build a gift line snapshot for embedding in items_json.
// Snapshots gift master data so old orders are immune to later edits/deletes.
function _buildGiftLineSnapshot_(giftItem, rule, qty, source, addedBy, note, sourceProductId) {
  return {
    line_type: 'gift',
    gift_snapshot_id: 'gl_' + uuid_().replace(/-/g,'').slice(0,16),
    gift_id: giftItem.gift_id,
    gift_name: giftItem.name,
    gift_description: giftItem.description,
    gift_image_url: giftItem.image_url || '',
    gift_image_drive_file_id: giftItem.image_drive_file_id || '',
    gift_qty: Number(qty || 1),
    source: source || 'auto',
    rule_id: rule ? rule.rule_id : '',
    rule_name: rule ? rule.name : '',
    source_product_id: sourceProductId || '',
    added_by: addedBy || '',
    added_at: nowISO_(),
    note: note || '',
    status: 'active'
  };
}

// Append eligible gift lines INTO an in-memory items array (mutates it).
// Called from submitOrderRpc before the row is persisted, so gifts ride along
// inside items_json instead of in a separate sheet.
function _attachAutoGiftLinesToItems_(items, cartCtx, now) {
  if (!Array.isArray(items)) return;
  var awarded = evaluateGiftRulesForCart_(cartCtx, now);
  for (var i = 0; i < awarded.length; i++) {
    var entry = awarded[i];
    if (!reserveGiftStock_(entry.gift.gift_id, entry.qty)) continue; // skip if out of stock
    items.push(_buildGiftLineSnapshot_(entry.gift, entry.rule, entry.qty, 'auto', '', '', ''));
  }
}

/* ---------- Gift Item RPCs ---------- */

function listGiftItemsRpc(token, opts) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var items = listGiftItemsFromSheet_(false).map(_decorateGiftItemOperational_);
    var q = opts && opts.q ? String(opts.q).toLowerCase() : '';
    if (q) items = items.filter(function(g){
      return String(g.name||'').toLowerCase().indexOf(q) >= 0
          || String(g.description||'').toLowerCase().indexOf(q) >= 0;
    });
    var total = items.length;
    if (opts && opts.limit) {
      var off = Math.max(0, Number(opts.offset)||0);
      var lim = Math.min(100, Math.max(1, Number(opts.limit)));
      items = items.slice(off, off+lim);
    }
    return { ok:true, items:items, total:total };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function _validateGiftItemPayload_(p, isUpdate) {
  if (!isUpdate || p.name !== undefined) {
    var nm = String(p.name||'').trim();
    if (!nm) return { ok:false, error:'ชื่อของแถมห้ามว่าง' };
    if (nm.length > 200) return { ok:false, error:'ชื่อยาวเกินไป' };
    p.name = nm;
  }
  if (p.description !== undefined) p.description = String(p.description||'').slice(0, 1000);
  if (p.stock !== undefined) {
    if (!_giftIsValidStock_(p.stock)) return { ok:false, error:'GIFT_STOCK_MUST_BE_MINUS_ONE_OR_NON_NEGATIVE_INTEGER' };
    p.stock = Number(p.stock);
  }
  if (p.image && p.image.mode === 'url') {
    var iuR = normalizeUrl_(p.image.url || '', { fieldName:'gift.image.url' });
    if (!iuR.ok) return { ok:false, error: iuR.error };
    p.image.url = iuR.value;
  }
  return { ok:true, value: p };
}

function createGiftItemRpc(token, payload) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var v = _validateGiftItemPayload_(payload||{}, false);
    if (!v.ok) return v;
    var p = v.value;
    var driveId = '', url = '';
    if (p.image && p.image.mode === 'file' && p.image.base64) {
      driveId = uploadValidatedImage_(p.image.base64, p.image.filename||('gift-'+Date.now()+'.jpg'),
        p.image.contentType||'image/jpeg', getFolderIdCached_(FOLDER_GIFT), true,
        { maxBytes:5*1024*1024, allowGif:false });
      url = publicUrl_(driveId);
    } else if (p.image && p.image.mode === 'url') {
      url = String(p.image.url||'');
    }
    var sh = sheetGiftItems_();
    var giftId = 'gift_' + uuid_().replace(/-/g,'').slice(0,16);
    var now = nowISO_();
    sh.appendRow([
      giftId, sanitizeSheetCell_(p.name), sanitizeSheetCell_(p.description||''),
      driveId, sanitizeSheetCell_(url),
      (p.stock !== undefined ? Number(p.stock) : -1),
      p.enabled === false ? 'FALSE' : 'TRUE',
      now, now,
      '', '', '' // created_by, updated_by, deleted_at — no longer maintained
    ]);
    auditLog_('gift.item.create', { category:['database'], type:['creation'],
      outcome:'success', route:'gift', rpc:'createGiftItemRpc',
      userId:sess.userId, sessionId:token,
      meta:{ resource_type:'gift_item', resource_id_hash: hashForLog_(giftId, 'gi_') } }, sess.logCtx);
    return { ok:true, gift_id: giftId };
  } catch(err) { return { ok:false, error:String(err.message||err) }; }
}

function updateGiftItemRpc(token, giftId, payload) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetGiftItems_();
    var n = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบของแถม' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(giftId));
    if (idx < 0) return { ok:false, error:'ไม่พบของแถม' };
    var rowNo = idx + 2;
    var existing = rowToGiftItem_(sh.getRange(rowNo,1,1,12).getValues()[0]);
    var v = _validateGiftItemPayload_(Object.assign({}, existing, payload||{}), true);
    if (!v.ok) return v;
    var p = v.value;
    var driveId = existing.image_drive_file_id;
    var url = existing.image_url;
    if (payload && payload.image && payload.image.mode === 'file' && payload.image.base64) {
      var newId = uploadValidatedImage_(payload.image.base64, payload.image.filename||('gift-'+Date.now()+'.jpg'),
        payload.image.contentType||'image/jpeg', getFolderIdCached_(FOLDER_GIFT), true,
        { maxBytes:5*1024*1024, allowGif:false });
      if (driveId && driveId !== newId) deleteDriveFileSafe_(driveId);
      driveId = newId; url = publicUrl_(newId);
    } else if (payload && payload.image && payload.image.mode === 'url') {
      if (driveId) deleteDriveFileSafe_(driveId);
      driveId = '';
      url = String(payload.image.url||'');
    }
    var now = nowISO_();
    sh.getRange(rowNo, 2, 1, 11).setValues([[
      sanitizeSheetCell_(p.name), sanitizeSheetCell_(p.description||''),
      driveId, sanitizeSheetCell_(url),
      (p.stock !== undefined ? Number(p.stock) : existing.stock),
      p.enabled === false ? 'FALSE' : 'TRUE',
      existing.created_at || now, now,
      '', '', '' // created_by, updated_by, deleted_at — no longer maintained
    ]]);
    auditLog_('gift.item.update', { category:['database'], type:['change'],
      outcome:'success', route:'gift', rpc:'updateGiftItemRpc',
      userId:sess.userId, sessionId:token,
      meta:{ resource_type:'gift_item', resource_id_hash: hashForLog_(giftId, 'gi_') } }, sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err.message||err) }; }
}

function toggleGiftItemRpc(token, giftId, enabled) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetGiftItems_();
    var n = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบของแถม' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(giftId));
    if (idx < 0) return { ok:false, error:'ไม่พบของแถม' };
    var rowNo = idx + 2;
    sh.getRange(rowNo, 7).setValue(enabled ? 'TRUE' : 'FALSE');
    sh.getRange(rowNo, 9).setValue(nowISO_());
    auditLog_('gift.item.toggle', { category:['database'], type:['change'],
      outcome:'success', route:'gift', rpc:'toggleGiftItemRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'gift_item', resource_id_hash: hashForLog_(giftId, 'gi_'), enabled: !!enabled } },
      _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

// Hard delete: remove the row entirely. Order snapshots in items_json hold all
// historical gift data, so deletion never affects past orders.
function deleteGiftItemRpc(token, giftId) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetGiftItems_();
    var n = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบของแถม' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(giftId));
    if (idx < 0) return { ok:false, error:'ไม่พบของแถม' };
    sh.deleteRow(idx + 2);
    var disabledRules = _disableGiftRulesForGift_(giftId);
    _invalidateGiftCaches_();
    auditLog_('gift.item.delete', { category:['database'], type:['deletion'],
      outcome:'success', route:'gift', rpc:'deleteGiftItemRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'gift_item', resource_id_hash: hashForLog_(giftId, 'gi_'),
             disabled_rules: disabledRules } }, _sess.logCtx);
    return { ok:true, disabledRules: disabledRules };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- Gift Rule RPCs ---------- */

function _validateGiftRulePayload_(p, isUpdate) {
  var nm = String(p.name || '').trim();
  if (!nm) return { ok:false, error:'GIFT_RULE_NAME_REQUIRED' };
  p.name = nm;
  p.description = String(p.description || '').slice(0, 1000);
  p.gift_id = String(p.gift_id || '');
  p.condition_type = String(p.condition_type || '');

  var cj = p.condition_json || {};
  if (typeof cj === 'string') {
    try { cj = JSON.parse(cj); } catch(_) { return { ok:false, error:'GIFT_CONDITION_JSON_INVALID' }; }
  }
  if (!cj || typeof cj !== 'object' || Array.isArray(cj)) cj = {};
  if (p.condition_type === 'required_products' || p.condition_type === 'required_variants') {
    cj.match_mode = cj.match_mode === 'any' ? 'any' : 'all';
  }
  p.condition_json = cj;

  var contractErrors = _giftRuleContractErrors_(p, _giftOperationalContext_());
  if (contractErrors.length) return { ok:false, error:contractErrors[0], validation_errors:contractErrors };
  p.gift_qty = Number(p.gift_qty);

  if (p.condition_type === 'min_subtotal') {
    p.condition_json.min_subtotal = Number(p.condition_json.min_subtotal);
  } else {
    var refKey = p.condition_type === 'required_products' ? 'required_products' : 'required_variants';
    p.condition_json[refKey] = p.condition_json[refKey].map(function(ref) {
      var normalized = {
        product_id: String(ref.product_id || ''),
        min_qty: Number(ref.min_qty)
      };
      if (refKey === 'required_variants') normalized.variant_key = String(ref.variant_key || '');
      return normalized;
    });
  }
  if (!isUpdate || p.starts_at !== undefined || p.ends_at !== undefined || p.no_end_date !== undefined) {
    var sw = _normalizeSchedule_({ starts_at: p.starts_at, ends_at: p.ends_at, no_end_date: p.no_end_date });
    var swCheck = _validateScheduleWindow_(sw.starts_at, sw.ends_at, sw.no_end_date);
    if (!swCheck.ok) return swCheck;
    p.starts_at = sw.starts_at || '';
    p.ends_at = sw.ends_at || '';
    p.no_end_date = sw.no_end_date;
  }
  // repeat_mode: 'per_threshold' grants gift_qty per completed threshold;
  // anything else (incl. missing/legacy blank) normalizes to once-per-order.
  p.repeat_mode = (p.repeat_mode === 'per_threshold') ? 'per_threshold' : 'once_per_order';
  if (p.priority === undefined) p.priority = 0;
  return { ok:true, value: p };
}

function listGiftRulesRpc(token, opts) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var rules = listGiftRulesFromSheet_(false);
    var context = _giftOperationalContext_();
    var now = new Date();
    var withStatus = rules.map(function(r){
      var decorated = _decorateGiftRuleOperational_(r, context);
      return Object.assign({}, decorated, { status: getGiftRuleStatus_(decorated, now) });
    });
    var q = opts && opts.q ? String(opts.q).toLowerCase() : '';
    var statusFilter = opts && opts.status ? String(opts.status) : 'all';
    if (q) withStatus = withStatus.filter(function(r){ return String(r.name||'').toLowerCase().indexOf(q) >= 0; });
    if (statusFilter && statusFilter !== 'all') withStatus = withStatus.filter(function(r){ return r.status === statusFilter; });
    var total = withStatus.length;
    if (opts && opts.limit) {
      var off = Math.max(0, Number(opts.offset)||0);
      var lim = Math.min(100, Math.max(1, Number(opts.limit)));
      withStatus = withStatus.slice(off, off+lim);
    }
    return { ok:true, rules: withStatus, total: total };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function getGiftRuleRpc(token, ruleId) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var rules = listGiftRulesFromSheet_(false);
    var match = rules.filter(function(r){ return String(r.rule_id) === String(ruleId); })[0];
    if (!match) return { ok:false, error:'ไม่พบกฎ' };
    return { ok:true, rule: _decorateGiftRuleOperational_(match, _giftOperationalContext_()) };
  } catch(err) { return { ok:false, error:String(err) }; }
}

function createGiftRuleRpc(token, payload) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var v = _validateGiftRulePayload_(payload||{}, false);
    if (!v.ok) return v;
    var p = v.value;
    var sh = sheetGiftRules_();
    var ruleId = 'gr_' + uuid_().replace(/-/g,'').slice(0,16);
    var now = nowISO_();
    sh.appendRow([
      ruleId, sanitizeSheetCell_(p.name), sanitizeSheetCell_(p.description||''),
      String(p.gift_id), String(p.condition_type),
      JSON.stringify(p.condition_json||{}),
      Number(p.gift_qty||1), String(p.repeat_mode||'once_per_order'),
      String(p.starts_at||''), String(p.ends_at||''),
      p.no_end_date ? 'TRUE' : 'FALSE',
      p.enabled === false ? 'FALSE' : 'TRUE',
      Number(p.priority||0),
      now, now,
      '', '', '' // created_by, updated_by, deleted_at — no longer maintained
    ]);
    auditLog_('gift.rule.create', { category:['database'], type:['creation'],
      outcome:'success', route:'gift', rpc:'createGiftRuleRpc',
      userId:sess.userId, sessionId:token,
      meta:{ resource_type:'gift_rule', resource_id_hash: hashForLog_(ruleId, 'gr_') } }, sess.logCtx);
    return { ok:true, rule_id: ruleId };
  } catch(err) { return { ok:false, error:String(err.message||err) }; }
}

function updateGiftRuleRpc(token, ruleId, payload) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetGiftRules_();
    var n = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบกฎ' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(ruleId));
    if (idx < 0) return { ok:false, error:'ไม่พบกฎ' };
    var rowNo = idx + 2;
    var existing = rowToGiftRule_(sh.getRange(rowNo,1,1,18).getValues()[0]);
    var merged = Object.assign({}, existing, payload||{});
    var v = _validateGiftRulePayload_(merged, true);
    if (!v.ok) return v;
    var p = v.value;
    var now = nowISO_();
    sh.getRange(rowNo, 2, 1, 17).setValues([[
      sanitizeSheetCell_(p.name), sanitizeSheetCell_(p.description||''),
      String(p.gift_id), String(p.condition_type),
      JSON.stringify(p.condition_json||{}),
      Number(p.gift_qty||1), String(p.repeat_mode||'once_per_order'),
      String(p.starts_at||''), String(p.ends_at||''),
      p.no_end_date ? 'TRUE' : 'FALSE',
      p.enabled === false ? 'FALSE' : 'TRUE',
      Number(p.priority||0),
      existing.created_at || now, now,
      '', '', '' // created_by, updated_by, deleted_at — no longer maintained
    ]]);
    auditLog_('gift.rule.update', { category:['database'], type:['change'],
      outcome:'success', route:'gift', rpc:'updateGiftRuleRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'gift_rule', resource_id_hash: hashForLog_(ruleId, 'gr_') } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err.message||err) }; }
}

function toggleGiftRuleRpc(token, ruleId, enabled) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetGiftRules_();
    var n = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบกฎ' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(ruleId));
    if (idx < 0) return { ok:false, error:'ไม่พบกฎ' };
    var rowNo = idx + 2;
    sh.getRange(rowNo, 12).setValue(enabled ? 'TRUE' : 'FALSE');
    sh.getRange(rowNo, 15).setValue(nowISO_());
    auditLog_('gift.rule.toggle', { category:['database'], type:['change'],
      outcome:'success', route:'gift', rpc:'toggleGiftRuleRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'gift_rule', resource_id_hash: hashForLog_(ruleId, 'gr_'), enabled: !!enabled } },
      _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

// Hard delete: row removed entirely.
function deleteGiftRuleRpc(token, ruleId) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var sh = sheetGiftRules_();
    var n = sh.getLastRow();
    if (n < 2) return { ok:false, error:'ไม่พบกฎ' };
    var ids = sh.getRange(2,1,n-1,1).getValues().map(function(r){ return String(r[0]); });
    var idx = ids.indexOf(String(ruleId));
    if (idx < 0) return { ok:false, error:'ไม่พบกฎ' };
    sh.deleteRow(idx + 2);
    auditLog_('gift.rule.delete', { category:['database'], type:['deletion'],
      outcome:'success', route:'gift', rpc:'deleteGiftRuleRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'gift_rule', resource_id_hash: hashForLog_(ruleId, 'gr_') } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
}

/* ---------- Order Gift RPCs ---------- */

// Read gift lines for an order from items_json (admin).
function listOrderGiftsRpc(token, orderId) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  try {
    var ord = getOrderRow_(orderId);
    if (!ord) return { ok:false, error:'ไม่พบคำสั่งซื้อ' };
    var raw = String(ord.sheet.getRange(ord.rowNo, 19).getValue() || '[]');
    var items = [];
    try { items = _normalizeOrderItems_(JSON.parse(raw)); } catch(_) {}
    var gifts = _getGiftLinesFromItems_(items).filter(function(g){ return g.status !== 'removed'; });
    return { ok:true, gifts: gifts };
  } catch(err) { return { ok:false, error:String(err) }; }
}

// Find which order contains a given gift_snapshot_id. Returns { orderId, line } or null.
// Used by legacy removeOrderGiftRpc / updateOrderGiftQtyRpc which only know the snapshot id.
function _findGiftLineAcrossOrders_(snapshotId) {
  var sh = sheetOrders_();
  var n = sh.getLastRow();
  if (n < 2) return null;
  var data = sh.getRange(2, 1, n-1, 19).getValues(); // need col 19 = items_json
  for (var i = 0; i < data.length; i++) {
    var orderId = String(data[i][0] || '');
    var raw = String(data[i][18] || '[]');
    var items;
    try { items = _normalizeOrderItems_(JSON.parse(raw)); } catch(_) { continue; }
    for (var j = 0; j < items.length; j++) {
      if (items[j].line_type === 'gift' && String(items[j].gift_snapshot_id) === String(snapshotId)) {
        return { orderId: orderId, line: items[j] };
      }
    }
  }
  return null;
}

function getOrderRow_(orderId) {
  var sh = sheetOrders_();
  var n = sh.getLastRow();
  if (n < 2) return null;
  var ids = sh.getRange(2, 1, n-1, 1).getValues().map(function(r){ return String(r[0]); });
  var idx = ids.indexOf(String(orderId));
  if (idx < 0) return null;
  return { rowNo: idx + 2, sheet: sh };
}

// --- New items_json-backed gift-mutation RPCs ---
function addManualGiftToOrderRpc(token, orderId, payload) {
  var sess = requireAdmin_(token);
  if (!sess) return { ok:false, error:'AUTH_REQUIRED' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    var p = payload || {};
    if (!p.gift_id) return { ok:false, error:'ต้องเลือกของแถม' };
    var qtyInput = (p.qty === undefined || p.qty === null || p.qty === '') ? 1 : p.qty;
    var qtyR = parseBoundedPositiveInteger_(qtyInput, MAX_QTY_PER_LINE);
    if (!qtyR.ok) {
      var qtyError = { ok:false, error:qtyR.error };
      if (qtyR.limit !== undefined) qtyError.limit = qtyR.limit;
      return qtyError;
    }
    var qty = qtyR.value;
    var ord = getOrderRow_(orderId);
    if (!ord) return { ok:false, error:'ไม่พบคำสั่งซื้อ' };
    var status = String(ord.sheet.getRange(ord.rowNo, 4).getValue()||'').toLowerCase();
    if (_isStockReleasedStatus_(status) || status === 'delivered') {
      return { ok:false, error:'ไม่สามารถเพิ่มของแถมในคำสั่งซื้อที่ปฏิเสธ/ยกเลิกหรือจัดส่งแล้ว' };
    }
    var gi = getGiftItemById_(p.gift_id);
    if (!gi) return { ok:false, error:'ไม่พบของแถม' };
    var giErrors = _giftItemContractErrors_(gi);
    if (giErrors.length) return { ok:false, error:giErrors[0], validation_errors:giErrors };
    if (!reserveGiftStock_(gi.gift_id, qty)) return { ok:false, error:'ของแถมในสต็อกไม่พอ' };
    var snap = _buildGiftLineSnapshot_(gi, null, qty, 'manual', sess.email||'', p.note||'', '');
    var upd = _updateOrderItemsJsonUnlocked_(orderId, function(items){
      items.push(snap);
      return items;
    });
    if (!upd.ok) {
      // Roll back the stock reservation if persistence failed.
      restoreGiftStock_(gi.gift_id, qty);
      return upd;
    }
    auditLog_('gift.order.add', { category:['order'], type:['change'],
      outcome:'success', route:'order', rpc:'addManualGiftToOrderRpc',
      userId:sess.userId, sessionId:token,
      meta:{ resource_type:'order', order_id_hash: hashForLog_(orderId, 'o_'),
             gift_id_hash: hashForLog_(gi.gift_id, 'gi_'), qty: qty } }, sess.logCtx);
    return { ok:true, gift_snapshot_id: snap.gift_snapshot_id, order_gift_id: snap.gift_snapshot_id };
  } catch(err) { return { ok:false, error:String(err.message||err) }; }
  finally { try { lock.releaseLock(); } catch(_) {} }
}

function removeGiftLineFromOrderRpc(token, orderId, giftSnapshotId) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    if (!giftSnapshotId) return { ok:false, error:'GIFT_LINE_NOT_FOUND' };
    var ord = getOrderRow_(orderId);
    if (!ord) return { ok:false, error:'ไม่พบคำสั่งซื้อ' };
    var status = String(ord.sheet.getRange(ord.rowNo, 4).getValue()||'').toLowerCase();
    var matched = null, found = false, alreadyRemoved = false;
    var upd = _updateOrderItemsJsonUnlocked_(orderId, function(items){
      for (var i = 0; i < items.length; i++) {
        if (items[i].line_type === 'gift' && String(items[i].gift_snapshot_id) === String(giftSnapshotId)) {
          found = true;
          if (items[i].status === 'removed') {
            alreadyRemoved = true;
            break;
          }
          if (items[i].status !== 'removed') {
            matched = { giftId: items[i].gift_id, qty: Number(items[i].gift_qty||1) };
            items[i].status = 'removed';
          }
          break;
        }
      }
      if (!found) throw new Error('GIFT_LINE_NOT_FOUND');
      return items;
    });
    if (!upd.ok) return upd;
    if (!found) return { ok:false, error:'GIFT_LINE_NOT_FOUND' };
    if (alreadyRemoved) return { ok:false, error:'GIFT_LINE_ALREADY_REMOVED' };
    // A released order (rejected/cancelled) already had this gift's stock returned to
    // inventory, so removing the line must NOT restore it again.
    if (matched && status !== 'delivered' && !_isStockReleasedStatus_(status)) {
      restoreGiftStock_(matched.giftId, matched.qty);
    }
    auditLog_('gift.order.remove', { category:['order'], type:['change'],
      outcome:'success', route:'order', rpc:'removeGiftLineFromOrderRpc',
      userId:_sess.userId, sessionId:token,
      meta:{ resource_type:'order', order_id_hash: hashForLog_(orderId, 'o_') } }, _sess.logCtx);
    return { ok:true };
  } catch(err) { return { ok:false, error:String(err) }; }
  finally { try { lock.releaseLock(); } catch(_) {} }
}

function updateGiftLineQtyRpc(token, orderId, giftSnapshotId, qty) {
  var _sess = requireAdmin_(token);
  if (!_sess) return { ok:false, error:'AUTH_REQUIRED' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok:false, error:'SERVER_BUSY' };
  try {
    var newQtyR = parseBoundedPositiveInteger_(qty, MAX_QTY_PER_LINE);
    if (!newQtyR.ok) {
      var qtyError = { ok:false, error:newQtyR.error };
      if (newQtyR.limit !== undefined) qtyError.limit = newQtyR.limit;
      return qtyError;
    }
    var newQty = newQtyR.value;
    if (!giftSnapshotId) return { ok:false, error:'GIFT_LINE_NOT_FOUND' };
    // A released order (rejected/cancelled) holds no stock, so a qty change there must
    // only update items_json — no reserve/restore. The new qty is what gets re-deducted
    // when the order is later un-rejected.
    var _ordRow = getOrderRow_(orderId);
    if (!_ordRow) return { ok:false, error:'ไม่พบคำสั่งซื้อ' };
    var _released = _isStockReleasedStatus_(String(_ordRow.sheet.getRange(_ordRow.rowNo, 4).getValue()||'').toLowerCase());
    var giftIdRef = '', oldQty = 0, diff = 0, reserved = false, found = false;
    var upd = _updateOrderItemsJsonUnlocked_(orderId, function(items){
      for (var i = 0; i < items.length; i++) {
        if (items[i].line_type === 'gift' && String(items[i].gift_snapshot_id) === String(giftSnapshotId)) {
          if (items[i].status === 'removed') throw new Error('GIFT_LINE_ALREADY_REMOVED');
          found = true;
          giftIdRef = String(items[i].gift_id);
          oldQty = Number(items[i].gift_qty || 1);
          diff = newQty - oldQty;
          if (!_released) {
            if (diff > 0) {
              if (!reserveGiftStock_(giftIdRef, diff)) {
                throw new Error('ของแถมในสต็อกไม่พอ');
              }
              reserved = true;
            } else if (diff < 0) {
              restoreGiftStock_(giftIdRef, -diff);
            }
          }
          items[i].gift_qty = newQty;
          break;
        }
      }
      return items;
    });
    if (!upd.ok && reserved) {
      // Roll back reservation if persistence failed after the increase.
      restoreGiftStock_(giftIdRef, diff);
    }
    if (upd.ok && !found) return { ok:false, error:'GIFT_LINE_NOT_FOUND' };
    if (upd.ok) {
      auditLog_('gift.order.qty_update', { category:['order'], type:['change'],
        outcome:'success', route:'order', rpc:'updateGiftLineQtyRpc',
        userId:_sess.userId, sessionId:token,
        meta:{ resource_type:'order', order_id_hash: hashForLog_(orderId, 'o_'),
               gift_id_hash: hashForLog_(giftIdRef, 'gi_'), qty: newQty } }, _sess.logCtx);
    }
    return upd.ok ? { ok:true } : upd;
  } catch(err) { return { ok:false, error:String(err.message||err) }; }
  finally { try { lock.releaseLock(); } catch(_) {} }
}

// --- Legacy aliases (Phase 1: order.html still calls these by old name) ---
function removeOrderGiftRpc(token, orderGiftId) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  var found = _findGiftLineAcrossOrders_(orderGiftId);
  if (!found) return { ok:false, error:'ไม่พบของแถมในคำสั่งซื้อ' };
  return removeGiftLineFromOrderRpc(token, found.orderId, orderGiftId);
}
function updateOrderGiftQtyRpc(token, orderGiftId, qty) {
  if (!requireAdmin_(token)) return { ok:false, error:'AUTH_REQUIRED' };
  var found = _findGiftLineAcrossOrders_(orderGiftId);
  if (!found) return { ok:false, error:'ไม่พบของแถมในคำสั่งซื้อ' };
  return updateGiftLineQtyRpc(token, found.orderId, orderGiftId, qty);
}

/* ---------- Public Gift RPCs ---------- */

function getActiveGiftCampaignsRpc() {
  try {
    ensureGiftSheets_();
    var rules = listGiftRulesFromSheet_(false);
    var giftItems = listGiftItemsFromSheet_(false);
    var giftMap = {};
    giftItems.forEach(function(g){ giftMap[g.gift_id] = g; });
    var prodMap = {};
    try {
      getSnap_().forEach(function(prod){ prodMap[String(prod.id)] = prod; });
    } catch(_) {}
    var operationalContext = { giftMap: giftMap, productMap: prodMap };
    var now = new Date();
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var decoratedRule = _decorateGiftRuleOperational_(r, operationalContext);
      if (!decoratedRule.operational) continue;
      r = decoratedRule;
      var status = getGiftRuleStatus_(r, now);
      if (status !== 'active' && status !== 'scheduled') continue;
      var gi = giftMap[r.gift_id];
      if (!gi || !gi.enabled || _giftItemContractErrors_(gi).length) continue;
      out.push({
        rule_id: r.rule_id, name: r.name, description: r.description,
        starts_at: r.starts_at, ends_at: r.ends_at, no_end_date: r.no_end_date,
        gift_qty: r.gift_qty || 1,
        status: status,
        condition_summary: formatGiftConditionSummary_(r),
        condition_details: formatGiftConditionDetails_(r, prodMap),
        gift_item: {
          gift_id: gi.gift_id, name: gi.name, description: gi.description,
          image_drive_file_id: gi.image_drive_file_id, image_url: gi.image_url,
          stock: gi.stock
        }
      });
    }
    return { ok:true, campaigns: out };
  } catch(err) { return { ok:false, error:String(err), campaigns: [] }; }
}

// Public — preview gift eligibility for a given cart payload.
// Reuses backend pricing + gift-rule evaluation. Read-only; never writes.
// Payload shape mirrors submitOrderRpc.items: [{ product_id, qty, selected_variants }]
function previewGiftEligibilityRpc(cartPayload) {
  try {
    var p = cartPayload || {};
    var inItems = (p.items === undefined || p.items === null) ? [] : p.items;
    if (!Array.isArray(inItems)) {
      return { ok:false, error:'INVALID_ITEMS', eligible:[], near:[], subtotal_after_promo:0 };
    }
    if (!inItems.length) {
      return { ok: true, eligible: [], near: [], subtotal_after_promo: 0 };
    }
    var snap = getSnap_();
    var prodMap = {};
    snap.forEach(function(prod){ prodMap[prod.id] = prod; });
    var normalizedCart = normalizeOrderCart_(inItems, prodMap);
    if (!normalizedCart.ok) {
      return Object.assign({ ok:false, eligible:[], near:[], subtotal_after_promo:0 }, normalizedCart);
    }
    ensureGiftSheets_();
    var now = new Date();
    var allPromos = listPromotionsFromSheet_(false);
    var subtotal = 0;
    var ctxItems = [];
    for (var i = 0; i < normalizedCart.items.length; i++) {
      var normalizedItem = normalizedCart.items[i];
      var prod = normalizedItem.prod;
      var qty = normalizedItem.qty;
      var rawUnit = normalizedItem.rawUnitPrice;
      var vk = normalizedItem.variantKey;
      // Gift min_subtotal base = subtotal after DIRECT discounts (matches the snapshot and
      // the promotion pipeline's Pass-A base). Conditional promos are excluded here so a
      // conditional discount never inflates/deflates gift eligibility circularly.
      var lineBest = resolveBestPromotionForLine_(allPromos, prod.id, vk, rawUnit, now, _promoIsDirect_);
      var pricing = lineBest ? lineBest.pricing : calcPromotionPrice_(rawUnit, null);
      subtotal += pricing.unit_final_price * qty;
      ctxItems.push({
        product_id: String(prod.id),
        variant_key: vk,
        qty: qty,
        unit_final_price: pricing.unit_final_price,
        title: prod.title
      });
    }
    var ctx = { items: ctxItems, subtotal_after_promo: subtotal, subtotal_before_shipping: subtotal };

    // Build eligible + near-miss lists
    var rules = getActiveGiftRules_(now);
    var giftItems = listGiftItemsFromSheet_(false);
    var giftMap = {}; giftItems.forEach(function(g){ giftMap[g.gift_id] = g; });
    var eligible = [];
    var near = [];
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      var gift = giftMap[rule.gift_id];
      if (!gift || !gift.enabled || _giftItemContractErrors_(gift).length) continue;
      var matched = evaluateGiftRule_(rule, ctx, now);
      // Reflect the multiplied grant so the storefront preview matches what
      // submitOrderRpc will actually attach for per_threshold rules.
      var times = (rule.repeat_mode === 'per_threshold' && matched >= 1) ? matched : 1;
      var giftSummary = {
        gift_id: gift.gift_id, name: gift.name, description: gift.description,
        image_url: gift.image_url, image_drive_file_id: gift.image_drive_file_id,
        qty: (rule.gift_qty || 1) * times,
        stock: gift.stock
      };
      var ruleMatchMode = (rule.condition_json || {}).match_mode === 'any' ? 'any' : 'all';
      if (matched) {
        eligible.push({
          rule_id: rule.rule_id, rule_name: rule.name,
          condition_type: rule.condition_type,
          match_mode: ruleMatchMode,
          condition_summary: formatGiftConditionSummary_(rule),
          condition_details: formatGiftConditionDetails_(rule, prodMap),
          gift: giftSummary
        });
      } else {
        // Compute near-miss only for min_subtotal
        var nearInfo = null;
        if (rule.condition_type === 'min_subtotal') {
          var minSub = Number((rule.condition_json||{}).min_subtotal || 0);
          var diff = Math.max(0, minSub - subtotal);
          if (diff > 0 && minSub > 0) {
            nearInfo = { type: 'min_subtotal', remaining: diff, target: minSub };
          }
        } else if (rule.condition_type === 'required_products') {
          var req = (rule.condition_json||{}).required_products || [];
          var missing = [];
          for (var rp = 0; rp < req.length; rp++) {
            var rq = req[rp];
            var minQ = Number(rq.min_qty || 1);
            var have = 0;
            for (var ci = 0; ci < ctxItems.length; ci++) {
              if (String(ctxItems[ci].product_id) === String(rq.product_id)) have += ctxItems[ci].qty;
            }
            if (have < minQ) {
              var prodForLabel = prodMap[String(rq.product_id)];
              missing.push({ product_id: String(rq.product_id), title: prodForLabel ? prodForLabel.title : String(rq.product_id), need: minQ - have });
            }
          }
          if (missing.length) nearInfo = { type: 'required_products', missing: missing, match_mode: ruleMatchMode };
        } else if (rule.condition_type === 'required_variants') {
          var reqV = (rule.condition_json||{}).required_variants || [];
          var missingV = [];
          for (var rv = 0; rv < reqV.length; rv++) {
            var rqv = reqV[rv];
            var minQv = Number(rqv.min_qty || 1);
            var haveV = 0;
            for (var cj = 0; cj < ctxItems.length; cj++) {
              if (String(ctxItems[cj].product_id) === String(rqv.product_id)
                  && String(ctxItems[cj].variant_key||'') === String(rqv.variant_key||'')) haveV += ctxItems[cj].qty;
            }
            if (haveV < minQv) {
              var prodVLbl = prodMap[String(rqv.product_id)];
              missingV.push({
                product_id: String(rqv.product_id),
                title: prodVLbl ? prodVLbl.title : String(rqv.product_id),
                variant_key: String(rqv.variant_key||''),
                need: minQv - haveV
              });
            }
          }
          if (missingV.length) nearInfo = { type: 'required_variants', missing: missingV, match_mode: ruleMatchMode };
        }
        near.push({
          rule_id: rule.rule_id, rule_name: rule.name,
          condition_type: rule.condition_type,
          match_mode: ruleMatchMode,
          gift: giftSummary,
          condition_summary: formatGiftConditionSummary_(rule),
          condition_details: formatGiftConditionDetails_(rule, prodMap),
          near: nearInfo
        });
      }
    }
    return { ok: true, eligible: eligible, near: near, subtotal_after_promo: subtotal };
  } catch (err) {
    return { ok: false, error: String(err), eligible: [], near: [] };
  }
}

// Describe what a promotion's discount target covers (what RECEIVES the discount),
// resolving product titles from the snapshot map.
function _promoTargetDescriptor_(promo, prodMap) {
  var t = promo.target_type;
  if (t === 'all') return { target_type: 'all', items: [] };
  var arr = Array.isArray(promo.target) ? promo.target : [];
  var items = arr.map(function(x){
    var pr = prodMap[String(x.product_id)];
    return { product_id: String(x.product_id), title: pr ? pr.title : String(x.product_id), variant_key: String(x.variant_key || '') };
  });
  return { target_type: t, items: items };
}

// Describe a conditional promotion's qualifying condition (what the customer must BUY).
function _promoConditionDescriptor_(promo, prodMap) {
  var ct = promo.condition_type;
  var cj = promo.condition_json || {};
  if (ct === 'min_subtotal') {
    return { condition_type: 'min_subtotal', min_subtotal: Number(cj.min_subtotal || 0) };
  }
  var mm = (cj.match_mode === 'any') ? 'any' : 'all';
  if (ct === 'required_products') {
    var rp = (cj.required_products || []).map(function(r){
      var pr = prodMap[String(r.product_id)];
      return { product_id: String(r.product_id), title: pr ? pr.title : String(r.product_id), min_qty: Number(r.min_qty || 1) };
    });
    return { condition_type: 'required_products', match_mode: mm, required_products: rp };
  }
  if (ct === 'required_variants') {
    var rv = (cj.required_variants || []).map(function(r){
      var pr = prodMap[String(r.product_id)];
      return { product_id: String(r.product_id), title: pr ? pr.title : String(r.product_id), variant_key: String(r.variant_key || ''), min_qty: Number(r.min_qty || 1) };
    });
    return { condition_type: 'required_variants', match_mode: mm, required_variants: rv };
  }
  return { condition_type: ct || '' };
}

// Public cart preview for CONDITIONAL promotions (no auth). Re-prices the cart via the
// SAME resolveCartPromotions_ pipeline submitOrderRpc uses, so preview line prices and
// eligibility can never diverge from the placed order. Returns per-line pricing (so the
// storefront can show the discounted price + build its client_pricing snapshot) plus
// eligible / near-miss lists for conditional promos.
function previewPromotionEligibilityRpc(cartPayload) {
  try {
    var p = cartPayload || {};
    var inItems = (p.items === undefined || p.items === null) ? [] : p.items;
    if (!Array.isArray(inItems)) {
      return { ok:false, error:'INVALID_ITEMS', eligible:[], near:[], lines:[], subtotal:0, subtotal_after_promo:0 };
    }
    if (!inItems.length) {
      return { ok: true, eligible: [], near: [], lines: [], subtotal: 0, subtotal_after_promo: 0 };
    }
    var snap = getSnap_();
    var prodMap = {};
    snap.forEach(function(prod){ prodMap[String(prod.id)] = prod; });
    var normalizedCart = normalizeOrderCart_(inItems, prodMap);
    if (!normalizedCart.ok) {
      return Object.assign({ ok:false, eligible:[], near:[], lines:[], subtotal:0, subtotal_after_promo:0 }, normalizedCart);
    }
    var now = new Date();

    // Build pipeline input (raw unit price after variant resolution).
    var ctxItems = [];
    for (var i = 0; i < normalizedCart.items.length; i++) {
      var normalizedItem = normalizedCart.items[i];
      var prod = normalizedItem.prod;
      ctxItems.push({
        product_id:String(prod.id), variant_key:normalizedItem.variantKey,
        qty:normalizedItem.qty, raw_unit_price:normalizedItem.rawUnitPrice, title:prod.title
      });
    }

    var cart = resolveCartPromotions_(ctxItems, now);
    var qualifiedSet = {};
    (cart.qualified_conditional_ids || []).forEach(function(id){ qualifiedSet[String(id)] = true; });
    // Which promo actually won each line (so we can report where a discount landed).
    var appliedByPromo = {};
    cart.lines.forEach(function(ln){
      if (ln.promotion) {
        var pid = String(ln.promotion.promotion_id);
        (appliedByPromo[pid] = appliedByPromo[pid] || []).push({ product_id: ln.product_id, variant_key: ln.variant_key });
      }
    });

    var outLines = cart.lines.map(function(ln){
      return {
        product_id: ln.product_id, variant_key: ln.variant_key, qty: ln.qty,
        unit_base_price: ln.unit_base_price, unit_final_price: ln.unit_final_price,
        unit_discount_amount: ln.unit_discount_amount,
        promotion: ln.promotion ? publicPromoSummary_(ln.promotion) : null
      };
    });

    var ctx = cart.ctx;
    var subtotalAfterDirect = cart.subtotal_after_direct;
    var eligible = [];
    var near = [];
    for (var q = 0; q < cart.promos.length; q++) {
      var promo = cart.promos[q];
      if (promo.application_mode !== 'conditional') continue;
      if (!_promoIsActive_(promo, now)) continue;
      var cj = promo.condition_json || {};
      var mm = (cj.match_mode === 'any') ? 'any' : 'all';
      var base = {
        promotion_id: promo.promotion_id, name: promo.name,
        discount_type: promo.discount_type, discount_value: promo.discount_value,
        discount_scope: promo.discount_scope || 'item',
        condition_type: promo.condition_type, match_mode: mm,
        condition: _promoConditionDescriptor_(promo, prodMap),
        target: _promoTargetDescriptor_(promo, prodMap)
      };
      if (qualifiedSet[String(promo.promotion_id)]) {
        if (promo.discount_scope === 'order_total') {
          // Order-total promos never land on a line. Only one can win per order (largest
          // discount); a qualified loser is reported applied:false so the storefront can show
          // "qualified but a bigger order-total discount applied". order_discount_amount is the
          // winner's applied amount, or (for a loser) what this promo would have deducted.
          var _isWinner = !!(cart.order_discount
            && String(cart.order_discount.promotion.promotion_id) === String(promo.promotion_id));
          base.applied = _isWinner;
          base.order_discount_amount = _isWinner
            ? Number(cart.order_discount.amount || 0)
            : calcOrderTotalDiscount_(cart.subtotal, promo);
          eligible.push(base);
        } else {
          base.applied_lines = appliedByPromo[String(promo.promotion_id)] || [];
          // Best-price resolution means a qualified promo can still lose every line it
          // targets to a bigger discount. `applied` + `outpriced_lines` let the storefront
          // label it "qualified but not applied" instead of implying it discounted something.
          base.applied = base.applied_lines.length > 0;
          base.outpriced_lines = cart.lines.filter(function(ln){
            var winId = ln.promotion ? String(ln.promotion.promotion_id) : '';
            return winId !== String(promo.promotion_id)
                && promoMatchesTarget_(promo, ln.product_id, ln.variant_key);
          }).map(function(ln){ return { product_id: ln.product_id, variant_key: ln.variant_key }; });
          eligible.push(base);
        }
      } else {
        // Near-miss detail per condition type (shape mirrors gift preview).
        var nearInfo = null;
        if (promo.condition_type === 'min_subtotal') {
          var minSub = Number(cj.min_subtotal || 0);
          var diff = Math.max(0, minSub - subtotalAfterDirect);
          if (diff > 0 && minSub > 0) nearInfo = { type: 'min_subtotal', remaining: diff, target: minSub };
        } else if (promo.condition_type === 'required_products') {
          var reqP = cj.required_products || [];
          var missP = [];
          for (var rp2 = 0; rp2 < reqP.length; rp2++) {
            var rqp = reqP[rp2]; var minQ = Number(rqp.min_qty || 1); var have = 0;
            for (var ci = 0; ci < ctx.items.length; ci++) {
              if (String(ctx.items[ci].product_id) === String(rqp.product_id)) have += ctx.items[ci].qty;
            }
            if (have < minQ) {
              var plabel = prodMap[String(rqp.product_id)];
              missP.push({ product_id: String(rqp.product_id), title: plabel ? plabel.title : String(rqp.product_id), need: minQ - have });
            }
          }
          if (missP.length) nearInfo = { type: 'required_products', missing: missP, match_mode: mm };
        } else if (promo.condition_type === 'required_variants') {
          var reqV = cj.required_variants || [];
          var missV = [];
          for (var rv2 = 0; rv2 < reqV.length; rv2++) {
            var rqv = reqV[rv2]; var minQv = Number(rqv.min_qty || 1); var haveV = 0;
            for (var cj2 = 0; cj2 < ctx.items.length; cj2++) {
              if (String(ctx.items[cj2].product_id) === String(rqv.product_id)
                  && String(ctx.items[cj2].variant_key || '') === String(rqv.variant_key || '')) haveV += ctx.items[cj2].qty;
            }
            if (haveV < minQv) {
              var vlabel = prodMap[String(rqv.product_id)];
              missV.push({ product_id: String(rqv.product_id), title: vlabel ? vlabel.title : String(rqv.product_id), variant_key: String(rqv.variant_key || ''), need: minQv - haveV });
            }
          }
          if (missV.length) nearInfo = { type: 'required_variants', missing: missV, match_mode: mm };
        }
        base.near = nearInfo;
        near.push(base);
      }
    }
    return {
      ok: true, eligible: eligible, near: near, lines: outLines,
      subtotal: cart.subtotal, subtotal_after_promo: subtotalAfterDirect,
      // Whole-order discount applied to the item subtotal (once). null when no order-total
      // promo qualifies/wins. subtotal_after_order_discount = subtotal − order_discount.amount.
      order_discount: cart.order_discount
        ? { promotion: publicPromoSummary_(cart.order_discount.promotion), amount: cart.order_discount.amount }
        : null,
      subtotal_after_order_discount: cart.subtotal_after_order_discount
    };
  } catch (err) {
    return { ok: false, error: String(err), eligible: [], near: [], lines: [] };
  }
}

// Customer-facing read: return gifts for an order via order token (no auth).
// Reads gift lines directly from items_json — no separate sheet lookup.
function getOrderGiftsByTokenRpc(orderToken) {
  try {
    assertConfig_();
    var vt = validateOrderToken_(orderToken, { scope:'read_gifts', maxRate:30, rateWindow:60 });
    if (!vt.ok) return { ok:false, error:vt.error };
    var rawItems = String(vt.row[ORDER_COLS.indexOf('items_json')] || '[]');
    var items;
    try { items = _normalizeOrderItems_(JSON.parse(rawItems)); } catch(_) { items = []; }
    var gifts = _getGiftLinesFromItems_(items).filter(function(g){ return g.status !== 'removed'; });
    return { ok:true, gifts: gifts };
  } catch(err) { return { ok:false, error:String(err) }; }
}

