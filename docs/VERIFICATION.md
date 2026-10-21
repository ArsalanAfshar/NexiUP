# Verification record / گزارش راستی‌آزمایی

Version **2.1.1**. Date: **2026-10-21 Asia/Tehran**. Repository: `ArsalanAfshar/NexiUP`. Working branch: `arena/4a2b629b-nexiup`.

This records reproducible **local** checks, not production deployment, an independent security audit, Cloudflare Free capacity certification or Iranian-network success.

این گزارش آزمون **محلی** قابل‌تکرار است، نه استقرار تولید، ممیزی مستقل امنیت، تضمین ظرفیت Free یا موفقیت اینترنت ایران.

## Results / نتایج

| Check | Result |
|---|---|
| `node --check worker.js` | PASS, Node **22.22.3** |
| `npm run typecheck` | PASS: TypeScript **5.9.3**, Workers types **5.20261019.1**, `checkJs` on the production file |
| `npm run verify` / built-in tests | **124 passed, 0 failed, 0 skipped**; runner approximately **5.5 s**; no runtime npm dependencies |
| Deployment/error regressions | **26 passed** in `tests/deployment.test.mjs`; original uncaught binding/null/undefined paths failed before the patch |
| Raw + bundled deployment matrix | **18 native local scenarios passed**, directly in workerd without a dev/auto-login proxy; missing/wrong bindings, fresh D1, real owner login/API for `all`, `hub`, `node`, and injected getter/null/undefined/unresolved-read faults |
| Single-Worker native smoke | PASS: five migration groups **plus final seeding**, native local D1 triggers, authenticated account creation, three Xray variants, embedded dashboard, **5,603-byte PNG QR**, exact additive usage |
| Two-Worker native smoke | PASS: separate hub/node D1, panel-key-authenticated HTTP burst, exactly one remote account, three main-domain variants, PNG + metadata to a Telegram fake |
| Real-browser integration | PASS: Playwright **1.64.1**, Chromium **153.0.0**, local HTTPS/workerd/D1; synthetic fixture data; read-only setup diagnostics, safe failure-reference display, desktop/mobile and FA/EN workflows |
| Independent QR scan | jsQR **1.4.0** recovered exact synthetic subscription URLs from current PNG pixels; built-in independent PNG reader also passes |
| Wrangler dry-run | PASS, Wrangler **4.151.3**; **no deployment** |
| Legal notices | NexiUP MIT, Nayuki MIT and Vazirmatn **OFL-1.1** notices all present in source and optional bundle; complete font notice also served inside the UI CSS |
| Diff/packaging | `git diff --check` passed; no node_modules, build output, reference clones, live credentials or real receipt/IP datasets included |

Default tests use Node built-ins (`node:test`, SQLite, assertions, crypto, streams, VM and zlib), not a test framework. The D1-shaped fake runs real SQLite transactions, indexes, UNIQUE/CHECK constraints and triggers. Network/socket fakes are marked as such. Optional native tests run **Miniflare 5.20261019.1-beta/workerd**. Only the default Worker handler is exported by the production file; test-only loaders expose private helpers.

مجموعه پیش‌فرض از ابزارهای داخلی Node و SQLite واقعی استفاده می‌کند؛ پاسخ موفق از پیش‌ساخته جای تراکنش و شرط SQL را نگرفته است. شبکه/سوکت ساختگی مشخص‌اند؛ تست native نیز workerd واقعی محلی دارد. فایل تولید فقط handler Worker را export می‌کند.

## Reported hosted 1101 — evidence boundaries / مرز شواهد خطای 1101

The user reports that both installation methods fail on Cloudflare while local execution succeeds, after checking configuration. **This account-specific failure has not been reproduced or diagnosed from hosted logs.** No authenticated Cloudflare connector/deployment access or hosted exception/stack was available. This report therefore does not mark the real incident resolved.

Before editing 2.1.0 (`ff1509e`), regression calls reproduced an escaping `env.DB` getter failure before the request `try`, and `null`/`undefined` rejection causing the catch itself to throw while reading `retry`. These are concrete source defects but **not evidence of which exception occurred in the user's account**. Source inspection did not establish a module-startup defect. Official 1101/error and live-log references are pinned in [RESEARCH.md](RESEARCH.md).

### What the 2.1.1 tests establish

- Public `/`, `/health`, `/admin`, `/setup` do not acquire D1. Missing environment/binding, invalid binding types and throwing accessors are covered. Health explicitly says `database_checked:false`, not database readiness.
- Request and scheduled initialization stay inside recovery boundaries. Null, undefined, strings, numbers, hostile getters/prototypes and a failing logger cannot turn error handling into another unhandled exception. Only locally created faults are trusted; the last-resort response uses literals.
- Failed D1 calls produce safe structured failure codes; a real missing application table still requires setup, but an unrelated D1 outage does not get mislabeled as a missing migration. Newer schema versions are not silently downgraded.
- Read-only `POST /setup` diagnostics authenticates before D1 access, requires HTTPS/acceptable Origin, accepts the role's setup/master owner or a dedicated web owner for this read-only action only, and neither migrates nor calls external services. It checks tables/version/seeding even when the regular readiness cache was already warm. Four guarded statements and **zero writes** were measured on a ready fixture.
- Individual SELECT reads and the overall preflight have eight-second deadlines. The native matrix waits through a **real eight-second unresolved read** in each artifact. Late reads cannot start further preflight queries after the overall deadline. D1 execution itself is not canceled. Tests verify that writes/batches get **no new deadline or automatic retry**.
- Error references appear in safe JSON/headers and the web login. Application logging defaults off; explicit opt-in emits fixed categories, version, random request ID and numeric source positions only. Tests inject secret-looking messages, paths and URLs and verify none appear in responses/logs. Full provider log envelopes may still contain request information; do not share them unredacted.
- The raw source and optional Wrangler bundle both pass missing/wrong-binding cases and fresh **native D1** authenticated initialization/login/API flows in `all`, `hub`, `node`. Fault injection is explicitly test-only; the actual application handler is tested without the synthetic preview/automatic login wrapper.
- All **five migration groups** compare identically with 2.1.0. No schema migration, identity reset, database deletion or key rotation was added. QR code/license and the embedded font bytes are unchanged. The previous 98 business/web/proxy regressions still pass, alongside 26 new ones.

The full browser suite also reran successfully with real local HTTPS/workerd/D1 and real cookie authentication. It exercises the new setup diagnostic button without writes. The preview deliberately lacks a Telegram bot token, and the report correctly remains `ready:false` despite a ready database. A separately marked, client-only injected 503 verifies reference display and password-field clearing; the real login and existing business workflows then run normally.

**Cannot establish here:** that the affected hostname serves this artifact, the hosted exception's cause, platform/module-startup behavior on that account, actual D1/Workers quotas/CPU, or Telegram/node/ISP success. A JavaScript catch cannot intercept module-instantiation/platform termination or replace an already-sent streaming/WebSocket response. If the new `/health` also remains a Cloudflare 1101 page, owner-side version/route and platform exception evidence is needed; do not keep deleting/recreating D1.

**فارسی:** این گزارش، رفع قطعی حادثهٔ حساب واقعی نیست. خطاهای مهارنشدهٔ مشخص در کد قبلی بازتولید و اصلاح شدند؛ هر دو خروجی خام/bundle و هر سه نقش در workerd محلی با D1 واقعی آزموده شدند. بررسی خواندنی، چهار دستور و صفر نوشتن دارد و موفقیت تلگرام/نود را جعل نمی‌کند. ۱۲۴ تست، مرورگر و smokeهای native موفق‌اند؛ همه پنج گروه مهاجرت، هویت حساب‌ها و داده‌ها دست‌نخورده‌اند. برای تشخیص حادثهٔ میزبان، نشان نسخه و گزارش امن لازم است، نه تکرار نصب یا حذف دیتابیس.

## Exact size measurements / اندازه دقیق

Node `gzipSync` defaults (gzip level 6); 1 KiB = 1,024 bytes:

| Artifact | Uncompressed | gzip |
|---|---:|---:|
| Paste-ready `worker.js` | **496,735 bytes** (485.09 KiB) | **179,541 bytes** (175.33 KiB) |
| Optional Wrangler upload module | **530,359 bytes** (517.93 KiB) | **178,285 bytes** (174.11 KiB) |

```text
wrangler 4.151.3
Total Upload: 517.93 KiB / gzip: 174.11 KiB
--dry-run: exiting now.
```

Current documented Workers Free size limit is **64 MiB uncompressed (67,108,864 bytes)**, with **no compressed-size limit**. This bundle is **0.79%** of that uncompressed ceiling. Being below the size cap does not prove CPU/memory/D1/traffic feasibility. Source needs no build; bundling is optional. An unmodified 46,308-byte Arabic variable font is embedded as a data URI and accounts for part of the size increase; it causes no external font request.

سقف مستند Free، **۶۴ MiB غیرفشرده** و بدون سقف اندازه فشرده است. bundle حدود **۰٫۷۹٪** آن است؛ این اندازه به‌معنی رعایت CPU/D1 یا تضمین رایگان‌ماندن نیست. فونت فارسی ۴۶٬۳۰۸بایتی داخل فایل است و دانلود بیرونی ندارد.

SHA-256:

```text
worker.js       b2e2a7048522248a6769e6039893d907dfd4ad59df58c809fc1629322661ee30
Wrangler module 186f44064e4e10b6aae68efc6a298b47ff3afd254865981ef83754383128cf57
```

Size rule evidence: [official limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size), and [pinned official source](https://github.com/cloudflare/cloudflare-docs/blob/da69fa833be0a8dc9d9ed6d9429c8ee0c4efbd8e/src/content/docs/workers/platform/limits.mdx). Other limits/source pins are in [RESEARCH.md](RESEARCH.md).

### Bounded SQL checks, not billing benchmarks

Measured by the runtime's own statement guard in SQLite fixtures:

| Operation fixture | D1 statements | External fetches |
|---|---:|---:|
| Owner deployment preflight, initialized database | **4** | **0** (also **0 writes**) |
| Complete 20-row import helper | **9** | 0 |
| Apply four endpoints to local fallback | **11** | 0 |
| Remote account issuance with four bases, ProxyIP defaults and five configured owners | **23** | **4** |

The import/application helper rows exclude HTTP session/CSRF entry checks; all are below the runtime guard of **46 statements**, itself below D1's 50. They are bounded regression fixtures, **not an exhaustive worst-case proof**. They do not measure billed rows/index writes or hosted CPU. Catalog summaries may scan up to 2,000 records. The default ProxyIP probe budget is 500 attempts/day, but import frequency, the rest of the bot and other account Workers share Free quotas. There are still no per-frame tunnel writes.

این شمارش، دستور SQL است، نه تعداد ردیف قابل‌صورتحساب یا اندازه‌گیری CPU تولید. نقش ورود HTTP، ایندکس، دفعات واردسازی و بار دیگر حساب باید جدا پایش شوند؛ هیچ تضمین ظرفیت Free از این جدول نتیجه نمی‌شود.

## Covered behavior / رفتارهای پوشش‌داده‌شده

- Idempotent paid approval and durable `pending → processing → done`; non-admin/unpaid rejection of approval; unique local names and normalized concurrent creation.
- Wallet/split-payment deduplication, atomic refunds/withdrawals, first-offer and coupon concurrency/capacity, receipt replay not reopening closed orders.
- HTTP webhook purchase/receipt/approval/provision/delivery end-to-end with persisted conversational state; due-time queue ordering prevents an old retrying operation/job from monopolizing newer eligible work.
- Exact node location/purpose selection, exclusive D1 locks, safe preflight failover, no failover/recreate after an ambiguous stock mutation, node quarantine, correct Bearer key-reference resolution including upstream short-key format.
- Automatic test settings/limits, designated-node enforcement, concurrent request coalescing, success-time cooldown, no cooldown consumption on definite failure and audited reset.
- Renewal extension from future/expired expiry, stable main token/identity, reset idempotency and stale-epoch fencing.
- Real additive byte accounting, duplicate flush receipts, no per-frame writes, VLESS/Trojan TCP stream forwarding, authentication rejection, kill switch, and malformed early data returning before creating repeating timers.
- Mandatory webhook secret before D1 access, private-chat boundaries, current admin permission on every privileged callback/conversation, signed user-bound callbacks.
- Main-domain URL validation, PNG upload/caption equality, independent pixel-level QR decoding, Unicode/percent-safe text splitting, one full config/message, fallback ownership/rate limit and Telegram 429 cursor preservation.
- Independent operator settings, exact owner-supplied defaults, mask/range/cipher validation, monotonic rollback, active-set variant budget, one-vs-two scalar ECH entries and shared identity.
- Base64/raw URI encoding, full Xray JSON shapes, representable Clash/sing-box fixtures and explicit 422/fallback rather than silently malformed advanced outputs.
- Cached base configurations served without node connectivity; live profile updates on the same main URL; authenticated base retrieval for a capped account.
- Embedded script syntax/no third-party assets; initialized role-separated APIs; panel-key registration/master isolation; 70%/90% account-request warnings deduplicated by UTC date; bounded cron maintenance.
- Workers-compatible `redirect:'manual'` plus explicit rejection of 3xx, so node credentials are never followed to a redirect target. The two-Worker native-runtime smoke checks actual fetch behavior rather than relying on Node's more permissive `redirect:'error'` implementation.

پوشش شامل گردش خرید کامل، اتمی‌بودن مالی/تست، هم‌زمانی و تکرار، محدودیت نود/کشور، بازیابی و قرنطینه، تمدید/reset، بایت‌شماری و مسیر تونل، مجوز وبهوک/مدیر، QR از روی پیکسل، ارسال واقعی هر کانفیگ، حفظ cursor در 429، استقلال/نسخه‌بندی پروفایل، ECH صحیح، قالب‌های معتبر و رد روشن قالب ناسازگار، به‌روزرسانی URL موجود، هشدار مصرف و رفتار fetch واقعی workerd است.

### Added in 2.1 / افزوده‌شده در ۲٫۱

- `checkJs` source diagnostics: menu/button union annotations and QR factory/static members; no `@ts-nocheck` or blanket source suppression.
- **40 web/ProxyIP tests**: role boundaries; HTTPS/Bearer/cookie login; wrong/expired/rotated sessions; credential forms redirected from HTTP to HTTPS; CSRF/Origin; private Symbol actor cannot be forged by JSON/Telegram; receipt masking/streaming; idempotent owner wallet/order/account actions; version-conflict validation; old-v4 data preserved.
- Readiness requires both migration version **five** and completed seeding. Both native smoke scripts stop on `ready:true`, not a hardcoded old count. An incomplete schema no longer reaches a misleading 422 subscription response.
- Separate `/admin/web-api/` namespace preserves legacy `api_route=admin` API, dashboard, subscriptions and tunnel path. Web/setup/master secrets cannot be registered as weaker hub-facing node keys.
- Country catalog parsing/normalization, bounded JSON/simple CSV, preserved test evidence, exact 2,000-entry capacity, genuinely concurrent imports, repeated cursors, cancellation racing an in-flight batch, atomic data/cursor/count updates across an interrupted reply.
- Synthetic TCP/TLS stream fixtures assert the requested TLS hostname, raw/upgraded stream cleanup, deadlines/response limits, chunked HTTP trace parsing, public exit/provenance fields and refusal to promote TCP/provider reports to relay verification. Malformed remote reports are rejected.
- Durable daily attempted-test budget, per-origin cooldown, explicit override for unverified/stale/wrong-target evidence, real D1 fallback application, rollback fencing and future-only remote per-account defaults using panel keys.
- Actual tunnel-handler stream test exercises direct failure followed by **all four** stored fallbacks with explicit ports, original-port inheritance, ignored client `proxyip` overrides and no per-frame D1 writes.
- Browser test performs HTTPS login/CSRF/logout, no credential localStorage/sessionStorage, FA/EN RTL/LTR, desktop 1,440 px and mobile 390 px (no document-wide horizontal overflow), mobile navigation, validated plan/account creation, isolated profile save/rollback, order rejection, queue filters, legacy-tool link, ProxyIP import/country filter/apply/rollback and source-label XSS escaping. No external asset requests or browser JavaScript/CSP errors.

آزمون‌های جدید، ورود امن/مجوز نقش/CSRF، حفظ داده و آماده‌سازی کامل، تکرار و هم‌زمانی/لغو واردسازی، اعتبار و منشأ مدرک آزمون، چهار fallback واقعیِ سوکت شبیه‌سازی‌شده، اعمال واقعی D1 و گردش مرورگر فارسی/انگلیسی و موبایل را پوشش می‌دهند. منابع عمومی، خود IPها و شبکه ایران در این تست‌ها زنده آزموده نشده‌اند.

### Added in 2.1 / افزوده‌شده در ۲٫۱

- `checkJs` source diagnostics: menu/button union annotations and QR factory/static members; no `@ts-nocheck` or blanket source suppression.
- **40 web/ProxyIP tests**: role boundaries; HTTPS/Bearer/cookie login; wrong/expired/rotated sessions; CSRF/Origin; private Symbol actor cannot be forged by JSON/Telegram; receipt masking/streaming; idempotent owner wallet/order/account actions; version-conflict validation; old-v4 data preserved.
- Readiness requires both migration version **five** and completed seeding. Both native smoke scripts stop on `ready:true`, not a hardcoded old count. An incomplete schema no longer reaches a misleading 422 subscription response.
- Separate `/admin/web-api/` namespace preserves legacy `api_route=admin` API, dashboard, subscriptions and tunnel path. Web/setup/master secrets cannot be registered as weaker hub-facing node keys.
- Country catalog parsing/normalization, bounded JSON/simple CSV, preserved test evidence, exact 2,000-entry capacity, genuinely concurrent imports, repeated cursors, cancellation racing an in-flight batch, atomic data/cursor/count updates across an interrupted reply.
- Synthetic TCP/TLS stream fixtures assert the requested TLS hostname, raw/upgraded stream cleanup, deadlines/response limits, chunked HTTP trace parsing, public exit/provenance fields and refusal to promote TCP/provider reports to relay verification. Malformed remote reports are rejected.
- Durable daily attempted-test budget, per-origin cooldown, explicit override for unverified/stale/wrong-target evidence, real D1 fallback application, rollback fencing and future-only remote per-account defaults using panel keys.
- Actual tunnel-handler stream test exercises direct failure followed by **all four** stored fallbacks with explicit ports, original-port inheritance, ignored client `proxyip` overrides and no per-frame D1 writes.
- Browser test performs HTTPS login/CSRF/logout, no credential localStorage/sessionStorage, FA/EN RTL/LTR, desktop 1,440 px and mobile 390 px (no document-wide horizontal overflow), mobile navigation, validated plan/account creation, isolated profile save/rollback, order rejection, queue filters, legacy-tool link, ProxyIP import/country filter/apply/rollback and source-label XSS escaping. No external asset requests or browser JavaScript/CSP errors.

آزمون‌های جدید، ورود امن/مجوز نقش/CSRF، حفظ داده و آماده‌سازی کامل، تکرار و هم‌زمانی/لغو واردسازی، اعتبار و منشأ مدرک آزمون، چهار fallback واقعیِ سوکت شبیه‌سازی‌شده، اعمال واقعی D1 و گردش مرورگر فارسی/انگلیسی و موبایل را پوشش می‌دهند. منابع عمومی، خود IPها و شبکه ایران در این تست‌ها زنده آزموده نشده‌اند.

## Reproduce / تکرار آزمون

Dependency-free syntax/default test suite:

```sh
node --check worker.js
npm test
```

Pinned development-only compiler checks:

```sh
npm ci
npm run verify
```

Optional local native/browser tooling (not needed for dashboard deployment):

```sh
npm install --no-save --package-lock=false miniflare@5.20261019.1-beta wrangler@4.151.3 playwright@1.64.1
node tests/workerd-smoke.mjs
node tests/remote-workerd-smoke.mjs
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir .work/bundle
node tests/deployment-workerd-smoke.mjs worker.js .work/bundle/worker.js
npx playwright install --with-deps chromium
node tests/browser-smoke.mjs
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run
```

The browser test additionally needs `openssl` for a disposable, one-day localhost TLS certificate. It sets browser-only `ignoreHTTPSErrors` for that self-signed test origin; this does **not** disable production probe TLS verification. This environment used the Chromium 153.0.0 binary from `@sparticuz/chromium` (with its packaged Linux shared libraries), without `--disable-web-security`. The production worker's CSP remains in the browser test; only the dev wrapper's iframe exception differs from production.

Tests accept optional `MINIFLARE_MODULE=file:///absolute/path/to/miniflare/dist/src/index.js`, `PLAYWRIGHT_MODULE=file:///absolute/path/to/playwright/index.mjs` and `CHROMIUM_EXECUTABLE=/absolute/path/to/chromium`. Browser artifacts and temporary certificates are under ignored `.work/`; certificates are removed after the test. Do not commit dependency directories or generated bundles. Optional tool installation does not add runtime dependencies.

The disposable preview is explicit:

```sh
# Development only; synthetic records, no working proxies, no production keys:
PREVIEW_AUTO_LOGIN=1 node tests/preview.mjs
# http://localhost:8787/admin (server binds 0.0.0.0)
```

`tests/preview.mjs` generates its own keys/data, does not read production credentials, intercepts external HTTP and rejects network-diagnostic routes. It can serve the UI in a preview iframe; the deployed Worker still denies framing and requires owner authentication. Do not expose a credentialed production system through this development wrapper. The browser test uses real cookie login, **not** auto-login.

مسیر پیش‌فرض package نمی‌خواهد؛ بررسی نوع، ابزار توسعه اختیاری دارد. تست مرورگر، ورود واقعی با cookie را آزمایش می‌کند، نه ورود خودکار. پیش‌نمایش جدا، کلید/داده ساختگی می‌سازد و تست شبکه را عمداً مسدود می‌کند؛ هیچ اتصال موفق واقعی به کاربر نسبت داده نمی‌شود. خروجی build، dependency، گواهی موقت و داده تولید را commit نکنید.

## Not verified / تأییدنشده

1. **No confirmation that the reported hosted 1101 is resolved; no real Cloudflare deployment or Telegram delivery.** Bot token/webhook, actual rendering/delivery/rate limits and customer workflows need an owner-controlled staging deployment. Dry-run does not verify live bindings/secrets exist.
2. **No live public catalog or checker validation.** Preset URLs are source-observed only. Availability, content size, data freshness, global country coverage, permission to use candidates and provider terms are unverified. Both integrations remain off by default.
3. **No live ProxyIP TCP/TLS reachability, exit-country or ISP proof.** Socket/HTTP trace fixtures check implementation boundaries; source labels and Worker colo are not exit proof. No real Iranian network, Irancell/Hamrah client route, ECH DNS resolution or arbitrary-service compatibility was tested.
4. **No actual stock-Nahan server integration or client GUI import.** Pinned source/API/schema and representative fixtures do not certify arbitrary Nahan commits or Android/iOS/Windows client versions. Inspected v2rayNG URI import ignores `cs`; full Xray JSON remains the lossless fallback.
5. **No Free production CPU/load/billing measurement.** 10 ms CPU, 128 MB memory, D1 reads/writes/indexes/storage, account requests and queue delay require actual monitoring. Local workerd/browser success and a small bundle are not hosted Free feasibility certification.
6. **No global hard metering/device-count guarantee.** Batched usage is eventually consistent; isolate eviction can lose tail bytes and concurrent traffic can overshoot. Connection caps are per isolate. Telegram acceptance and local cursor commit are not one transaction.
7. **No full upstream UI/feature parity or universal web replacement for bot screens.** No GPL/unlicensed Nahan/EDT dashboard was copied; NAT64/cascade/arbitrary routing and automatic remote deployment remain absent. Some business workflows remain in Telegram. Full web ownership is not delegated staff/customer authentication.
8. **No complete historical v1 migration.** Explicit cutover preserves old tables and imports documented users/balances/manual services; history/catalog/network reconciliation requires review.
9. **No independent security/legal audit.** Evaluate owner-key protection, network policy, payment operations, backup access, Cloudflare Terms and local law.

**فارسی:** استقرار/تلگرام واقعی، منبع/checker عمومی، IPهای زنده، کشور خروجی واقعی، اینترنت ایران، stock Nahan، رابط کلاینت‌ها و مصرف/ظرفیت Free تأیید نشده‌اند. برنامه نتیجه ساختگی موفق تولید نمی‌کند. انتساب/مجوز فونت و QR حفظ شده، ولی این کار ممیزی مستقل امنیت/حقوقی نیست. مصرف و تعداد دستگاه جهانی سخت، برابری کامل بالادستی یا مهاجرت تمام تاریخچه نسخه ۱ تضمین نمی‌شود.

## Final review / بازبینی نهایی

- Production source SHA/version and the raw/bundled matrix are recorded above; both READMEs include in-place upgrade and safe hosted-diagnostic instructions. Main remains the original code, so obtain this release from the working branch, not by assuming the default branch changed.
- No owner tutorial UUID/host/proxy/card examples were installed as production values. Synthetic TEST-NET records appear only in test/preview fixtures with an explicit banner.
- Control secrets remain environment-backed; web sessions are hashed in D1. Node keys cannot equal configured web/setup/master secrets. No query-string control credentials or raw receipt/configuration/error-body logging was introduced.
- New tests and forms use shared business validators. Operator defaults and legacy routes survive migration; no previously issued account identity is duplicated for operator variants.
- External source/checker operations are manual and opt-in; no code/UI/QR/font is loaded from an external repository. Auto-deploy is still disabled.
- All work stays on `arena/4a2b629b-nexiup`; main and repository visibility remain unchanged. No real Cloudflare credentials were requested or deployed.
