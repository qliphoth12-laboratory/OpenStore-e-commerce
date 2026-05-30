# Open Storefront

A self-hosted e-commerce storefront that runs entirely on **Google Apps Script (GAS)**.
No build step, no package manager, no server to rent — the backend is a single Apps Script
Web App, data lives in Google Sheets, and product images live in Google Drive.

It includes a customer storefront, a full admin panel (products, orders, promotions, gifts,
shipping, payments, users), order tracking with multiple carriers, OTP-protected 2FA login,
and PDPA-style PII encryption.

> The UI is in **Thai**. Strings, toasts, and alerts are written in Thai by design.

## Features

- Storefront with cart, checkout, product variants, promotions, and free-gift campaigns
- Admin panels for products, orders, promotions, gifts, shipping carriers, payments, and users
- Customer order tracking via a private `?token=` link (no login required)
- Carrier tracking integration (AfterShip, Thailand Post, ETracking)
- Admin login with password hashing (PBKDF2) and optional email OTP 2FA
- Customer PII in the orders sheet is encrypted (HMAC-SHA256 keystream XOR cipher with authentication tag)
- PromptPay QR payment configuration

## Project Structure

The repository keeps source files under `System/` for organisation. GAS projects are flat,
so everything is copied into the same script project at deploy time.

| Path | Role |
|---|---|
| `System/Backend/code.gs` | Apps Script backend — RPC functions, routing, storage |
| `System/Backend/shipping.gs` | Carrier tracking module (AfterShip / Thailand Post / ETracking) |
| `System/Frontend/index.html` | Customer storefront |
| `System/Frontend/edit-store.html` | Storefront with live theme/appearance editor |
| `System/Frontend/product.html`, `order.html`, `promotion.html`, `gift.html`, `shipping-page.html`, `payment.html`, `user.html`, `system.html`, `legal.html`, `print-order.html` | Admin panels |
| `System/Frontend/order-view.html` | Customer order detail / slip upload (token access) |
| `System/Frontend/login.html` | Admin login + OTP 2FA |
| `System/Frontend/admin-shared.html` | Shared admin UI component (sidebar, topbar, helpers) |
| `System/Frontend/privacy-policy.html`, `term_and_service.html` | Public legal pages |
| `QA/` | Integration tests, E2E tests, and performance load-test tooling |
| `docs/` | Architecture and logging documentation |

## Setup

1. Create a new Google Apps Script project.
2. Copy `System/Backend/code.gs` into the project as a script file (you can name it anything, e.g. `backend`).
3. Copy `System/Backend/shipping.gs` into the project as a second script file.
4. Copy every file from `System/Frontend/` into the project as HTML files (keep the same names).
5. In **Project Settings → Script Properties**, set:
   - `SHEET_ID` — ID of a Google Sheet the app will use for data
   - `DRIVE_FOLDER_ID` — ID of a Drive folder for product/store images
   - *(optional)* `DATA_ENCRYPT_KEY` — key used to encrypt customer PII
   - *(optional carrier keys)* `AFTERSHIP_API_KEY`, `THP_STATIC_TOKEN`,
     `ETRACK_API_KEY`, `ETRACK_KEY_SECRET`
6. Deploy as a **Web App** (Execute as: you / Access: anyone).
7. Run `setupAll()` once from the Apps Script editor to create the sheets,
   the Drive folder, and the 1-minute sync trigger.
8. Open the Web App URL. On first visit, the login page redirects to a setup
   flow to create the first owner account.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the system is structured.

## Local Preview

You can open the `.html` files directly in a browser, but backend calls are stubbed
(`GAS.available = false`) — anything that needs the Apps Script backend will not work.

## QA

- `QA/Integration/` — integration test suite. Copy `integration-tests.gs` and
  `integration-dashboard.html` into the Apps Script project, then run
  `qaOpenIntegrationDashboard()` from the editor.
- `QA/performance/` — Node.js load test (Node 18+). Copy `config.example.json`
  to `config.json`, set your deployed Web App URL, then `npm install` and `npm run smoke`.
- `QA/E2E/` — Playwright Chromium E2E tests against a deployed Web App. Copy
  `e2e.config.example.json` to `e2e.config.local.json`, set your URL and admin token,
  then `npm install && npx playwright install chromium` and `npm run e2e`.

See [QA/Dev.md](QA/Dev.md) for the full QA guide.

## Activity logging (optional)

An optional best-effort activity log records auth, order, payment and admin
events as JSON Lines files in Drive `/log`. It is **off by default** — fresh
installs log nothing. The owner can enable it (and a separate third-party IP
observation sub-toggle) from the system settings page. See
[docs/LOGGING.md](docs/LOGGING.md) for details, privacy notes, and why
client-fetched IPs are not server-verified.

## Security

Never commit Script Property values, API keys, or `QA/performance/config.json`.

## License

[MIT](LICENSE)
