# Mesh 3.0.0 + legacy 2.1.2 — verification

**Date:** 2026-10-23 Asia/Tehran. **Repository:** ArsalanAfshar/NexiUP. **Branch:** `arena/4a2b629b-nexiup`. Main is unchanged. [English setup](MESH.md) · [نصب فارسی](MESH_FA.md).

This records local, reproducible evidence—not a hosted Cloudflare deployment, actual Iranian/client connectivity, a security audit, or Free-capacity certification. No production credentials were requested, installed or used. Uploaded upstream code was inspected as data, not executed or vendored.

## Results / نتایج

| Check | Result |
|---|---|
| Reproducible delivery generation | PASS: `npm run build:check` compares complete committed artifacts against owned `mesh/` sources and licensed helpers |
| Syntax | PASS: Node **22.22.3**, all three delivery files |
| JavaScript types | PASS: TypeScript **5.9.3**, Workers types **5.20261019.1**, `checkJs`, no blanket type-check suppression |
| Default suite | **167 passed, 0 failed, 0 skipped**; approximately 7.5 seconds on the final run; **43 Mesh cases + all 124 legacy cases** |
| Native compatibility proof | PASS: 2026-03-16 without override gives ArrayBuffer/3 bytes; 2026-03-17 gives Blob/0 bytes in naive conversion; 2026-10-20 with explicit ArrayBuffer gives 3 bytes |
| Cold-boot source and bundles | PASS: public manager UI/health with missing or wrong D1; protected login returns structured 503; unconfigured node boots without D1/KV; six native cases across both artifact forms |
| Raw Mesh native integration | PASS: one manager + two nodes, real local workerd/D1, owner auth, observed bidirectional challenges, API enablement, one account/UUID, 12 Xray variants over two nodes, local PNG |
| Bundled Mesh native integration | Same complete flow PASS with both actual Wrangler modules |
| Native WS/TCP + shared quota | PASS for raw and bundled pair: VLESS node 1 admits **6 bytes**, Trojan node 2 **14 more**; final frame is sliced; total/day committed/report counters are **20**; next TCP connection is denied before dialing |
| Mesh browser | PASS: Playwright **1.64.1**, Chromium **153.0.0**, real local HTTPS/workerd/D1, cookie auth, CSRF, origin setup, two real API nodes, account create/all→selected, actual QR, renewal, pause/resume, profile isolation/rollback, XSS, FA/EN, 390px mobile |
| Legacy native integrations | Existing single-Worker and separate hub/node flows PASS; one remote account, three variants and PNG to Telegram fake preserved |
| Legacy native WebSocket regression | PASS on the modern compatibility date: **12 upload + 12 download** payload bytes echoed and persisted in the original usage tables |
| Legacy browser | Full existing HTTPS/session/business/proxy UI integration PASS; no external assets or browser JS/CSP errors |
| Independent QR decoding | jsQR **1.4.0** recovers exact 64-hex-token Mesh URLs, including a long hostname; PNG fixtures **7,908** and **15,593** bytes |
| Wrangler dry runs | PASS, pinned **4.151.3**, both named configs; **no deployment** |
| Legacy data/migrations | All five SQL migration groups compare identically to `85db43e`; no legacy identity/financial migration or reset added |
| Notices / bytes | MIT/Nayuki/OFL notices retained; embedded font unchanged, **46,308 bytes**, SHA-256 `84a382e46c30fb4f73d0e3800c16d0af15888e2731e57fa5f93e2c29a2c6a957` |
| Packaging | No uploaded 5 MB reference, runtime npm dependencies, node_modules, TLS test keys, bundle outputs or real customer/IP data included |

### A real failure was found, not explained away by a passing fake

Before the binary-type correction, the new native tunnel test received **Blob** objects, opened **zero** central connections/credit leases/TCP sockets, and hit the handshake deadline. The prior fakes always supplied ArrayBuffer and therefore missed this. The supplied working file explicitly set `binaryType='arraybuffer'`; both the new node and preserved legacy Worker now set it **before accept**. Test fakes default to Blob and assert the override at accept, and a separate dated native regression confirms the behavior.

This explains a concrete WebSocket parsing/connection failure. It **does not prove the exact cause of every user-reported 1101**, particularly a failure before the handler or in a different deployed revision. Nahan 3.0.4 already sets binaryType, so its reported hosted failure remains unconfirmed. Both connector functions existed in the inspected local runtime/types; the standard socket module also made a controlled local TCP connection. No anti-detection/padding claim is inferred. Pinned official evidence and the upload hash are in [RESEARCH.md](RESEARCH.md#2026-10-23--uploaded-worker-comparison-and-mesh-30).

### What “native” does and does not mean

`tests/mesh-native-harness.mjs` runs actual local workerd Workers, native D1, real WebSocket frames and a real sandbox TCP echo listener. **Only the TCP destination** is mapped by an explicit test-only source adapter to loopback. Production public-host validation, packet parsing, scoped authentication, authoritative ledger, byte admission, callbacks and close lifecycle are not bypassed. HTTP between the local manager and nodes is routed through local worker fetchers; public Cloudflare routing/TLS/ISP behavior is not thereby certified.

No attached or Nahan tunnel code is executed. No source adapter, loopback exception, synthetic account or auto-login is present in the production files. The browser's Node HTTPS test proxy maps its local origin to the disposable manager origin, validates the incoming Origin mapping, and forwards credentials/cookies normally. It does **not** relax production CSP/frame denial or log in automatically. Browser-only acceptance of a self-signed test certificate does not weaken production TLS.

## Accounting/security regression coverage

- One shared total/day pool across nodes, concurrent reservations bounded by database triggers, partial final frame, exact normal settlement/refund, duplicate grant/close/action idempotency, and mismatched report rejection.
- Network-wide admission limit, selected/all/current/future node membership, disabled/paused/expired/revoked states, separate per-node keys, rejection of owner-key reuse, no scoped-node account enumeration/control-panel privilege.
- Token rotation versus UUID rotation semantics; future-expiry renewal without hidden reset; stale-version/limit-below-reservation checks leave memberships unchanged; usage epochs and late-report isolation; UTC rollover and immutable old-day tunnel deadlines.
- Node loss and lost grant replies stay conservatively charged. Pruning preserves account/day/node totals and unknown reservation differences; administrative receipts are not silently removed.
- D1 table/trigger readiness, true read-only preflight before schema creation, missing/wrong bindings and primitive exceptions, owner hash/session/logout/Origin/CSRF, private owner QR while a public paused account stays inaccessible.
- Bidirectional API challenge must be recorded by the manager: a forged HTTP 200/echo without the return request fails. Redirects do not receive credentials.
- Bounded socket queue/message/credit sizes, serialized upload/downlink meter, permit deadline/round-trip conservatism, manager outage before TCP, only operator-supplied fallbacks, ignored client relay overrides, malformed early data before WebSocket allocation.
- Post-upgrade diagnostics are opt-in and fixed-field only; secret-looking error text, destination/query data, node key and UUID are absent from the record.
- Stable shared identity across full Xray operator variants, exact local PNG, isolated profile edits, monotonic rollback and atomic prevention of disabling all variants.

The default suite uses Node built-ins and real SQLite behind a D1-shaped adapter. Native/browser tools are optional development dependencies. SQL invocation counts do **not** measure billed rows/index writes, and none of these tests is a production load benchmark. Nodes are trusted operator software, not cryptographically attested meters; payload admission counts are not proof of delivery to an Internet destination.

## Artifact measurements

UTF-8 bytes; Node `gzipSync` defaults, level 6; 1 KiB = 1,024 bytes. Optional bundle measurements exclude its development source map.

| Artifact | Raw | gzip |
|---|---:|---:|
| manager-worker.js (paste-ready) | **255,066** (249.09 KiB) | **106,187** (103.70 KiB) |
| node-worker.js (paste-ready) | **23,898** (23.34 KiB) | **8,896** (8.69 KiB) |
| Wrangler manager module | **253,314** (247.38 KiB) | **104,831** (102.37 KiB) |
| Wrangler node module | **25,765** (25.16 KiB) | **8,340** (8.14 KiB) |
| worker.js (legacy 2.1.2) | **496,922** (485.28 KiB) | **179,659** (175.45 KiB) |

SHA-256:

```text
manager          24f702be697cb89ca599aac3539420efb0daf1bd617295d5e62e59b1f1b43cb8
node             01537d8119a56d1edc9bbfffe1743c4fb3d7c9e006194dc4a0d66ba9905a259a
manager_bundle   79dd565eef590f726aea15fb83ca19e72ec704b1ef58260830cce460a8207fd6
node_bundle      fa9af70c23b72790e287950a221df027ddcc4a9735b6f3012a4606a4c1d78992
legacy           0e1c548829ff3bb2064d882d07c531e717c10ad47f308a709bd1db0e1f39cadb
```

Each delivery file is self-contained. The documented size cap is not a CPU, request, D1, memory or price guarantee. Manager has no socket import or remote UI; node has no D1/KV layer and loads the documented socket module only on authenticated TCP handling. The two files do not need to import one another at runtime.

## Reproduce

```sh
npm ci
npm run verify

# Optional local tooling, not part of the deployment:
npm install --no-save --package-lock=false miniflare@5.20261019.1-beta wrangler@4.151.3 playwright@1.64.1
node tests/websocket-compat-smoke.mjs
node tests/mesh-boot-smoke.mjs
node tests/mesh-workerd-smoke.mjs
node tests/legacy-websocket-smoke.mjs
node tests/workerd-smoke.mjs
node tests/remote-workerd-smoke.mjs

WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.manager.toml --dry-run --outdir .work/mesh-manager-bundle
WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.node.toml --dry-run --outdir .work/mesh-node-bundle
node tests/mesh-boot-smoke.mjs .work/mesh-manager-bundle/manager-worker.js .work/mesh-node-bundle/node-worker.js
node tests/mesh-workerd-smoke.mjs .work/mesh-manager-bundle/manager-worker.js .work/mesh-node-bundle/node-worker.js

npx playwright install --with-deps chromium
node tests/mesh-browser-smoke.mjs
node tests/browser-smoke.mjs
```

The test environment used `@sparticuz/chromium` **153.0.0** and its packaged Linux libraries, without disabling web security. Browser tests additionally use `openssl` for disposable TLS certificates, removed after execution. Optional module paths: `MINIFLARE_MODULE`, `PLAYWRIGHT_MODULE`, `CHROMIUM_EXECUTABLE`. Artifacts/tooling are under ignored `.work/`; no dev server or production deployment is required. `tests/qr-helpers.mjs` now hosts the shared independent pixel reader without accidentally registering duplicate tests.

## Not established / تأییدنشده

1. The user's actual Cloudflare 1101 cause, active deployment, exception/stack or Nahan outage. No authenticated account logs or production deployment were available.
2. Public TCP/ProxyIP reachability, exit country, real Iranian operator/ECH behavior, and Android/iOS/Windows client imports. No real proxy inventory was manufactured.
3. Free production throughput/CPU/D1/requests/storage. No code dependency on a paid add-on does not imply arbitrary traffic is free.
4. Instant distributed revocation, physical device counts or uninterrupted long transfers. The documented permit/reconnect/credit limits are real, intentional boundaries.
5. Exact delivered-byte accounting after crashes or lost responses. Unknown reservations are visible and conservative; trusted nodes and reasonably synchronized provider clocks are required.
6. Automatic migration of legacy billing/UUIDs/URLs or automatic Telegram provisioning into Mesh. Legacy remains separate and preserved.
7. Full upstream feature parity, UDP/Shadowsocks/XHTTP/gRPC in this pair, remote-code auto-deploy, or an independent security/legal audit.

**فارسی:** ۱۶۷ تست، فایل خام و bundle، دو نود/مدیر واقعی محلی، WebSocket/TCP با echo آزمایشی و مرورگر HTTPS موفق‌اند. تفاوت Blob/ArrayBuffer واقعاً بازتولید و در هر دو نود جدید و جزء قدیمی اصلاح شد؛ ولی علت حساب نهان یا همهٔ 1101ها از این نتیجه درنمی‌آید. سقف مشترک ۲۰ بایت با ۶+۱۴ بایت دو نود، برش قطعهٔ آخر و رد TCP بعدی تأیید شد. نه استقرار حساب واقعی، نه IP/اپراتور زنده و نه ظرفیت Free گواهی نشده است. reset مالی/مهاجرت پنهان یا کپی فایل بالادستی رخ نداده و main دست‌نخورده است.
