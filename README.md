# NexiUP · 2.1.1

**[راهنمای کامل فارسی](README_FA.md)** · [Research and original-bot inventory](docs/RESEARCH.md) · [Verification](docs/VERIFICATION.md) · [Licenses](THIRD_PARTY.md)

A single-file Telegram subscription-sales hub and **original Nahan-users-API-compatible node** for Cloudflare Workers + D1. Receipt approval provisions an account automatically. Paid and test accounts get one main-domain subscription URL, a locally generated PNG QR, and an authenticated, per-configuration Telegram fallback.

> **Important scope and license decision:** this is not a verbatim Nahan fork. The inspected Nahan README claims MIT but its LICENSE is missing; a named ancestor reports GPL-2.0. No Nahan/edgetunnel source or HTML is copied into this MIT project. The node is an independent compatible implementation with an original integrated web control panel. Full upstream UI/feature parity is not claimed. See **Design decisions** and `THIRD_PARTY.md`.
>
> **Deployment status:** implemented and locally tested, not certified for production. No live Telegram bot, Cloudflare account deployment, Iranian mobile connection, or Android/iOS/Windows GUI import was tested here. Free-plan feasibility depends on measured CPU, requests, D1 writes and actual workload—not just script size.

> **New in 2.1:** fix JavaScript type diagnostics; open `/admin` for secure web administration and country-organized ProxyIP import/testing/apply/rollback. Recommended web secret: `WEB_ADMIN_KEY`; fallback rules and first login are in §8. No pre-verified production IP inventory is bundled.

> **Get the correct file:** this revision is on branch **`arena/4a2b629b-nexiup`**: [open its `worker.js`](https://github.com/ArsalanAfshar/NexiUP/blob/arena/4a2b629b-nexiup/worker.js). **Main is intentionally unchanged.** Do not assume a default-branch download contains 2.1.1; check the file/version and the deployed `/health` marker.

## Deployed error 1101 — patch 2.1.1

A successful local run does **not** rule out a hosted failure. Cloudflare documents 1101 for uncaught JavaScript exceptions and requests that cannot finish; it is not automatically evidence of a missing migration. The account-specific cause reported for 2.1.0 has **not** been established: no hosted exception, stack or deployment access was available.

This patch fixes reproduced uncaught paths: runtime/binding initialization before the request's `try`, and an error handler that itself threw on `null`/`undefined` rejections. Binding access is now lazy and validated, unknown rejections are handled safely, and D1 service failures are no longer all labelled as missing migrations.

**Upgrade in place; do not recreate the database:**

1. Back up D1, replace the **entire** `worker.js` with **2.1.1**, and deploy the active Worker version. Keep the existing D1 binding, secrets, routes and identities. All five migration groups are unchanged from 2.1.0.
2. Open **`/health`** on the affected Worker origin. Expect `version:"2.1.1"`, `status:"alive"`, `database_checked:false` and `X-NexiUP-Version: 2.1.1`. This checks the active handler, **not** D1, Telegram, node connectivity or production readiness. `/`, `/admin` and `/setup` also open without touching D1.
3. Open **`/setup` → Check deployment — read only**. Use `SETUP_KEY` on hub/all or `MASTER_KEY` on node; a configured `WEB_ADMIN_KEY` also grants this **read-only** action, not the setup mutation actions. The same authenticated API is `POST /setup` with `{"action":"diagnostics"}`. No keys belong in the URL.

| Result | Meaning / safe next action |
|---|---|
| `d1_binding_missing` / `d1_binding_invalid` / `d1_binding_unavailable` | Binding `DB` is absent, not D1-shaped, or could not be acquired. Inspect the **active deployment's** binding; a text variable containing a database ID is not a D1 binding. |
| `d1_unavailable` | A D1 operation failed. Do not assume migrations or database recreation will fix it. Check service/account status and the safe error reference. |
| `d1_read_timeout` | A read/preflight exceeded its 8-second wall-time deadline. It is not a successful readiness check. |
| Schema `migration_required` / `seed_required` | Use authenticated **Initialize D1** against the existing database until `ready:true`; never delete it to initialize. |
| Schema `incomplete` / `newer_than_worker` / `invalid_version` | Existing schema metadata is inconsistent or belongs to another Worker version. Preserve/export data and review the matching code/schema; do not reset or blindly downgrade. |
| Configuration check `false` | Only that minimum environment check failed. Even all checks passing does **not** verify external credentials, Telegram, routing, proxies or ISP reachability. |

The preflight runs at most **four guarded SELECT statements**, bypasses the readiness cache, has an **8-second total deadline**, and performs **no writes, seeding or external requests**. SELECT reads have individual 8-second deadlines too; these do not cancel D1 execution. Mutating operations are deliberately **not** wrapped in a blanket timeout or automatic retry that could report failure while a payment/provisioning write later commits.

**If an error remains:** 5xx errors caught by the request boundary include safe `version`/`request_id` fields and matching headers; the web login displays the reference. Temporarily set the text variable **`NEXIUP_DIAGNOSTICS="true"`**, deploy it, then use **Workers & Pages → Worker → Logs → Live** and reproduce the failing request. NexiUP emits only `event:"nexiup_runtime_error"`, version, random request ID, fixed surface/error code and optional numeric `worker.js` line/column. It never logs the exception message/full stack, URL, headers, keys, SQL, receipt or configuration. Handled errors may have an `ok` invocation outcome despite an HTTP 5xx; find the console record, not only the uncaught-exception filter. Turn the flag off afterwards. Full Cloudflare live-log events can still contain request URLs/headers: **do not publish the whole event**; extract only the safe NexiUP record. Line numbers refer to the deployed source or bundle.

If even `/health` still returns Cloudflare's 1101 page without the new version marker, investigate the active version/route and the platform's exception; JavaScript request catches cannot intercept module-instantiation/platform failures or replace a response already sent. Keep only the exception type, numeric source position, time and Ray ID when sharing platform evidence; redact URLs, credentials and payloads. This patch is not a claim that the unidentified hosted incident has been resolved. [Evidence and reproduced checks](docs/VERIFICATION.md).

## 1. What is included

- Persian by default, selectable English, private-chat operation and first-use Terms acceptance.
- Germany/USA catalog, real numeric daily/total traffic limits, validity, connection limit and integer prices. Location labels are **not proof of exit geography**.
- Multiple card-transfer/other manual-payment instructions; photo/document/reference receipts; approve/reject with reason; full/split wallet payments; cancellation/refunds; configurable payment timeout.
- Wallet top-ups/bonus, withdrawals, adjustments and an idempotent ledger; referral commissions; first-order offers; fixed/percentage coupons with durable global/per-user reservations.
- Automatic account creation, safe node failover, renewal, usage lookup and subscription history. A paid order is retained on provisioning failure.
- A designated automatic-test node, configurable quotas/validity/cooldown, durable grants, history and audited cooldown resets.
- Independent, versioned operator profiles: Irancell/other networks and Hamrah-e Aval; both owner-supplied ECH resolvers produce separate entries under the **same account identity**.
- Main-domain aggregation from stored node base configurations; profile changes update existing subscription responses without changing the URL or deploying code.
- Actual QR PNGs without an external QR service; exact text URL in the photo caption; **«باز نشد؟ کانفیگ‌ها ارسال شوند»** sends actual complete Xray configurations, one per plain-text message when they fit.
- Telegram admin menus for nodes, profiles, tests, plans, payments, guides, channels, coupons, texts, settings, users, subscriptions, orders, operations/recovery, withdrawals, broadcasts, statistics, usage, diagnostics, audit and backups.
- Forced-channel membership (up to three), membership tracking/bot-permission checks, support tickets/replies, direct messages and forwarded-user quick replies when Telegram exposes the sender ID.
- Segmented cursor-based broadcasts, 3-day/1-day/expired reminders, hourly opportunity for a daily report, audit and bounded cleanup.
- Responsive Persian/English owner web administration with real business/node actions, protected receipts, validated editors, profile rollback and audit.
- Persistent country-organized ProxyIP catalog; opt-in public import, bounded native TCP/TLS/trace checks, explicit fallback application and rollback. Source claims, external reports and measured exits remain distinct.
- Node VLESS/Trojan over TLS WebSocket/TCP, optional DNS-only UDP, multiple users, total/daily caps, expiry, per-isolate connection limits, clean IPs, per-user relay/host overrides, kill switch, dashboard, subscription information page, static camouflage and configuration backup/restore.

The inventory of the original bot and its security defects is in `docs/RESEARCH.md`. Useful workflows were reimplemented; unsafe optional auth, manual account issuance, misleading availability claims and race-prone wallet logic were not retained. Existing v1 data migration has explicit boundaries in §18.

## 2. Architecture

```text
Customer / Admin
       │ Telegram webhook (secret header)
       ▼
NexiUP hub ───────────── D1: users, ledger, orders, jobs, profiles, nodes
       │                         │
       │ HTTPS + node API key    └─ one cron: provisioning / delivery / upkeep
       ├──────── Node DE ── its D1 ── VLESS/Trojan TCP
       ├──────── Node US ── its D1 ── VLESS/Trojan TCP
       └──────── Test node ─ its D1 ─ test accounts

Client ─ HTTPS main-domain /sub/<random-token>
       └─ all enabled representable operator variants, same UUID/account

ROLE=all: hub + one local node; provisioning calls the node functions
          in-process, without an HTTP self-fetch.
```

`ROLE=hub`: bot and main subscription domain. `ROLE=node`: panel/tunnels, no Telegram webhook. `ROLE=all` (default): both. Remote nodes still use HTTPS in `all`; only a registry entry explicitly marked `local:true` uses in-process calls. Only one local registry entry is allowed, preventing double-counting the same local capacity.

Use a separate D1 per Worker, except that `all` naturally shares its one binding. Nodes do not need a cron. Creating more Workers in one account does **not** multiply account-wide Free allowances.

## 3. Requirements

- Cloudflare Workers and D1; an HTTPS Worker origin or correctly routed custom domain.
- A Telegram bot from `@BotFather`, your numeric Telegram user ID, and independent random secrets from a password manager.
- For remote nodes, a **node-specific panel API key**, never the node master key.
- Owner-supplied bank/owner details, prices, intended node endpoints and network settings. None are seeded as live deployment values.
- A compatible, sufficiently recent Xray client for all advanced operator settings. Read §12 before promising compatibility.
- Optional: Node **22.13+** for tests (`node:sqlite` is experimental in Node 22); Wrangler for CLI deployment. No Node or npm dependency runs in the Worker. No build step is required.

Use must comply with Cloudflare Terms and local law. The software is educational and provided **without warranty**. Review any service-specific proxy restrictions before deploying; this project does not represent Cloudflare permission or an availability guarantee.

## 4. Verified Cloudflare Free limits

Verified **2026-10-20** against live official documentation. Workers limits were last updated October 12. [1](https://developers.cloudflare.com/workers/platform/limits/) Pricing includes Workers/KV/D1. [2](https://developers.cloudflare.com/workers/platform/pricing/) D1 has its own stricter query ceiling. [9](https://developers.cloudflare.com/d1/platform/limits/)

| Resource | Published Free limit | NexiUP discipline / remaining risk |
|---|---:|---|
| Worker requests | 100,000/day **per account**, resets 00:00 UTC | Webhooks, not polling; one cron. Public traffic/abuse still counts. Monitor rather than promise it cannot be exceeded. |
| HTTP and cron CPU | 10 ms/invocation | Small bounded jobs; cached configuration; fixed-mask QR; no heavy per-packet crypto. **Production CPU is unmeasured.** |
| Memory | 128 MB/isolate | ≤64 accepted WebSockets/isolate, ≤1 MiB upstream queue/socket, bounded bodies, ≤100 node accounts; real memory must still be monitored. |
| External subrequests | 50/invocation | Runtime guard at 40; ≤2 creation candidates per attempt; redirects disabled; no recursive Telegram retry. |
| Internal-service subrequests | 1,000/invocation | Not a substitute for D1's stricter 50-query limit. |
| D1 statements | 50/invocation | Runtime guard at 46, counting each batch statement; staged migrations and paginated jobs. Long tunnels close before exhausting their budget. |
| Simultaneous outgoing connections | 6/invocation | Node attempts and Telegram deliveries are sequential; no large `Promise.all` fan-out. |
| Script size | **64 MiB uncompressed; no compressed-size limit** | Dry-run bundle approximately **518 KiB**, gzip approximately **174 KiB**. The old 3 MB compressed estimate is no longer the published limit. Exact measurements: `docs/VERIFICATION.md`. |
| Startup | 1 second | No startup I/O; local workerd startup succeeded. Production startup timing not measured. |
| Cron triggers | 5/account | One on the hub/all Worker; none required on nodes. |
| Workers | 100/account | Registry does not bypass this or account-wide quotas. |
| Env values / size | 64/Worker, 5 KB each | Secrets referenced by name, operational values in D1. Leave room for each node key. |
| D1 reads / writes | 5M rows read/day; 100k written/day/account | Indexed lookups, bounded lists, batched usage. **Index updates also count.** There is no assertion that all workloads fit. |
| D1 storage | 10 databases; 500 MB/database; 5 GB/account | Receipt `file_id`s rather than images; retention and D1 exports. Audit/financial history needs operator retention planning. |
| D1 row / parameters | 2 MB/row; 100 bound parameters/query | Input limits, small per-record statements; no unbounded JSON blobs of all users. |
| D1 recovery | 7-day Free Time Travel | Additional private exports recommended. |
| KV | 100k reads/day; 1k writes/deletes/lists/day; 1 GB; 1 write/sec/key | **Not used.** No KV binding or paid add-on is required. |

Further official details: https://developers.cloudflare.com/d1/platform/pricing/ and https://developers.cloudflare.com/kv/platform/limits/.

**Usage writes are the likely constraint.** At a 30-second flush interval, a continuously busy isolate has up to 2,880 flush opportunities/day. Roughly `(1 batch row + U active usage rows) × 2,880 × busy isolates`, **plus indexes and bot writes**, can exhaust 100k writes quickly. This is a planning expression, not a measured guarantee. Raising `usage_flush_seconds` reduces writes but increases persistence/limit lag. There are no per-frame database writes.

## 5. Dashboard-only deployment — exact first three steps

1. **Create D1:** Cloudflare → Storage & databases → D1 → Create database. Use a new database for an initial installation; export an existing v1 database before an upgrade.
2. **Create the Worker and bind it:** Workers & Pages → Create application/Worker → Edit code → paste the **entire `worker.js`** → Deploy. Add a **D1 binding named exactly `DB`**. Set compatibility date `2026-10-20` and flag `global_fetch_strictly_public`.
3. **Set role, identity and secrets:** Settings → Variables and Secrets. Set `ROLE` and `ADMIN_IDS` for hub/all. Add the required secrets from §6: `BOT_TOKEN`, `WEBHOOK_SECRET`, `CALLBACK_SECRET`, `SETUP_KEY`; add `MASTER_KEY` for node/all. Save/deploy the settings. Never paste secrets into Telegram, Git, a URL query or these examples.

Then:

4. Open `https://<YOUR_WORKER_HOST>/setup`. GET only serves a form; it performs no privileged operation. Enter `SETUP_KEY` (hub/all) or `MASTER_KEY` (node) in the password field. Press **Initialize D1**. The UI makes separate authenticated POSTs: five migration groups, then seed/ready. Wait for `ready:true`. Do not use `?key=...`.
5. On hub/all, enter the **main HTTPS origin**, without a path, and press **Save main origin**. This is the domain encoded in all new QR/text links. Configure its actual routing before use. Do not change this origin casually: old-domain URLs cannot redirect themselves after the old domain stops serving the Worker.
6. On hub/all press **Register webhook**. This calls Telegram `setWebhook` with `secret_token`, `max_connections:4`, supported updates and no dropped pending updates; it registers commands and saves the bot username. Send `/start` and accept Terms. `/language` offers Persian/English.
7. Add **one cron** on hub/all: `* * * * *`. Do not add the same cron to node-only Workers. Without it, automatic queued delivery/provisioning/upkeep does not progress unless an administrator uses the protected setup “process next” buttons.
8. Open **`/admin`** for the web panel (see §8), or use the Telegram admin menu. Complete configuration and issue a test purchase before enabling real sales.

### Optional Wrangler

`wrangler.toml` contains no credentials. Replace `database_id` with your actual D1 ID, choose your role, and supply secrets with `wrangler secret put NAME` or the dashboard. Do not deploy the placeholder ID.

```sh
node --check worker.js
npm test
npx wrangler deploy --dry-run
# Only after configuring your real bindings/secrets:
npx wrangler deploy
```

Wrangler is optional development tooling, not a runtime dependency. Disable its development telemetry if desired with `WRANGLER_SEND_METRICS=false`. `nodejs_compat` is not needed.

## 6. Exact environment, secrets and bindings

| Name | Kind | Roles | Meaning |
|---|---|---|---|
| `DB` | D1 binding | All | The Worker's database. No `KV`, `IOT_DB`, R2, Queue or Durable Object binding is required. |
| `NEXIUP_DIAGNOSTICS` | Optional text variable | All | Off by default (`"false"`). Exact text `"true"` enables sanitized application exception events; no raw error/URL/secret logging. Turn off after investigation. |
| `ROLE` | Variable | All | `hub`, `node`, or `all` (default). |
| `ADMIN_IDS` | Variable or Secret | hub/all | Comma-separated positive numeric **private-user** IDs; up to five recipients. Owner IDs cannot be removed by Telegram admins. |
| `BOT_TOKEN` | Secret | hub/all | Token obtained from BotFather. |
| `WEBHOOK_SECRET` | Secret | hub/all | 32–256 random characters; Telegram-supported letters/digits/underscore/hyphen. Mandatory. |
| `CALLBACK_SECRET` | Secret | hub/all | Separate 32–256-character random HMAC secret. Rotation invalidates old buttons; customers can reopen `/start`. |
| `SETUP_KEY` | Secret | hub/all | Separate 32–256-character setup Bearer credential. |
| `WEB_ADMIN_KEY` | Secret | All, recommended | Separate 32–256-character owner credential for `/admin`. If absent, uses `SETUP_KEY` on hub/all or `MASTER_KEY` on node. A weak present value fails closed. |
| `MASTER_KEY` | Secret | node/all | 32–256 random characters. No default `admin`, recovery URL or database-stored master key. Required before serving a node. |
| `NODE_KEY_<NAME>` | Secret(s) | hub and corresponding node | On NexiUP nodes: separate 32–256-character panel keys. Register each reference in the node panel; give the hub its own copy in a Secret. Stock Nahan's generated shorter `nahan_*` keys are accepted only for stock adapters, with their upstream security limitations. |
| `CF_ACCOUNT_ID` | Variable | hub/all, optional | Your real Cloudflare account ID for usage estimates. |
| `CF_API_TOKEN` | Secret | hub/all, optional | Least-privileged account analytics-read token; no deployment rights needed. |

There is **no** implicit `NODE_API_KEY`, `MAIN_DOMAIN`, `HOST` or legacy `WORKER_ROLE`. Hub-to-node requests never fall back to a master key; this is separate from the explicit owner web-login fallback above. Main URL, node URLs, test settings, payment details and profiles are D1 settings edited without source changes. Worker Secret installation/rotation itself is a Cloudflare settings action, not something the Telegram bot can securely perform for you.

## 7. D1, migrations, caching and idempotency

`schema_version` tracks five idempotent migration groups using `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`. Each protected setup call applies one group in a transactional batch; the final call seeds settings and profiles. Migration five adds hashed web sessions, ProxyIP catalog/import jobs, diagnostic budgets and policies; the first four shipped groups are unchanged. Tables use the `nx_` prefix. Legacy bot tables and stock `kv_store` are not overwritten. Upgrades run the same protected initializer. Uninitialized public/tunnel requests fail closed rather than executing DDL on the hot path.

D1 stores users, settings, catalog, orders, ledger, withdrawals, coupon reservations, nodes, operations, subscriptions, test slots/grants, locks, action rate limits, profiles/revisions, audit, conversations, webhook deduplication, delivery jobs, support, membership, broadcasts, panel accounts/keys/request receipts, usage and flush receipts. Monetary updates use conditional SQL, unique ledger keys and SQLite triggers inside `batch` transactions; the wallet is an auditable single-user balance ledger, **not an accounting-grade double-entry system**.

- One durable test slot per Telegram user prevents parallel bypass. A pending request is not cleared by a cooldown reset.
- Stable operation IDs, persisted random account names, unique local identities, per-operation/per-node D1 leases and remote reconciliation prevent blind duplicate provisioning.
- Stock Nahan has no transactional idempotent create API. Its node writes are serialized and spaced by 11 seconds to exceed the inspected 10-second config-cache TTL. **All other stock-node writers must be stopped.** An ambiguous mutation quarantines that node from other hub operations until reconciled. It is not treated as permission to create elsewhere.
- Settings/profile caches are scoped to the binding and expire after **15 seconds**; local saves invalidate them immediately. HTTP subscription responses are `no-store`. Client applications have their own refresh interval; the advertised update interval is one hour, and manual refresh may be needed.
- Webhook updates are claimed durably and completed after processing. Notifications use a durable outbox/cursor. Telegram lacks a send-message idempotency key: a crash after Telegram accepts a message but before cursor persistence can produce a duplicate **message**, not a second account or wallet credit.
- There is no per-configuration tunnel identity. Every operator variant shares the same UUID/password and entitlement.

## 8. First-time admin setup and editing

Send `/admin` in a private bot chat as an owner ID. Add any extra admins from **Users → user → Grant admin**; only configured owners can grant/revoke these admins. Every privileged callback and conversation continuation checks current authorization.

The **Telegram** editors intentionally use validated JSON rather than dozens of brittle text wizards:

1. Select a record under Nodes / Profiles / Plans / Settings, or **New**.
2. Copy the displayed JSON, edit values, and send the complete object. Unknown fields, bad ranges and invalid structures are rejected. Use a JSON document when the object is too large for a Telegram message.
3. Review the validated preview, then **Save and apply**. No active profile is replaced before confirmation. Disabling uses `enabled:false`, preserving historical references.
4. Use **Roll back** on a profile to restore its previous schema-valid revision as a new, monotonically increasing version. “Known-good” here means **validated schema**, not a claim of a successful mobile-network test.

Bot settings include main origin, support, currency, announcement, maintenance, order hours, referral percentage, first-order discount, top-up bonus, minimum amounts, maximum pending orders, report hour, Terms and platform import guides in both languages. Text overrides cover welcome/main/support/payment/test/approved/rejected messages; `{name}` and `{brand}` are supported. Limits/prices are appended from stored numeric data, not inferred from marketing prose.

### Web administration (2.1)

Open **`https://<YOUR_WORKER_HOST>/admin`** on your own deployed Worker. This is the new integrated control panel, not just the older node JSON editor.

1. Recommended: create a separate random **`WEB_ADMIN_KEY`** Worker Secret (32–256 characters). If it is **absent**, login uses `SETUP_KEY` on `hub`/`all`, or `MASTER_KEY` on `node`. A present but weak/empty `WEB_ADMIN_KEY` fails closed; it does not fall back. Never put a key in a URL.
2. Sign in over HTTPS. Authenticated login advances any pending migration groups and final seeding. Wait for initialization to finish. Web login does not register the Telegram webhook or add a Cloudflare cron: complete §5 as well.
3. Use the language switch for Persian RTL / English LTR. The interface, icons and Persian font are embedded in the single Worker; no UI framework, CDN, remote HTML/font or runtime package is required. Small-screen tables scroll horizontally.
4. Select **Edit → Validate → Save and apply**. The server validates again. Form and advanced-JSON modes share the same underlying validators; active profiles/settings/catalog records use revision checks. Profile rollback creates a new version without changing subscription URLs.

| Role | Web controls |
|---|---|
| `hub` | Overview and seven-day sales, nodes/health, operator profiles, plans/payment methods/guides/channels/coupons/texts, bot/test settings, orders/receipt review, subscriptions, customers/wallet adjustments/bans/cooldown reset, provisioning queue/recovery, audit and ProxyIP discovery/policies. |
| `node` | Local account CRUD, limits/expiry/reset/pause, node settings, environment-backed API-key registration/revocation, local statistics/audit and ProxyIP discovery/fallback. No hub financial or Telegram-admin endpoints. |
| `all` | Both sets. A local record still has to be explicitly configured for in-process provisioning. |

**Orders → Provisioning queue and recovery** filters queued, creating, ready, completed, failed and reconciliation-required operations. Recovery never creates an arbitrary replacement identity after an ambiguous mutation. Receipt files are fetched through an authenticated endpoint; list responses do not expose Telegram file tokens. Wallet writes and account creation use idempotency keys. Destructive actions require confirmation. Support conversations, broadcasts, withdrawal review and additional Telegram-admin delegation remain in the existing Telegram workflow; full upstream-UI or every-bot-screen web parity is not claimed.

The web login is **owner-level**, not a customer login or a delegated Telegram-staff login. A node's hub-facing panel key cannot log in as the web owner. Owner sessions last **30 minutes**; the browser receives a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie, while D1 stores its hash and credential fingerprint. No key/token is written to browser localStorage/sessionStorage. Cookie mutations require an exact same Origin plus a session-bound CSRF header. Logout, key rotation and role changes invalidate sessions; at most 16 unexpired sessions are retained. Brute-force protection is per isolate, not a replacement for an account-level WAF/rate policy. Production framing is denied.

Web endpoints use **`/admin/web-api/…`**, separately from the Nahan-compatible `/<api_route>/api/…`. This deliberately preserves existing nodes whose custom `api_route` is `admin`, including `/admin/api/users`, `/admin/dash`, `/admin/ws` and `/admin?sub=…`. Automation can use a Bearer owner key; browser authentication does not weaken node panel/master separation. Keep keys distinct, including `WEB_ADMIN_KEY` and `SETUP_KEY` versus hub-facing node keys.

**Settings → This node → Node backup and legacy tools** opens the retained `/<api_route>/dash` tools. They require a separate **master-key** sign-in; web cookies are not silently converted into legacy master credentials. Telegram/D1 backups in §17 remain available.

The development-only `tests/preview.mjs` uses disposable synthetic data and visibly labels the simulation. `PREVIEW_AUTO_LOGIN=1` is an explicit opt-in **in that Node wrapper only**; it is not a Worker backdoor. The wrapper disables networking diagnostics and relaxes framing for the preview. Neither behavior is in production `worker.js`. Never deploy the preview wrapper or use its TEST-NET addresses as real proxies.

## 9. Adding, editing and testing nodes

### NexiUP node

1. Deploy `ROLE=node`, bind its D1 and set a fresh `MASTER_KEY`. Initialize `/setup`; open `/<api_route>/dash` (initial route `sync`).
2. In Cloudflare add a distinct Secret named, for example, `NODE_KEY_DE`. This is a **reference name**, not a provided credential.
3. In the node dashboard **Keys**, submit `{"name":"hub","secret_ref":"NODE_KEY_DE"}`. Registration requires the master key but does not reveal it or the panel-key value. The same operation is `POST /<route>/api/keys`; keys can be revoked with DELETE `?id=`.
4. In the hub's Cloudflare settings add the matching panel key as a Secret. In Telegram → Nodes → New fill the exact object below using **your** endpoint, route and reference. No secret value goes into D1/Telegram.

```json
{
  "id": "de-primary",
  "code": "de",
  "label": "Germany sales",
  "base_url": "https://<YOUR_NODE_HOST>",
  "api_route": "sync",
  "api_key_ref": "NODE_KEY_DE",
  "max_users": 10,
  "enabled": false,
  "purpose": "sales",
  "adapter": "nexiup",
  "local": false
}
```

The hostname is an explicitly non-runnable placeholder. Preview/save, test the API, then enable. USA uses `code:"us"`. A dedicated test node uses `purpose:"test"`, a unique ID and an administrator-chosen code such as `test`. IDs/labels are local registry metadata, not assumed exit IPs.

For `all`, set `local:true`, use the actual same Worker origin, `adapter:"nexiup"`, and an empty `api_key_ref`. Calls stay in-process. A sales local node is used for tests only if explicitly selected with `allow_sales_node:true`.

### Stock Nahan node

Choose `adapter:"nahan"`, `local:false`. Create a panel API key on that node, put it in a hub Secret and reference it. **Never use its master key.** The hub cannot remotely prove a long supplied string is not another server's master key; credential scope remains an operator responsibility. Short upstream `nahan_*` tokens are less robust than NexiUP keys; prefer NexiUP nodes for stronger idempotency/storage.

Harden a stock node first: replace its default master, disable upstream auto-update/remote deployment and stop other bot/linked-panel configuration writers.

The users API uses GET list / GET `?id=`, POST create, PUT `?id=`, DELETE `?id=`, and POST `?id=&action=toggle|reset`, with `Authorization: Bearer …`. Create fields use actual `trafficLimit`, `dailyLimit`, `expiryDays`, `notes`, `connLimit`, `maxConfigs`. NexiUP also supports per-user `proxyIp`, `cleanIp`, `userNodes`, `userPanelUrl`, `userMode` and `userPorts`, plus exact `expiryMs` and `isPaused` on its own node. Names are unique and restricted to 1–64 ASCII letters/digits/underscore/hyphen. The compatible node subscription route treats the name as a bearer credential: use the hub-generated random names, not predictable human names, when creating directly through the panel/API.

NexiUP's keys-registration contract deliberately references Worker Secrets rather than returning database-stored credentials. Arbitrary upstream `seg*`, `nat64`, custom-routing/cascade/deploy fields are **not** silently accepted by the independent node API. Global operator profiles provide the required masks/ECH instead. Stock base subscriptions must be TLS WebSocket VLESS/Trojan with the same actual account UUID; unsupported parameters or >4 distinct base entries fail explicitly. Turn off upstream fake ECH (`pbk=enabled`) before using the hub's real profiles.

Assignment chooses the lowest hub load/capacity ratio among enabled nodes with the **exact** selected sales location/purpose, then checks remote account count. It attempts at most two candidates; only preflight/definite non-mutating failures may fail over. At ≥80% capacity an admin notification is queued. Existing endpoint/location identity cannot be silently changed when it has accounts: add a new node for migration. Disabling a node stops new assignment, not existing customer delivery.

**Test node** checks authenticated API access. NexiUP stats can report `request.cf.colo` as the **Cloudflare edge**, not the tunnel exit. The stats field `request_country` is the requester’s country, not the edge/exit country. Proxy exit IP/country is explicitly “not verified”; the hub's own egress IP is never presented as the node exit. Verify exit location using an actually connected client and a trusted IP-check service.

## 10. Plans, payment instructions and customer flow

Plans require `id`, `name`, `description`, `days`, `daily_gb`, `total_gb`, `conn_limit`, `price`, `locations`, `enabled`, `reset_usage`, `max_configs`. These are numeric enforcement inputs. `0` for a traffic/connection cap means no cap at that **plan** level, not exemption from platform limits. Example editor defaults are disabled until reviewed. No live bank card, crypto address or purchasable sample plan is seeded.

Under Payments add a name, bank card/account/owner details, instructions and enabled state. Multiple bank/crypto methods from the original workflow remain possible; an administrator still verifies the transfer. A receipt reference is not proof of settlement.

Screenshots-as-text:

```text
/start → Terms [Accept] → Buy subscription → Germany / USA
→ Plan: duration + daily/total caps + per-isolate connection limit + price
→ Invoice [Wallet] [Split] [Payment methods] [Coupon] [Cancel]
→ Card/owner + exact remaining amount → receipt photo

Admin: receipt + order/amount [Approve] [Reject with reason]
Approve → pending → processing → queued provisioning → done
Customer: [QR image]
          https://<MAIN_HOST>/sub/<RANDOM_TOKEN>  (same photo caption)
          [باز نشد؟ کانفیگ‌ها ارسال شوند]
          limits + expiry + platform guide
```

Unpaid `pending_payment` orders expire after `order_hours` (default 2), with the wallet portion refunded once. Submitted receipts and paid/processing orders are **not** automatically discarded. Manual-bank refunds require human support; the bot does not pretend to reverse a bank transfer.

First-order offers and coupon uses are durable reservations; cancellations do not automatically restore coupon/first-offer availability. This conservative anti-abuse decision must be reflected in your Terms. Wallet top-ups and withdrawals do not count as subscription revenue. Referral credits are unique per completed paid order.

## 11. Automatic test subscriptions

Defaults: **1 GB in Nahan's API (=1 GiB, 1,073,741,824 bytes)** total, **1 GiB/day**, **1 day**, **48 hours between successful grants**. Tests are initially **disabled** until the admin designates a node.

Telegram → Test settings:

```json
{
  "enabled": false,
  "traffic_gb": 1,
  "daily_gb": 1,
  "days": 1,
  "cooldown_hours": 48,
  "node_id": "",
  "allow_sales_node": false
}
```

Select an actual enabled test node, adjust any field, preview and save. No code deployment is needed. Test accounts use a fixed one-connection-per-isolate cap. To intentionally reuse a sales node, select its ID and explicitly set `allow_sales_node:true`; there is no implicit sales-node fallback.

```text
Customer: Get test configuration
→ durable per-user slot + unique operation/account name
→ designated node account created automatically
→ successful issuance recorded → cooldown begins
→ same main-domain URL / PNG QR / actual-config fallback as paid accounts
```

A known failure creates a failed grant record but consumes **no** cooldown. An uncertain remote result retains the pending slot while reconciling, rather than permitting another potentially duplicate grant. In Test history inspect node/status/time/error code. Test settings → Reset cooldown, or Users → user → Reset cooldown, clears the next-success deadline and writes an audit event; it never cancels an in-flight issuance.

## 12. Operator profiles and compatibility

The initial default set has three enabled entries per base transport: **one Irancell/other variant plus two Hamrah-e Aval variants**. A separate **standard profile is disabled by default** for clients that cannot express the advanced fields. All entries use the same customer account and limits; there are no per-operator duplicate entitlements.

### Irancell and other networks

Editable defaults: `fingerprint:"unsafe"`, this `finalmask`, and the complete `cipher_suites` string below. The tutorial's example URI says `fp=chrome`; this implementation uses the stated `unsafe` setting because the inspected Xray parser explicitly accepts it. Certificate verification remains enabled (`allowInsecure:false`). This does **not** mean every GUI/URI importer supports it.

```json
{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","lengths":["0","104","1"],"delays":["0"],"maxSplit":"0"}},{"type":"fragment","settings":{"packets":"1-1","lengths":["114","1"],"delays":["1"],"maxSplit":"11"}}]}
```

```text
TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256
```

Validation rejects unknown shapes, unsupported fingerprints/cipher names, descending/negative ranges, excess entries, and a last fragment length with minimum zero. Limits: ≤4 TCP masks, ≤8 lengths/delays per mask, delay/maxSplit bounds 1000, lengths ≤65535, finalmask JSON ≤1600 characters, cipher list ≤1800 bytes. These are implementation safety bounds, not network-performance advice.

### Hamrah-e Aval

`fingerprint:"chrome"`, ECH selection initially **both**:

- `cloudflare-ech.com+udp://1.1.1.1`
- `cloudflare-ech.com+udp://8.8.8.8`

The `ech` array stores zero, one or both entries. Each selected resolver produces its **own** URI `ech=` and Xray `tlsSettings.echConfigList` scalar. Never concatenate them into a comma-list: the inspected Xray grammar accepts one `domain+resolver` string. Admins can edit domain/resolver strings, choose either resolver, enable/disable a profile, or add another independently named profile (≤6 profiles, ≤24 generated variants total; active per-base variant weights may sum to at most six so four bases also fit). No future method or IP was invented.

### Format matrix

| Output | Advanced defaults | Important conditions |
|---|---|---|
| Default / `?format=base64` | All variants as encoded VLESS/Trojan URIs with `fp`, `fm`, `cs`, `ech` | Some clients silently ignore unknown URI parameters. Inspected v2rayNG imports `fp/fm/ech` but **not `cs`**. |
| `?format=raw` | Same full URI entries as plain lines | Useful for inspection; not a promise of lossless GUI import. |
| `?format=xray` / `vjson` / `v2ray` | Array of complete Xray JSON configurations | Each object has its own inbound/outbounds, correct TLS/WS fields, `finalmask`, `cipherSuites`, scalar ECH. Import individual objects if your client cannot import an array. Not a claim about old V2Ray-core support. |
| `?format=clash` / `yaml` | Only profiles without Xray-only mask/ciphers/ECH/unsafe | YAML 1.2 using JSON flow syntax, with warnings; needs VLESS-capable Mihomo for VLESS. |
| `?format=sing-box` / `singbox` | Same representable standard profiles | Proper WS transport and TLS structure; no invented Xray fields. |

Unsupported variants in generic formats are explicitly reported in `X-NexiUP-Warnings` (and YAML comments). If **none** can be represented, HTTP **422** returns an Xray fallback URL, not malformed or empty configuration. The browser information page explains this. Standard variants are an explicit admin opt-in, not a silent downgrade.

Source checks are pinned in `docs/RESEARCH.md`: Xray `92ccc939…` and v2rayNG `118cf5bc…`. Cipher list acceptance does not prove the TLS library can force TLS 1.3 ordering or every suite. Real ECH also depends on compatible Cloudflare hostname/ECH configuration, DNS reachability and client version. **No real Iranian operator test was performed.** Test on your actual devices/networks before enabling sales claims.

## 13. One URL, QR and text fallback

The public bearer URL is `https://<MAIN_HOST>/sub/<128-bit-random-token>`. Stored base transports allow the hub to respond without fetching an unavailable node. Profiles are rendered live from the latest active revisions. The normal client default is Base64; a browser requesting HTML gets a bilingual information page with format links and an embedded, same-origin QR route.

The QR is an actual Model 2 medium-ECC QR rendered to a 1-bit PNG locally. Its pixels encode **exactly** the plain-text URL in its Telegram photo caption. No third party receives that URL for image generation.

The fallback button is HMAC-bound to the private Telegram user and internal subscription ID. Ownership/status/expiry are rechecked. A durable 60-second user rate limit applies. Delivery snapshots contain **all** variants once, in order; each fitting message contains an operator label, import hint and complete compact Xray JSON. No HTML/Markdown parser can alter the config. For an oversized configuration the bot explains how to concatenate the next raw pieces without separators, avoids splitting URI `%XX` or Unicode pairs, and also sends an intact JSON document.

A queued cursor survives 429 `retry_after`; the failed step is not skipped. Repeating a completed request later can intentionally send a new batch. Transport/network reachability remains separate: keeping the main URL reachable does **not** make a blocked tunnel SNI/node host reachable. Neither domain is promised always accessible in Iran.

## 14. Renewal and failed-paid-order recovery

Renewal creates a new bill but updates the **same** node UUID/account and main subscription token. New expiry is `max(now, current expiry) + purchased days`. NexiUP nodes accept an exact absolute `expiryMs`. Stock Nahan PUT interprets integer `expiryDays` **from now**; the hub rounds remaining days upward, so there may be **less than one extra day** of rounding, not loss of already-paid validity.

A target expiry and operation marker are persisted before mutation. Retrying does not keep extending it. `reset_usage:false` is the default: existing usage is retained and caps are set to the new plan, not added. `true` explicitly resets counters and is explained before renewal/payment and on delivery. NexiUP reset keys are idempotent and epoch-fenced against old buffered traffic. A lost stock-reset response is **not** blindly repeated.

In **Operations**:

- Retry/reconcile uses the existing identity, never an arbitrary new name.
- A definite failed test can reacquire its slot if no later successful/pending test occupies it.
- An ambiguous stock create stays pinned/quarantined. Inspect the node independently; only then use **Confirm absent**. It performs another GET but the admin confirmation is essential because stock caches cannot prove absence.
- For an uncertain stock reset, use **Confirm reset done** only after inspection.
- Never reject/cancel a processing paid order as a shortcut. Recover it or arrange an explicitly audited customer refund outside the provisioning loop.

Admin subscription controls support pause/resume, extension, delete, reset usage and **Refresh transports**. Base transports are snapshots taken at issue/renewal; after changing node clean IPs/ports/host aliases, use Refresh transports for the affected subscription. Operator-profile changes themselves remain live within 15 seconds. NexiUP nodes provide authenticated base retrieval via GET users `?id=…&action=configs`, including capped accounts; no account recreation is necessary. Destructive controls require confirmation; uncertain manual mutations are not automatically replayed.

## 15. Node panel and tunnel behavior

The new owner portal is **`/admin`** (§8). The retained legacy node-only `/<api_route>/dash` is embedded, responsive and bilingual, with users, validated JSON settings, API-key references, stats, audit and paginated backup/restore. Credentials stay in page memory, not localStorage/cookies. Public root camouflage is a small static page, not a third-party website fetch. All HTML user data is escaped; scripts use `textContent` for API results. Unauthorized control APIs have per-isolate brute-force throttling and long required credentials.

Panel configuration: API route, `protocol` (`vless`/`trojan`/`both`), clean IPs, admin-defined relay fallback IPs/hosts, user-node aliases, supported TLS ports, paused state, optional DoH `dns_url`, flush interval and tunnel lifetime. No clean IP, relay, geographic exit, or DNS endpoint is invented. Per-user hostnames must route to the **same account database**; merely entering another independent Worker hostname does not replicate users.

- Only TLS WebSocket TCP tunnels; UDP is DNS-only, destination port 53, and requires an explicitly configured HTTPS DoH endpoint. No arbitrary UDP, SOCKS upstream, NAT64 conversion, cascade, remote deployment or automatic relay scanning is claimed.
- Incoming client `proxyip` query strings are ignored. Only stored admin relay choices are tried, and only on initial connect failure before replayable application writes. Private/local destinations and SMTP port 25 are rejected.
- ≤4 base transports/account; `maxConfigs` caps bases, **not** operator variants. An excessive combination fails visibly instead of trimming.
- 100 stored-account safety cap/node; the hub's default registry capacity is 10. Expired/deleted account cleanup is an operator task, not proof of extra Free quota. Disable/delete old accounts from admin controls as appropriate.
- Real upload/download bytes are accumulated without per-frame writes and flushed in additive D1 batches; unique batch receipts prevent duplicate accounting, and reset epochs reject old deltas. **Cross-isolate limits are eventually consistent**: simultaneous use can overshoot, and isolate eviction can lose unflushed tail bytes. They are not a financially exact global hard quota.
- `connLimit` means concurrent tunnels **per isolate**, not a globally exact device count. Workers cannot impose a distributed exact count without additional coordination/writes; do not market it as “two devices guaranteed”.
- Settings caches may lag 15 seconds; open tunnels refresh during usage cycles. Kill switch is not instantaneous across all isolates (normally cache + refresh interval). Long tunnels close after the configured maximum (default 600 seconds), or earlier to protect the D1 budget; clients must reconnect.

Auto-update and remote deploy are **off and intentionally non-enableable** in this implementation. Metadata points to `ArsalanAfshar/NexiUP`. There is no telemetry/phone-home or startup GitHub fetch. Manual reviewed upgrades avoid turning an upstream compromise into remote execution. Reintroducing remote deployment needs an explicit security/license review and dedicated least-privilege credentials.

### ProxyIP explorer: countries, live checks and actual application (2.1)

This is an independent implementation inspired by the requested workflow, **not copied edgetunnel/EDT UI code**. The production catalog starts empty. No supposedly working global IP pack is embedded. Country coverage is whatever your authorized imported source currently supplies—not a promise of every country or reachable relays.

**Import and discovery**

1. Open **ProxyIP explorer** in `/admin`. Import your own JSON or simple CSV/text, or explicitly enable a public source in **Settings → ProxyIP source and budget**, review the privacy/permission notice, save, then click **Fetch source**. There is no automatic scan or scheduled remote refresh.
2. The optional presets below were found in pinned public source, **not live-verified in this environment**. Either can be replaced with another public HTTPS endpoint. URLs must have no credentials, query or non-443 port. Both integrations start off:

```json
{
  "source_url": "https://zip.cm.edu.kg.cmliussss.net/all.json",
  "external_enabled": false,
  "checker_url": "https://api.090227.xyz/check",
  "checker_enabled": false,
  "timeout_ms": 5000,
  "daily_test_limit": 500
}
```

3. JSON accepts an array, `{ "data": [...] }`, or `{ "proxies": [...] }`. Rows accept `endpoint`/`ip`/`host`/`proxy`, optional `port`, and `country`/`country_code`/`meta.country`. The inspected provider's `port` arrays must include 443. Optional labels/cities are untrusted display text; its `meta.clientIp` is **not** recorded as measured exit evidence. Simple CSV has `country,endpoint,label` columns; quoted multi-line CSV is not supported. Replace placeholders with endpoints you are permitted to use, for example the **schema**, not a working proxy:

```json
[{ "endpoint": "<YOUR_AUTHORIZED_PROXY_HOST>:443", "country": "DE", "label": "Your relay label" }]
```

4. IPv4, DNS hosts and IPv6 are supported; use `[IPv6]:port` for an explicit IPv6 port. Private/local targets, URLs masquerading as endpoints, invalid ports and port 25 are rejected. Imports are bounded to **1 MiB**, **2,000 catalog records**, **20 records per durable continuation**, with one-hour jobs. Counts show truncation/rejections rather than claiming full source coverage. Concurrent jobs share a capacity lock; retries do not double-insert, and cancellation cannot resurrect a cancelled job. A failed fetch leaves the previous catalog usable. Re-importing metadata does not fabricate or reset a prior test result.
5. Country filters group the **source's claimed country**. The observed exit country is a separate column. Labels, DNS names and provider IP metadata are not geographic proof. Unknown-country entries do not inflate the country count.

**What live tests mean**

Choose the origin (**this Worker** or an explicitly selected remote NexiUP node), then check one entry or the visible page. The browser schedules at most **two** checks concurrently, shows progress and can stop future work; already-started requests may still finish. Nothing is applied automatically.

| Check | Meaning and limits |
|---|---|
| TCP only | A socket opened from the selected origin. Timing is TCP establishment, **not ICMP ping**. This does not establish TLS, relay functionality, exit country or client compatibility. |
| TLS + relay trace | TCP, then `startTls({expectedServerHostname:'www.cloudflare.com'})`, then HTTPS `/cdn-cgi/trace`. Host, bounded HTTP body, public IP, country and trace-colo fields must validate. Only a completed result is `relay_ok`; failures remain explicit. TLS verification is never disabled. |
| External checker | Explicitly opt-in, sending the candidate to the configured checker as `proxyip`. A successful answer is **reported**, not promoted to a locally verified relay/country. No silent fallback from failed native checks. |

The public source/checker receives the network request and, for the checker, the candidate address. Application code sends neither subscription URLs, account UUIDs nor administrative keys to those providers. Platform-added network metadata follows Cloudflare behavior. Native remote-node checks do use the designated node's panel key, as normal authenticated node administration. The selected node must implement NexiUP **2.1** `POST /<route>/api/proxy-check`; older/stock APIs fail explicitly instead of receiving a master key or a fabricated result. Remote evidence trusts that authorized node's report; it is not independent cryptographic attestation.

TCP/TLS/total timings, check time, evidence origin, observed exit IP/country, trace colo and request Worker colo are separate. **Neither Cloudflare colo is itself an exit-country claim.** Trace evidence covers that destination, origin and moment, not every client, service, ISP or future request. Default deadline is **5 s** (configurable 2–8 s), trace response ≤16 KiB. A persistent per-Worker UTC-day budget charges attempts **before** networking: default **500/day**, configurable 1–5,000. There is also a 30-second candidate/mode/origin cooldown. A remote check charges the hub and selected node's respective budgets.

**Apply, scope and rollback**

- Select at most **four** endpoints and explicitly apply. A successful relay check from the **matching target**, no older than **30 minutes**, is required unless you deliberately check the unverified-override box. TCP-only or external-reported success is insufficient.
- **This node (`self`):** updates real `panel.proxy_ips` in D1. Existing and future local accounts that inherit node defaults see the change within cache/connection-refresh limits; per-user overrides are not overwritten.
- **Remote registry node (`node:<id>`):** persists a hub-side default and injects `proxyIp` only into **new** account POSTs. It does **not** alter remote master settings or existing customers. Use that node's own owner UI for explicit changes to existing overrides. Port-aware defaults require an upgraded NexiUP 2.1 node or a verified compatible adapter; the override checkbox cannot add missing features to older nodes. Stock-Nahan per-user behavior still requires verification against the deployed version.
- The tunnel tries its original destination first, then up to four stored fallbacks on initial connection failure. Explicit endpoint ports are honored; old bare-host entries keep the original destination port. Selecting a country is **not** forced routing of all traffic through that country. Untrusted client `proxyip` query parameters stay ignored.
- Rollback creates another revision. Local rollback refuses to overwrite a manual settings change made since apply. Clear fallback is explicit; deleting a catalog row alone does not silently change an active route.

Discovery and diagnostic writes are control-plane operations, not per-frame traffic writes. Catalog filters/counts can still read up to 2,000 rows; import and indexes consume D1 writes. The budgets do **not** prove Cloudflare Free CPU, row or account-request compliance. Avoid repeated full imports, monitor real metrics and test your own authorized endpoints/clients before enabling sales.

## 16. Scheduling, usage screen and capacity planning

One `* * * * *` cron partitions UTC minutes modulo six:

| Slot | Work |
|---|---|
| 0, 2 | One queued provisioning/reconciliation operation |
| 1, 3 | One delivery job, at most three steps (one-second per-chat pacing) |
| 4 | At most two unpaid cancellations + two expiry reminders + bounded cleanup |
| 5 | Broadcast up to five recipients; at minute 5 each hour, analytics/daily-report work instead |

This conservative default offers about **20 operation attempts and 20 delivery-job visits/hour**, not a high-volume sales guarantee. An operation can need multiple visits; one order can generate several admin/customer jobs. Queue latency can be minutes or longer. Protected `/setup` process-next controls can advance one operation/job per request; never run an unbounded cron loop to compensate. Measure CPU and queue depth before changing schedules/batch sizes.

Operational diagnostics in the Telegram admin menu shows a D1 read wall-time check, webhook/main-origin match, pending Telegram updates and operation/delivery counts without echoing credentials or raw remote error text. `/health` is only a liveness/version route, not a database-capacity test.

Usage menu queries optional Cloudflare GraphQL analytics for **account-wide UTC-day requests** against 100,000 and queues daily-deduplicated warnings at 70% and 90%. It labels adaptive/delayed data as an estimate. Without API credentials it says “not configured”, not “0 used”. Account limits include other projects. D1 row use must also be checked in the Cloudflare dashboard; this bot screen is not a D1 billing meter.

Choose customers/node from actual usage, concurrency, isolate count and daily write budget. Approximate traffic entitlement for `U` users with daily cap `D` is `U×D` GiB/day, but that does not establish a Cloudflare bandwidth allowance or operational capacity. Start with a few test users, inspect CPU p95/p99 and D1 rows, maintain headroom, and reduce traffic or move plans if the Free limits are exceeded. No VPS or paid add-on is required by the code; no workload is guaranteed to stay free.

## 17. Backup and restore

- Telegram **Backup** exports validated configuration by kind in pages of up to three records. It includes secret **references**, not secret values. Settings still contain private payment/support data; keep files private.
- Send a v2 page as a JSON document with caption **`#import_nexiup`** as a current admin. All records are validated before per-record upserts; restoration is audited and non-destructive. It is not a whole-database atomic transaction across multiple pages.
- Node panel backups are up to twenty user records/page, with identities and configuration. Download **every page**. Treat these files as credentials. Restore upserts settings/identities and does not reset usage.
- Neither configuration export is a complete customer/financial/usage backup. Use Cloudflare D1 export/download or optional `wrangler d1 export` for the full database, and Free Time Travel (7 days) for recent recovery. Store Worker Secrets separately in a password manager. Test restore in a separate non-production Worker/D1 first.
- Built-in cleanup bounds old completed webhook/outbox/flush rows to seven-day retention attempts, with small per-run batches. Audit, ledger, grants and accounts are retained until an operator applies an appropriate retention policy. Growing backlogs can outpace cleanup; monitor storage.

## 18. Upgrading and original-v1 cutover

**2.1.0 → 2.1.1:** replace code in place after a backup; there is **no new migration or data reset**. Keep the same bindings/secrets and check the active version at `/health`, then use read-only `/setup` deployment checks. Application error references and opt-in sanitized logs help distinguish runtime/binding/schema failures. The account-specific reported 1101 cause still requires hosted evidence.

**2.0 → 2.1:** back up D1, replace the entire single Worker file, then run authenticated `/setup` initialization until **`ready:true`**, or sign in to `/admin`. Version five alone is not proof that final seeding completed. The additive migration preserves existing users, balances, orders, nodes, accounts and profiles; old operator values are not reset. Data-dependent public/node paths fail closed until ready; liveness and public bootstrap pages do not require D1. The web API uses `/admin/web-api/` so a pre-existing node `api_route=admin` continues to work. Source/checker integrations remain off until explicit opt-in. Review the new owner-secret/session behavior before reopening traffic.


For v2 upgrades: private D1 export → review diff/licenses → paste updated complete `worker.js` → run protected `/setup` initialization → check health, one test issuance, QR/fallback, renewal, and cron. Do not rotate/delete keys or change the main domain unintentionally. For rollback restore the old code only when schema-compatible; otherwise restore a tested D1 snapshot too.

For the original manual bot:

1. Export its D1, stop the old webhook/Worker writes and settle outstanding manual orders/withdrawals. Do not run old/new financial writers simultaneously.
2. New `nx_` tables coexist with untouched v1 tables. `/setup` accepts authenticated POST `{"action":"legacy","kind":"users","after":0,"confirm":"old_worker_stopped_and_d1_backed_up"}`. Repeat with returned `next` until a page imports zero rows. It imports users/referrers/bans and an idempotent opening-balance ledger entry. Owner/admin access is configured separately; old flags do not silently grant new privilege.
3. Repeat with `kind:"services"` after users. Existing manual subscriptions become read-only legacy services with new main-domain URLs and their original text fallback. Their unknown caps are labeled **unverified**, and they cannot be automatically renewed without a real node mapping.
4. Review/re-enter numeric plans, bank instructions, guides, channels, coupons and text/settings from the retained v1 data. There is no safe automatic inference from a traffic marketing string to daily quotas/device limits/node locations. Existing order/ledger/support history remains in the original tables for export/audit; this importer does **not** move all historical records into v2 dashboards or manufacture node identities.

This is an explicit migration boundary, not a claim of an invisible one-click full historical migration. The original source remains at commit `77e421f…`. Main and repository visibility were not changed.

## 19. Security checklist

- [ ] Independent random setup/callback/webhook/master secrets; no default password; correct private owner IDs.
- [ ] Distinct node panel API keys, never master keys; scopes verified on stock Nahan; no other stock config writers.
- [ ] HTTPS origins/routing and the main subscription domain checked; no secrets in URL queries.
- [ ] Webhook rejects missing/wrong `X-Telegram-Bot-Api-Secret-Token`; old webhook disabled during cutover.
- [ ] Existing payment/plan/test settings reviewed before enabling; Terms disclose actual caps, resets, coupons and network limitations.
- [ ] Profile previews/rollback tested, fresh client import checked, real operator trials completed before claims.
- [ ] Request URL logging disabled or appropriately redacted: `/sub/<token>` is a bearer credential. Example Wrangler observability is off.
- [ ] Private D1/config backups; restrict Cloudflare dashboard/D1 access. D1 necessarily holds customer identities/configuration bases and Telegram receipt references.
- [ ] Analytics token is read-only; no remote-deploy token is requested. Secrets never go into audit details/error messages.
- [ ] Monitor D1 writes, CPU, request totals, storage, queue lag, grant failures and quarantined nodes. Rotate exposed credentials and review logs.

The node prevents common literal private-host targets, but this is not a replacement for platform network controls, abuse monitoring or a formal security audit. Denial-of-service against public Worker URLs can still consume account quotas.

## 20. Troubleshooting

| Symptom | Check / remedy |
|---|---|
| Cloudflare **1101** | See the 2.1.1 section at the top: verify active version, run read-only preflight, use safe error references/live exception evidence. Do not delete D1 or assume a passing local test clears the incident. |
| Web login / `web_admin_secret_required_min_32` | Use HTTPS and the correct owner key; remove an accidentally empty `WEB_ADMIN_KEY` or set a strong one. Panel keys do not grant owner access. |
| `csrf_failed` / `origin_forbidden` | Reopen the panel directly on its HTTPS origin and sign in again; check reverse-proxy Host/Origin handling. Do not disable CSRF. |
| Source fetch failed / body too large | External fetch must be opted into; endpoint availability, response format and 1 MiB bound are not guaranteed. Use a smaller authorized import; the last catalog is retained. |
| `fresh_target_relay_test_or_explicit_override_required` | Run TLS/trace from the intended target within 30 minutes, or deliberately accept the documented risk. TCP or third-party “success” alone is insufficient. |
| Remote probe unsupported | Upgrade that node to NexiUP 2.1; stock/older APIs have no equivalent verified diagnostics contract. Do not substitute a master key. |
| `run_setup_migrations` | Binding name `DB`; complete all initializer calls until `ready:true`. |
| `master_key_required_min_32` | Set a strong `MASTER_KEY` for node/all. No default login is provided. |
| Bot silent | Correct `ROLE`, token/owner IDs, main origin and webhook secret; run Register webhook; inspect Telegram webhook status privately. A GET to `/setup` alone does not set it. |
| Issuance/delivery queued | Enable hub cron; check operation state, node settings/capacity and 429 retry times. Use protected process-next to inspect one step. |
| `node_quarantined`, `stock_result_not_proven_absent` | Do not create a second account elsewhere. Inspect stock node, wait for cached responses to expire, then reconcile/explicitly confirm absence. |
| `node_api_key_missing_or_master` | The D1 value must be a Secret reference, not the key value. Install the corresponding panel key in hub secrets. |
| No matching node | Exact `de`/`us` and `sales`, enabled state, max users; tests require a designated node and explicit sales-node permission. |
| Cloudflare **1042** | Official docs identify same-zone Worker fetch without `global_fetch_strictly_public`, or nonexistent/disabled workers.dev routing. Set the flag, enable the actual workers.dev route, or use a correctly configured public custom domain. Cloudflare service bindings are another architectural remedy but not wired into this registry adapter. Never fix it by disabling TLS. Documentation-verified, not live-account-tested here. |
| HTTP 422 for Clash/sing-box | Advanced profiles cannot be losslessly represented. Use `?format=xray`, or explicitly enable a compatible standard profile. Read warning headers. |
| `unrepresentable_node_parameter` | Disable stock fake ECH (`pbk=enabled`) and unsupported transports/routing options; don't silently strip unknown critical fields. |
| QR scans but connection fails | QR/subscription reachability is separate from tunnel SNI/clean-IP/relay reachability. Verify an individual full Xray config and actual exit from a client. |
| Limits lag / usage missing | Buffered cross-isolate counters are eventual; eviction can lose tail bytes. Review D1 errors/write quota and flush interval. |
| Node full with expired accounts | Remote count includes stored identities. Inspect/delete old accounts; do not assume expiry deletes them or frees platform quota. |
| `version_conflict` / `stale_preview` | Another save changed the record or the confirmation is stale. Reopen editor and preview again. |
| Bot secret changed / invalid callback | Reopen `/start` or `/admin` for newly signed buttons. |
| 1027 / D1 quota errors / 1102 | Respect account request/row budgets and 10 ms CPU. Reduce workload/format size, inspect metrics, or change platform plan; no “retry forever” workaround. |

1042 reference: https://developers.cloudflare.com/workers/observability/errors/.

## 21. Verification

```sh
node --check worker.js
npm test                 # Node built-ins only; no package install required
npm ci                   # optional development typings/compiler
npm run verify           # syntax + checkJs/TypeScript + tests
```

**124 tests pass** using Node's built-in test runner and a D1-shaped real-SQLite fake: conditional state transitions, wallet/coupon concurrency, per-user test slots and success-time cooldowns, API shapes, failover/quarantine, renewal/reset, webhook/admin authorization, profile versioning/encoding/formats, per-config fallback/429, PNG-pixel QR decoding and VLESS/Trojan stream fakes with no per-frame writes. No test framework/package installation is needed for this suite. The test-only loader exposes private helpers and stubs `cloudflare:sockets`; the deployable file exports only its Worker handler.

The additional `tests/deployment.test.mjs` covers 26 deployment/error regressions, including hostile/primitive rejections, lazy binding acquisition, authenticated read-only preflight, cache-bypassing schema checks, deadlines and mutation safety. `tests/deployment-workerd-smoke.mjs` passes **18 local native scenarios** across the raw source and Wrangler bundle, without a dev/auto-login proxy: missing/wrong bindings, fresh D1 and real login/API flows for all three roles, plus explicit fault injection and real 8-second unresolved-read recovery. These tests do **not** identify or certify the reported hosted incident.

Optional `tests/workerd-smoke.mjs` ran on Miniflare **5.20261019.1-beta** / workerd: actual Worker startup, native local D1 migrations/triggers, authenticated panel creation, three Xray variants, HTML panel and PNG output passed. The optional **two-Worker** `tests/remote-workerd-smoke.mjs` also passed with separate native D1 databases: a hub made authenticated HTTP calls to the local node, provisioned one account, rendered three variants on its main domain, and sent PNG plus metadata to a Telegram fake. A separate jsQR **1.4.0** decode recovered the exact URL from PNG pixels. Wrangler **4.151.3** dry-run passed. Wrangler/Miniflare/jsQR/Playwright are optional development tools, not runtime dependencies. TypeScript 5.9.3 and Workers types 5.20261019.1 are pinned **devDependencies** for reproducible `checkJs`; the screenshot menu/QR type errors are fixed without disabling source checking.

The optional **`tests/browser-smoke.mjs`** also passed in Chromium 153 against real local HTTPS/workerd/D1: read-only deployment preflight, displayed safe failure references, secure cookie login/CSRF/logout, desktop/mobile RTL/LTR, validated plan/account creation, isolated profile changes/rollback, receipt/order workflows, queue filters, safe ProxyIP import/filter/apply/rollback and XSS escaping. There were no external asset requests or browser JS/CSP errors. Native probe-parser/socket tests use synthetic streams, not live relay or geography certification.

See `docs/VERIFICATION.md` for measurements and the unverified list. No real receipts, credentials or illustrative owner UUID/hosts/proxy IPs were deployed or copied as defaults.

## 22. FAQ, limitations, licenses and Design decisions

**Is this a literal customized Nahan fork?** No: license uncertainty blocked copying. It is an independent, compatible users-API implementation; upstream NAT64/cascade/full UI/remote-update behavior is not claimed.

**Can I paste only worker.js?** Yes. It embeds its UI, QR encoder and migrations. Bind D1, set secrets and finish the protected initializer; package.json/tests are development-only.

**Will the main URL work if a node is blocked?** It can serve stored configurations when the main domain is reachable, but cannot bypass a blocked transport domain or guarantee reachability in Iran.

**Are traffic and device limits globally exact?** No. Traffic bytes are additive/deduplicated when flushed, but persistence and enforcement lag across isolates. Connection counts are per isolate, not exact device counts. If strict global metering is essential, this Free/no-hot-write design is unsuitable without additional coordination and measurement.

**Do admin changes need source edits?** Operational bot/test/node/profile/catalog values live in D1. Profile changes affect existing URLs within the documented server cache TTL. Installing/rotating Worker Secrets is still a Cloudflare operation.

**Why are queued jobs conservative?** Free cron has the same 10 ms CPU limit as HTTP. Throughput and latency are intentionally bounded rather than advertised as high-volume or guaranteed free.

### Design decisions — verified facts vs assumptions

1. **Verified:** current Free size limit is 64 MiB uncompressed with no compressed-size cap. D1 has a 50-statement/invocation ceiling despite the higher generic internal-subrequest ceiling. Every account shares its quotas.
2. **Verified:** inspected stock Nahan uses JSON-blob RMW storage, 10-second caches, byte counters with activity-triggered ~30-second whole-blob writes, relative-from-now integer expiry PUT and non-unique POST names. NexiUP normalizes local users/usage, serializes stock writes, persists intent and quarantines ambiguity.
3. **Verified in source, not in mobile networks:** `unsafe`, finalmask and scalar ECH grammar; v2rayNG does not import `cs`. Full Xray JSON is the lossless fallback. Both ECH resolvers mean two variants, one account.
4. **Chosen:** tests start disabled, with 1 GiB total/day, one day, 48 hours from **successful issuance**; no silent production-node fallback; no cooldown consumption on definite failure.
5. **Chosen:** no example host, UUID, proxy IP, bank number or assumed exit country is used as production configuration. Main origin and sales/test nodes are explicit admin choices.
6. **Chosen:** schema-valid profile rollback, 15-second server cache, one account per subscription, no silent generic-format downgrade, true local PNG QR and full-config fallback.
7. **Chosen:** renewal preserves usage unless its plan explicitly requests reset. First-offer/coupon reservations survive cancellation. Exact stock reset uncertainty requires operator reconciliation.
8. **Chosen for security/license clarity:** original compatible node rather than copying uncertain/GPL upstream code; no auto-update/deploy, fake configs, external HTML, telemetry or guessed future operator methods.
9. **Chosen repository handling:** the connected checkout is already `ArsalanAfshar/NexiUP` (public). Work stays on `arena/4a2b629b-nexiup`, not a new `nexiup` branch/repository. Main and existing visibility are unchanged; no credentials are committed.
10. **Chosen for web compatibility/security:** an original owner-only bilingual panel at `/admin`, separate `/admin/web-api/` namespace, hashed short sessions and Origin/CSRF enforcement; existing custom node routes are preserved. Node master keys are never acquired or sent by a hub-side ProxyIP policy.
11. **Chosen for honest diagnostics:** empty initial catalog; explicit off-by-default source/checker; claimed versus observed country; target/time-scoped TLS/trace evidence; TCP and provider reports cannot masquerade as verified routing. Local fallback affects inheriting accounts; remote policies affect future accounts only. The workflow is independently implemented, with no GPL/unlicensed UI copied.
12. **Chosen for deployed failure handling:** public bootstrap/liveness is independent of D1; initialization is inside an awaited request boundary, unknown exceptions are never reflected, and only app-created faults are trusted. Preflight is owner-authenticated, read-only, cache-bypassing and bounded; error logging is opt-in and metadata-only. No blanket timeout/retry is added to in-flight mutations. Local fault reproduction is **not** proof of the reported hosted cause, and module/platform failures remain outside the boundary.
13. **Needs confirmation before production:** node/proxy geography and reachability, operator/client-version compatibility, bank/owner/prices/Terms, acceptable queue delay and quota lag, measured Free CPU/D1 capacity, exclusive stock-node writes, and completeness of any v1 data cutover. A literal upstream fork also needs a documented license grant.

NexiUP-owned code and the attributed embedded QR encoder are MIT. The embedded, unmodified Vazirmatn Arabic font is **SIL OFL-1.1**, with its full notice in `worker.js` and `docs/licenses/Vazirmatn-OFL.txt`. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md). Use must comply with Cloudflare Terms and applicable local law; educational use, **no warranty**.
