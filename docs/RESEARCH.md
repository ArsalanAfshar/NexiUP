# Implementation evidence and original-bot inventory

Research dates: **2026-10-20 UTC / 2026-10-21 Asia/Tehran**, including the 2.1 web/ProxyIP and 2.1.1 deployed-error follow-ups. Source inspection is not a network deployment test.

## Original bot: `77e421f59f1c354c3a2cf507568790e0d7902a29`

Read `worker.js` and `README.md` before examining Nahan. The original has Persian customer/admin messages (not selectable English), 23 D1 tables, isolate caches, and a manual configuration-delivery model. Its MIT declaration is in the source header and README; there is no LICENSE file at this commit. This owner-requested implementation adds the missing MIT text for NexiUP-owned code. The original files remain accessible in Git history; main is not modified.

Inventory:

- Commands: `/start` (referral and service deep links), `/services`, `/myservices`, `/wallet`, `/test`, `/help`, `/admin`.
- Customer menus: purchase, subscription list/detail/renewal, connection guides, referrals, wallet, support; pinned announcement and maintenance message.
- Plans: name, description, traffic *text*, duration days/text, integer price, enabled flag, sort order. Three seeded sample plans; no actual provisioning limits or location selection.
- Payments: multiple bank/crypto instructions; full wallet, split wallet/manual payment, receipt photo/document/text tracking; pending-payment and pending-approval orders; admin approval/rejection with reason; wallet refund on rejection/timeout. Admin approval asks the admin to type a configuration.
- Wallet: top-up receipt review, configurable bonus, withdrawals/destination review, adjustment and ledger; referral percentage and per-order commission; first-purchase discount; percentage/fixed coupons with expiry, global/per-user usage and minimum order.
- Forced join: multiple public/private channels, membership checks/tracking, strict switch, bot-access diagnostic.
- Support: tickets, replies, admin direct messages and forwarded-message quick replies.
- Admin menus: diagnostics, period stats, users/search/ban/balance/message, plans, orders, payments, manual tests, guides, forced channels, referrals, wallet/withdrawals, coupons, broadcast segments, settings/text overrides, extra admins, backup/import and logs.
- Automation: broadcast cursor batches of 25; order timeout; 3-day/1-day/expired reminders; daily report; update/log retention.
- Test flow: user requests a test, admin types a config; 24-hour default cooldown checked against delivery history; no atomic parallel-request protection.

Original claims that must **not** be preserved as guarantees: "production-ready", "100% free at high load", "double-entry ledger", availability/ping promises. Inspection found race-prone approval/debit/refund paths, optional webhook auth, incomplete restore, no Terms acceptance, no language selection, and multiple unbounded fan-outs. These are behaviors to harden, not useful features to preserve.

## Nahan inspected source

Repository: https://github.com/itsyebekhe/nahan
Commit: `67c9a038da4b0812bc4c8b630a6144967d102880` (`CURRENT_VERSION = 3.0.4`). Examined `_worker.js`, `dashboard.html`, `subscription.html`, `README.md`, `HELP.md`; used code rather than contradictory help prose.

Verified in code:

- Users API: `/<apiRoute>/api/users`; Bearer master or panel API key accepted. GET lookup accepts UUID or case-insensitive name; PUT/DELETE use UUID. POST does not reject duplicate names. Subscription URL is `https://<host>/<route>?sub=<encoded-name>`.
- POST/PUT fields include `name`, `trafficLimit`, `dailyLimit`, `expiryDays`, `notes`, `connLimit`, `maxConfigs`, `proxyIp`, `cleanIp`, `userMode`, `userPorts`, `userNodes`, `nat64`, `userPanelUrl`, `segMode`, `segPackets`, `segLengths`, `segDelays`, `segMaxSplit`, `segManual`, `tlsMask`.
- GB inputs are multiplied by 6000; limits convert back using `1073741824 / 6000`: effectively **GiB**, despite GB UI labels. `expiryDays` is `Date.now() + parseInt(days) * 86400000`, not an extension.
- `kv_store` contains `sys_config` and `sys_usage`. Config mutations read/modify/write a single JSON object. Isolate config/usage caches have 10-second TTLs. Sequential hub calls alone cannot fence other writers or a stale isolate.
- `trackUsage` increments real byte counters and, on activity after 30 seconds, writes the *whole* cached usage JSON. Concurrent isolates can overwrite one another; buffered tail bytes can be lost. Connection counts are isolate-local.
- Dashboard and subscription HTML are fetched remotely. Dashboard also loads fonts/Tailwind remotely. Default master is `admin`; remote deploy defaults true. These defaults are not reused.
- URI ECH toggle appends `pbk=enabled`, which is **not** the owner's Xray ECH DNS syntax. Cannot claim that upstream implements the requested ECH method.
- Keys API exists, but generated keys use `Math.random`; master/config secrets can be returned to authenticated panel API-key holders. NexiUP uses segregated administration credentials.

### License gate / decision

Nahan's README declares MIT and links `LICENSE`, but no LICENSE or copyright grant file exists at the inspected commit; GitHub license API returns 404. The cited `ImLTHQ/edgetunnel` license endpoint also returned 404. `cmliu/edgetunnel` reports **GPL-2.0**, not MIT. Consequently no Nahan/edgetunnel source or HTML is copied into this MIT deliverable. The node is an original, readable **Nahan users-API-compatible implementation**, not a claim that upstream GPL/unknown-license code has become MIT. Restoring a literal Nahan fork requires a documented upstream license grant. This deviation is repeated in both READMEs.

## Client syntax evidence

Read, not copied:

- Xray-core `92ccc939aaf4f8965f369cf0b142e005aeaa11d5`: https://github.com/XTLS/Xray-core
  - `infra/conf/transport_security.go`: `fingerprint = unsafe` is explicitly accepted; `cipherSuites` is a colon-separated string.
  - `infra/conf/transport_finalmask.go`: `finalmask.tcp[].type = fragment`; settings use packets, string ranges in lengths/delays, maxSplit; the last lengths entry must have nonzero minimum.
  - `transport/internet/tls/ech.go`: **one** `domain+resolver-URI` per `echConfigList`, split at the first `+`. There is no comma-separated multi-resolver grammar. Therefore two enabled ECH resolvers produce **two separate variants with the same account UUID**, not one invalid concatenated string.
  - Go TLS cipher configuration cannot guarantee configurable TLS 1.3 cipher ordering; accepting JSON is not proof every requested suite is effective.
- v2rayNG `118cf5bc7d0b290947b0827f5ad03e73018d8e5d`: https://github.com/2dust/v2rayNG
  - `fmt/FmtBase.kt` imports `fp`, `fm`, `ech`; does **not** import `cs`. Full Xray JSON is required to preserve the supplied cipher string on this client. URI serialization preserves `cs` for clients that understand it but is not advertised as full v2rayNG equivalence.
  - `core/CoreOutboundBuilder.kt` copies finalmask JSON and echConfigList into Xray stream/TLS settings.
- Generic Clash/Mihomo and sing-box do not use Xray's exact finalmask or ECH DNS-resolver string schema. NexiUP never transplants these fields into guessed schemas. Unsupported variants are excluded with explicit warnings; if none remain the endpoint returns 422 with a full-Xray-JSON fallback. An admin can enable a separate standard WS/TLS profile for these formats.
- No Iranian mobile-network test, iOS import, Android GUI import, or Windows GUI import has been performed in this workspace. The tutorial's `fp=chrome` URI conflicts with its stated `unsafe` setting. `unsafe` is used for the Irancell profile only because the inspected Xray schema explicitly accepts it; TLS certificate verification is not disabled.

## Cloudflare limits: live official documents

Retrieved 2026-10-20:

- https://developers.cloudflare.com/workers/platform/limits/ (updated October 12): 100,000 requests/day/account, 10 ms CPU for HTTP **and Free cron**, 128 MB/isolate, 50 external subrequests/invocation, 1,000 internal-service subrequests, 6 simultaneous outgoing connections, 64 env values, 5 KB/value, 5 cron triggers/account, 100 Workers/account, 1-second startup.
- **Important change:** that page's Worker-size section now states **64 MiB uncompressed, no compressed-size limit**. The old 3 MB compressed estimate is not the current published limit. Record gzip as informational only.
- https://developers.cloudflare.com/d1/platform/pricing/: 5M rows read/day, 100k written/day, 5 GB/account. Index updates count as additional writes.
- https://developers.cloudflare.com/d1/platform/limits/: 10 Free databases, 500 MB/database, 7-day Time Travel, **50 D1 queries/invocation**, 100 bound parameters/query, 2 MB/row. Use the stricter D1-specific ceiling even though internal-service subrequests can total 1,000.
- https://developers.cloudflare.com/kv/platform/limits/ and https://developers.cloudflare.com/workers/platform/pricing/: 100k reads/day, 1k writes/deletes/lists/day, 1 GB; 1 write/sec/key. NexiUP does not require KV.
- https://developers.cloudflare.com/workers/observability/errors/: error 1042 can mean same-zone fetch without `global_fetch_strictly_public`, or a disabled/nonexistent workers.dev route. Service bindings or a correctly routed custom domain are alternatives. These are documentation-verified remedies, not deployed tests here.

## Embedded QR library

Project Nayuki QR-Code-generator, commit `3c6d0b3cefb4e049dc337e82237c9644399716a8`; `typescript-javascript/qrcodegen.ts` has a complete MIT notice. Transpiled once for vendoring, with its notice retained in worker.js. Deployment has no build step or package dependencies. Local PNG serialization is original NexiUP code; no subscription URL is sent to a QR service.

The current Workers size rule was also rechecked against the official GitHub documentation source at commit `da69fa833be0a8dc9d9ed6d9429c8ee0c4efbd8e`: 64 MiB uncompressed, with no compressed-size limit. Native local-runtime checks and final file/bundle measurements are in [VERIFICATION.md](VERIFICATION.md).

## 2.1 follow-up: web administration and ProxyIP evidence

- Reproduced the screenshot JavaScript diagnostics using TypeScript **5.9.3** and `@cloudflare/workers-types` **5.20261019.1** with `checkJs` on `worker.js`. Mixed one-dimensional/nested menu inference and the generated QR namespace/static-member shape caused the errors. JSDoc menu unions and a lexical QR factory fix the source; source checking is not switched off.
- Inspected `cmliu/edgetunnel` commit `a8ab11125ece9bc27983f609a6359be81b21050c` and the external UI repository `EDT-Pages/EDT-Pages.github.io` commit `53d1fd9fbf2179714ea2b3c5d2fee781d72de7b1`. The former has GPL lineage; the latter has no recognized license. No dashboard/obfuscated code was copied. NexiUP embeds an original bilingual UI instead of fetching a remote page.
- In `admin/index.html`, the public catalog loader references **https://zip.cm.edu.kg.cmliussss.net/all.json**. It reads `data.data`, candidates' `ip` and `port`, with `meta.country`, localized country names, city, ASN/organization and `meta.clientIp`. The inspected loader selects port 443 or an array containing 443. These are interoperability facts, not proof of country or currently working IPs.
- That UI calls **https://api.090227.xyz/check?proxyip=…** and consumes `success`, `responseTime`, `supports_ipv4` and `supports_ipv6`. NexiUP treats such responses only as third-party reports. The candidate alone is an application-level input to the optional checker; administrative secrets/configurations are not sent to it.
- **Neither preset endpoint was live-fetched or tested here.** Both are off by default. Actual availability, payload size, geographic coverage, endpoint permission, provider terms and relay behavior require operator verification. No external country-IP dataset was vendored or advertised as healthy.
- Native socket API evidence: [official TCP socket docs](https://github.com/cloudflare/cloudflare-docs/blob/43dc7d94e21340f7940ae9fde065f7b0ee976b1d/src/content/docs/workers/runtime-apis/tcp-sockets.mdx) and the pinned Workers types. `secureTransport:'starttls'` permits one upgrade; `startTls()` replaces the original socket/streams. Types document `startTls({expectedServerHostname})` for the expected remote identity. NexiUP checks a fixed Cloudflare HTTPS trace target with hostname verification and bounded responses, not an unauthenticated HTTP/geo guess. Parser/stream/option tests are synthetic; no live Cloudflare TCP/TLS or ISP success is inferred.
- Diagnostic provenance explicitly separates claimed source country, TCP reachability, remote provider reports, selected-node measurements, request Worker colo and the trace's observed IP/country/colo. A trace at one destination and time does not prove arbitrary traffic always exits there. Remote-node reports trust that configured node; they are not independent attestation.
- Owner cookies/CSRF and protected receipt streaming use a separate `/admin/web-api/` namespace, preserving custom legacy `api_route=admin` node routes. Browser integration uses real local HTTPS, workerd and D1 with synthetic business records; production has no auto-login or iframe exception.
- The Arabic variable font from `@fontsource-variable/vazirmatn` **5.3.0** was inspected under complete SIL OFL-1.1 terms and embedded unmodified (46,308 bytes). Full notices and byte hash are in `THIRD_PARTY.md`; no font is loaded from a CDN.

آزمون مرورگر، API و سوکت ساختگی را نباید معادل تأیید IP عمومی، کشور خروجی واقعی، اینترنت ایران یا ظرفیت Free دانست. فهرست/سرویس بیرونی فقط با رضایت صریح و بدون دریافت کد رابط استفاده می‌شود؛ هیچ داده کشور/IP به‌عنوان فهرست سالمِ تولید در مخزن قرار نگرفته است.

## 2.1.1 follow-up: deployed Cloudflare 1101

- User reports both installation methods produce hosted 1101 despite local success and checked configuration. **No hosted exception/stack or authenticated Cloudflare account access was available.** A local passing run cannot identify the production cause; no deployment was performed.
- Official errors reference: [pinned source, `4849d13f34154c2dbc55f69eb72fa82fedea7dd3`](https://github.com/cloudflare/cloudflare-docs/blob/4849d13f34154c2dbc55f69eb72fa82fedea7dd3/src/content/docs/workers/observability/errors.mdx). 1101 covers uncaught JavaScript exceptions and “The script will never generate a response”; unresolved promises and WebSocket close handling are documented cases. CPU-limit failures are separately listed as 1102. Size alone is not a diagnosis of this report.
- Official live logs: [pinned source, `7e3642576493205c05f68870b24b26fce42fbcee`](https://github.com/cloudflare/cloudflare-docs/blob/7e3642576493205c05f68870b24b26fce42fbcee/src/content/docs/workers/observability/logs/real-time-logs.mdx). Dashboard path is Workers & Pages → Worker → Logs → Live; Wrangler tail is an alternative. Full events can contain request URL/headers, so only the fixed-field NexiUP record should be shared, not a raw tail dump. High-volume live logs can be sampled.
- Concrete 2.1.0 source findings: `runtime(env,execution)` preceded the request `try` and eagerly acquired `env.DB`; the outer catch read `e.retry` without guarding null/undefined or property access. Before-patch tests reproduced uncaught entry failures, including a secondary error inside the catch. They model failure modes, **not the actual account's exception**.
- `ready()` swallowed all D1 errors as missing migrations. It now distinguishes genuine missing application tables from operational failures, while an owner-only read-only preflight checks current tables/version/seeding without trusting the warm readiness cache. Five migration groups and existing financial/provisioning semantics are unchanged.
- Implementation choices: lazy D1 binding, protected request/scheduled initialization, private fault identity, safe 5xx references, no raw error reflection, metadata-only opt-in logs, eight-second read/preflight deadlines and no new timeout/retry on mutating statements. Module/platform failures and already-sent responses cannot be caught/replaced by this boundary.
- The raw source and Wrangler bundle were both run directly in local workerd with native D1 for `hub`, `node`, `all`, missing/wrong bindings, real owner authentication and explicit null/undefined/getter/unresolved-read injection. These are local native checks, not a Cloudflare deployment or proof the user's 1101 is resolved. Results and hashes are in [VERIFICATION.md](VERIFICATION.md).

**فارسی:** گزارش 1101 واقعی را با موفقیت لوکال رد نکردیم. مسیرهای مهارنشدهٔ کد بازتولید و اصلاح شدند، ولی بدون استثنای حساب تولید، علت قطعی اعلام نمی‌شود. گزارش خواندنی مالک و لاگ امنِ اختیاری اضافه شده‌اند؛ هیچ لاگ خام/راز/URL منتشر یا دیتابیس حذف نمی‌شود. خواندن زمان‌دار است، نه نوشتن مالیِ در جریان؛ raw و bundle در workerd محلی آزموده شده‌اند، نه اینترنت/حساب واقعی.
