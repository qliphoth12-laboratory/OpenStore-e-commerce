# ระบบ Activity Log

เอกสารนี้อธิบายระบบ **traffic และ activity log แบบ best-effort** ของ Open Storefront ที่รันบน Google Apps Script (GAS) Web App
ระบบนี้บันทึกเหตุการณ์ด้าน authentication, order, payment, admin และ security เป็นไฟล์ JSON Lines ที่อ่านด้วยเครื่องได้ใน Google Drive

> **เป็น best-effort log ไม่ใช่ web server access log จริง**
> Google Apps Script ไม่เปิดเผย raw request metadata ให้ script code เช่น source IP, source port หรือ request headers
> ดังนั้นระบบนี้บันทึกได้เฉพาะข้อมูลที่ application สังเกตได้ในระดับ RPC เท่านั้น

## เปิดใช้ได้ตามต้องการ และปิดไว้เป็นค่าเริ่มต้น

Logging เป็นโหมด production logging ที่เลือกเปิดใช้ได้เอง การติดตั้งใหม่จาก open-source repo จะ **ไม่บันทึก log ใด ๆ**
จนกว่า owner จะเปิดใช้งานอย่างชัดเจน

| Toggle | Script Property | ค่าเริ่มต้น | ควบคุมอะไร |
|---|---|---|---|
| Logging | `LOGGING_ENABLED` | `false` (ปิด) | ระบบ log ทั้งหมด |
| IP observation | `LOG_IP_OBSERVATION` | `false` (ปิด) | การดึง public IP ผ่าน third-party provider เช่น ipify |

เปิด/ปิดได้จากหน้า **system.html -> ระบบบันทึก Log** เฉพาะ owner เท่านั้น
หรือจะตั้ง Script Property เป็น `'true'` โดยตรงก็ได้

`LOG_IP_OBSERVATION` เป็น sub-toggle แยกต่างหาก หมายความว่าเปิด logging ได้โดยไม่ต้องส่ง IP ของลูกค้าไปยัง third party

## Pipeline

```text
RPC / doGet  ->  enqueueLog_()  ->  chunked CacheService queue (LOGQ_*)
                                          |
                       tickSync (1 min) -> processLogQueue_()
                                          |
              freeze queue -> read parts -> group by UTC date
                                          |
        Drive /log/archive/YYYY-MM-DD/  ->  *.part-NNNNNN.jsonl.txt  (immutable)
                                        +   *.manifest.jsonl.txt     (SHA-256 index)
```

- `enqueueLog_()` อยู่บน hot path ของ request โดยสร้าง JSON 1 บรรทัด แล้ว append เข้า chunked buffer ใน `CacheService`
  ภายใต้ lock สั้น ๆ ประมาณ 300 ms ถ้าจับ lock ไม่ได้จะ drop event และเพิ่ม counter แทน
  จุดสำคัญคือ **ไม่มีการเขียน Drive บน request path**
- `processLogQueue_()` ทำงานจาก trigger เดิมคือ `tickSync` ไม่สร้าง trigger ใหม่ต่อ event
  function นี้จะ freeze queue โดยสลับ version ใหม่ แล้วเขียน batch ที่ freeze แล้วลง Drive เป็น immutable part files
- `cleanupLogArchive_()` ทำงานจาก `tickSync` เช่นกัน สูงสุดวันละครั้ง และย้าย folder archive ที่เก่ากว่า retention ไป Drive trash

## โครงสร้างไฟล์ใน Drive

```text
<DRIVE_FOLDER_ID>/log/
  archive/
    2026-05-18/
      2026-05-18.part-000001.jsonl.txt   <- immutable, written once
      2026-05-18.part-000002.jsonl.txt
      2026-05-18.manifest.jsonl.txt      <- one line per part: sha256, counts
  failed/
    failed-LOGW-xxxx.jsonl.txt           <- emergency spool เฉพาะกรณีเขียน Drive ล้มเหลว
```

- Part files ใช้นามสกุล `.jsonl.txt` เพื่อให้เปิดอ่านได้ง่ายใน text viewer และยังคงเป็น machine-readable
  โดย 1 บรรทัดคือ JSON object 1 record หรือ NDJSON
- Part files เป็น **immutable** หลังสร้างแล้วจะไม่ append เพิ่ม
- Manifest เป็น index รายวันขนาดเล็ก แต่ละบรรทัดเก็บข้อมูลของ part file เช่น
  `record_count`, `bytes`, `sha256`, `prev_part_sha256` และ `worker_run_id`

**Folder `/log` มีข้อมูลส่วนบุคคลและต้องเป็น private เท่านั้น ห้ามแชร์สาธารณะ**

## รูปแบบ Log Record

record ได้แรงบันดาลใจจาก ECS หรือ Elastic Common Schema โดย field สำคัญมีดังนี้

| Field | หมายเหตุ |
|---|---|
| `@timestamp`, `event.action`, `event.outcome` | เวลา / เหตุการณ์ / ผลลัพธ์ |
| `event.id` | sequential id เช่น `LOG-YYYYMMDD-NNNNNNNN` |
| `source.ip` / `source.port` / `source.mac` | **เป็น `null` เสมอ** ดูเหตุผลด้านล่าง |
| `client.ip` | มีเฉพาะเมื่อเปิด IP observation |
| `user.id_hash`, `session.id_hash` | hash ด้วย HMAC-SHA256 ไม่เก็บค่าจริง |
| `integrity.entry_hash` | SHA-256 ของ event content |
| `open_storefront` | route, rpc, hashed ids และ client context |

### ทำไม `source.ip`, `source.port`, `source.mac` ถึงเป็น `null`

Google Apps Script **ไม่ให้ script code เข้าถึง raw request metadata**
เช่น source IP, source port, request headers หรือ MAC address และไม่มี API สำหรับข้อมูลเหล่านี้

ดังนั้น field เหล่านี้จึงเป็น `null` เสมอ
ระบบจะไม่แกล้งบันทึกข้อมูลที่จริง ๆ แล้วมองไม่เห็น

### ทำไม `client.ip` ไม่ถือว่า server-verified

เมื่อเปิด IP observation browser ของลูกค้าหรือ admin จะ fetch public IP ของตัวเองจาก third-party provider เช่น ipify
แล้วส่งค่ากลับมาพร้อม RPC

server ไม่ได้เห็น IP นี้โดยตรง ผู้ใช้สามารถแก้ค่าได้ผ่าน DevTools หรือ crafted request
ดังนั้น log จะติด label ไว้ชัดเจนว่าเป็น client-fetched signal

```text
labels.network_source = "third_party_observed_client_fetched"
labels.ip_observer    = "ipify"
```

`client.ip` จึง **ไม่ใช่ IP ที่ server verify แล้ว**
ควรใช้เป็นสัญญาณประกอบแบบอ่อนเท่านั้น ไม่ควรใช้เป็นหลักฐานเดี่ยวหรือ security control หลัก

### `open_storefront.context_source`

field นี้บอกว่า client context มาจากที่ไหน

| Value | ความหมาย |
|---|---|
| `request` | context ถูกเก็บจากหน้าที่เรียก RPC นั้นโดยตรง เช่น login หรือ storefront checkout |
| `session_login` | context มาจาก session ของ admin ซึ่งถูกสังเกตตอน admin login ไม่ใช่ตอน action ปัจจุบัน |

admin mutation events เช่น `product.*`, `order.status.update`, `order.mark.shipped`,
`user.*`, `promotion.*`, `payment.config.update`, `key.rotate.*`
จะใช้ `context_source: session_login`

ค่า `client.ip` และ `user_agent` ของ event เหล่านี้จึงเป็นค่าที่เห็นตอน login
และจะคงเดิมตลอด session ระบบ **ไม่ได้เก็บ IP ราย action**

context ที่ trim แล้วอยู่ใน session cache อายุ 6 ชั่วโมงเท่านั้น และ **ไม่ถูกเขียนลง sheet**
ถ้า cache entry ถูก evict ก่อนเวลา ระบบจะ rebuild session โดยไม่มี context
event หลังจากนั้นอาจมี `client.ip = null` จนกว่า admin จะ login ใหม่

logging context เป็น metadata แบบ best-effort การไม่มี context จะไม่ block admin action

### `session.ip_changed`

บนทุก admin page load จะมี fire-and-forget beacon ผ่าน `reportSessionContextRpc`
เพื่อรายงาน client context ล่าสุด ถ้า client-reported IP ต่างจาก IP ที่เห็นตอน login
ระบบจะ emit event `session.ip_changed` พร้อม `meta.login_ip`, `meta.observed_ip` และ `outcome: unknown`

**event นี้เป็น audit signal แบบ best-effort เท่านั้น ไม่ใช่ security control**

เหตุผล:

- IP เป็นค่า client-fetched จาก ipify และ spoof ได้ถ้าผู้ใช้ถือ token อยู่
- admin ที่ถูกต้องอาจเปลี่ยน IP บ่อย เช่น mobile network, VPN, CGNAT
- event นี้จึง **ไม่ block, ไม่ challenge และไม่ logout** ผู้ใช้
- `meta.ip_observed` ถูกตั้งเป็น `client_fetched_unverified` เพื่อไม่ให้เข้าใจผิดว่าเป็น verified detection

event นี้จะเกิดประโยชน์เฉพาะเมื่อเปิด IP observation และทั้ง IP ตอน login กับ IP ปัจจุบัน fetch สำเร็จ

## Privacy และข้อมูลที่ไม่บันทึก

ข้อมูลที่ hash ด้วย HMAC-SHA256 โดยใช้ secret ต่อ installation (`LOG_HASH_SECRET`):

- user id
- email
- session token
- order id
- order token
- client id

ข้อมูลที่ **ไม่บันทึกเด็ดขาด**:

- password
- OTP
- session token หรือ order token แบบเต็ม
- PromptPay number แบบเต็ม
- slip file id
- customer PII แบบเต็ม เช่น ชื่อ เบอร์โทร ที่อยู่
- request payload แบบเต็ม

event แต่ละบรรทัดจำกัดขนาดประมาณ 4 KB
ถ้าใหญ่เกิน ระบบจะ truncate และตั้งค่า `open_storefront.truncated = true`

**Privacy Notice:** ถ้าเปิด IP observation ควรระบุใน Privacy Notice ของร้านว่าเว็บไซต์ใช้ third-party IP observation provider เช่น ipify
เพื่อสนับสนุน security logging, compliance และ debugging
สามารถแก้ข้อความประกาศได้จากหน้า admin `legal.html`

## Retention

- ค่า retention เริ่มต้นคือ **90 วัน** ผ่าน `LOG_RETENTION_DAYS`
- `cleanupLogArchive_()` จะย้าย folder `archive/YYYY-MM-DD` ที่เก่ากว่า retention ไป Drive trash
  การย้ายไป trash ยัง recover ได้ ไม่ใช่ hard delete
- `/log/failed` **ไม่ถูกล้างอัตโนมัติ** ควรตรวจและจัดการเองเป็นระยะ

## Performance

- log path ไม่อ่าน/เขียน Google Sheets
- ไม่มี Drive write ต่อ request
- ไม่มี Drive scan ต่อ request
- ไม่มี trigger ต่อ event
- `enqueueLog_()` ใช้ lock สั้น ๆ ประมาณ 300 ms และทำงานกับ `CacheService` ไม่กี่ operation
- การ flush ถูก throttle โดยปกติสูงสุดทุก 5 นาที หรือเร็วขึ้นถ้า queue เกินประมาณ 200 KB
- logging failure จะไม่กระทบ business logic เพราะ `enqueueLog_()` swallow error ทั้งหมด
  RPC หลักจะไม่ fail เพียงเพราะ logging ล้มเหลว

## การใช้งานและดูแลระบบ

- **เปิด/ปิด:** หน้า `system.html` -> ระบบบันทึก Log เฉพาะ owner เท่านั้น
- **Drop counter:** แสดงในหน้า `system.html` ถ้ามีค่ามากกว่า 0 หมายถึงมี event ถูก drop จาก lock contention หรือ peak load
  เป็นข้อมูลประกอบแบบ best-effort
- **Manual flush:** รัน `tickSync()` หรือ `processLogQueue_()` จาก GAS editor
- **Integrity check:** คำนวณ SHA-256 ของ part file อีกครั้ง แล้วเทียบกับ line ใน manifest

## ข้อควรระวังสำหรับนักพัฒนา

- ห้ามเพิ่ม password, OTP, full token, full PromptPay number หรือ customer PII แบบเต็มเข้า log
- ถ้าเพิ่ม event ใหม่ ให้เก็บเฉพาะ metadata ที่จำเป็นและ hash identifier ที่ sensitive
- อย่าทำ Drive write หรือ Sheet write ใน request hot path ของ logging
- ถ้าเพิ่ม third-party observation ใหม่ ต้องทำเป็น toggle แยกและอธิบาย privacy impact ให้ชัดเจน
- logging ต้องเป็น best-effort เสมอ และห้ามทำให้ order/payment/admin action ล้มเหลวเพราะ log เขียนไม่ได้
