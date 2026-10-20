# Verification record / گزارش راستی‌آزمایی

Date: **2026-10-20 UTC**. Repository: `ArsalanAfshar/NexiUP`. Working branch: `arena/4a2b629b-nexiup`.

This is a reproducible local verification record, not a production, security-audit, capacity or Iranian-network certification.

این گزارش آزمون محلیِ قابل‌تکرار است، نه تأیید استقرار تولید، ممیزی امنیت، ظرفیت یا اتصال واقعی اپراتورهای ایران.

## Results / نتایج

| Check | Result |
|---|---|
| `node --check worker.js` | PASS on Node 22.22.3 |
| `npm test` | **57 passed, 0 failed, 0 skipped**, about 5 seconds |
| Static review | No undefined variables, unreachable statements, duplicate parameters, invalid `typeof`, or unsafe `finally` reported by the development-only ESLint check |
| Single-Worker workerd smoke | PASS: native Worker startup, four D1 migration groups + seeding, authenticated user creation, three operator variants, embedded dashboard, PNG QR and additive native-D1 usage trigger |
| Two-Worker workerd smoke | PASS: separate hub/node native D1 databases, env-backed panel key, authenticated HTTP provisioning burst, exactly one remote account, three main-domain Xray variants, PNG and metadata sent to a Telegram fake |
| Independent QR scan | jsQR 1.4.0 decoded the real generated PNG and recovered the exact main-domain URL; no URL metadata/text trick |
| `wrangler deploy --dry-run` | PASS with Wrangler 4.151.3; **no deployment performed** |
| Diff review | Whitespace check passed; no credentials, generated bundles, reference clones, dependencies, or receipt/configuration datasets staged |

The default suite uses **only Node built-ins**: `node:test`, strict assertions, `node:sqlite`, streams, module-loader hooks, crypto, VM and zlib. Fake D1 wraps real SQLite transactions, UNIQUE constraints, triggers and conditional updates instead of returning canned “success” results. Fake fetch captures Telegram payloads and simulates HTTP node errors/retries. WebSocket/socket stream fakes exercise the real tunnel handler. The test loader exposes private helpers; production exports only the Worker handler (workerd rejects scalar named entrypoint exports).

مجموعه اصلی فقط از ابزارهای داخلی Node استفاده می‌کند. Fake مربوط به D1، SQL واقعی SQLite شامل تراکنش، شرط، یکتایی و trigger را اجرا می‌کند، نه پاسخ موفق از پیش‌ساخته. fetch شبیه‌سازی‌شده، payload تلگرام و خطا/تلاش نود را بررسی می‌کند. شبیه‌ساز WebSocket/socket مسیر واقعی تونل را اجرا می‌کند. loader تست توابع خصوصی را در دسترس می‌گذارد؛ فایل تولید فقط handler را export می‌کند.

## Exact size measurements / اندازه دقیق

Measured after the final runtime changes:

| Artifact | Uncompressed | gzip |
|---|---:|---:|
| Paste-ready `worker.js` | **251,473 bytes** (245.58 KiB) | **74,991 bytes** (73.23 KiB) |
| Wrangler dry-run upload module | **276,868 bytes** (270.38 KiB) | **74,053 bytes** (72.32 KiB) |

Both NexiUP and Project Nayuki legal notices are marked as legal comments and were verified present in the dry-run bundle, not just in source files.

Wrangler output:

```text
wrangler 4.151.3
Total Upload: 270.38 KiB / gzip: 72.32 KiB
--dry-run: exiting now.
```

Current official Workers Free limit: **64 MiB uncompressed = 67,108,864 bytes**, and **no compressed-size limit**. The dry-run module uses approximately **0.41%** of that uncompressed ceiling. The prior 3 MB compressed estimate is not the current documented rule. Source and bundled sizes differ because the optional development bundler reformats/tree-shakes the module; pasting the source needs no bundling.

سقف فعلی مستندات Free برابر **۶۴ MiB غیرفشرده** است و سقف فشرده ندارد. خروجی dry-run حدود **۰٫۴۱٪** آن است. تخمین قبلی ۳ MB فشرده، قاعده فعلی نیست. اختلاف source و bundle ناشی از تبدیل ابزار اختیاری توسعه است؛ paste کردن source به build نیاز ندارد.

Source SHA-256:

```text
3063c4e259cd97878670682b004a465db65a0979d815fa36733c05be9d29962b
```

Dry-run module SHA-256:

```text
c096911347bd6ea8b585136674941056c62fadb5a8ef7f9563e30492cec722cf
```

Limit independently checked both on the official documentation page and its official GitHub source:

- https://developers.cloudflare.com/workers/platform/limits/#worker-size
- https://github.com/cloudflare/cloudflare-docs/blob/da69fa833be0a8dc9d9ed6d9429c8ee0c4efbd8e/src/content/docs/workers/platform/limits.mdx

Other limits and pinned upstream/client evidence are in [RESEARCH.md](RESEARCH.md).

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

## Reproduce / تکرار آزمون

Required, dependency-free suite:

```sh
node --check worker.js
npm test
```

Optional local development tooling (not needed for dashboard deployment):

```sh
npm install --no-save --package-lock=false miniflare@5.20261019.1-beta wrangler@4.151.3
node tests/workerd-smoke.mjs
node tests/remote-workerd-smoke.mjs
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run
```

The optional smoke scripts also accept `MINIFLARE_MODULE=file:///absolute/path/to/miniflare/dist/src/index.js`. They create temporary local databases and random synthetic credentials in memory, intercept test network calls, then dispose the runtimes. They do not deploy Cloudflare resources or contact a live Telegram bot. Keep local dependencies/bundles out of Git. A real CLI deployment requires replacing the example database ID and configuring secrets; dry-run does not validate that those live bindings exist.

مسیر اصلی هیچ package اضافی نمی‌خواهد. ابزارهای اختیاری فقط برای اجرای workerd محلی و dry-run هستند؛ دیتابیس/اعتبار ساختگی موقت می‌سازند و شبکه تست را رهگیری می‌کنند، نه منابع واقعی Cloudflare یا ربات واقعی. خروجی build و dependency را commit نکنید. dry-run وجود binding و راز واقعی حساب شما را تأیید نمی‌کند.

## Not verified / تأییدنشده

1. **No real deployment or Telegram delivery:** actual bot token, webhook registration, Telegram photo rendering, 429 behavior and recovery must be tested with an owner-configured bot/account.
2. **No actual stock-Nahan server integration:** request shapes/storage/expiry semantics were inspected in pinned source and tested with fakes. No guarantee is made for other commits, concurrent outside writers, or arbitrary remote failure histories. A stock server cannot offer the same transactional idempotency as the independent node.
3. **No Iranian mobile-network tests or client GUI imports:** source-schema verification and representative output fixtures are not tests of Hamrah-e Aval/Irancell routing, ECH DNS resolution, cipher effectiveness, Android/iOS/Windows import behavior or all client versions. In particular, inspected v2rayNG URI import ignores `cs`; use full Xray JSON.
4. **No external TCP/UDP tunnel reachability/exit-country proof:** stream forwarding was tested with fakes; edge colo is not proxy exit country. Cloudflare egress restrictions, actual relays and DNS behavior remain deployment-specific.
5. **No Free production CPU/load measurement:** 10 ms CPU, 128 MB memory, D1 row/write/storage quotas, incoming requests and queue throughput require real monitoring. Local workerd success and a small script do not establish quota compliance under load.
6. **Not a global hard-metering claim:** usage flushes are batched/eventually consistent; isolation/eviction can lose tail bytes or allow overshoot. Connection limits are per isolate, not exact global device counts. Telegram message acceptance and local cursor commit cannot be one transaction.
7. **Not full upstream Nahan feature/UI parity:** upstream license grant is incomplete; NAT64/cascade/arbitrary custom routing and automatic remote code deployment are deliberately not copied/implemented. Keys registration references Worker Secrets rather than returning plaintext D1 secrets.
8. **Not a full v1 historical migration:** explicit import covers users/opening balances and legacy manual services. Catalog/network/financial-history cutover needs operator review. Original tables remain untouched.
9. **No formal security or legal audit:** review threat model, bank operations, backup permissions, Cloudflare Terms and local law before use.

**فارسی:** استقرار واقعی، ارسال واقعی تلگرام، اتصال به سرور stock Nahan، اینترنت همراه اول/ایرانسل، ورود GUI کلاینت‌ها، خروجی جغرافیایی تونل، مصرف واقعی Free و ممیزی رسمی امنیت/حقوقی آزمایش نشده‌اند. مصرف و تعداد اتصال جهانیِ سخت تضمین نمی‌شود. این خروجی fork عینی نهان یا مهاجرت کامل تاریخچه نسخه ۱ نیست؛ مرزهای آن در هر دو README روشن است.

## Final-review notes / یادداشت بازبینی

- No owner-supplied illustrative UUID, sample Worker host or proxy IP was used as a live default.
- Secrets are environment references; no query-string master/setup/API key and no raw error-body logging. Panel user audit targets are hashed instead of recording raw tunnel UUIDs.
- Node registry and main domain are explicit validated admin choices. Test defaults are disabled until a designated node is selected; sales-node use requires explicit consent.
- All runtime files are embedded; external repositories are not fetched for UI/code/QR. Optional analytics only runs when configured.
- Main is still based on the original commit; all project changes are on the session branch. Repository visibility was not changed. No live credentials or customer data were available or requested.
