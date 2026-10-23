# NexiUP Mesh · 3.0.0

**[فارسی](README_FA.md)** · **[Complete setup](docs/MESH.md)** · [Verification](docs/MESH_VERIFICATION.md) · [Source comparison](docs/RESEARCH.md#2026-10-23--uploaded-worker-comparison-and-mesh-30) · [Licenses](THIRD_PARTY.md)

**One central web manager. Multiple independent Cloudflare Worker nodes. One subscription identity and one shared total/daily allowance. No Nahan runtime dependency.**

## Download the correct two files

| File | Purpose |
|---|---|
| **[manager-worker.js](manager-worker.js)** | Deploy once. Web panel, accounts, node registry, subscriptions/PNG QR and authoritative D1 quota ledger. |
| **[node-worker.js](node-worker.js)** | Deploy to every node. API pairing and VLESS/Trojan TCP over TLS WebSocket; no D1 or KV on nodes. |

These are **complete standalone ES modules**. Paste the entire selected file; no npm, build, remote UI or VPS is required to install it. Nodes do not need Nahan, a master key or a role switch.

Current work is on **`arena/4a2b629b-nexiup`**. **Main is intentionally unchanged**; do not assume the default branch contains this release. The `mesh/` files are development sources, not additional deployment files.

> `worker.js` is the preserved **legacy 2.1.2 bot/all-in-one Worker**, not the Mesh manager or node. The existing Telegram/payment/wallet/referral/proxy-catalog features remain there. **They do not automatically provision Mesh accounts.** Read [the legacy guide](docs/LEGACY.md) for that component. Deploy Mesh to a **new Worker/origin** and back up D1; there is no silent migration of old accounts, financial records or subscription URLs. Root `wrangler.toml` is legacy; Mesh has two named configs.

## Quick setup

1. **Manager:** create a new Worker, paste `manager-worker.js`, bind D1 as **`DB`**, and set a strong random ASCII secret **`OWNER_KEY`** (32–256 characters).
2. **Both files:** compatibility date `2026-10-20` or later and flag **`global_fetch_strictly_public`**. Deploy. `/health` identifies the active component/version without pretending to test the database or network.
3. **Manager panel:** open `/admin` and log in with `OWNER_KEY`. First authorized login initializes `nx3_` tables. Save the manager's real canonical HTTPS origin in **Settings**.
4. **Each node:** create another Worker with `node-worker.js`. Set **`NODE_ID`**, **`MANAGER_URL`** (that canonical manager origin) and a distinct secret **`NODE_KEY`**. **No node D1/KV/cron is needed.**
5. **Pair:** put the same node key in a manager Secret named `NODE_KEY_<NAME>`. In **Nodes**, enter the node ID, HTTPS origin and **reference name**, not the secret value. Save, **Test API**, then **Enable**. The manager must actually observe the node's challenge; HTTP 200 alone is not proof.
6. **Create:** in **Subscriptions**, choose positive total/daily GiB, days/expiry, concurrent-tunnel admission limit, protocol and **all active/current/future nodes** or selected nodes. Deliver the single URL/QR. Nodes authorize the account on demand; manual account creation on every node is unnecessary.

Full instructions, API/credential separation, quota semantics, troubleshooting and upgrade precautions: **[docs/MESH.md](docs/MESH.md)** / **[docs/MESH_FA.md](docs/MESH_FA.md)**.

## What the web panel does

- Persian/English, RTL/LTR, responsive desktop/mobile, secure sessions/CSRF/logout.
- Node registration, bidirectional API testing, enable/disable, explicit clean host and up to four operator-supplied fallback endpoints. Country is a claim, not proof of exit geography.
- Real create/edit/renew/pause/resume/revoke/reset; durable idempotency and optimistic version checks. Renewing preserves usage unless reset is explicitly requested.
- One UUID across permitted nodes and operator variants; one canonical subscription URL, locally generated PNG QR, full Xray JSON and raw/base64 exports. Incompatible export formats fail explicitly.
- Independent Irancell/Hamrah/standard operator settings with validation and versioned rollback. Actual client/ISP compatibility is not certified.
- Distinct reported, reserved/uncertain and per-node usage, UTC daily counters, audit, read-only deployment diagnostics and bounded optional maintenance.

No fabricated live IP inventory or production host/UUID/key defaults are installed. Auto-code deployment is not implemented.

## Shared limits, without multiplying an account

A **10 GiB account on three nodes is still 10 GiB total**. The central D1 transaction reserves byte credits before any node forwards payload. Upload/download consume the same local serialized credit, and a last frame is sliced to the remaining allowance. No per-frame D1 writes occur.

Confirmed closure refunds unused credits **once**. Lost-node/ambiguous credit remains conservatively charged and is displayed separately—not invented as verified usage or automatically refunded. Normal reports settle at credit rollover/close. The subscription header includes reservations to avoid understating committed allowance.

Daily allowance resets at **00:00 UTC**. Fresh admission checks account/node/membership/expiry; existing permissions last at most **30 seconds** and refresh every 20 seconds. Reset and identity rotation have a 31.5-second drain window. A tunnel currently lasts at most **four minutes** and has a **36-control-RPC budget**, so clients must reconnect; very long uninterrupted transfers are not guaranteed. Global admission counts **tunnels, not physical devices**.

Nodes must be **trusted and controlled by you**; a malicious operator/node can bypass its own meter. Manager failure is fail-closed. Current guard: **12 nodes**, bounded buffers and finite positive plans. Supported transport: **VLESS/Trojan over TLS WebSocket, TCP**; UDP/Shadowsocks/XHTTP/gRPC are not part of this pair.

**Free is not a capacity promise.** No paid add-on is required by code, but central admission, reservation, settlement and authorization refreshes consume real requests/D1 writes, including indexes/triggers. Measure CPU, account-wide quotas, storage and client behavior before production. Keep private D1 exports and Worker Secrets backed up.

## The uploaded working file and 1101

The uploaded file was inspected, not blindly copied. A **real compatibility difference** was reproduced: from compatibility date **2026-03-17**, binary WebSocket frames default to **Blob**. The uploaded file explicitly selects `binaryType='arraybuffer'`; NexiUP 2.1.1 did not. The native test saw **Blob → zero bytes in the naive conversion**, then working native WS/TCP after the fix. Mesh node 3.0.0 and legacy 2.1.2 now set it **before `accept()`**, with regression tests that model Blob defaults.

This is **not a blanket explanation for every 1101**. Nahan 3.0.4 already has that setting, so its reported hosted failure is not diagnosed by this finding. `request.fetcher` exists in current types/native runtime; the standard socket import also worked locally. There is no evidence that the supplied file's ~4.8 MB trailing comment prevents exceptions. The manager has no socket import; nodes load the documented socket API after authorization, and neither public boot path acquires D1.

If the new `/health` remains a platform error, actual active-version/route and exception evidence is still needed. Read-only diagnostics and opt-in **`NEXIUP_DIAGNOSTICS="true"`** produce safe fixed-field references, including post-upgrade tunnel errors. Do not share full Cloudflare log envelopes containing credentials or subscription URLs. No live Cloudflare account deployment or Iranian-network success is claimed.

## Development and verification

```sh
npm ci
npm run verify                  # reproducible artifacts + syntax + checkJs + tests
npm run build:mesh              # only needed after editing mesh/ or owned helpers

# Configure actual IDs/variables/secrets before any real deployment:
WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.manager.toml --dry-run
WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.node.toml --dry-run
```

**167 built-in tests pass**, including 43 new Mesh cases and all 124 legacy cases. Native workerd checks exercise raw **and bundled** manager/two-node deployments with real D1, observed bidirectional challenges and actual WebSockets/TCP to a **test-only local echo**. One node admitted 6 bytes and another exactly 14 more against a shared 20-byte daily cap; the next byte/new TCP connection was refused. The real HTTPS browser test covers authenticated setup, nodes, account creation/selection, QR, renewal, pause/resume, profile isolation/rollback, XSS and FA/EN mobile workflows. This is local evidence, not production/ISP/Free-capacity certification. Details, commands and hashes: [verification](docs/MESH_VERIFICATION.md).

## Design decisions

1. Two self-contained artifacts with independent boot paths, not an upstream UI fork or a role-switch installation puzzle.
2. One authoritative D1 ledger and stateless nodes, not per-node allowance multiplication or eventually consistent KV enforcement.
3. Reserve-before-forward, explicit uncertainty, bounded permission leases and stable action IDs; no guessed refunds or blind mutation retry.
4. Strong distinct environment-backed owner/node secrets, hashed sessions, Origin/CSRF, no credential-following redirects, no remote assets/code or telemetry.
5. Preserve the legacy bot/data and fix its WebSocket compatibility without silently migrating billing, identity or URLs into Mesh.
6. Production assumptions requiring confirmation: trusted nodes/clocks, actual deployed artifact, TCP/client/ISP support, operator profiles, acceptable reconnect/reservation behavior, retention and measured Cloudflare Free capacity.

NexiUP-owned code is MIT. The local QR encoder retains Nayuki's MIT notice; the manager's unmodified Vazirmatn font retains full SIL OFL-1.1 notices. No uploaded/Nahan/edgetunnel source or remote dashboard was vendored. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md). Follow Cloudflare Terms and applicable law; **no warranty**.
