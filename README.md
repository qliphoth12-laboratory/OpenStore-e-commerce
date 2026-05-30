# Open Storefront

Open Storefront คือระบบหน้าร้านอีคอมเมิร์ซแบบ self-hosted ที่ทำงานบน **Google Apps Script (GAS)** ทั้งระบบ
ไม่ต้อง build โปรเจกต์ ไม่ต้องใช้ package manager และไม่ต้องเช่า server เพิ่ม โดย backend เป็น Apps Script Web App เพียงตัวเดียว
ข้อมูลจัดเก็บใน Google Sheets และรูปสินค้าเก็บใน Google Drive

ระบบมาพร้อมหน้าร้านสำหรับลูกค้า แผงจัดการหลังบ้านแบบครบชุด เช่น สินค้า คำสั่งซื้อ โปรโมชัน ของแถม การจัดส่ง การชำระเงิน และผู้ใช้
รองรับการติดตามคำสั่งซื้อกับหลายขนส่ง การเข้าสู่ระบบแบบ 2FA ด้วย OTP ทางอีเมล และการเข้ารหัสข้อมูลส่วนบุคคลตามแนวทาง PDPA

> UI ของระบบเป็น **ภาษาไทย** โดยข้อความ ปุ่ม toast และ alert ถูกออกแบบให้ใช้ภาษาไทยเป็นหลัก

## คู่มือการใช้งาน

เปิดคู่มือ PDF ได้ที่ [คู่มือการใช้งาน Open Storefront.pdf](<คู่มือการใช้งาน Open Storefront.pdf>)

## คุณสมบัติหลัก

- หน้าร้านพร้อมตะกร้าสินค้า checkout ตัวเลือกสินค้า โปรโมชัน และแคมเปญของแถม
- แผงจัดการหลังบ้านสำหรับสินค้า คำสั่งซื้อ โปรโมชัน ของแถม ขนส่ง การชำระเงิน และผู้ใช้
- หน้าติดตามคำสั่งซื้อสำหรับลูกค้าผ่านลิงก์ส่วนตัวแบบ `?token=` โดยไม่ต้องเข้าสู่ระบบ
- รองรับการเชื่อมต่อสถานะขนส่ง เช่น AfterShip, Thailand Post และ ETracking
- ระบบเข้าสู่ระบบผู้ดูแลด้วยการ hash รหัสผ่านแบบ PBKDF2 และเลือกเปิดใช้ OTP 2FA ทางอีเมลได้
- เข้ารหัสข้อมูลส่วนบุคคลของลูกค้าในชีตคำสั่งซื้อด้วย HMAC-SHA256 keystream XOR cipher พร้อม authentication tag
- ตั้งค่าการชำระเงินผ่าน PromptPay QR ได้

## โครงสร้างโปรเจกต์

ไฟล์ source หลักถูกจัดไว้ใต้โฟลเดอร์ `System/` เพื่อให้อ่านง่าย แต่โปรเจกต์ GAS จะทำงานในรูปแบบไฟล์แบน
ดังนั้นตอนนำไป deploy จะต้องคัดลอกไฟล์ทั้งหมดเข้าไปอยู่ใน Apps Script project เดียวกัน

| Path | หน้าที่ |
|---|---|
| `System/Backend/code.gs` | Backend ของ Apps Script เช่น RPC functions, routing และ storage |
| `System/Backend/shipping.gs` | โมดูลติดตามขนส่ง เช่น AfterShip / Thailand Post / ETracking |
| `System/Frontend/index.html` | หน้าร้านสำหรับลูกค้า |
| `System/Frontend/edit-store.html` | หน้าร้านพร้อมตัวแก้ไขธีม/หน้าตาแบบ live editor |
| `System/Frontend/product.html`, `order.html`, `promotion.html`, `gift.html`, `shipping-page.html`, `payment.html`, `user.html`, `system.html`, `legal.html`, `print-order.html` | หน้าจัดการหลังบ้าน |
| `System/Frontend/order-view.html` | หน้ารายละเอียดคำสั่งซื้อ/อัปโหลดสลิปของลูกค้า ผ่าน token access |
| `System/Frontend/login.html` | หน้าเข้าสู่ระบบผู้ดูแลและ OTP 2FA |
| `System/Frontend/admin-shared.html` | ส่วน UI กลางของหลังบ้าน เช่น sidebar, topbar และ helper ต่าง ๆ |
| `System/Frontend/privacy-policy.html`, `term_and_service.html` | หน้าเอกสารทางกฎหมายสำหรับผู้ใช้ทั่วไป |
| `QA/` | ชุดทดสอบ integration, E2E และเครื่องมือ load test ด้าน performance |
| `docs/` | เอกสาร architecture และ logging |

## การติดตั้ง

1. สร้าง Google Apps Script project ใหม่
2. คัดลอก `System/Backend/code.gs` เข้าไปใน project เป็นไฟล์ script หนึ่งไฟล์ โดยตั้งชื่ออะไรก็ได้ เช่น `backend`
3. คัดลอก `System/Backend/shipping.gs` เข้าไปเป็นไฟล์ script อีกหนึ่งไฟล์
4. คัดลอกไฟล์ทั้งหมดจาก `System/Frontend/` เข้าไปเป็นไฟล์ HTML โดยคงชื่อไฟล์เดิมไว้
5. ไปที่ **Project Settings -> Script Properties** แล้วตั้งค่า:
   - `SHEET_ID` คือ ID ของ Google Sheet ที่ระบบจะใช้เก็บข้อมูล
   - `DRIVE_FOLDER_ID` คือ ID ของ Google Drive folder สำหรับเก็บรูปสินค้า/รูปหน้าร้าน
   - *(ไม่บังคับ)* `DATA_ENCRYPT_KEY` คือ key สำหรับเข้ารหัสข้อมูลส่วนบุคคลของลูกค้า
   - *(ไม่บังคับ สำหรับขนส่ง)* `AFTERSHIP_API_KEY`, `THP_STATIC_TOKEN`, `ETRACK_API_KEY`, `ETRACK_KEY_SECRET`
6. Deploy เป็น **Web App** โดยตั้งค่า Execute as: you และ Access: anyone
7. เรียกใช้ `setupAll()` หนึ่งครั้งจาก Apps Script editor เพื่อสร้างชีต โฟลเดอร์ Drive และ trigger sync ทุก 1 นาที
8. เปิด Web App URL ครั้งแรก ระบบจะพาไปยังขั้นตอนตั้งค่าเพื่อสร้างบัญชี owner คนแรก

อ่านโครงสร้างระบบเพิ่มเติมได้ที่ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## การพรีวิวในเครื่อง

สามารถเปิดไฟล์ `.html` ใน browser ได้โดยตรง แต่ backend calls จะเป็น stub (`GAS.available = false`)
ดังนั้นฟีเจอร์ที่ต้องเรียก Apps Script backend จะยังไม่ทำงานในการเปิดไฟล์แบบ local

## QA

- `QA/Integration/` คือชุดทดสอบ integration ให้คัดลอก `integration-tests.gs` และ `integration-dashboard.html`
  เข้า Apps Script project แล้วเรียก `qaOpenIntegrationDashboard()` จาก editor
- `QA/performance/` คือ Node.js load test สำหรับ Node 18+ ให้คัดลอก `config.example.json`
  เป็น `config.json` ตั้งค่า deployed Web App URL จากนั้นรัน `npm install` และ `npm run smoke`
- `QA/E2E/` คือ Playwright Chromium E2E tests สำหรับทดสอบกับ deployed Web App ให้คัดลอก
  `e2e.config.example.json` เป็น `e2e.config.local.json` แล้วตั้งค่า URL และ admin token
  จากนั้นรัน `npm install && npx playwright install chromium` และ `npm run e2e`

อ่านคู่มือ QA แบบเต็มได้ที่ [QA/Dev.md](QA/Dev.md)

## Activity logging (ไม่บังคับ)

ระบบมี activity log แบบ best-effort สำหรับบันทึกเหตุการณ์ เช่น auth, order, payment และ admin events
เป็นไฟล์ JSON Lines ใน Drive `/log` โดยค่าเริ่มต้นจะ **ปิดอยู่** ทำให้การติดตั้งใหม่จะยังไม่บันทึก log ใด ๆ
เจ้าของระบบสามารถเปิดใช้งานได้จากหน้าตั้งค่าระบบ รวมถึง sub-toggle สำหรับการสังเกต IP จาก third-party แยกต่างหาก
อ่านรายละเอียด บันทึกด้าน privacy และเหตุผลที่ client-fetched IPs ไม่ถูก server-verified ได้ที่ [docs/LOGGING.md](docs/LOGGING.md)

## ความปลอดภัย

ห้าม commit ค่า Script Property, API keys หรือไฟล์ `QA/performance/config.json`

## License

[MIT](LICENSE)
