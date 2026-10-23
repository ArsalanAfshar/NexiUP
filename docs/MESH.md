# NexiUP Mesh 3.0 — one manager, multiple API nodes

[راهنمای فارسی](MESH_FA.md) · [Evidence / verification](MESH_VERIFICATION.md) · [Source comparison](RESEARCH.md#2026-10-23--uploaded-worker-comparison-and-mesh-30)

## The two delivery files

| File | Deploy it to | Required configuration |
|---|---|---|
| [`manager-worker.js`](../manager-worker.js) | **One new central Worker** | D1 binding **`DB`**, secret **`OWNER_KEY`**, one distinct **`NODE_KEY_<NAME>`** secret for each node |
| [`node-worker.js`](../node-worker.js) | **Each separate node Worker** | Variable **`NODE_ID`**, variable **`MANAGER_URL`**, secret **`NODE_KEY`** |

Both are complete, paste-ready ES modules. No runtime npm packages, remote HTML/assets, Nahan installation, VPS, KV, Durable Object or paid add-on is required by the code. **Nodes have no database.** Only the manager has D1. A source build is not required to install the committed files.

Use the files on **`arena/4a2b629b-nexiup`**, not an assumed update to `main`; main remains untouched. `worker.js` is the **separate legacy 2.1.2 bot/all-in-one Worker**, not either Mesh file. Root `wrangler.toml` is also legacy; use the two explicitly named Mesh configs for CLI installation.

**Important scope:** Mesh accounts use new `nx3_` tables and a new API. The old Telegram/payment/wallet/referral/proxy-catalog system remains in `worker.js`, but it does **not automatically sell/provision Mesh accounts**. No automatic migration of existing financial records, UUIDs, subscriptions or old URLs is performed. Deploy Mesh on a **new Worker/origin**; do not replace an active legacy endpoint and assume its customers' URLs still work. Export D1 first. Separate D1 is recommended; namespace separation does not create extra Free quotas.

## What is implemented

- Responsive owner web panel at `/` and `/admin`, Persian/English, RTL/LTR and mobile navigation.
- Real owner login, 30-minute hashed D1 sessions, `__Host-` Secure/HttpOnly/Strict cookies, exact Origin and CSRF checks, logout revocation. No browser credential storage or default admin password.
- Register, edit, test and enable/disable up to **12** nodes. No initial live nodes or proxy inventory is fabricated.
- Pairing verifies a **unique challenge observed by the manager**: manager → node → manager. Merely echoing JSON/HTTP 200 is not sufficient. This is API evidence, not proof of TCP routing, exit country or ISP access.
- Create accounts with a name, private notes, duration/absolute expiry, **positive total and daily byte limits**, a network-wide concurrent-tunnel admission limit, VLESS/Trojan/both, and all-active or selected nodes.
- **All** means current and future enabled nodes; **selected** means only explicitly chosen nodes. One account UUID is used across allowed nodes and operator variants. There is one canonical subscription URL.
- Edit limits without resetting usage; renew from `max(current_expiry, now)`; pause/resume/revoke; explicit usage reset; rotate only the URL token or separately rotate the UUID. Administrative actions have durable idempotency/CAS checks.
- Actual VLESS/Trojan TCP over TLS WebSocket, real shared quota admission, byte slicing at the remaining allowance, bounded buffers, explicit socket closure, and fail-closed central authorization. **UDP, Shadowsocks, XHTTP and gRPC are not implemented in this pair.**
- Raw/base64 subscriptions, full Xray JSON, local PNG QR and a subscription portal. Clash/sing-box export only represent compatible enabled profiles; Xray-specific requirements are not silently discarded.
- Independently editable/versioned Irancell, Hamrah and standard profiles; two scalar ECH resolver variants remain separate and share the same account. Profile rollback is monotonic. These settings are retained from NexiUP's own implementation, not certification of current client/ISP support.
- Optional operator-supplied clean host and up to four `host:port` TCP fallback endpoints per node. Client query parameters cannot override them. They are **not automatically considered tested**. The full older country-catalog/probe UI remains in the legacy Worker, not silently grafted onto Mesh.
- Separate reported usage, committed/reserved allowance, uncertain reservations and per-node totals; audit log; read-only deployment preflight; bounded optional housekeeping.

## Dashboard-only installation

### 1. Central manager

1. Back up any existing D1. Create a **new Worker** and a D1 database. Paste the **complete `manager-worker.js`**, not the `mesh/` development pieces.
2. Bind the database with the exact name **`DB`**. A text variable containing a database ID is not a D1 binding.
3. Set secret **`OWNER_KEY`** to a random 32–256-character ASCII value, kept in your password manager. Do not put it in source, Git, a query string, Telegram or a screenshot. Do not reuse a node key.
4. Set compatibility date **`2026-10-20`** (or later) and flag **`global_fetch_strictly_public`**. Save/deploy the active version.
5. Open `/health`: expect **`component:"manager"`**, **`version:"3.0.0"`**, `database_checked:false`. This is liveness, not readiness.
6. Open `/admin`, enter `OWNER_KEY`, and sign in. Authorized first login creates the new schema; unauthenticated page loads do not. The read-only diagnostic button works before initialization and does not create tables.
7. In **Settings**, save the real canonical **HTTPS origin** of this manager, without a path/query. Node `MANAGER_URL` must match it. It determines every new subscription/QR URL. Changing it does not preserve a domain that you stop serving.

### 2. Each node

1. Create a separate Worker, paste the **complete `node-worker.js`**. Choose a different Worker name and node ID for each deployment.
2. Set **`NODE_ID`** to your chosen identifier (letters/digits/underscore/hyphen, max 48).
3. Set **`MANAGER_URL`** to the manager's canonical HTTPS origin from Settings.
4. Set a separate random 32–256-character ASCII secret **`NODE_KEY`**. It is for **this node only**, not the manager's owner key.
5. Set the same compatibility date/`global_fetch_strictly_public` flag and deploy. **Do not add D1, KV, cron, `ROLE`, `MASTER_KEY` or Nahan to this node.**
6. Its public `/health` should identify **`component:"node"`**, version 3.0.0, `configured:true`, `database_required:false`. It explicitly does not claim a TCP test succeeded.

### 3. Pair and enable

1. On the **manager**, add a Worker Secret whose name matches `NODE_KEY_<NAME>`; its **value is this node's `NODE_KEY`**. Use different values for different nodes. Only the reference name is stored in D1.
2. In the manager's **Nodes** screen, add the node's exact `NODE_ID`, label, real HTTPS origin and that **secret reference name**. Do not paste the secret value into the form. Country is optional operator metadata (`ZZ` = unknown), not measured exit geography.
3. Save. A new node is disabled. Run **Test API**; a successful result proves the challenge went both ways. Then **Enable** the node. A failed test disables it. Changing origin/key reference requires a fresh test before enablement.
4. Repeat for each node. A node with an old Nahan/legacy API does not qualify: deploy the new node file, not a master-key workaround.

### 4. Create and deliver a subscription

1. Select **Subscriptions → New subscription**. Set a finite total/daily allowance in **GiB** (1 GiB = 1,073,741,824 bytes), days, maximum concurrent tunnels, protocol and node selection. Daily limit cannot exceed total; zero is rejected, not interpreted as unlimited.
2. Choose **all active nodes, current and future** or specific enabled nodes. Creating the account is one authoritative transaction; it does not race twelve remote account databases.
3. Save. The details dialog shows the canonical URL, real PNG QR, downloads and per-node accounting. Nodes automatically recognize the account through the manager API at connection time; no per-node manual account creation is needed.
4. Prefer **full Xray JSON** where cipher suites/final mask/ECH must be retained. URI importers can drop `cs`; not every client supports the advanced profiles. Test on the actual intended client/network before selling access.
5. Renewal preserves UUID/token and usage by default. Reset is an explicit separate choice. Rotating just the link **does not revoke an already downloaded UUID**; use UUID rotation or revoke for that purpose.

## How the shared limits actually work

A 10 GiB account on three nodes has **10 GiB total**, not 10 GiB per node.

1. Every new tunnel authenticates against the central account and selected-node membership. Global connection admission is serialized in D1, not counted only inside one isolate. It is a **tunnel count**, not proof of physical device count; lowering the limit applies to new admissions rather than evicting a chosen set of existing tunnels.
2. The node generates private random connection/lease IDs. They are not taken from client parameters. The initial credit is at most **64 KiB**; further leases are at most **4 MiB**, always bounded by remaining total/day allowance.
3. D1 triggers atomically check current entitlements and both counters, then reserve bytes **before forwarding**. Concurrent requests from different nodes cannot over-allocate the shared pool. Missing enforcement tables/triggers fail closed.
4. Upload and download share a serialized meter. The final chunk is sliced to the remaining credit. Metering counts payload bytes admitted to forwarding, not TLS/WS overhead or proof that a remote application received them. A failed write may be conservatively counted.
5. Known final settlement closes the lease once, records monotonic upload/download and refunds only its unused credit. Duplicate reports cannot refund twice. Normal reports settle at credit rollover or connection closure, **not every frame**; the UI is not an instantaneous packet counter.
6. If a node disappears or a grant response is lost, unused bytes are **not guessed/refunded**. Unknown credit remains charged and is shown separately from reported bytes. Pruning history never refunds it or erases aggregate totals. An owner may investigate and explicitly increase/reset the allowance; do not label unknown bytes as verified delivery.
7. Daily accounting is **00:00–24:00 UTC**. Tunnels are bounded at the UTC boundary and the known absolute expiry. Unspent old-day credits cannot be reused in the new day. Total usage does not reset each day.
8. Authorization permits last at most **30 seconds**, refreshed every **20 seconds**. Pause/revoke/node disable/membership or expiry edits take effect on existing tunnels within that bound; new admission checks current state. Manager failure prevents new credits and closes tunnels when permits lapse (often sooner on a failed refresh).
9. Reset starts a new usage epoch and imposes a **31.5-second drain window**; late old reports cannot debit the new epoch. UUID rotation uses a separate authorization revision and preserves accounting, with the same safe pause. Provider clocks are assumed reasonably synchronized; nodes use a monotonic local deadline and subtract the full RPC round trip rather than trusting client time.
10. Each tunnel currently has a **4-minute maximum lifetime**, a **36-control-RPC budget**, at most five sequential TCP destinations, a 1 MiB inbound queue and 256 KiB message ceiling. Clients need to reconnect at these limits; very long transfers are not guaranteed uninterrupted. No retry/failover occurs after application payload has been sent to an upstream.

**Trust boundary:** run only nodes you control and deploy the audited node code. A malicious node holding its API key can lie about traffic or bypass its local meter; this design is not remote hardware attestation. Node keys cannot administer the panel, enumerate accounts or borrow another node's identity. The public subscription UUID is an access credential: keep URLs/QR/configurations private.

## API contract and authentication

Owner control: `/api/…`; cookie reads, Origin+CSRF for cookie mutations, or explicit owner Bearer for trusted CLI automation. Node control: authenticated **POST** `/mesh/v1/ping`, `/open`, `/check`, `/grant`, `/close`; distinct node Bearer plus `X-NexiUP-Node`. A node cannot use an owner cookie/key in place of its scoped key. Nodes expose protected **GET** `/_mesh/health` for pairing and `/connect` for VLESS/Trojan WebSocket handshakes. This is **`nexiup-mesh/1`**, not a Nahan API.

Core owner routes: `POST /api/login`, `GET /api/session`, `POST /api/logout`, `POST /api/diagnostics` (owner Bearer, read only), `GET /api/overview`, `PUT /api/settings`, `GET/POST /api/nodes`, `POST /api/nodes/<id>/test`, `GET/POST /api/accounts`, `GET/PUT /api/accounts/<record-id>`, `POST /api/accounts/<record-id>/action`, owner-only `GET /api/accounts/<record-id>/qr`, profile save/rollback, audit pagination, and `POST /api/maintenance`.

Create bodies require a fresh 32–64-hex `nonce`; account actions require the current `version` and a nonce. Retrying the **same** request with the **same** nonce is safe. Reusing it with a different body is rejected. Treat a lost mutation response as ambiguous, inspect the record and reuse its original nonce—never blindly make a new financial/reset/renewal operation. SQL is parameterized. Server mutation statements are not wrapped in a blanket timeout; bounded node HTTP RPCs may have ambiguous results, which are handled conservatively by the credit protocol.

## Storage, maintenance and Free-plan reality

Only the manager holds users, entitlements, hashed sessions, nodes/key references, total/day/per-node counters, connection/credit records, profile revisions, idempotency receipts and audit. The legacy `nx_` tables are untouched. There is no per-frame D1 write and no node KV cache pretending to enforce a shared quota.

Nevertheless, admission, credits, settlement and 20-second authorization refreshes create real requests and D1 writes, including trigger/index work. **The implementation is not a guarantee of free high-volume proxy service.** Measure Workers CPU/requests, D1 reads/writes/indexes/storage and node connection counts on your own account. All Workers share account quotas. The 46-statement request guard is not a billed-row benchmark. TCP restrictions/Cloudflare Terms still apply; clean hosts/fallbacks do not bypass them automatically.

Optional manager cron **`17 * * * *`** prunes at most 100 expired sessions/probes, old leases and unreferenced old connections per table per invocation. Leases/connections are retained at least seven days; aggregate account/day/node counters remain. Idempotency receipts, identities and audit are not silently purged. The cap may not keep up with a busy service; monitor storage and export/archive under an explicit retention plan. No node cron is required.

Use a private Cloudflare **D1 export / Time Travel backup** for full recovery, plus a password manager for Worker Secrets. GUI link/QR export is not an accounting backup. Validate restoration on a separate non-production manager before changing a live endpoint. Do not reset/delete D1 to troubleshoot 1101.

## Optional CLI (not required for paste deployment)

```sh
npm ci                         # development only
npm run verify                 # reproducible delivery files, syntax, types, tests

# Configure YOUR real D1 ID and secrets first; placeholders are not deployable values.
WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.manager.toml --dry-run
WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.node.toml --dry-run

# Only when intentionally deploying your configured Workers:
npx wrangler deploy --config wrangler.manager.toml
# Fill NODE_ID / MANAGER_URL and set NODE_KEY separately for EACH node:
npx wrangler deploy --config wrangler.node.toml --name <YOUR_UNIQUE_NODE_WORKER_NAME>
```

`mesh/` contains editable original sources. `npm run build:mesh` assembles complete delivery files using only NexiUP-owned helpers and the already licensed QR/font. `npm run build:check` detects stale generated files. It does not load code from a repository at runtime or auto-deploy anything.

## 1101, the supplied file, and debugging

A concrete compatibility defect was reproduced: since compatibility date **2026-03-17**, binary WebSocket messages default to **Blob**, not ArrayBuffer. The uploaded file explicitly sets `binaryType='arraybuffer'`; old NexiUP 2.1.1 did not. A native test observed **Blob / zero bytes** before the fix and real WS/TCP forwarding afterwards. Both **Mesh node 3.0.0** and **legacy 2.1.2** set the property before `accept()`. Tests now model the new default instead of always supplying ArrayBuffer.

This is **not proof of every reported 1101**, and it is not a diagnosis of the user's Nahan deployment: the inspected Nahan 3.0.4 source **already sets binaryType**. Likewise, `request.fetcher` exists in current types/native runtime; the standard socket import also worked locally. There is no evidence that the uploaded file's ~4.8 MB trailing comment prevents exceptions. No padding trick or undocumented anti-detection claim was copied. Full comparison, provenance and pins are in [RESEARCH.md](RESEARCH.md).

- `/health` verifies active component/version without database or TCP work. Use the manager's owner-only read-only diagnostics for D1/table/trigger readiness.
- Ordinary errors carry a safe error code, version and random reference. Optional text variable **`NEXIUP_DIAGNOSTICS="true"`** emits fixed-field `nexiup_mesh_error` or `nexiup_mesh_tunnel_error` records, including post-upgrade failures, without raw messages, request URLs, keys or packet/configuration bodies. Turn it off after investigation.
- In Cloudflare **Workers & Pages → Worker → Logs → Live**, find those records. Full provider log envelopes can contain sensitive request URLs/headers; do **not** publish them. App-handled failures may have an `ok` invocation outcome despite HTTP 5xx or a closed tunnel.
- If `/health` itself is still a platform 1101 page, check the active deployed file/version/route and the platform exception. Module/platform failures cannot be caught by request code. Hosted logs/account access and Iranian/client testing were not available here; local workerd success is not production certification.

## Design decisions / assumptions

1. Two separate artifacts, not role switches or a fork of an unlicensed upstream panel. The manager has no socket import; the node loads the documented socket API only after admission. Neither public boot path acquires D1.
2. Stateless nodes and one authoritative D1 ledger instead of independent node quotas that multiply a subscription or eventually consistent KV counters that overshoot.
3. Reservation/refund accounting favors **not exceeding** a limit over guessing usage after crashes. Reported versus reserved/uncertain usage is explicit, including subscription header semantics.
4. Permissions are lease-bounded, not marketed as instantaneous distributed revocation. Reset/rotation drain windows, UTC daily boundaries and global tunnel admission are explicit.
5. Trusted operator-owned nodes, strong independent secrets, exact Origins/CSRF, no redirecting authenticated fetches, no runtime remote UI/code, no fabricated host/UUID/proxy defaults, no auto-deploy.
6. Legacy bot/accounts remain separate and preserved. Migration/billing integration requires an explicit plan; no silent identity/URL or financial-data migration is performed.
7. Before production confirm the active Cloudflare artifact, real TCP/client/ISP behavior, operator profiles, clocks, acceptable reconnect/reservation behavior, storage retention and actual Free CPU/D1 capacity. No live-account or Internet proxy success is inferred from the synthetic test network.
