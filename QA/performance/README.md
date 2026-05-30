# Performance Test สำหรับหน้า Storefront

โฟลเดอร์นี้เป็นเครื่องมือทดสอบ performance ของหน้า `index.html` / storefront ที่ deploy ผ่าน Google Apps Script Web App แล้ว โดยเน้น Phase แรกเป็นการยิง `GET` หน้าเว็บเท่านั้น เพื่อวัดแบบคร่าว ๆ ว่าระบบยังตอบสนองได้ดีถึงผู้ใช้พร้อมกันประมาณกี่คน

เครื่องมือนี้ไม่แก้ business logic ของร้านค้า และไม่ส่งคำสั่ง checkout หรือสร้าง order จริง

## สิ่งที่ต้องมี

- Node.js 18 ขึ้นไป
- Google Apps Script Web App URL ที่ deploy แล้ว เช่น `https://script.google.com/macros/s/.../exec`

สคริปต์นี้ไม่ใช้ dependency ภายนอก จึงติดตั้งง่ายและลดปัญหาสภาพแวดล้อม

## ตั้งค่า

คัดลอกไฟล์ตัวอย่าง:

```powershell
cd performance
Copy-Item config.example.json config.json
```

เปิด `config.json` แล้วแก้ค่าหลัก:

```json
{
  "targetUrl": "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  "pagePath": "",
  "queryParams": {
    "page": "index"
  },
  "concurrentUsers": 5,
  "durationSeconds": 30,
  "rampUpSeconds": 10,
  "requestTimeoutMs": 15000
}
```

ความหมายของ config:

| ค่า | ความหมาย |
| --- | --- |
| `targetUrl` | URL ของ Google Apps Script Web App ที่ deploy แล้ว |
| `pagePath` | path เพิ่มเติมถ้ามี ปกติ Apps Script มักปล่อยว่างได้ |
| `queryParams` | query parameter สำหรับเปิดหน้า index/storefront เช่น `{ "page": "index" }` |
| `mode` | โหมดที่ต้องการ เช่น `smoke`, `light`, `medium`, `heavy`, `step` |
| `concurrentUsers` | จำนวนผู้ใช้พร้อมกันสำหรับ test ปกติ |
| `durationSeconds` | ระยะเวลาทดสอบต่อรอบ |
| `rampUpSeconds` | ระยะเวลาค่อย ๆ เพิ่มผู้ใช้จนถึงจำนวนที่กำหนด |
| `requestTimeoutMs` | timeout ต่อ request |
| `outputFile` | path ของรายงาน ถ้าเว้นว่างจะสร้างใน `results/report-YYYYMMDD-HHMM.md` |
| `thresholds.maxErrorRatePercent` | error rate ที่ถือว่าเริ่มมีปัญหา |
| `thresholds.maxP95Ms` | p95 response time ที่ถือว่าเริ่มช้า |

## วิธีรัน

ติดตั้ง/ตรวจ package:

```powershell
cd performance
npm install
```

รันตาม config:

```powershell
npm run test
```

หรือเลือก preset:

```powershell
npm run smoke
npm run light
npm run medium
npm run heavy
npm run step
```

รันด้วย Node ตรง ๆ:

```powershell
node run-performance-test.js --config config.json --preset smoke
node run-performance-test.js --config config.json --preset step
```

override ค่าบางอย่างโดยไม่แก้ไฟล์ config:

```powershell
node run-performance-test.js --config config.json --users 10 --duration 60 --ramp-up 20
```

## โหมดทดสอบ

| โหมด | เหมาะกับ | ค่าเริ่มต้น |
| --- | --- | --- |
| Smoke test | เช็คว่า URL ใช้งานได้และไม่พังทันที | 5 users, 30 วินาที |
| Light load | โหลดเบา ใกล้การใช้งานจริงช่วงเริ่มต้น | 25 users, 60 วินาที |
| Medium load | โหลดระดับกลาง | 50 users, 90 วินาที |
| Heavy load | โหลดสูง ควรใช้ด้วยความระวัง | 100 users, 120 วินาที |
| Step test | เพิ่มผู้ใช้ทีละขั้นเพื่อหาจุดเริ่มมีปัญหา | เริ่ม 5 แล้วเพิ่มทีละ 10 ถึง 100 users |

สำหรับ Google Apps Script ควรเริ่มจาก `smoke` แล้วค่อยไป `light` และ `step` แบบระวัง อย่าเริ่มจาก `heavy` ทันที

## Metrics ที่เก็บ

รายงานจะเก็บข้อมูลหลักเหล่านี้:

- total requests
- successful requests
- failed requests
- average response time
- p50 / p95 / p99 response time
- min / max response time
- requests per second
- error rate
- HTTP status code breakdown
- จำนวน concurrent users ที่ทดสอบ
- ข้อสรุปว่าเริ่มมีปัญหาที่ user ประมาณกี่คน

รายงาน Markdown จะถูกสร้างที่:

```text
performance/results/report-YYYYMMDD-HHMM.md
```

และมี raw data เป็น JSON คู่กัน:

```text
performance/results/report-YYYYMMDD-HHMM.json
```

## วิธีอ่านผล

ให้ดู 3 ค่าเป็นหลัก:

| ค่า | วิธีอ่าน |
| --- | --- |
| `p95 response time` | ถ้าสูง แปลว่าผู้ใช้บางส่วนเริ่มรอนาน แม้ค่าเฉลี่ยอาจยังดูดี |
| `error rate` | ถ้าเกิน 5% ควรถือว่าเริ่มมีปัญหา |
| `HTTP status code` | ถ้ามี 429, 503, timeout หรือ network error มากขึ้น อาจติด quota/rate limit |

วิธีสรุปว่า "รองรับได้กี่ user พร้อมกัน":

1. รัน `npm run smoke` เพื่อเช็คว่า URL ถูกต้อง
2. รัน `npm run light`
3. รัน `npm run step`
4. ดูระดับสูงสุดที่ยังผ่าน threshold เช่น error rate ไม่เกิน 5% และ p95 ไม่เกิน 3000 ms
5. ใช้ระดับก่อนหน้าจุดที่เริ่ม fail เป็นค่าประมาณที่ปลอดภัยกว่า

ตัวอย่าง: ถ้า step test ผ่านที่ 45 users แต่เริ่ม error สูงที่ 55 users ให้สรุปแบบระวังว่า storefront รองรับได้ประมาณ 45 users พร้อมกันภายใต้เงื่อนไขการทดสอบนี้

## คำเตือนเรื่อง Google Apps Script quota

- การยิง load test ใส่ Google Apps Script จริงอาจติด quota หรือ rate limit
- ควรเริ่มจากจำนวน user ต่ำก่อนเสมอ
- ห้ามยิงหนักเกินไปโดยไม่จำเป็น โดยเฉพาะ `heavy` หรือ `step` ที่ตั้ง `maxUsers` สูง
- ผลลัพธ์เป็นค่าประมาณ ไม่ใช่ตัวเลข absolute 100%
- Apps Script ไม่เหมาะกับ load test หนักมากแบบ production server
- หลังทดสอบควรตรวจ Apps Script executions, error log, quota และ response จากฝั่ง Google ด้วย

## ความปลอดภัยของข้อมูลร้านค้า

Phase แรกนี้สคริปต์ใช้ HTTP `GET` เท่านั้น และไม่มี payload สำหรับสร้าง order หรือ checkout

ถ้าในอนาคตต้องทดสอบ RPC, checkout, หรือ action ที่เขียนข้อมูล ควรแยกเป็น optional script ใหม่ ปิดไว้โดย default และต้องยิงเข้า test environment เท่านั้น

## ปรับ threshold

แก้ใน `config.json`:

```json
{
  "thresholds": {
    "maxErrorRatePercent": 5,
    "maxP95Ms": 3000
  }
}
```

ถ้าหน้า storefront มีงานหนักโดยธรรมชาติ อาจตั้ง p95 เป็น 5000 ms ได้ แต่สำหรับ UX ร้านค้าทั่วไป p95 เกิน 3 วินาทีควรเริ่มตรวจสอบแล้ว

## ตัวอย่าง config สำหรับ step test แบบเบา

```json
{
  "targetUrl": "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  "queryParams": {
    "page": "index"
  },
  "mode": "step",
  "requestTimeoutMs": 15000,
  "thresholds": {
    "maxErrorRatePercent": 5,
    "maxP95Ms": 3000
  },
  "stepTest": {
    "startUsers": 5,
    "stepUsers": 5,
    "maxUsers": 50,
    "durationSeconds": 30,
    "rampUpSeconds": 10,
    "cooldownSeconds": 10
  }
}
```
