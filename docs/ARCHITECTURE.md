# Architecture

เอกสารนี้อธิบายสถาปัตยกรรมของ Open Storefront ในระดับที่เหมาะสำหรับนักพัฒนาที่ต้องดูแล ต่อยอด หรือ debug ระบบจริง
ระบบนี้เป็น e-commerce storefront ที่รันบน Google Apps Script ทั้ง backend และการ serve หน้าเว็บ โดยใช้ Google Sheets เป็นฐานข้อมูลหลัก
และ Google Drive เป็นพื้นที่เก็บไฟล์รูปภาพ/สลิป/ไฟล์ log

## ภาพรวมระบบ

Open Storefront แบ่งระบบหลักเป็น 4 ส่วน:

- **Frontend**: ไฟล์ HTML/CSS/JavaScript แบบ plain files ใน `System/Frontend/` ไม่มี framework และไม่มี build step
- **Backend**: Apps Script ใน `System/Backend/code.gs` และโมดูลติดตามขนส่งใน `System/Backend/shipping.gs`
- **Storage**: Google Sheets สำหรับข้อมูลเชิงโครงสร้าง และ Google Drive สำหรับไฟล์รูปภาพ สลิป และ log archive
- **Runtime Services**: ใช้ GAS services เช่น `CacheService`, `LockService`, `PropertiesService`, `HtmlService`, `MailApp`, `UrlFetchApp`, `ScriptApp`

โครงสร้าง deployment ของ GAS เป็นแบบ flat project ดังนั้นแม้ repo จะแยกไฟล์ไว้เป็นหมวดหมู่
แต่ตอน deploy ต้องนำไฟล์ `.gs` และ `.html` ทั้งหมดเข้า Apps Script project เดียวกัน

```text
Browser
  |
  |  GET Web App URL / ?page=...
  v
Apps Script doGet(e)
  |
  |-- HtmlService renders System/Frontend/*.html
  |-- injects site config + product snapshot + exec URL + order token
  v
Rendered page
  |
  |  google.script.run / callRpc(method, ...args)
  v
Apps Script RPC functions
  |
  |-- Google Sheets: products, orders, users, shipping, promotions, gifts, payment, store
  |-- Google Drive: product images, gift images, store assets, slips, logs
  |-- CacheService: product snapshot, site config, sessions, OTPs, rate limits, logs queue
```

## ไฟล์หลัก

| Path | หน้าที่ |
|---|---|
| `System/Backend/code.gs` | backend หลัก: routing, RPC, sheets, cache, orders, products, auth, payment, logging, setup |
| `System/Backend/shipping.gs` | adapter สำหรับ AfterShip, Thailand Post และ ETracking พร้อม normalize ผลลัพธ์ |
| `System/Frontend/index.html` | หน้าร้านลูกค้า เช่น แสดงสินค้า ตะกร้า checkout และ gift preview |
| `System/Frontend/edit-store.html` | ตัวแก้ไขหน้าร้าน/theme แบบ live editor |
| `System/Frontend/admin-shared.html` | UI และ helper กลางของหลังบ้าน เช่น sidebar, topbar, toast, auth guard, `callRpc` |
| `System/Frontend/login.html` | หน้าเข้าสู่ระบบผู้ดูแล และ flow OTP 2FA |
| `System/Frontend/product.html` | จัดการสินค้า stock รูปภาพ variant และสถานะขาย |
| `System/Frontend/order.html` | จัดการคำสั่งซื้อ ดูรายละเอียด เปลี่ยนสถานะ อัปเดตข้อมูลจัดส่ง |
| `System/Frontend/print-order.html` | หน้ารวมสำหรับพิมพ์ใบขนส่ง/เตรียมคำสั่งซื้อ |
| `System/Frontend/promotion.html` | จัดการ promotion rules |
| `System/Frontend/gift.html` | จัดการ gift item และ gift rule |
| `System/Frontend/shipping-page.html` | จัดการบริษัทขนส่ง วิธีส่ง และ provider tracking |
| `System/Frontend/payment.html` | ตั้งค่า PromptPay QR และภาพพื้นหลังการชำระเงิน |
| `System/Frontend/user.html` | จัดการผู้ใช้หลังบ้าน |
| `System/Frontend/system.html` | ตั้งค่าระบบ เช่น Script Properties, logging, key rotation |
| `System/Frontend/order-view.html` | หน้าลูกค้าสำหรับดู order ผ่าน token และอัปโหลดสลิป |
| `System/Frontend/privacy-policy.html`, `term_and_service.html` | หน้า public legal |
| `docs/LOGGING.md` | รายละเอียดระบบ activity logging |
| `QA/` | integration, E2E และ performance tooling |

## Request Routing

ทุกหน้าเข้าผ่าน Apps Script Web App function `doGet(e)` ใน `code.gs`
โดย route จะอ่านจาก `e.pathInfo` หรือ query string `?page=...`

ตัวอย่าง route:

| Route | HTML ที่ serve |
|---|---|
| `/`, `?page=index` | `index.html` |
| `?page=product` | `product.html` |
| `?page=order` | `order.html` |
| `?page=order-view&token=...` | `order-view.html` |
| `?page=edit-store` | `edit-store.html` |
| `?page=shipping` | `shipping-page.html` |
| `?page=promotion` | `promotion.html` |
| `?page=gift` | `gift.html` |
| `?page=payment` | `payment.html` |
| `?page=user` | `user.html` |
| `?page=system` | `system.html` |
| `?page=privacy-policy` | `privacy-policy.html` |
| `?page=term-and-service` | `term_and_service.html` |

ตอน render หน้า `doGet(e)` จะสร้าง template ด้วย `HtmlService.createTemplateFromFile(view)` แล้ว inject ค่าหลักเข้า template:

- `siteCfgJs`: config หน้าร้านที่รวม product snapshot, shipping และ payment config แล้ว
- `siteCfgMeta`: timestamp ของ config และ product snapshot
- `execUrl`: URL ของ deployed Web App
- `orderToken`: token จาก query string สำหรับหน้า `order-view`

หน้า public เช่น `index`, `order-view`, `privacy-policy`, `term_and_service` ตั้งค่า iframe ด้วย `XFrameOptionsMode.ALLOWALL`
ส่วนหน้า admin/login ใช้ค่า default ของ GAS เพื่อกันการ embed จากภายนอก

## Frontend Runtime

Frontend เป็น HTML files ที่มี JavaScript อยู่ในไฟล์เดียวกันหรือ include `admin-shared.html`
การเรียก backend ทำผ่าน `google.script.run` โดยแต่ละหน้าห่อเป็น helper เช่น `callRpc()` หรือ `_rpc()`

รูปแบบ response จาก backend ใช้มาตรฐานเดียวกัน:

```js
{ ok: true, ...data }
{ ok: false, error: "..." }
```

ฝั่ง client ต้องตรวจ `ok` ก่อนใช้ข้อมูลเสมอ เพราะ Apps Script RPC จะคืนค่า business error ผ่าน object
ไม่ใช่ throw exception ทุกกรณี

### Admin Shared Component

หน้า admin ส่วนใหญ่ include `admin-shared.html` เพื่อใช้ของร่วมกัน:

- sidebar และ topbar
- brand/logo loader
- HUD toast และ loading state
- auth/session validation
- helper สำหรับเรียก RPC
- style กลางของ table, chip, status, empty state และ skeleton

หน้า admin ต้องมี session token ใน client storage และเรียก RPC พร้อม token
ถ้า session ใช้ไม่ได้ backend จะคืน `AUTH_REQUIRED` หรือ `SESSION_INVALID`

## Backend Layers

`code.gs` เป็น monolithic Apps Script file แต่แบ่งหน้าที่หลักเป็น layer ได้ดังนี้:

- **Routing layer**: `doGet(e)`, `include(filename)`
- **Config layer**: default site config, `readSiteConfig_()`, `writeSiteConfig_()`, `buildConfigWithProducts_()`
- **Sheet access layer**: helper เช่น `sheetProd_()`, `sheetOrders_()`, `sheetUsers_()`, `sheetShipping_()`, `sheetPayment_()`
- **Cache layer**: product snapshot, shipping list, payment config, site config, sessions, OTP, rate limits
- **Business RPC layer**: product, order, payment, shipping, promotion, gift, user, system
- **Security layer**: password hashing, session HMAC, OTP, order token validation, field encryption, upload validation
- **Logging layer**: best-effort queue, Drive archive writer, retention cleanup
- **Setup/maintenance layer**: `setupAll()`, `tickSync()`, snapshot rebuild, log flush

`shipping.gs` แยกออกมาเพื่อเก็บ provider-specific logic ของ tracking โดยเฉพาะ
และคืนผลลัพธ์เป็น shape กลางเดียวกันก่อนส่งให้หน้า order/customer

## Google Sheets Data Model

Google Sheets เป็นฐานข้อมูลหลัก ทุก sheet มี header row และ helper ใน backend จะสร้าง/เพิ่ม column ที่ขาดให้อัตโนมัติเท่าที่รองรับ

### `product`

เก็บสินค้าและข้อมูลสำหรับหน้าร้าน

| Column | ความหมาย |
|---|---|
| `id` | product id |
| `title`, `desc`, `badge` | ข้อมูลแสดงผลสินค้า |
| `price` | base price |
| `image_drive_file_id`, `image_url` | รูปหลัก |
| `variants_json` | variant groups/options เช่น size/color/ราคา/stock |
| `extra_images_json` | รูปเพิ่มเติม |
| `weight_grams` | น้ำหนักสินค้า |
| `allowed_shipping_ids` | method ids ที่สินค้านี้อนุญาตให้จัดส่ง |
| `stock` | stock ระดับสินค้า ถ้าใช้ `-1` หมายถึงไม่จำกัด |
| `sale_starts_at`, `sale_ends_at`, `sale_mode` | สถานะการขายและ schedule |

`sale_mode` เป็น source of truth หลักของสถานะขาย ค่า legacy เช่น `active`, `sale_enabled`, `sale_no_end_date`
ยังถูก sync ไว้เพื่อให้รายงานเก่าหรือคนอ่านชีตดูได้ง่าย แต่ logic ใหม่อ่านจาก `sale_mode`

### `orders`

เก็บคำสั่งซื้อและข้อมูลลูกค้า

| Column | ความหมาย |
|---|---|
| `order_id` | เลขคำสั่งซื้อ เช่น `ORD-YYYYMMDD-XXXXXX` |
| `created_at`, `updated_at` | timestamp |
| `status` | สถานะ order เช่น unpaid, paid, approved, shipped, delivered, rejected |
| `customer_name`, `customer_phone`, `customer_contact` | ข้อมูลลูกค้า เข้ารหัสเมื่อมี `DATA_ENCRYPT_KEY` |
| `shipping_name`, `shipping_address`, `shipping_district`, `shipping_amphoe`, `shipping_province`, `shipping_postal_code` | ข้อมูลจัดส่ง เข้ารหัสเมื่อมี key |
| `customer_notes` | note จากลูกค้า |
| `shipping_fee`, `subtotal`, `total` | ยอดเงิน |
| `shipping_method_id` | วิธีจัดส่งที่เลือก |
| `items_json` | line items ทั้งสินค้าและของแถม |
| `status_history_json` | ประวัติการเปลี่ยนสถานะ |
| `shipping_info_json` | ข้อมูล shipping เพิ่มเติม |
| `token` | token สำหรับหน้า order-view เข้ารหัส at rest |
| `slip_drive_file_id` | ไฟล์สลิปใน Drive |
| `token_expires_at` | วันหมดอายุ token |
| `tracking_json` | tracking result/cache เข้ารหัส at rest |
| `fulfillment_shipping_json` | บริษัทขนส่งจริงที่ร้านใช้จัดส่ง (แยกจากที่ลูกค้าเลือก) — plaintext, ไม่มี PII |

### `store`

เก็บ config และ asset ของร้าน

- row `site_config` เก็บ JSON config หลักของหน้าร้าน
- row อื่น ๆ ใช้เก็บรูป/logo/status images โดยมี `key`, `drive_file_id`, `url`, `updated_at`

### `shipping`

เก็บบริษัทขนส่งและวิธีจัดส่ง

| Column | ความหมาย |
|---|---|
| `id` | company id |
| `name` | ชื่อบริษัทขนส่ง |
| `active` | เปิดใช้งานหรือไม่ |
| `methods_json` | วิธีส่ง/ราคา/เงื่อนไข |
| `carrier_id` | id ที่ใช้ map กับ provider tracking เช่น `thaipost`, `kerry`, `flash` |
| `tracking_url_template` | URL template สำหรับ tracking link |
| `tracking_provider` | provider ที่ใช้ เช่น `aftership`, `thaipost`, `etracking` |

เมื่อแก้ shipping config ระบบจะ cleanup method ids ที่ถูกลบออกจากสินค้า
และอาจ auto-disable สินค้าที่ไม่มี active shipping method เหลืออยู่

### `promotions`

เก็บ promotion rules

- รองรับส่วนลดแบบ fixed/percent
- target ได้ทั้งทุกสินค้า สินค้าเฉพาะรายการ หรือ variant เฉพาะ
- มี `starts_at`, `ends_at`, `enabled`, `no_end_date`, `deleted_at`
- status เช่น active/scheduled/expired/disabled คำนวณแบบ dynamic

ราคาที่ผ่าน promotion ถูก inject เข้า product snapshot เพื่อให้ storefront ใช้งานได้ทันที

### `gift_items` และ `gift_rules`

`gift_items` คือ catalog ของของแถม เช่น ชื่อ รายละเอียด รูป stock และ enabled flag

`gift_rules` คือเงื่อนไขการแจกของแถม เช่น:

- ยอด subtotal ขั้นต่ำ
- สินค้า/variant ที่เข้าเงื่อนไข
- จำนวนของแถม
- ช่วงเวลาเริ่ม/จบ
- enabled/deleted state

ตอน checkout ระบบจะคำนวณ eligibility และ commit ของแถมลง `items_json` ด้วย `line_type: "gift"`

### `payment`

เก็บ payment config แบบ single-row

| Column | ความหมาย |
|---|---|
| `promptpay_number`, `promptpay_name` | ข้อมูล PromptPay |
| `bg_drive_id`, `bg_url` | ภาพพื้นหลัง/ภาพประกอบการชำระเงิน |
| `qr_x`, `qr_y`, `qr_size` | ตำแหน่งและขนาด QR บนภาพ |
| `updated_at`, `updated_by` | audit metadata |

การแก้ payment config เป็น owner-only และมี OTP flow แยกเพื่อป้องกัน admin ทั่วไปเปลี่ยนบัญชีรับเงิน

### `users`

เก็บบัญชีหลังบ้าน

| Column | ความหมาย |
|---|---|
| `id`, `email` | user identity |
| `password_hash`, `salt` | hash รหัสผ่าน |
| `role` | role เช่น owner/admin |
| `otp_required` | บังคับ OTP ตอน login หรือไม่ |
| `session_key_hash`, `session_expires_at` | session metadata แบบ hash |

รหัสผ่านใหม่ใช้ PBKDF2-HMAC-SHA256 format `v2:ITERATIONS:HEXHASH`
ระบบยังรองรับ legacy hash และจะ upgrade เมื่อผู้ใช้ login สำเร็จ

## Google Drive Layout

ไฟล์ทั้งหมดอยู่ใต้ folder ที่ตั้งใน Script Property `DRIVE_FOLDER_ID`
backend จะสร้าง subfolder ตามประเภทไฟล์

```text
<DRIVE_FOLDER_ID>/
  product/   public product images
  gift/      public gift item images
  store/     public store images/logo/banner
  slip/      private payment slips
  log/       private activity logs
```

รูป product/gift/store มักตั้ง sharing เป็น `ANYONE_WITH_LINK` เพื่อให้ browser เปิดได้
แต่สลิปและ log ต้องเป็น private และอ่านผ่าน RPC ที่ตรวจสิทธิ์หรือ order token เท่านั้น

## Cache And Synchronization

ระบบใช้ `CacheService` เพื่อลดการอ่าน Google Sheets/Drive ใน hot path

### Product Snapshot

product snapshot คือ array ของสินค้าที่ normalize แล้ว พร้อม promotion/sale status
ใช้ cache key หลัก:

- `PROD_SNAPSHOT_CACHE`
- `PROD_SNAPSHOT_TS`
- `PROD_SNAP_META`
- `PROD_SNAP_PART_*`
- `PROD_DRIVE_TS_CHECKED`

ถ้า JSON snapshot มีขนาดเกิน limit ของ `CacheService` ระบบจะใช้ chunked snapshot
โดยเขียน chunk ภายใต้ version ใหม่ แล้วค่อยเขียน meta เป็นขั้นสุดท้าย
เพื่อป้องกัน reader ประกอบ snapshot จาก chunk คนละ version

`tickSync()` จะเรียก `syncSnapIfStale_()` ทุก 1 นาที
และมี sentinel TTL ประมาณ 30 วินาทีเพื่อลดการเรียก `DriveApp.getFileById(...).getLastUpdated()`

เมื่อ mutate ผ่าน app เช่น create/update product หรือ submit order
ระบบจะ rebuild หรือ patch snapshot โดยตรง ทำให้ storefront เห็นข้อมูลใหม่เร็วกว่าเคสแก้ชีตเอง

### Site Config, Shipping, Payment

- site config cache เก็บ JSON จาก `store` row `site_config`
- shipping list cache เก็บบริษัทขนส่งจาก `shipping`
- payment cache เก็บ config จาก `payment`

เมื่อมีการ save config ที่เกี่ยวข้อง ระบบจะ invalidate cache ที่เกี่ยวข้อง

### Sessions, OTP และ Rate Limit

ใช้ `CacheService` สำหรับ:

- session token อายุสูงสุด 6 ชั่วโมง
- login OTP อายุ 10 นาที
- OTP verification attempt tracking
- login/order-token/tracking rate limit
- key rotation lock
- activity log queue

ข้อมูลใน cache เป็น best-effort และอาจถูก evict ได้ตาม behavior ของ GAS
ดังนั้น logic สำคัญต้อง fallback จาก sheet หรือขอ login ใหม่ได้เสมอ

## Order Flow

### Checkout

1. ลูกค้าสร้าง cart ใน `index.html`
2. frontend เรียก backend เพื่อ preview promotion/gift/shipping ตามข้อมูลที่เลือก
3. เมื่อ submit order จะเรียก `submitOrderRpc(...)`
4. backend validate payload, stock, shipping method, promotion/gift eligibility และข้อมูลลูกค้า
5. ใช้ `LockService` เพื่อลด race condition ขณะ commit stock และ append order
6. สร้าง `order_id` และ order token
7. append แถวลง `orders`
8. patch/rebuild product snapshot เพื่อสะท้อน stock ใหม่
9. คืน token ให้ลูกค้าเปิดหน้า `order-view`

ระบบมี idempotency ด้วย `client_order_id` เพื่อลดความเสี่ยงจากการกด submit ซ้ำหรือ retry จาก browser

### Customer Order View

หน้า `order-view.html` เข้าถึงด้วย `?page=order-view&token=...`
token ถูก validate ด้วย `validateOrderToken_()` ก่อนอ่านข้อมูลหรืออัปโหลดสลิป

scope สำคัญ:

- read order detail
- upload slip เฉพาะสถานะที่ยังรอชำระ/รอตรวจ
- read slip เฉพาะกรณีที่อนุญาต
- tracking lookup

token มี `token_expires_at` และถูกเก็บแบบ encrypted at rest ใน `orders`

### Admin Order Management

admin สามารถ:

- list/search/filter orders
- เปิดรายละเอียด order
- เปลี่ยนสถานะ
- เพิ่ม/แก้/ลบของแถมใน order
- mark shipped พร้อม tracking number
- ดู production summary
- อัปเดตวันหมดอายุ order token

รายการ order ใช้ optimization โดย filter/paginate ก่อน decrypt ข้อมูลส่วนบุคคล
เพื่อลดเวลาอ่านข้อมูลเมื่อมี order จำนวนมาก

## Promotion Flow

Promotion ถูกอ่านจาก `promotions` และ apply เข้า product snapshot ใน `rebuildSnap_()`
แนวคิดสำคัญคือ storefront ไม่ต้องคำนวณหนักเองทุกครั้ง แต่รับ product object ที่มีข้อมูลราคาหลัง promotion พร้อมใช้

status ของ promotion คำนวณจาก:

- `enabled`
- `starts_at`
- `ends_at`
- `no_end_date`
- `deleted_at`

เมื่อ promotion เปลี่ยน ต้อง invalidate/rebuild snapshot เพื่อให้ product card และ checkout เห็นราคาใหม่

## Gift Flow

Gift system แยกเป็น catalog และ rule

```text
gift_items   -> ของแถมที่มี stock/รูป/สถานะ
gift_rules   -> เงื่อนไขการแจก
cart/order   -> preview eligibility -> commit เป็น line_type="gift"
```

ระบบตรวจทั้ง availability, stock และเงื่อนไข rule
ถ้าของแถมหมดหรือไม่เข้าเงื่อนไข จะส่ง warning กลับให้ frontend แสดงผลโดยไม่ทำให้ order หลักเสียหายโดยไม่จำเป็น

ของแถมที่ติดไปกับ order จะถูก snapshot ลง `items_json`
เพื่อให้ order history ยังอ่านได้แม้ภายหลัง gift item จะถูกแก้ชื่อ/รูป/ปิดใช้งาน

## Shipping And Tracking

Shipping config ใน `shipping` ใช้สำหรับคำนวณวิธีจัดส่งและผูก carrier metadata
ส่วนการติดตามพัสดุอยู่ใน `shipping.gs`

Provider ที่รองรับ:

- **AfterShip**: ใช้ `AFTERSHIP_API_KEY`
- **Thailand Post**: ใช้ `THP_STATIC_TOKEN`
- **ETracking**: ใช้ `ETRACK_API_KEY` และ `ETRACK_KEY_SECRET`

`shipping.gs` normalize response ทุก provider เป็น `TrackingResult`:

```js
{
  ok: true,
  provider: "aftership" | "thaipost" | "etracking",
  trackingNumber: "...",
  carrierId: "...",
  tag: "Delivered",
  events: [{ tag, message, location, time }],
  isDelivered: true,
  lastUpdatedAt: "..."
}
```

events ถูก normalize เป็น oldest-first
หน้า `order-view.html` จะจัดรูปแบบ timeline สำหรับแสดงผลอีกที

การ match provider/carrier มี validation:

- `thaipost` provider ใช้ได้เฉพาะ `carrier_id = "thaipost"`
- `etracking` ไม่รองรับ Thailand Post
- `aftership` ใช้ได้กับ carrier ที่มี slug mapping

เมื่อ tracking บอกว่าจัดส่งสำเร็จแล้ว ระบบสามารถ persist result ลง `tracking_json`
และเปลี่ยนสถานะ order เป็น delivered ตามเงื่อนไขที่กำหนด

### Fulfillment Carrier Override (บริษัทขนส่งจริง)

ระบบแยก **สองแนวคิด** ของการจัดส่งออกจากกัน:

1. **ที่ลูกค้าเลือกและจ่ายเงิน** — เก็บใน `shipping_method_id` + `shipping_info_json`
   เป็น snapshot ที่ไม่เปลี่ยนแปลง (หลักฐานของสิ่งที่ลูกค้าเลือก) — **ห้ามเขียนทับ**
2. **บริษัทขนส่งจริงที่ร้านใช้จัดส่ง** — เก็บใน `fulfillment_shipping_json`
   ร้านเปลี่ยนได้หลังสร้าง order โดย**ไม่กระทบราคา** (ส่วนต่างค่าขนส่งร้านรับผิดชอบเอง)

RPC `orderUpdateFulfillmentShippingRpc(token, orderId, companyId, methodId, reason)`:

- อนุญาตเฉพาะสถานะ `unpaid` / `paid` / `approved` (ปฏิเสธ `shipped` / `delivered` /
  `rejected` / `cancelled`) และ**ไม่เปลี่ยนสถานะหลักของ order**
- ต้องระบุ `reason` เมื่อสถานะเป็น `paid` / `approved`
- ตรวจสอบว่า company + method active และ method เป็นของ company นั้นจริง
- `carrier_id` / `tracking_provider` / `tracking_url_template` **resolve ฝั่ง backend**
  จาก shipping config แล้ว snapshot ไว้ (order ยังอ่านได้แม้ config ถูกแก้/ลบภายหลัง) —
  ไม่เชื่อค่าจาก frontend
- บันทึก history event `shipping_carrier_changed` (note แบบ customer-safe) + audit log
- ทำงานภายใต้ `LockService` ป้องกัน race กับ `orderMarkShippedRpc`

`orderMarkShippedRpc` เลือก carrier ตาม `fulfillment_shipping_json` ก่อน ถ้าไม่มีจึง fall
back ไปที่ company เดิมใน `shipping_info_json`; order เก่าที่ไม่มี override ทำงานเหมือนเดิม

**Monetary field locking**: เมื่อ order เคยถึงสถานะ `paid`/`approved`/`shipped`/`delivered`
แล้ว (พิจารณาจาก status history — ล็อกถาวรแม้ย้อนกลับเป็น `unpaid`) `orderUpdateFieldsRpc`
จะปฏิเสธการแก้ `shipping_fee` / `subtotal` / `total`; ก่อนชำระเงินที่ยังแก้ค่าส่งได้
`total` คำนวณใหม่ฝั่ง backend จาก `subtotal + shipping_fee` เสมอ (ไม่เชื่อ `total` จาก client)

หน้า `order-view.html` แสดงข้อความก่อนจัดส่งว่าจะส่งด้วยบริษัทจริงใด (เฉพาะ `company_name`
ที่ผ่านการ sanitize — ไม่เปิดเผย reason/ผู้แก้ไข/บริษัทเดิมให้ลูกค้า)

## Authentication And Authorization

### Login

Flow หลัก:

1. `login.html` เรียก `loginRpc(email, password, clientCtx)`
2. backend ตรวจ rate limit
3. หา user จาก `users`
4. verify password ด้วย PBKDF2
5. ถ้า user บังคับ OTP จะส่ง OTP ทาง email และคืน `otpRequired: true`
6. ถ้าไม่ต้อง OTP หรือ verify OTP สำเร็จ จะสร้าง session token
7. session เก็บใน `CacheService` และ hash metadata ลง sheet

### Session

session token เป็น secret ที่ส่งจาก browser มากับ RPC admin
backend ตรวจด้วย `requireAdmin_(token)` หรือ `requireOwner_(token)`

แนวทางแยกสิทธิ์:

- admin ทั่วไปจัดการสินค้า order promotion gift shipping ได้ตาม RPC ที่อนุญาต
- owner-only สำหรับงานเสี่ยง เช่น payment config, system properties, user management บางส่วน, key rotation

### OTP

OTP ใช้กับหลาย flow:

- login 2FA
- แก้ payment config
- แก้ system properties
- rotate encryption key
- เปลี่ยนอีเมลผู้ใช้

OTP มี TTL, attempt limit และ rate limit เพื่อกัน brute force และ spam email

## Security Model

### Field-Level Encryption

ถ้าตั้ง `DATA_ENCRYPT_KEY` ระบบจะเข้ารหัส PII ใน `orders`
field ที่เข้ารหัสรวมถึงชื่อลูกค้า เบอร์โทร ที่อยู่ token และ `tracking_json`

รูปแบบ encryption:

- keystream จาก HMAC-SHA256
- XOR กับ plaintext bytes
- format `enc:<iv>:<cipherHex>:<mac>`
- มี authentication tag จาก HMAC เพื่อ detect การแก้ไข ciphertext

ถ้าไม่มี `DATA_ENCRYPT_KEY` ระบบจะเก็บเป็น plaintext เพื่อไม่ให้ระบบพัง
แต่ production ควรมี key เสมอ และ `setupAll()` จะ generate key ให้หากยังไม่มี

### Input Validation

backend มี helper สำหรับ:

- จำกัดความยาว field
- strip control characters
- reject HTML-like tags ใน plain text fields
- sanitize string cell ที่ขึ้นต้นด้วย `=`, `+`, `-`, `@`, tab หรือ newline เพื่อกัน formula injection ใน Google Sheets
- validate upload mime/type/size สำหรับรูปและสลิป
- validate URL และ Drive file access

### Access To Files

- public images ใช้ Drive sharing แบบ anyone-with-link
- slip files ต้องอ่านผ่าน token/admin RPC
- log files ต้องอยู่ private ใต้ `/log`
- backend ตรวจ parent folder สำหรับ slip ก่อนคืน data URL

## Activity Logging

ระบบ logging เป็น optional และปิดโดย default
รายละเอียดเต็มอยู่ที่ [LOGGING.md](LOGGING.md)

สรุป flow:

```text
RPC / page beacon
  -> enqueueLog_()
  -> CacheService queue
  -> tickSync()
  -> processLogQueue_()
  -> Drive /log/archive/YYYY-MM-DD/*.jsonl.txt
```

จุดสำคัญ:

- ไม่มี Drive write บน request hot path
- logging failure ไม่ทำให้ business RPC fail
- log เป็น best-effort ไม่ใช่ network access log
- GAS ไม่เปิดเผย raw source IP/headers ให้ script
- IP observation ต้องเปิดแยก และเป็น client-fetched จาก third party จึงไม่ถือว่า server-verified
- retention default 90 วัน

## Setup And Scheduled Jobs

### `setupAll()`

ควรรันหนึ่งครั้งจาก Apps Script editor หลัง deploy

หน้าที่:

- ตั้ง `SHEET_ID` ถ้ายังไม่มี โดยใช้ active spreadsheet หรือสร้างใหม่
- ตั้ง `DRIVE_FOLDER_ID` ถ้ายังไม่มี โดยสร้าง folder ใหม่
- สร้าง/ensure sheets หลักทั้งหมด
- seed default `site_config`
- seed status images
- rebuild product snapshot
- ติดตั้ง trigger `tickSync` ทุก 1 นาที
- ensure log folders
- generate `DATA_ENCRYPT_KEY` ถ้ายังไม่มี
- set `SETUP_COMPLETED = true`

ถ้าต้อง rerun setup ใน development ต้อง clear `SETUP_COMPLETED` ด้วย dev helper หรือแก้ Script Property เองอย่างระวัง

### `tickSync()`

trigger ทุก 1 นาที ทำงานเบื้องหลัง:

- sync/rebuild product snapshot ถ้า stale
- flush activity log queue ไป Drive
- cleanup log archive ตาม retention

## Failure And Consistency Notes

ระบบนี้ต้องอยู่บนข้อจำกัดของ Apps Script และ Google Sheets จึงออกแบบให้ใช้แนวทาง pragmatic consistency:

- ใช้ `LockService` กับจุดที่มี race risk เช่น stock/order commit และ snapshot rebuild
- product snapshot อาจ stale สั้น ๆ หากแก้ Google Sheet ตรง แต่ `tickSync()` จะ sync กลับ
- app-mediated writes พยายาม invalidate/rebuild cache ทันที
- CacheService เป็น best-effort จึงต้องมี fallback จาก sheet
- order commit ถ้าเกิด partial failure หลัง append แล้วจะไม่ rollback stock/order แบบเต็ม เพราะ order ที่เขียนลง sheet แล้วถือเป็น customer commitment
- logging เป็น best-effort และไม่ block งานหลัก

## Development Notes

- เปลี่ยน sheet schema ให้เพิ่ม column ต่อท้ายเท่านั้นถ้าเป็นไปได้ เพื่อเลี่ยง breaking existing deployments
- RPC ใหม่ควรคืน `{ ok: true }` หรือ `{ ok: false, error }` ให้สม่ำเสมอ
- RPC ที่ mutate ข้อมูลหลังบ้านควรรับ `token` และเรียก `requireAdmin_()` หรือ `requireOwner_()`
- ถ้าแก้ product/promotion/sale/shipping ที่กระทบ storefront ต้อง invalidate หรือ rebuild product snapshot
- ถ้าเพิ่มข้อมูล PII ใน `orders` ให้พิจารณาเพิ่มเข้า `PII_FIELDS_ORDER`
- ถ้าเพิ่มไฟล์ upload type ใหม่ ให้กำหนด Drive folder และ access model ให้ชัดเจน
- ห้าม log secret, OTP, password, full token, full PromptPay number หรือข้อมูลลูกค้าแบบเต็ม

## QA Surface

| Folder | ใช้ทดสอบ |
|---|---|
| `QA/Integration/` | Apps Script integration dashboard |
| `QA/E2E/` | Playwright tests กับ deployed Web App |
| `QA/performance/` | Node.js load/performance smoke test |

ดูรายละเอียดการทดสอบที่ [../QA/Dev.md](../QA/Dev.md)
