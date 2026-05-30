# Architecture

## Overview

- **Frontend**: plain HTML/CSS/JS files served by the Apps Script Web App. No
  framework, no build step.
- **Backend**: `backend.gs` (+ `shipping.gs`) running as a GAS Web App.
- **Storage**: Google Sheets for structured data, Google Drive for images.
- **Caching**: `CacheService` holds a product snapshot, refreshed every minute
  by the `tickSync` trigger or on demand when the Sheet changes.

## Request flow

`doGet(e)` routes by `pathInfo` or the `?page=` query parameter and serves the
matching HTML file. It injects server config and the product snapshot into a
`<script id="server-cfg">` tag so the page renders without an extra round-trip.

The client calls the backend through `callRpc(method, ...args)`, a thin wrapper
around `google.script.run`. Every RPC returns `{ ok: true, ... }` or
`{ ok: false, error: '...' }`; clients check `.ok` before using the result.

## Data model (Google Sheets)

| Sheet | Holds |
|---|---|
| `product` | Products, variants, stock |
| `orders` | Customer orders (PII fields encrypted) |
| `promotions` | Discount promotions |
| `gift_items`, `gift_rules` | Free-gift catalog and rules |
| `shipping` | Carrier companies and rate tiers |
| `payment` | Payment configuration (PromptPay, etc.) |
| `store` | Store images and site config |
| `users` | Admin accounts (PBKDF2 password hashes) |

## Subsystems

- **Promotions** — fixed/percent discounts targeting all products, a product, or
  a specific variant. Status (active/scheduled/expired/disabled) is computed
  dynamically. Applied prices are injected into the product snapshot.
- **Gifts** — gift items + rules; eligible gifts are previewed in the cart and
  committed onto the order as line items with `line_type: 'gift'`.
- **Orders** — each order gets a random access token for the customer order
  view. Status changes are logged in `status_history_json`.
- **Carrier tracking** (`shipping.gs`) — AfterShip, Thailand Post, and ETracking
  providers normalized to a single `TrackingResult` shape.
- **Auth** — admin login with PBKDF2 hashing and optional email OTP 2FA;
  session tokens stored in `CacheService`.

## Admin UI

All admin pages include `admin-shared.html`, which provides the sidebar, topbar,
HUD toast, and shared helpers (`callRpc`, `showHUD`/`hideHUD`, auth, pagination).

For the full RPC reference and section-by-section file map, see `CLAUDE.md`.
