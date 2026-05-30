# Activity Log System

A **best-effort traffic & activity log** for the Open Storefront Google Apps
Script (GAS) Web App. It records authentication, order, payment, admin and
security events as machine-readable JSON Lines files in Google Drive.

> **Best-effort, not a web server access log.** GAS does not expose raw request
> metadata to script code. This system logs what the application can observe at
> the RPC layer — it is not, and cannot be, a true network-level access log.

## Optional — off by default

Logging is an **optional production logging mode**. A fresh open-source install
logs **nothing** until the owner explicitly enables it.

| Toggle | Script Property | Default | Controls |
|---|---|---|---|
| Logging | `LOGGING_ENABLED` | `false` (off) | The whole log system |
| IP observation | `LOG_IP_OBSERVATION` | `false` (off) | Third-party IP lookup (ipify) |

Enable either from **system.html → ระบบบันทึก Log** (owner only) or by setting
the Script Property directly to `'true'`. IP observation is a **separate**
sub-toggle: logging can run without ever sending a customer IP to a third party.

## Pipeline

```
RPC / doGet  ->  enqueueLog_()  ->  chunked CacheService queue (LOGQ_*)
                                          |
                       tickSync (1 min) -> processLogQueue_()
                                          |
              freeze queue -> read parts -> group by UTC date
                                          |
        Drive /log/archive/YYYY-MM-DD/  ->  *.part-NNNNNN.jsonl.txt  (immutable)
                                        +   *.manifest.jsonl.txt     (SHA-256 index)
```

- `enqueueLog_()` is on the hot path: it builds one JSON line and appends it to a
  chunked CacheService buffer under a 300 ms lock. If the lock cannot be acquired
  it drops the event and bumps a counter — **no Drive write on the request path**.
- `processLogQueue_()` runs from the existing `tickSync` trigger (no new trigger).
  It freezes the queue (swaps in a new version), then writes the whole frozen
  batch to Drive as immutable part files.
- `cleanupLogArchive_()` also runs from `tickSync`, at most once per 24 h, and
  trashes archive day-folders older than 90 days.

## Drive layout

```
<DRIVE_FOLDER_ID>/log/
  archive/
    2026-05-18/
      2026-05-18.part-000001.jsonl.txt   <- immutable, written once
      2026-05-18.part-000002.jsonl.txt
      2026-05-18.manifest.jsonl.txt      <- one line per part: sha256, counts
  failed/
    failed-LOGW-xxxx.jsonl.txt           <- emergency spool (only on Drive failure)
```

- Part files use the `.jsonl.txt` extension so they open in any text viewer
  while staying machine-readable (one JSON object per line, NDJSON).
- Part files are **immutable** — never appended to after creation.
- The manifest is a small per-day index; each line carries the part's
  `record_count`, `bytes`, `sha256`, `prev_part_sha256` and `worker_run_id`.

**The `/log` folder holds personal data and must remain private.** Do not share
it publicly.

## Log record format

Records are ECS-inspired (Elastic Common Schema). Key fields:

| Field | Notes |
|---|---|
| `@timestamp`, `event.action`, `event.outcome` | when / what / result |
| `event.id` | sequential `LOG-YYYYMMDD-NNNNNNNN` |
| `source.ip` / `source.port` / `source.mac` | **always `null`** — see below |
| `client.ip` | only when IP observation is on — see below |
| `user.id_hash`, `session.id_hash` | HMAC-SHA256, never the raw value |
| `integrity.entry_hash` | SHA-256 of the event content |
| `open_storefront` | route, rpc, hashed ids, client context |

### Why `source.ip` / `source.port` / `source.mac` are null

Google Apps Script does **not** give script code access to raw request metadata
(source IP, source port, request headers, MAC address). There is no API for it.
These fields are therefore always `null` — the system never pretends to observe
something it cannot.

### Why `client.ip` is not "server-verified"

When IP observation is enabled, the **customer's browser** fetches its own public
IP from a third-party provider (ipify) and sends it back with the RPC. The server
never observes this IP directly — a user could alter it via DevTools or a crafted
request. It is therefore labelled:

```
labels.network_source = "third_party_observed_client_fetched"
labels.ip_observer    = "ipify"
```

It is **not** a server-verified IP. Treat it as a weak, advisory signal only.

### `open_storefront.context_source` — where the client context came from

| Value | Meaning |
|---|---|
| `request` | Context was collected by the page making this very RPC (login, storefront checkout). |
| `session_login` | Context was taken from the admin's session — observed when the admin **logged in**, not at the moment of this action. |

Admin mutation events (`product.*`, `order.status.update`, `order.mark.shipped`,
`user.*`, `promotion.*`, `payment.config.update`, `key.rotate.*`) carry
`context_source: session_login`. Their `client.ip` / `user_agent` are the values
seen at login and stay constant for the whole session — a per-action IP is **not**
collected. The trimmed context lives only in the 6 h session cache record and is
**never written to a sheet**; if the cache entry is evicted early the session is
rebuilt without it and later admin events fall back to `client.ip = null` until
the admin logs in again. Logging context is best-effort metadata — its absence
never blocks an admin action.

### `session.ip_changed` — advisory tripwire, **not** a security control

On each admin page load a fire-and-forget beacon (`reportSessionContextRpc`)
reports a fresh client context. If the client-reported IP differs from the one
seen at login, a `session.ip_changed` event is emitted with `meta.login_ip`,
`meta.observed_ip` and `outcome: unknown`.

**This is a best-effort audit signal only.** The IP is client-fetched (ipify) and
fully **spoofable** by anyone holding the token — an attacker simply replays the
victim's IP. It is also noisy: legitimate admins change IP often (mobile, VPN,
CGNAT). The event therefore **never blocks or challenges** any action, and
`meta.ip_observed` is hard-set to `client_fetched_unverified` so readers do not
mistake it for a verified detection. It only produces signal when IP observation
is enabled and both the login and current ipify fetches succeeded.

## Privacy & what is never logged

- Hashed (HMAC-SHA256, per-install secret `LOG_HASH_SECRET`): user id, email,
  session token, order id, order token, client id.
- **Never logged:** passwords, OTPs, full session/order tokens, full PromptPay
  numbers, slip file IDs, full customer PII (name, phone, address), full request
  payloads.
- Each event line is capped at ~4 KB; oversized events are truncated
  (`open_storefront.truncated = true`).

**Privacy Notice:** if you enable IP observation, your store's Privacy Notice
should disclose that the site uses a third-party IP observation provider (ipify)
to support security logging, compliance and debugging. Edit the notice via the
`legal.html` admin page.

## Retention

- Default retention: **90 days** (`LOG_RETENTION_DAYS`).
- `cleanupLogArchive_()` trashes `archive/YYYY-MM-DD` folders older than that
  (moved to Drive trash — recoverable, not hard-deleted).
- `/log/failed` is **not** auto-cleaned — review and clear it manually.

## Performance

- No Google Sheets in the log path. No Drive write per request. No Drive scan per
  request. No trigger per event.
- `enqueueLog_()` does a short (300 ms) lock + a couple of CacheService ops.
- Flushing is throttled: at most every 5 minutes, or sooner if the queue exceeds
  ~200 KB.
- Logging failures never propagate into business logic — `enqueueLog_()` swallows
  all errors. A business RPC never fails because logging failed.

## Operations

- **Enable/disable:** system.html → ระบบบันทึก Log (owner only).
- **Drop counter:** shown in system.html; a non-zero value means events were
  dropped under lock contention (peak load) — informational, best-effort.
- **Manual flush:** run `tickSync()` or `processLogQueue_()` from the GAS editor.
- **Integrity check:** re-compute SHA-256 of a part file and compare with its
  manifest line.
