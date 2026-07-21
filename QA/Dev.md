# QA Developer Guide

คู่มือนี้อ้างอิง **Open Storefront `v1.1.0`** และอธิบายเครื่องมือทดสอบทั้งหมดใน folder `QA/`
ครอบคลุม Unit, Performance, Integration และ E2E รวมถึงวิธีติดตั้ง ตั้งค่า รัน และอ่านผล

---

## ภาพรวม: มีเครื่องมือ 4 ชุด

| ชุด | Folder | รันที่ไหน | ทดสอบอะไร |
|---|---|---|---|
| **Unit** | `QA/unit/` | เครื่อง local (Node.js) | pricing parity และ zero-trust cart/variant/quantity contract |
| **Performance** | `QA/performance/` | เครื่อง local (Node.js) | วัดความเร็วและรับโหลดของหน้า storefront (GET เท่านั้น) |
| **Integration** | `QA/Integration/` | Google Apps Script (GAS) | ทดสอบ backend RPC ทุก flow แบบ real data |
| **E2E** | `QA/E2E/` | เครื่อง local (Playwright + Chromium) | ทดสอบ UI browser-level บน deployed GAS จริง |

ทั้งสี่ชุดทำงานร่วมกันแต่ใช้คนละ layer:

```
E2E (Playwright)        ← ทดสอบ UI ที่ผู้ใช้เห็น
     ↓
Integration (GAS)       ← ทดสอบ backend logic + data flow
     ↓
Unit (Node.js)          ← ทดสอบฟังก์ชันสำคัญแบบเร็วและไม่แตะข้อมูลจริง

Performance (Node.js)   ← ทดสอบกำลังรับโหลดของหน้า GET แยกจาก functional flow
```

---

## 1. Unit Test

Unit tests ไม่ต้อง deploy, ไม่เรียก network, ไม่ใช้ Google Sheets และไม่มี dependency ภายนอก ต้องมีเพียง Node.js 18 ขึ้นไป

รันจาก root ของ repository:

```powershell
npm --prefix QA/unit test
```

หรือรันแยก:

```powershell
node QA/unit/pricing-parity.test.js
node QA/unit/order-cart-validation.test.js
```

| Test file | ตรวจอะไร |
|---|---|
| `pricing-parity.test.js` | ราคา variant, promotion, order-total discount และยอดรวมของ `index.html` กับ `edit-store.html` ต้องตรงกัน |
| `order-cart-validation.test.js` | variant ต้องครบ, ห้าม group/option ปลอม, quantity/resource limits และค่าราคา/น้ำหนัก/stock ต้องมาจาก server |

ให้รัน Unit ก่อน Integration/E2E เสมอ เพราะเร็วและไม่สร้าง fixture จริง

---

## 2. Performance Test

### สิ่งที่ต้องมี

- Node.js 18 ขึ้นไป
- Google Apps Script Web App ที่ deploy แล้ว (URL ของ production หรือ staging)

### ติดตั้ง

```powershell
cd QA\performance
npm install
```

### ตั้งค่า

สร้างไฟล์ config จาก template:

```powershell
Copy-Item config.example.json config.json
```

เปิด `config.json` แล้วแก้ `targetUrl` เป็น URL ของ deployment จริง:

```json
{
  "targetUrl": "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  "pagePath": "",
  "queryParams": { "page": "index" },
  "mode": "smoke",
  "concurrentUsers": 5,
  "durationSeconds": 30,
  "rampUpSeconds": 10,
  "requestTimeoutMs": 15000,
  "thresholds": {
    "maxErrorRatePercent": 5,
    "maxP95Ms": 3000
  },
  "stepTest": {
    "startUsers": 5,
    "stepUsers": 10,
    "maxUsers": 100,
    "durationSeconds": 30,
    "rampUpSeconds": 10,
    "cooldownSeconds": 5
  }
}
```

> **หมายเหตุ:** `config.json` ถูก ignore ใน `.gitignore` แล้ว — ไม่ต้อง commit

### รัน

| คำสั่ง | เหมาะกับ |
|---|---|
| `npm run smoke` | เช็คก่อนว่า URL ใช้งานได้ (5 users, 30 วินาที) |
| `npm run light` | โหลดเบา ใกล้การใช้งานจริง (25 users, 60 วินาที) |
| `npm run medium` | โหลดกลาง (50 users, 90 วินาที) |
| `npm run heavy` | โหลดสูง — ใช้ด้วยความระวัง (100 users, 120 วินาที) |
| `npm run step` | เพิ่มโหลดทีละขั้นจนหาจุดเริ่มมีปัญหา |
| `npm run test` | รันตาม `mode` ใน config.json |

Override ค่าบางอย่างโดยไม่แก้ไฟล์:

```powershell
node run-performance-test.js --config config.json --preset smoke --users 10 --duration 60
```

### ลำดับที่แนะนำ

1. `npm run smoke` — ยืนยัน URL ถูกต้อง
2. `npm run light` — ตรวจโหลดเบา
3. `npm run step` — หาจุดเริ่มมีปัญหา

อย่ารัน `heavy` ก่อนผ่าน `smoke` และ `light` เพราะ GAS มี quota

### อ่านผล

รายงานถูกสร้างที่ `QA/performance/results/report-YYYYMMDD-HHMM.md` และ `.json`

ค่าที่ต้องดู:

| ค่า | วิธีอ่าน |
|---|---|
| `p95` | 95% ของ request ใช้เวลาไม่เกินค่านี้ — ถ้าสูงกว่า 3,000 ms ควรตรวจ |
| `error rate` | อัตรา request ที่ล้มเหลว — ถ้าเกิน 5% ถือว่าเริ่มมีปัญหา |
| HTTP status | ถ้ามี 429 / 503 มาก แปลว่าติด GAS quota หรือ rate limit |

ตัวอย่างการอ่าน step test: ถ้าผ่านที่ 45 users แต่ error พุ่งที่ 55 users → ระบบรับได้ประมาณ **45 users พร้อมกัน** ภายใต้เงื่อนไขนี้

### ข้อจำกัด

- ยิงเฉพาะ HTTP GET ไม่ได้จำลอง checkout หรือ RPC
- ไม่ได้รัน JavaScript ใน browser จริง
- ผล p95 / error rate ขึ้นกับ GAS quota และเครือข่ายในช่วงเวลานั้น

---

## 3. Integration Test

### สิ่งที่ต้องมี

- Google Apps Script project ที่ deploy แล้ว (GAS project เดียวกับ `code.gs`)
- บัญชี Admin ของระบบ

### ติดตั้ง (ครั้งแรก)

Integration tests รันใน **GAS environment** ไม่ใช่ local ดังนั้นขั้นตอนคือ copy ไฟล์เข้า GAS project:

1. เปิด Google Apps Script editor ของ project
2. สร้างไฟล์ใหม่ชื่อ **`integration-tests`** (ประเภท Script)
3. วาง content จาก `QA/Integration/integration-tests.gs` ลงไป
4. สร้างไฟล์ใหม่ชื่อ **`integration-dashboard`** (ประเภท HTML)
5. วาง content จาก `QA/Integration/integration-dashboard.html` ลงไป
6. บันทึกและ update QA/test Web App deployment ให้รวมสองไฟล์นี้

> ห้ามติดตั้ง integration helpers ใน production deployment เพราะ write/E2E fixtures สามารถสร้างและลบข้อมูลจริงได้

### เปิด Dashboard

เปิด dashboard ผ่าน QA Web App URL:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec?page=qa-integration
```

หรือใช้ test deployment URL (`/dev?page=qa-integration`) จากบัญชีที่มีสิทธิ์แก้ Apps Script project
ฟังก์ชัน `qaOpenIntegrationDashboard()` คืน `HtmlOutput` สำหรับเรียกจากโค้ด/เครื่องมือ แต่การกด Run ใน editor ไม่ได้เปิด sidebar อัตโนมัติ

### ล็อกอิน Admin ใน Dashboard

ก่อนรัน test ที่ต้องสิทธิ์ admin หรือ write tests ให้ใส่ email + password ในช่อง **Admin Login** แล้วกด **Login**

ถ้าบัญชีเปิด OTP 2FA จะมีช่อง OTP ปรากฏ — ใส่รหัสแล้วกด **Verify OTP**

token จะเก็บใน `localStorage` ชั่วคราวตลอด session

### รัน Test

| ปุ่ม | ทำอะไร |
|---|---|
| **Load cases** | โหลดรายการ testcase ทั้งหมดจาก GAS |
| **Run all** | รันทุก testcase ตามลำดับ |
| **Run selected** | รัน testcase ที่เลือก (checkbox) |
| **Run section** (ปุ่มข้างหมวด) | รันเฉพาะหมวดนั้น |
| **Run** (ปุ่มข้าง testcase) | รัน testcase เดี่ยว |

ตัวกรอง tab ด้านบน (All / Failed / Passed / Skipped / Orders / Gifts / …) ช่วยดูเฉพาะหมวดหรือสถานะที่ต้องการ

### โหมด Write Tests

Test ส่วนใหญ่เป็น **read-only** (อ่านข้อมูลแล้วตรวจ contract ไม่เขียน Sheet)

Test ที่ **เขียนข้อมูลจริง** ต้องเปิด toggle **"Enable real write tests"** ก่อน — และต้องล็อกอิน admin ก่อนเสมอ

Write tests จะสร้างข้อมูลชั่วคราว เช่น สินค้า โปรโมชั่น ของแถม shipping และ order จริง แล้วเรียก cleanup หลังรัน
ให้ตรวจ `details.cleanup` ทุกครั้ง เพราะบาง failure/partial-write อาจจงใจเก็บ order ไว้เป็นหลักฐานหรือ cleanup ไม่สำเร็จ

### หมวด Test ที่มี

| หมวด | ทดสอบอะไร |
|---|---|
| **Environment** | backend contract, setup status, RPC พื้นฐาน |
| **Config** | site config, brand info, snapshot bundle |
| **Products** | product list สาธารณะ, pagination, contract |
| **Promotions** | การคำนวณส่วนลด, target specificity, overlap protection |
| **Shipping** | ค่าขนส่งสาธารณะ, carrier info |
| **Payment** | payment config validation, OTP lifecycle, slip upload |
| **Gifts** | gift campaigns, eligibility preview, stock behavior |
| **Auth** | session validation, RPC auth guards |
| **Routes** | HTTP route smoke (ตรวจว่า page render ไม่พัง) |
| **Orders** | สร้าง order, promotion/gift rule updates, schedule ระหว่าง preview/submit, multiplied gifts, idempotency, stock lifecycle/race, production summary และ full commerce flow |

ชุด `orders.rules-*` ตรวจ contract ของ Promotion/Gift รุ่นใหม่ในระดับออร์เดอร์จริง ได้แก่ conditional pricing, `discount_scope=order_total`, `match_mode` แบบ ALL/ANY, `repeat_mode=per_threshold`, rule activation/expiry, stale pricing หลังแก้ promotion, snapshot หลังแก้หรือลบ rule, การกระจายส่วนลดท้ายบิลใน split shipping, หลาย promotion/gift ใน cart เดียว, client pricing, stock, cancel/un-cancel, idempotency, production summary และการไม่คิด gift เข้า subtotal/ค่าขนส่ง

Mega coverage มีทั้ง flow 6 product lines ที่ให้ promotion ระดับ item และ order-total รวม 8 ตัวแข่งขันพร้อม gift rules 5 ตัว และ flow recovery ที่แก้ promotion ระหว่าง preview/submit เพื่อตรวจ `PRICE_CHANGED`, refresh/resubmit, immutable snapshot และ stock lifecycle แบบครบวงจร

### Concurrent / Race Tests (Orders)

Test ที่ชื่อขึ้นต้นว่า **concurrent** หรือ **race** รันจาก dashboard โดยตรง (client-driven) — dashboard ยิง `google.script.run` หลายชุดพร้อมกันเพื่อจำลอง race condition

test เหล่านี้ต้องการ:
- `Enable real write tests` เปิดอยู่
- ล็อกอิน admin แล้ว

ตัวอย่าง concurrent tests:
- `concurrent-stock-race` — ผู้ซื้อ 5 คนแข่งกันซื้อสินค้า stock=2, คาดว่าต้องมีผู้ชนะพอดี 2 คน
- `concurrent-gift-stock-race` — แข่งกันได้ของแถม stock=2
- `variant-stock-race` — แข่งกันซื้อ variant stock=2

### อ่านผลใน Dashboard

แต่ละ testcase แสดง:
- **PASSED / FAILED / SKIPPED / RUNNING** — สถานะ
- **ระยะเวลา** (ms)
- **รายละเอียด** (กดเปิด accordion)
- **Run log** — log แต่ละขั้น พร้อม request/response ที่ sanitize แล้ว
- **JSON** — download ผลของ testcase นั้นพร้อมรายละเอียดและ run log เป็น JSON

ปุ่ม **Export JSON** ด้านบนใช้ download ผลทั้งรอบ โดยมี report, test manifest, results และ logs ส่วน Raw JSON ของผลล่าสุดยังดูได้ที่ "Raw JSON" ด้านล่าง

### Trace Events (Server-side streaming)

ระหว่างรัน dashboard จะ poll `getQaIntegrationTraceEventsRpc` ทุก 1.2 วินาทีเพื่อดึง log จาก GAS server มาแสดงแบบ near-realtime ใน Run log

---

## 4. E2E Test (Playwright)

### สิ่งที่ต้องมี

- Node.js 18 ขึ้นไป
- Chromium (ติดตั้งผ่าน playwright)
- Google Apps Script Web App ที่ deploy แล้ว (ควรเป็น staging/test deployment ไม่ใช่ production)
- `integration-tests.gs` ติดตั้งใน GAS project เดิมแล้ว (E2E ใช้ fixture helpers จาก integration-tests)
- Admin session token (ดูวิธีได้จากหัวข้อด้านล่าง)

### ติดตั้ง (ครั้งแรก)

```powershell
cd QA\E2E
npm install
npx playwright install chromium
```

### ตั้งค่า

สร้างไฟล์ config ของเครื่องนี้:

```powershell
Copy-Item e2e.config.example.json e2e.config.local.json
```

แก้ `e2e.config.local.json`:

```json
{
  "baseUrl": "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  "adminToken": "PASTE_ADMIN_SESSION_V1_HERE",
  "gasRpcTimeoutMs": 120000,
  "fixtureVisibleTimeoutMs": 180000,
  "fixturePollMs": 3000,
  "swalTimeoutMs": 90000,
  "googleScriptTimeoutMs": 180000
}
```

> `e2e.config.local.json` ถูก ignore ใน `.gitignore` แล้ว — ไม่ต้อง commit

**วิธีหา `adminToken`:** เปิด browser ไปที่หน้า admin แล้ว login สำเร็จ จากนั้นเปิด DevTools → Application → Local Storage → ดูค่า key `ADMIN_SESSION_V1`

หรือจะ override ผ่าน env variable ก็ได้:

```powershell
$env:E2E_BASE_URL  = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
$env:E2E_ADMIN_TOKEN = "your-token-here"
```

### รัน

| คำสั่ง | ผล |
|---|---|
| `npm run e2e` | รันทุก spec ใน headless mode |
| `npm run e2e:mega` | รันเฉพาะ mega promotion/gift workflow |
| `npm run e2e:order-total` | รันเฉพาะ order-total promotion workflow |
| `npm run e2e:headed` | รันพร้อม browser เปิดให้เห็น |
| `npm run e2e:ui` | เปิด Playwright UI Mode (interactive, เลือก spec และดู trace) |
| `npm run e2e:report` | เปิด HTML report จากรอบที่รันล่าสุด |

### Test Specs ที่มี

#### `tests/checkout-warnings.spec.js`
ทดสอบ popup เตือนที่ปรากฏตอน checkout เมื่อสถานะสินค้าเปลี่ยนหลังจากใส่ตะกร้าแล้ว

| Scenario | เงื่อนไข | ผลที่คาดหวัง |
|---|---|---|
| `product-stock-zero-after-cart` | stock หมดหลังใส่ตะกร้า | warning "สินค้าหมด" |
| `product-stock-partial-after-cart` | stock เหลือน้อยกว่าที่สั่ง | เสนอให้ลดจำนวน |
| `gift-already-out-of-stock` | ของแถม stock=0 ตั้งแต่ต้น | แสดง warning และ order ยังสำเร็จ |
| `gift-stock-depleted-after-preview` | ของแถม stock หมดหลัง preview | warning block ก่อน checkout |
| `price-changed-after-cart` | ราคาสินค้าเปลี่ยนหลังใส่ตะกร้า | warning "ราคาเปลี่ยนแล้ว" |
| `promotion-ended-after-cart` | โปรโมชั่นหมดอายุหลังใส่ตะกร้า | warning "ราคาเปลี่ยนแล้ว" |
| `sale-not-active-after-cart` | ช่วง sale หมดอายุหลังใส่ตะกร้า | warning "สินค้าไม่พร้อมขาย" |

#### `tests/checkout-validation.spec.js`
ทดสอบ validation ฟอร์ม checkout (ก่อน submit)

| Test | ตรวจอะไร |
|---|---|
| missing customer name | ชื่อว่างต้อง highlight field + แสดง error |
| invalid phone format | เบอร์โทรผิดรูปแบบต้อง block |
| missing shipping address | ที่อยู่ว่างต้อง highlight |
| missing province | จังหวัดว่างต้อง block |
| missing postal code | รหัสไปรษณีย์ว่างต้อง block |
| unaccepted terms | ยังไม่ยอมรับเงื่อนไขต้องมีข้อความชัดเจน |

#### `tests/cart.spec.js`
ทดสอบ behavior ของตะกร้า

| Test | ตรวจอะไร |
|---|---|
| add product | เพิ่มสินค้าแล้ว badge และ list อัปเดต |
| increase quantity | เพิ่มจำนวนแล้วยอดรวมอัปเดต |
| remove last item | ลบสินค้าสุดท้ายแล้วตะกร้าว่าง |

#### `tests/product-variants.spec.js`
ทดสอบ variant selection UI

| Test | ตรวจอะไร |
|---|---|
| default option preselected | option แรกถูกเลือกอัตโนมัติ และนำเข้าตะกร้าถูกต้อง |
| switching option re-prices | เปลี่ยน option แล้วราคาใน detail view อัปเดต |

#### `tests/order-success.spec.js`
ทดสอบ happy path checkout สำเร็จ

| Test | ตรวจอะไร |
|---|---|
| success card + pay link | กด checkout สำเร็จ → แสดง success card มีลิงก์ชำระเงิน |
| double-click guard | ปุ่ม submit disable ขณะ request in-flight |

#### `tests/mega-promotion-gift.spec.js`

- checkout หก product lines ที่มี item/order-total promotions แข่งขันกันแปดรายการและ gift rules ห้ารายการ
- ตรวจ best-price/outpriced UI, gift multiplier, totals, success popup, token order view และ stock หลัง submit

#### `tests/promotion-order-total.spec.js`

- ตรวจ conditional fixed order-total discount ตั้งแต่ cart preview ถึง persisted order
- ยืนยันว่า unit price ไม่ถูกลดซ้ำ ส่วนลดหักครั้งเดียว และ total รวม shipping ถูกต้อง

### วิธีทำงานของ E2E Fixtures

ก่อน suite รัน → `e2eCleanupAllCheckoutWarningFixturesRpc()` ล้าง fixture เก่า `E2E-…` ที่ค้างไว้

spec ทั่วไปใช้ `e2ePrepareCheckoutWarningFixtureRpc(scenario)` ส่วน mega และ order-total ใช้ prepare/inspect/cleanup RPC เฉพาะของตน
ทุก flow สร้างข้อมูลเฉพาะ run แล้วรอ polling จนสินค้าขึ้นบนหน้าร้านจริงก่อนเริ่มกด UI

หลัง test → `afterEach` เรียก cleanup ลบ fixture ของรอบนั้น

เพราะฉะนั้น E2E tests ต้องใช้ GAS deployment ที่มี `integration-tests.gs` และต้องใช้ deployment ที่ไม่ใช่ production เพราะ fixture สร้าง/ลบข้อมูลจริง

### Timeout ที่ควรรู้

| ค่า | default | หมายความว่า |
|---|---|---|
| `gasRpcTimeoutMs` | 120,000 ms | รอ GAS RPC ตอบสูงสุด 2 นาที |
| `fixtureVisibleTimeoutMs` | 180,000 ms | รอสินค้า fixture ขึ้นหน้าร้านสูงสุด 3 นาที |
| `googleScriptTimeoutMs` | 180,000 ms | รอ google.script.run สูงสุด 3 นาที |

GAS อาจโหลดช้าหลัง deploy ใหม่ — timeout เหล่านี้ตั้งไว้เผื่อแล้ว

---

## สรุป: ใช้เครื่องมือไหนเมื่อไร

| สถานการณ์ | เครื่องมือ |
|---|---|
| แก้สูตรราคา/variant/quantity แล้วต้องการ feedback เร็ว | Unit (`npm --prefix QA/unit test`) |
| ต้องการรู้ว่าหน้าร้านรับ user กี่คนพร้อมกัน | Performance (`npm run step`) |
| แก้ backend แล้วอยากตรวจว่า logic ยังถูกต้อง | Integration (ผ่าน GAS Dashboard) |
| อยากตรวจว่า UI popup เตือน / form / cart ทำงานถูก | E2E (`npm run e2e`) |
| ก่อน deploy ทุกครั้ง (release gate) | Unit + Integration บน QA deployment + E2E |
| หลัง deploy ใหม่ | Integration smoke + E2E critical flow + Performance smoke |

---

## Troubleshooting

### Performance: `Config file not found`
→ ยังไม่ได้ copy `config.example.json` เป็น `config.json`

### Performance: `targetUrl must start with http://`
→ แก้ `targetUrl` ใน `config.json` ให้เป็น URL จริง

### Integration: `ต้องเปิด dashboard ผ่าน Apps Script HtmlService`
→ เปิด QA Web App ด้วย `?page=qa-integration` ไม่ใช่เปิด HTML file จาก disk โดยตรง

### Integration: testcase fail ทั้งหมดหลัง copy ไฟล์
→ ตรวจว่า `integration-tests.gs` อยู่ใน GAS project **เดียวกัน** กับ `code.gs` และ QA deployment ใช้ version ล่าสุด

### E2E: `e2e.config.local.json` ไม่มี
→ รัน `Copy-Item e2e.config.example.json e2e.config.local.json` แล้วใส่ค่าจริง

### E2E: fixture ไม่ขึ้นบนหน้าร้าน (timeout)
→ GAS snapshot cache อาจยังไม่ refresh — รอ 1-2 นาทีหลัง deploy แล้วลองใหม่ หรือรัน `adminResyncSnapshot` จาก admin panel ก่อน

### E2E: `AUTH_REQUIRED` ใน fixture setup
→ `adminToken` ใน `e2e.config.local.json` หมดอายุ — ล็อกอิน admin ใหม่แล้วดู token ใน localStorage อีกครั้ง

### E2E: `Integration-tests.gs` ฟังก์ชันไม่พบ
→ GAS project ยังไม่มี `integration-tests.gs` — copy เข้าไปตามขั้นตอนในหัวข้อ Integration ด้านบน
