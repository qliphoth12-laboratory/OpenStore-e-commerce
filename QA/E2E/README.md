# Chromium E2E Checkout Warnings

ชุดนี้เป็น Browser E2E ที่รันบน Chromium กับ deployed Google Apps Script Web App จริง โดย helper สำหรับสร้าง/แก้/ล้างข้อมูลทดสอบอยู่เฉพาะใน `QA/Integration/integration-tests.gs`

## เตรียม Apps Script

1. Copy หรือ deploy ไฟล์ `QA/Integration/integration-tests.gs` เข้า Apps Script project สำหรับ test deployment
2. Update deployment ของ Web App ให้ใช้โค้ดล่าสุด
3. อย่า copy ไฟล์ integration test นี้เข้า production deployment

## ติดตั้งครั้งแรก

```powershell
cd QA\e2e
npm install
npx playwright install chromium
```

## ตั้งค่า URL

แนะนำให้ใช้ไฟล์ local config:

```powershell
Copy-Item e2e.config.example.json e2e.config.local.json
```

จากนั้นแก้ `e2e.config.local.json`:

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

ไฟล์ `e2e.config.local.json` ถูกใส่ใน `.gitignore` แล้ว จึงใช้เก็บ URL test deployment ของเครื่องนี้ได้

`adminToken` คือค่าจาก localStorage key `ADMIN_SESSION_V1` หลังจาก login หน้า admin สำเร็จแล้ว ใช้เพื่อให้ integration helper ตรวจสิทธิ์ก่อนสร้าง/แก้/ล้าง fixture ทดสอบ

ถ้าต้องการ override ชั่วคราว ยังใช้ env ได้เหมือนเดิม:

```powershell
$env:E2E_BASE_URL="https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
$env:E2E_ADMIN_TOKEN="PASTE_ADMIN_SESSION_V1_HERE"
```

ค่า env จะชนะค่าในไฟล์ config

Apps Script อาจโหลดช้าได้ โดยเฉพาะตอนเพิ่ง update deployment หรือ rebuild snapshot ค่า timeout ด้านบนจึงตั้งไว้เผื่อไว้แล้ว ระบบจะรอได้สูงสุด 3 นาที แต่ถ้าพร้อมก่อนก็เริ่มทดสอบทันที

## รันเทส

```powershell
npm run e2e
npm run e2e:headed
npm run e2e:ui
```

ค่า default รันเฉพาะ Chromium desktop, `workers=1`, เก็บ trace และ screenshot เฉพาะตอน fail

## Scenarios

- `product-stock-zero-after-cart`
- `product-stock-partial-after-cart`
- `gift-already-out-of-stock`
- `gift-stock-depleted-after-preview`
- `price-changed-after-cart`
- `promotion-ended-after-cart`
- `sale-not-active-after-cart`
- `happy-path` — สินค้าพร้อมขายปกติ สต็อกเยอะ ไม่มี gift/promo/variant (ใช้กับ validation, cart, success)
- `happy-path-variants` — สินค้าพร้อมขาย มีกลุ่มตัวเลือก "ขนาด" (S / M) สำหรับทดสอบ variant

ทุก test จะเรียก cleanup ใน `afterEach` เพื่อลบ order/product/gift/promotion/shipping ของ fixture run นั้น

## Test specs

- `tests/checkout-warnings.spec.js` — popup เตือนตอน checkout: สต็อก/ราคา/โปรโมชัน/ของแถม/ช่วงการขาย (areas 5–7)
- `tests/checkout-validation.spec.js` — ตรวจฟอร์ม checkout: ชื่อ/เบอร์โทร/ที่อยู่/จังหวัด/รหัสไปรษณีย์/เงื่อนไข (area 4)
- `tests/cart.spec.js` — ตะกร้า: เพิ่มสินค้า · เพิ่มจำนวน · ลบสินค้า → ตะกร้าว่าง (area 3)
- `tests/product-variants.spec.js` — ตัวเลือกสินค้า: ตัวเลือกเริ่มต้นถูกเลือก + เปลี่ยนตัวเลือกแล้วราคาปรับ (area 2/3)
- `tests/order-success.spec.js` — สั่งซื้อสำเร็จ: การ์ดสำเร็จ + ลิงก์ชำระเงิน · ปุ่มถูก disable ระหว่างส่ง (area 9/10)

## ยังไม่ครอบคลุม (แนะนำให้เพิ่มภายหลัง)

- **โหลดรายการสินค้าล้มเหลว (area 1)** — รายการสินค้าถูก server-render ฝังมากับหน้า (`#server-cfg`)
  จึงจำลอง popup error ตอนโหลดผ่าน fixture ไม่ได้ ทดสอบได้เฉพาะสถานะ empty ("ยังไม่มีสินค้าในขณะนี้")
- **จัดส่งแบบแยกพัสดุ (area 8)** — ต้องมี fixture สินค้า 2 ชิ้น + วิธีจัดส่ง 2 แบบ (ขยาย backend เพิ่ม)
  หมายเหตุ: ปัจจุบัน frontend แสดงข้อความ `SHIPPING_INVALID` แบบรวม ไม่ได้โชว์ `message` ละเอียด
  ที่ backend ส่งกลับ (เช่น "มีสินค้าที่ยังไม่ได้กำหนดวิธีจัดส่ง") — เป็นจุดที่ควรปรับปรุงใน production ภายหลัง

ก่อนเริ่ม suite จะเรียก `e2eCleanupAllCheckoutWarningFixturesRpc()` ในไฟล์ integration test เพื่อล้าง fixture `E2E-...` ที่ค้างจากรอบก่อน จากนั้นแต่ละ test จะเรียก `e2ePrepareCheckoutWarningFixtureRpc()` เพื่อสร้างสินค้าทดสอบเองและรอจนสินค้าขึ้นบนหน้าร้านจริงก่อนเริ่มกด UI
