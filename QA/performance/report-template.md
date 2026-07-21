# Performance Test Report

> ไฟล์นี้เป็น template อ้างอิงสำหรับ Open Storefront `v1.1.0` รายงานจริงจะถูกสร้างใน `QA/performance/results/report-YYYYMMDD-HHMM.md`

## สรุป

- URL ที่ทดสอบ:
- System version / deployment:
- Git commit หรือ release tag:
- วันที่ทดสอบ:
- รูปแบบทดสอบ:
- จำนวนผู้ใช้พร้อมกัน:
- ระยะเวลาทดสอบ:
- ข้อสรุปโดยประมาณ:

## Metrics

| Metric | Value |
| --- | ---: |
| Total requests | |
| Successful requests | |
| Failed requests | |
| Requests/sec | |
| Average response time | |
| p50 | |
| p95 | |
| p99 | |
| Min | |
| Max | |
| Error rate | |

## HTTP Status Code

| Status | Count |
| --- | ---: |

## ข้อจำกัด

- เป็นการยิง GET หน้า storefront/index เท่านั้น
- ผลลัพธ์เป็นค่าประมาณ และขึ้นกับ quota/rate limit ของ Google Apps Script
- ไม่ได้จำลอง browser จริงทั้งหมด เช่น การ render, cache, และ network condition ของผู้ใช้จริง

## คำแนะนำ

- เริ่มจาก smoke/light ก่อน แล้วค่อยเพิ่มโหลด
- ถ้า error rate สูงหรือ p95 สูงขึ้นมาก ให้หยุดเพิ่มโหลด
- ตรวจ Google Apps Script quota และ log หลังทดสอบทุกครั้ง
