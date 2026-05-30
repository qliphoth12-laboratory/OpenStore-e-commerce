# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Open Storefront** — E-commerce storefront ใช้ Google Apps Script (GAS) เป็น backend, ไฟล์ HTML เป็น frontend ทั้งหมด ไม่มี build step, ไม่มี package manager.

## Files

| File | Role |
|---|---|
| `index.html` | Storefront หน้าร้าน (~6,084 บรรทัด) |
| `product.html` | Admin panel — CRUD สินค้า |
| `order.html` | Admin panel — จัดการคำสั่งซื้อ (list + update status) |
| `order-view.html` | หน้าลูกค้าดูรายละเอียดคำสั่งซื้อ + อัปโหลดสลิป (เข้าถึงด้วย `?token=`) |
| `payment.html` | Admin panel — ตั้งค่าการชำระเงิน (PromptPay QR, OTP verify) |
| `shipping-page.html` | Admin panel — จัดการบริษัทขนส่ง + อัตราค่าส่ง |
| `edit-store.html` | Admin panel — อัปโหลด/ตั้งค่ารูปร้าน (logo, banner, bg) + settings |
| `legal.html` | Admin panel — ตั้งค่า legal config (privacy policy + terms metadata) |
| `login.html` | Admin login page — email/password + OTP 2FA |
| `user.html` | Admin panel — จัดการบัญชีผู้ดูแล (CRUD admin users) |
| `system.html` | Admin panel — ตั้งค่าระบบ |
| `term_and_service.html` | Public page — ข้อกำหนดการใช้บริการ |
| `privacy-policy.html` | Public page — นโยบายความเป็นส่วนตัว |
| `print-order.html` | Admin panel — พิมพ์ใบขนส่ง (PDF/ZIP) ด้วย jsPDF + html2canvas + JSZip |
| `promotion.html` | Admin panel — จัดการโปรโมชั่น (CRUD + status filter + product/variant picker) |
| `gift.html` | Admin panel — จัดการของแถม (gift items + gift rules สองแท็บ) |
| `admin-shared.html` | Shared UI component — sidebar, topbar, HUD toast, skeleton, status badges; include ด้วย `<?!= include('admin-shared') ?>` ใน admin panel ทุกไฟล์ |
| `backend.gs` | Google Apps Script backend (GAS) |
| `shipping.gs` | GAS module — unified carrier tracking (AfterShip, Thailand Post, ETracking); public RPC `getCarrierTrackingRpc`; admin key RPCs |
| `SECURITY-NOTES.md` | Security audit notes — รายการฟังก์ชัน public และระดับ auth ที่ตรวจสอบแล้ว |
| `README.md` | Open-source README — feature list + setup steps |
| `docs/` | `ARCHITECTURE.md`, `DEPLOYMENT.md` — เอกสารสำหรับ developer ภายนอก |
| `QA/performance/` | Node.js load-test tool (Node 18+, ไม่ต้อง deps พิเศษ) — ยิง GET storefront วัด p50/p95/p99, error rate |
| `QA/Integration/` | GAS integration test runner (`integration-tests.gs`) + dashboard (`integration-dashboard.html`) — copy เข้า GAS project แล้วเรียก `qaOpenIntegrationDashboard()` |

## Deployment

ไม่มี build tool หรือ CLI — ใช้วิธี copy-paste:
1. `backend.gs` → วางใน Google Apps Script project (ตั้ง Script Properties: `SHEET_ID`, `DRIVE_FOLDER_ID`)
2. HTML files ทั้งหมด → วางเป็น HTML files ใน GAS project เดียวกัน
3. Deploy เป็น **Web App** จาก GAS editor
4. รันฟังก์ชัน `setupAll()` ครั้งแรกเพื่อสร้าง Sheet + Drive folder + time trigger

**Local preview**: เปิด HTML ตรง ๆ ใน browser ได้ แต่ `GAS.available = false` — ฟีเจอร์ที่ต้องเรียก backend จะ stub (ไม่ทำงาน)

## Architecture

### Backend (backend.gs)
- ข้อมูลสินค้าเก็บใน Google Sheet ชื่อ `product` (columns: `id, title, desc, price, badge, image_drive_file_id, image_url, created_at, updated_at, active, variants_json, extra_images_json, weight_grams, allowed_shipping_ids, stock, sale_enabled, sale_starts_at, sale_ends_at, sale_no_end_date, sale_mode`) — สถานะการขายใช้ `sale_mode` เป็นหลัก; โปรโมชั่นใช้ระบบ promotion แยกต่างหาก
- ข้อมูลคำสั่งซื้อเก็บใน Sheet ชื่อ `orders`; บริษัทขนส่งเก็บใน Sheet ชื่อ `shipping`; โปรโมชั่นเก็บใน Sheet ชื่อ `promotions`
- รูปร้าน (logo/banner/bg) เก็บใน Sheet ชื่อ `store` (columns: `key, drive_file_id, url, updated_at`); สร้างอัตโนมัติถ้าไม่มี
- `sheetProd_()` (และ sheet helper อื่น ๆ) เพิ่ม column ที่ขาดให้ sheet โดยอัตโนมัติ ถ้ามีการเพิ่ม field ใหม่ในอนาคต
- รูปสินค้าเก็บใน Google Drive folder, expose เป็น public URL
- Snapshot cache ใน `CacheService` key `PROD_SNAPSHOT_CACHE` — อัปเดตอัตโนมัติทุก 1 นาที (`tickSync`) หรือเมื่อ Sheet เปลี่ยน (`_syncSnapIfStale`)
- `doGet()` inject config + products ลงใน `<script id="server-cfg">` ตอน serve HTML

### URL Routing (doGet)

`doGet` routes by `pathInfo` or `?page=` query param:
- default / `index` → serves `index.html`
- `product` / `products` → serves `product.html`
- `order` / `orders` → serves `order.html`
- `order-view` → serves `order-view.html` (ต้องมี `?token=<orderToken>`)
- `payment` → serves `payment.html`
- `shipping` / `shippings` → serves `shipping-page.html`
- `editstore` / `edit-store` → serves `edit-store.html`
- `login` → serves `login.html`
- `403` → serves `403.html`
- `user` / `users` → serves `user.html`
- `system` → serves `system.html`
- `legal` → serves `legal.html`
- `promotion` / `promotions` → serves `promotion.html` (admin)
- `gift` / `gifts` → serves `gift.html` (admin)
- `privacy-policy` / `privacy_policy` → serves `privacy-policy.html`
- `term-and-service` / `term_and_service` → serves `term_and_service.html`
- `print-order` / `print_order` → serves `print-order.html`
- unknown route → returns plain-text `404 Not Found` (no 403.html)

Public views (`index`, `order-view`, `privacy-policy`, `term_and_service`) ใช้ `XFrameOptionsMode.ALLOWALL`; หน้าอื่น ๆ ทั้งหมดใช้ `DEFAULT` (blocks external iframes)

Template variables injected into HTML files:
- `siteCfgJs` — `JSON.stringify(config)` (สำหรับ `<script id="server-cfg">`)
- `siteCfgMeta` — `JSON.stringify({ cfgTs, prodTs })` (timestamps สำหรับ cache busting)
- `execUrl` — URL ของ deployed Web App (`ScriptApp.getService().getUrl()`)
- `orderToken` — token จาก query param (เฉพาะ order-view)

### Admin Panel (product.html)

ใช้ Bootstrap 5 + SweetAlert2 — **ไม่ใช้ `GAS` object** แต่ใช้ `callRpc(method, ...args)` ที่ wrap `google.script.run` โดยตรง:
```js
callRpc('functionName', ...args)  // returns Promise, rejects on failure
```
- Product list cache: `localStorage` key `PROD_CACHE_KEY`
- Image cache: `localStorage` key `IMG_CACHE_KEY` (map fileId → dataURL)
- เช็ค `window.google && google.script && google.script.run` เพื่อ detect GAS environment
- HUD (toast ล่างซ้าย): `showHUD(text)` / `hideHUD(state, text)` — state `'ok'` หรือ `'err'`

### Frontend (index.html)
GAS Web App template — ต้องมี `<?!= siteCfgJs ?>` ใน `<script id="server-cfg" type="application/json">` เพื่อรับ server config

**Config priority** (สูงสุดทับต่ำสุด):
1. `DEFAULT_CONFIG` (hardcoded ~บรรทัด 2925)
2. `localStorage` key `SHOP_CONFIG_SIMPLE`
3. `#server-cfg` script tag (inject จาก `doGet`)

**Image cache**: `localStorage` key `SHOP_IMG_CACHE_V1`, LRU max 60 items, ฟังก์ชัน `driveFileToDataUrlCached(fileId)`

### JS Sections ใน index.html (ลำดับบรรทัดโดยประมาณ)
| Section | บรรทัด |
|---|---|
| CONSTANTS | 2808 |
| UI FEEDBACK (Toasts & Alerts) | 2813 |
| IMAGE HANDLING & CACHING | 2824 |
| GOOGLE APPS SCRIPT INTEGRATION | 2963 |
| CONFIGURATION (DEFAULT_CONFIG) | 2990 |
| GLOBAL STATE | 3403 |
| UTILITY FUNCTIONS | 3411 |
| THEME SYSTEM | 3473 |
| DOM ELEMENTS | 3748 |
| UI RENDERING (product cards) | 3752 |
| IMAGE VIEWER | 3963 |
| PRODUCT DETAIL MODAL | 4111 |
| SHOPPING CART | 4644 |
| ORDER CONFIRMATION | 4861 |
| SORT FUNCTIONALITY | 5828 |
| PARALLAX ENGINE | 5902 |
| INITIALIZATION | 5972 |

### Carrier Tracking (shipping.gs)

ทุก provider ส่งคืน unified `TrackingResult`:
```js
{ ok, provider, trackingNumber, carrierId, tag, events: [{tag, message, location, time}], isDelivered, lastUpdatedAt }
```
- `events` เรียง oldest-first เสมอ (order-view.html reverse สำหรับ display)
- **Provider selection**: `_fetchTracking_(trackingNumber, carrierId, provider)` — `aftership` (default) / `thaipost` (ThaiPost เท่านั้น) / `etracking` (ไม่รองรับ ThaiPost)
- **Delivered cache**: เมื่อ `isDelivered = true` จะ save events ลง `trackingJson.delivered_cache` ใน orders sheet — ครั้งต่อไปใช้ cache แทน API call; อัปเดต order status → `'delivered'` อัตโนมัติ
- **Script Properties** สำหรับ tracking: `AFTERSHIP_API_KEY`, `THP_STATIC_TOKEN` (Thailand Post), `ETRACK_API_KEY` + `ETRACK_KEY_SECRET` (ETracking)
- **Carrier IDs**: `thaipost`, `kerry`, `flash`, `jt`, `best`, `dhl` — ใช้ใน `AFTERSHIP_SLUGS` และ `ETRACK_SLUGS`

### Auth System (Admin Login)

- Admin accounts เก็บใน Sheet ชื่อ `users` (columns: `id, email, password_hash, salt, role, otp_required, created_at, updated_at`)
- Password hashing: PBKDF2 (v2, prefix `v2:`) — อัปเกรดจาก SHA-256 legacy อัตโนมัติเมื่อ login สำเร็จ
- Session token เก็บใน `CacheService` — ส่งกลับไปยัง client เพื่อใช้ใน RPC ที่ต้องการ auth
- Rate limiting: 5 ครั้งผิดพลาด → ล็อก 5 นาที (CacheService key `RATE_LOGIN_PREFIX + email`)
- OTP 2FA (optional): ส่ง OTP ทาง email (MailApp), หมดอายุ 10 นาที, พยายามผิดเกิน 5 ครั้ง → OTP ถูกยกเลิก

### Promotion System

- **Sheet `promotions`** (15 columns): `promotion_id, name, description, discount_type, discount_value, target_type, target_json, starts_at, ends_at, enabled, created_at, updated_at, created_by, updated_by, deleted_at`
- **discount_type**: `'fixed'` (ลดเป็นบาท) หรือ `'percent'` (ลด %, ≤ 100)
- **target_type**: `'all'` (ทั้งร้าน) / `'product'` (target_json: `[{product_id}]`) / `'variant'` (target_json: `[{product_id, variant_key}]`)
- **variant_key** = sorted `"groupName=optionLabel|..."` (ดู `_buildVariantKey`); สร้าง stable key จาก selected_variants
- **Pricing**: ใช้ `_calcPromotionPrice(basePrice, promo)` → ปัดเป็นบาทเต็มด้วย `Math.round`, floor ที่ 0 (`Math.max(0, …)`)
- **Status (dynamic, ไม่เก็บใน sheet)**: `disabled` (enabled=false หรือ deleted_at) / `scheduled` (now < starts_at) / `active` (starts_at ≤ now ≤ ends_at) / `expired` (now > ends_at)
- **Specificity**: เมื่อมี promo หลายรายการตรงกัน เลือก variant > product > all; tiebreak ด้วย `created_at` ใหม่สุด
- **Overlap protection**: `_assertNoOverlappingPromotion` ปฏิเสธ promo ที่ enabled + ทับช่วงเวลา + ทับ target (all ทับทุกอย่าง; product ทับ product/variant ของ product เดียวกัน; variant ทับ variant ของ key เดียวกัน)
- **Cache**: `CacheService` key `PROMO_LIST_CACHE` TTL 60s; ทุก mutation invalidate + `_rebuildSnap()`
- **Snapshot injection**: `_applyPromotionsToProducts(products, now)` ฉีด `product.promotion`, `product.final_price`, `product.discount_amount`, และ `product.variant_promotions[variant_key] = {promotion, unit_base_price, unit_final_price, unit_discount_amount}` ลง snapshot — frontend อ่านได้ตรงๆ ไม่ต้องคำนวณเอง
- **Frontend (index.html / edit-store.html)**:
  - `_resolveProductPromotion(product, sel)` → คืน entry ตามตัวเลือกปัจจุบัน
  - `_bestCardPromo(product)` → variant ที่ราคาต่ำสุดของ product สำหรับการ์ด
  - `formatPromotionRemaining(endsAt)` + `_startModalCountdown` → countdown ทุก 1 วินาที; modal close → `_stopModalCountdown`
  - `_refreshCardCountdowns()` — refresh `[data-promo-end]` elements

### Gift System

- **Sheets**: `gift_items` (ของแถม), `gift_rules` (เงื่อนไขการให้ของแถม); Drive folder `gift` เก็บรูปของแถม. ของแถมที่แนบกับ order จริงเก็บเป็น gift line (`line_type: 'gift'`) ใน `items_json` ของ order
- **gift_items** — `gift_id, name, description, stock (-1=ไม่จำกัด), image_drive_file_id, enabled, …`
- **gift_rules** — กำหนดเงื่อนไข (ยอดซื้อขั้นต่ำ, สินค้าที่กำหนด ฯลฯ) → ให้ของแถม gift_id ใด, จำนวนเท่าไร
- **Cart preview**: `previewGiftEligibilityRpc(cartPayload)` — public, ไม่ต้อง auth; คืน gift candidates สำหรับ cart ปัจจุบัน (ใช้ใน storefront ก่อน checkout)
- **Commit phase**: `submitOrderRpc` evaluate gift rules → หักสต็อก → แนบ gift lines ลงใน order items โดยมี `line_type: 'gift'`; ถ้าสต็อกหมดขณะ commit → `skippedGifts` array ส่งคืน (storefront แสดง warning)
- **Admin**: `gift.html` — สองแท็บ: (1) จัดการ gift items (CRUD + toggle + stock), (2) จัดการ gift rules (CRUD + toggle)
- **Order view**: `listOrderGiftsRpc` / `addManualGiftToOrderRpc` / `removeGiftLineFromOrderRpc` / `updateGiftLineQtyRpc` — admin จัดการของแถมใน order หลัง submit; `getOrderGiftsByTokenRpc(orderToken)` — ลูกค้าดูได้ (ไม่ต้อง auth)
- **getActiveGiftCampaignsRpc()** — public; คืน gift rules ที่ active พร้อม gift item snapshot สำหรับ storefront แสดงป้ายโปรโมชั่น

- **Token-based access**: แต่ละ order มี random token (ไม่ซ้ำ) สำหรับให้ลูกค้าเข้าถึง `order-view` โดยไม่ต้อง login
- **Status history**: `status_history_json` เก็บ log ทุกการเปลี่ยน status พร้อม timestamp
- **Shipping fee**: คำนวณจาก weight รวม (sum ของ `weight_grams × qty`) เทียบกับ tiers ใน shipping sheet
- **Tracking integration**: `orderMarkShippedRpc` ลงทะเบียน tracking กับ AfterShip อัตโนมัติ; ลูกค้าดู tracking ได้ผ่าน `getCarrierTrackingRpc(orderToken, trackingNumber, carrierId)` (ไม่ต้อง auth); provider จาก `trackingJson.tracking_provider` (`aftership`|`thaipost`|`etracking`)
- **PII encryption**: ข้อมูล sensitive ของลูกค้าใน orders sheet (ชื่อ, ที่อยู่, เบอร์โทร ฯลฯ) เข้ารหัสผ่าน `encryptField_` / `decryptField_` — ใช้ HMAC-SHA256 keystream (XOR stream cipher) พร้อม authentication tag (HMAC truncated 128-bit) ตรวจจับการแก้ไข/สลับ ciphertext; **ไม่ใช่ AES**. รูปแบบ ciphertext: `enc:<iv>:<encHex>:<mac>` (v2; v1 `enc:<iv>:<encHex>` ไม่มี mac ยัง decrypt ได้). decrypt อัตโนมัติเมื่อ `_rowToOrder()`

### Admin Panels (order.html, payment.html, shipping.html, edit-store.html, gift.html, …)

ทุก admin panel ใช้รูปแบบเดียวกับ `product.html`:
- `callRpc(method, ...args)` — wrap `google.script.run`, returns Promise
- `showHUD(text)` / `hideHUD(state, text)` — toast ล่างซ้าย, state `'ok'` หรือ `'err'`
- detect GAS: `window.google && google.script && google.script.run`
- **Shared layout**: วาง `<script>window._EXEC_URL='<?!= execUrl ?>';</script>` ก่อน แล้วตามด้วย `<?!= include('admin-shared') ?>` เสมอ — `admin-shared.html` inject sidebar nav, topbar, HUD `<div id="hud">`, page loader, skeleton CSS, และ status badge CSS ให้ครบ

### localStorage Keys

| Key | ใช้ใน | เก็บอะไร |
|---|---|---|
| `SHOP_CONFIG_SIMPLE` | index.html | site config (theme/settings) — ทับ DEFAULT_CONFIG |
| `SHOP_IMG_CACHE_V1` | index.html | Drive image cache (LRU 60 items, fileId → dataURL) |
| `SHOP_ORDER_TOKENS_V1` | index.html | order history array `[{ token, order_id, created_at, items[] }]` |
| `SHOP_LAST_ORDER_TOKEN` | index.html | token ล่าสุดที่ค้นหาผ่าน lookupOrderByToken |
| `PROD_CACHE_KEY` | product.html | product list cache |
| `IMG_CACHE_KEY` | product.html | Drive image cache (fileId → dataURL) |

### order-view.html

ใช้ `callRpc` เหมือน admin panels แต่เข้าถึงผ่าน `?token=` ไม่ต้อง auth:
- `renderItems(items)` — สร้าง table row พร้อม `<img id="ov-item-thumb-{i}">`
- `loadItemThumbs(items)` — โหลดรูปจาก `item.image_drive_file_id` / `item.image_url`; fallback เรียก `getProductImagesByIdsRpc` สำหรับ order เก่า
- `_applyThumb(el, skelEl, driveId, imgUrl)` — ใช้ cache Drive image หรือ URL ตรง

## Key Conventions

- **ภาษา UI**: ทุก label, toast, alert ใช้ **ภาษาไทย**
- **CSS theming**: ใช้ CSS custom properties (`:root { --var: value }`) ทั้งหมด — อย่า hardcode สี ใช้ variables แทน
- **RPC pattern**: backend ฟังก์ชัน return `{ ok: true, ... }` หรือ `{ ok: false, error: '...' }` เสมอ — client ตรวจ `.ok` ก่อนใช้ผล
- **Snapshot**: หลังแก้ข้อมูล Sheet ให้เรียก `_rebuildSnap()` เสมอ เพื่ออัปเดต cache
- **Script Properties**: เก็บ `SHEET_ID`, `DRIVE_FOLDER_ID`, encryption key, และ carrier API keys (`AFTERSHIP_API_KEY`, `THP_STATIC_TOKEN`, `ETRACK_API_KEY`, `ETRACK_KEY_SECRET`) ใน `PropertiesService.getScriptProperties()` — site config เก็บใน sheet `store` (key `site_config`), snapshot cache ใช้ `CacheService`
- **First-time setup**: ถ้า `users` sheet ว่าง — `checkSetupNeededRpc` คืน `{ needsSetup: true }` → login.html redirect ไปหน้า setup เพื่อเรียก `setupFirstAdminRpc(email, password)` สร้าง owner account แรก
- **system.html**: ใช้ตั้งค่า SHEET_ID, DRIVE_FOLDER_ID (save ด้วย OTP ผ่าน `sendSystemOtpRpc` + `verifySystemOtpAndSaveRpc`) และ AfterShip API key (`saveAftershipKeyRpc`); แสดง system info ผ่าน `getSystemInfoRpc`
- **Key rotation**: owner สามารถ rotate encryption key ด้วย OTP ผ่าน `sendKeyRotateOtpRpc` + `verifyAndRotateKeyRpc` — re-encrypts ข้อมูลทุก row ใน orders sheet; ตรวจสถานะด้วย `getRotateLockStatusRpc`

## Backend RPC Functions

| Function | Purpose |
|---|---|
| `doGet(e)` | Serve HTML + inject server config |
| `publishSiteConfig(token, obj)` | บันทึก theme/settings จาก client (ต้อง admin token) |
| `getSiteConfigBundle()` | ดึง config + products bundle |
| `getBrandInfoRpc()` | ดึงเฉพาะ brand fields (siteTitle, logoImage, logoImageDriveFileId) จาก CacheService — lightweight, public |
| `productListRpc(tokenOrOpts, optsArg?)` | list สินค้า — ถ้า arg1 เป็น token → admin (คืนทุก product); ถ้าเป็น opts → public (active เท่านั้น) |
| `productCreateRpc(token, payload)` | เพิ่มสินค้า (รองรับ image file/url) |
| `productUpdateRpc(token, id, patch)` | แก้ไขสินค้า (รวมเปลี่ยนรูป) |
| `productDeleteRpc(token, id)` | ลบสินค้า + ลบรูปจาก Drive |
| `productBulkDeleteRpc(token, ids)` | admin ลบสินค้าหลายชิ้นพร้อมกัน (รับ array ของ IDs) |
| `getFileDataUrlRpc(fileId)` | แปลง Drive image → base64 dataURL (public แต่ folder-restricted: product/store เท่านั้น) |
| `getAdminFileDataUrlRpc(token, fileId)` | admin: แปลง Drive image → base64 (ไม่มี folder restriction) |
| `getStockSummaryRpc(token)` | admin ดึง stock summary ของสินค้าทุกชิ้น |
| `updateStockRpc(token, updates)` | admin อัปเดต stock quantity |
| `adminDeactivateOrphanedProductsRpc(token)` | admin deactivate สินค้าที่ไม่มีรูปใน Drive แล้ว |
| `setupAll()` | สร้าง Sheet + Drive folder + trigger ครั้งแรก |
| `tickSync()` | time trigger ทุก 1 นาที sync snapshot |
| `productGetRpc(id)` | ดึงสินค้าชิ้นเดียวตาม id |
| `adminResyncSnapshot(token)` | force rebuild snapshot cache ด้วยตนเอง |
| `setSiteConfigJsonForce(token, json)` | owner-only debug/recovery — เขียน site config ดิบ (ไม่มี UI เรียก, audit-logged) |
| `ping()` | auth warm-up — ตรวจสอบสิทธิ์ DriveApp |
| `_processVariants(newV, oldV)` | helper: upload/delete Drive images สำหรับ variants |
| `_processExtraImages(newImgs, oldImgs)` | helper: upload/delete Drive images สำหรับ extra_images |
| `submitOrderRpc(payload)` | ลูกค้า submit คำสั่งซื้อ — คำนวณราคา/ค่าส่ง server-side, คืน token |
| `orderListRpc(token, opts)` | admin list คำสั่งซื้อ (filter/sort/pagination) |
| `orderGetRpc(token, orderId)` | admin ดึงคำสั่งซื้อตาม ID |
| `orderProductionSummaryRpc(token)` | admin สรุปยอดสั่งซื้อรวมต่อสินค้า (พร้อม variant) และต่อของแถม สำหรับวางแผนการผลิต (read-only, ไม่ decrypt PII) |
| `getOrderByTokenRpc(token)` | ลูกค้าดึงคำสั่งซื้อด้วย token (ไม่ต้อง auth, rate limit 10 req/min) |
| `getOrderStatusByTokenRpc(token)` | ลูกค้าดึงเฉพาะ status + tracking ด้วย token |
| `uploadSlipRpc(token, base64, ...)` | ลูกค้าอัปโหลดสลิปโอนเงิน |
| `getSlipByOrderTokenRpc(orderToken, slipFileId)` | ลูกค้าดึงรูปสลิปด้วย order token (ตรวจ token + status) |
| `orderUpdateStatusRpc(token, orderId, status, note)` | admin เปลี่ยน status คำสั่งซื้อ + บันทึก history |
| `orderUpdateFieldsRpc(token, orderId, patch)` | admin แก้ไข field อื่น ๆ ของ order |
| `updateOrdersTokenExpiryRpc(token, expireDays)` | admin อัปเดตวันหมดอายุของ order tokens |
| `getShippingRpc()` | ดึงรายการขนส่งทั้งหมด (public — ใช้ใน storefront คำนวณค่าส่ง) |
| `saveShippingRpc(token, data)` | admin บันทึกข้อมูลขนส่ง (เขียนทับทั้ง sheet) |
| `savePaymentConfigRpc(token, payload)` | admin บันทึก config การชำระเงิน (PromptPay, บัตร ฯลฯ) |
| `getPaymentConfigRpc(token)` | ดึง config การชำระเงิน |
| `sendPaymentOtpRpc(token)` | ส่ง OTP ยืนยันก่อนบันทึก payment config |
| `verifyPaymentOtpAndSaveRpc(token, otp, payload)` | ยืนยัน OTP แล้วบันทึก payment config |
| `getStoreImagesRpc()` | ดึง store images (logo/banner/bg) จาก sheet `store` (public) |
| `saveStoreImageRpc(token, key, imageObj)` | อัปโหลดหรือตั้ง URL รูปร้าน key=`logo`/`banner`/`bg`; imageObj `{ mode:'file', base64, filename, contentType }` หรือ `{ mode:'url', url }` |
| `getProductImagesByIdsRpc(ids)` | ดึง image_drive_file_id + image_url สำหรับ product ids (fallback สำหรับ order เก่า) |
| `loginRpc(email, password)` | admin login — คืน `{ token }` หรือ `{ otpRequired: true }` |
| `loginVerifyOtpRpc(email, otp)` | ยืนยัน OTP หลัง login — คืน `{ token }` |
| `validateSessionRpc(token)` | ตรวจ session ยังใช้งานได้อยู่หรือไม่ |
| `logoutRpc(token)` | ลบ session ออกจาก CacheService |
| `checkSetupNeededRpc()` | ตรวจว่าระบบต้องการ setup ครั้งแรก (users sheet ว่าง) |
| `setupFirstAdminRpc(email, password)` | สร้าง owner account แรก (ใช้ได้เฉพาะครั้งเดียวตอน setup) |
| `userListRpc(token)` | admin list บัญชีผู้ดูแล |
| `userCreateRpc(token, payload)` | admin สร้างบัญชีผู้ดูแลใหม่ |
| `userUpdateRpc(token, id, patch)` | admin แก้ไข field ของ user (role, otp_required ฯลฯ) |
| `userDeleteRpc(token, id)` | admin ลบบัญชีผู้ดูแล |
| `userRequestEmailChangeOtpRpc(token, userId, newEmail)` | ขอ OTP ยืนยันก่อนเปลี่ยน email |
| `userConfirmEmailChangeRpc(token, userId, newEmail, otp)` | ยืนยัน OTP แล้วเปลี่ยน email |
| `orderDeleteRpc(token, orderIds)` | admin ลบ order (รับ array ของ IDs) |
| `orderMarkShippedRpc(token, orderId, trackingData)` | admin mark shipped + ลงทะเบียน AfterShip tracking |
| `saveAftershipKeyRpc(token, apiKey)` | บันทึก AfterShip API key ใน Script Properties |
| `clearAftershipKeyRpc(token)` | ลบ AfterShip API key ออกจาก Script Properties |
| `saveThaipostTokenRpc(token, staticToken)` | บันทึก Thailand Post static token ใน Script Properties |
| `clearThaipostTokenRpc(token)` | ลบ Thailand Post static token ออกจาก Script Properties |
| `saveEtrackKeyRpc(token, apiKey, keySecret)` | บันทึก ETracking API key + key secret ใน Script Properties |
| `clearEtrackKeyRpc(token)` | ลบ ETracking API key + key secret ออกจาก Script Properties |
| `getCarrierTrackingRpc(orderToken, trackingNumber, carrierId)` | ลูกค้าดึงข้อมูล tracking โดยไม่ต้อง auth (rate limit 10 req/min) |
| `getSystemInfoRpc(token)` | ดึง system info (Sheet ID, Folder ID, exec URL ฯลฯ) |
| `sendSystemOtpRpc(token)` | ส่ง OTP ยืนยันก่อนบันทึก system settings |
| `verifySystemOtpAndSaveRpc(token, otp, payload)` | ยืนยัน OTP แล้วบันทึก system settings |
| `deleteStoreImageRpc(token, fileId)` | ลบ store image จาก Drive + sheet (single) |
| `deleteStoreImagesRpc(token, fileIds)` | ลบ store images หลายไฟล์พร้อมกัน |
| `sendKeyRotateOtpRpc(token)` | ส่ง OTP ยืนยันก่อน rotate encryption key (owner เท่านั้น) |
| `verifyAndRotateKeyRpc(token, otp)` | ยืนยัน OTP แล้ว rotate encryption key + re-encrypt orders |
| `getRotateLockStatusRpc()` | ตรวจสถานะ key rotation process |
| `releaseRotateLockRpc(token)` | ปลด lock หาก rotation ค้าง (owner เท่านั้น) |
| `getLegalConfigRpc(token)` | ดึง legal config (privacy policy + terms metadata) |
| `saveLegalConfigRpc(token, payload)` | บันทึก legal config (legalEntityName, contact, privacy/terms metadata) |
| `listPromotionsRpc(token)` | admin list promotions (รวม `status: active/scheduled/expired/disabled` คำนวณ dynamic) |
| `getPromotionRpc(token, promotionId)` | admin ดึง promotion ตาม ID |
| `createPromotionRpc(token, payload)` | admin สร้าง promotion (validate + overlap check + invalidate cache + rebuild snapshot) |
| `updatePromotionRpc(token, promotionId, payload)` | admin แก้ไข promotion (re-validate, exclude self ใน overlap check) |
| `togglePromotionRpc(token, promotionId, enabled)` | admin เปิด/ปิด promotion (เปิดต้องผ่าน overlap check) |
| `deletePromotionRpc(token, promotionId)` | admin soft-delete (set deleted_at + disable) |
| `listGiftItemsRpc(token, opts)` | admin list gift items (pagination) |
| `createGiftItemRpc(token, payload)` | admin สร้าง gift item (รองรับ image file/url → Drive folder `gift`) |
| `updateGiftItemRpc(token, giftId, payload)` | admin แก้ไข gift item |
| `toggleGiftItemRpc(token, giftId, enabled)` | admin เปิด/ปิด gift item |
| `deleteGiftItemRpc(token, giftId)` | admin ลบ gift item + รูปจาก Drive |
| `listGiftRulesRpc(token, opts)` | admin list gift rules (pagination) |
| `getGiftRuleRpc(token, ruleId)` | admin ดึง gift rule ตาม ID |
| `createGiftRuleRpc(token, payload)` | admin สร้าง gift rule |
| `updateGiftRuleRpc(token, ruleId, payload)` | admin แก้ไข gift rule |
| `toggleGiftRuleRpc(token, ruleId, enabled)` | admin เปิด/ปิด gift rule |
| `deleteGiftRuleRpc(token, ruleId)` | admin soft-delete gift rule |
| `listOrderGiftsRpc(token, orderId)` | admin list ของแถมใน order |
| `addManualGiftToOrderRpc(token, orderId, payload)` | admin เพิ่มของแถมเข้า order ด้วยตนเอง |
| `removeGiftLineFromOrderRpc(token, orderId, giftSnapshotId)` | admin ลบ gift line ออกจาก order |
| `updateGiftLineQtyRpc(token, orderId, giftSnapshotId, qty)` | admin แก้จำนวนของแถมใน order |
| `getActiveGiftCampaignsRpc()` | public — คืน gift rules ที่ active + gift item snapshot (storefront ใช้แสดงป้ายโปรโมชั่น) |
| `previewGiftEligibilityRpc(cartPayload)` | public — ตรวจ cart ว่าได้ของแถมอะไร (ก่อน submit) |
| `getOrderGiftsByTokenRpc(orderToken)` | ลูกค้าดู gift ใน order ด้วย token (ไม่ต้อง auth) |

## QA

### Performance Test (`QA/performance/`)

เครื่องมือ load test แบบ Node.js ยิง HTTP GET ใส่ storefront ที่ deploy แล้ว — **ไม่สร้าง order จริง**

**ต้องการ**: Node.js 18+, ตั้งค่า `QA/performance/config.json` (copy จาก `config.example.json`)

```powershell
cd QA\performance
npm install        # ครั้งแรก
npm run smoke      # เช็ค URL ใช้งานได้
npm run light      # โหลดเบา
npm run step       # step test หาจุดที่เริ่มมีปัญหา
npm run test       # ตาม mode ใน config.json
```

รายงานออกที่ `QA/performance/results/report-YYYYMMDD-HHMM.md` + `.json`; ดู `p95`, `error rate` เป็นหลัก (threshold default: error < 5%, p95 < 3000 ms)

### Integration Tests (`QA/Integration/`)

**วิธีใช้**: copy `integration-tests.gs` + `integration-dashboard.html` เข้า GAS project เดียวกับ backend แล้วรัน `qaOpenIntegrationDashboard()` จาก GAS editor — dashboard จะโหลดใน sidebar

RPC entry points (ใช้ใน dashboard):
- `getQaIntegrationTestManifestRpc()` — ดึงรายการ test cases
- `qaRunIntegrationTestSuiteRpc(options)` — รัน test ทุกตัว
- `qaRunIntegrationTestCaseRpc(testId, options)` — รัน test เดี่ยว
- `getQaIntegrationTraceEventsRpc(runId, afterSeq)` — streaming trace events
- `clearQaIntegrationTraceRpc(runId)` — ล้าง trace cache
