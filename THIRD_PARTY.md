# Attribution and license review / انتساب و بررسی مجوز

## NexiUP

Original bot: [ArsalanAfshar/NexiUP](https://github.com/ArsalanAfshar/NexiUP), commit `77e421f59f1c354c3a2cf507568790e0d7902a29`. The original source header says `LICENSE: MIT`; its README says `Copyright (c) 2026 NexiUP Contributors`, but no license file was present. This owner-requested rewrite preserves that attribution and adds the standard MIT text for NexiUP-owned code. Original source and documentation remain in Git history. No changes were made to main.

ربات اولیه در سربرگ کد و README مجوز MIT را اعلام می‌کند، ولی فایل مجوز نداشت. این بازنویسی به درخواست مالک، انتساب قبلی را حفظ و متن MIT را برای کد متعلق به NexiUP اضافه می‌کند. نسخه اولیه در تاریخچه Git باقی است و شاخه main تغییر نکرده است.

## Nahan and edgetunnel: inspected, not copied

- [itsyebekhe/nahan](https://github.com/itsyebekhe/nahan), commit `67c9a038da4b0812bc4c8b630a6144967d102880`, declares MIT in README, but its linked LICENSE file is missing and GitHub's license endpoint returns 404.
- The stated lineage includes [ImLTHQ/edgetunnel](https://github.com/ImLTHQ/edgetunnel) (license endpoint returned 404) and [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) (GitHub reports GPL-2.0).
- Follow-up review: `cmliu/edgetunnel` at `a8ab11125ece9bc27983f609a6359be81b21050c` (GPL lineage) and `EDT-Pages/EDT-Pages.github.io` at `53d1fd9fbf2179714ea2b3c5d2fee781d72de7b1` (no recognized license). The public catalog/checker URLs and response field names were observed for interoperability; neither source/UI nor a country-IP dataset was copied. Provider use remains optional and subject to its own availability/terms.
- Therefore **no Nahan/edgetunnel source, dashboard, subscription HTML, obfuscated bundle, or tunnel code is vendored here**. The node is an original Nahan-users-API-compatible implementation. API names and protocol facts are used for interoperability; MIT is not claimed for upstream code. A literal fork requires a documented upstream license decision/grant first.
- The requested upstream lineage is acknowledged, not silently erased or rebranded as NexiUP-authored code.

Nahan در README ادعای MIT دارد، اما فایل مجوز آن در نسخه بررسی‌شده موجود نیست. یکی از نیاکان معرفی‌شده GPL-2.0 است. بنابراین هیچ کد یا HTML آن‌ها در خروجی MIT کپی نشده؛ نود، پیاده‌سازی مستقل با API سازگار است، نه تغییر مجوز یک fork واقعی. برای fork عینی باید وضعیت مجوز بالادستی روشن شود.

## Project Nayuki QR-Code-generator — embedded MIT component

Source: [nayuki/QR-Code-generator](https://github.com/nayuki/QR-Code-generator), commit `3c6d0b3cefb4e049dc337e82237c9644399716a8`, `typescript-javascript/qrcodegen.ts`. Transpiled once with TypeScript 5.9.3 to readable JavaScript, appended to `worker.js` with its notice retained. Version 2.1 adapts the generated namespace wrapper into a lexical factory with explicit static members so JavaScript `checkJs` passes; the encoder algorithms and complete MIT notice are preserved. Deployment never fetches or compiles it. The PNG serializer and test-only PNG/QR fixture reader are original NexiUP code.

مولد QR با مجوز روشن MIT و حفظ کامل انتساب، یک‌بار به جاوااسکریپت خوانا تبدیل و داخل worker.js تعبیه شده است. هنگام نصب یا اجرا وابستگی شبکه‌ای یا مرحله ساخت ندارد. هیچ URL اشتراک به سرویس QR بیرونی فرستاده نمی‌شود.

> Copyright (c) Project Nayuki. (MIT License)
> https://www.nayuki.io/page/qr-code-generator-library
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
> - The above copyright notice and this permission notice shall be included in
>   all copies or substantial portions of the Software.
> - The Software is provided "as is", without warranty of any kind, express or
>   implied, including but not limited to the warranties of merchantability,
>   fitness for a particular purpose and noninfringement. In no event shall the
>   authors or copyright holders be liable for any claim, damages or other
>   liability, whether in an action of contract, tort or otherwise, arising from,
>   out of or in connection with the Software or the use or other dealings in the
>   Software.

## Vazirmatn — embedded SIL OFL-1.1 font

Copyright **2015 The Vazirmatn Project Authors** (https://github.com/rastikerdar/vazirmatn).

The unmodified Arabic variable WOFF2 from **`@fontsource-variable/vazirmatn` 5.3.0**, file `files/vazirmatn-arabic-wght-normal.woff2`, is embedded as a data URI for readable Persian even on devices without Arabic system fonts. The package's complete license was inspected before embedding. Font bytes remain **SIL Open Font License 1.1, not MIT**. NexiUP's original code remains MIT. The full copyright/permission/conditions/disclaimer are in both `worker.js` (a preserved legal comment) and [docs/licenses/Vazirmatn-OFL.txt](docs/licenses/Vazirmatn-OFL.txt).

- Font size: **46,308 bytes**; no runtime font/network request.
- SHA-256: `84a382e46c30fb4f73d0e3800c16d0af15888e2731e57fa5f93e2c29a2c6a957`.
- Distribution metadata: https://registry.npmjs.org/@fontsource-variable/vazirmatn/5.3.0 ; upstream listed by the package: Google Fonts / Vazirmatn.
- The font is not sold separately, renamed in its binary, or relicensed as NexiUP-owned code. The source and optional Wrangler bundle both retain the legal notice; the complete font notice is also included in the CSS of each served admin HTML copy.

فونت متغیر عربی/فارسی Vazirmatn بدون تغییر و با بررسی مجوز کامل در فایل تعبیه شده است؛ برای نمایش فارسی به فونت نصب‌شده یا دانلود بیرونی وابسته نیست. مجوز **خود فونت SIL OFL-1.1 است، نه MIT**؛ مجوز کد اصلی NexiUP همچنان MIT می‌ماند. متن کامل انتساب و مجوز در Worker و فایل مجوز جدا حفظ شده است.

## Schema/protocol references and development-only tools

Xray-core and v2rayNG source were inspected for field/schema compatibility; no implementation code was copied. Cloudflare documentation supplied platform/API facts. Links, commit pins and findings are in [docs/RESEARCH.md](docs/RESEARCH.md).

Node's built-in runner/SQLite power the default tests. TypeScript 5.9.3 and Cloudflare Workers types 5.20261019.1 are pinned devDependencies with a lockfile. Wrangler, Miniflare/workerd, Playwright, Chromium and jsQR are optional development/verification tools, not runtime dependencies. No installed node_modules, cloned reference source or generated bundle is committed. No dependency on an external repository exists at Worker runtime.

کد Xray و v2rayNG فقط برای بررسی شِما خوانده شد؛ پیاده‌سازی آن‌ها کپی نشده است. ابزارهای Wrangler، Miniflare، TypeScript و jsQR صرفاً برای بررسی محلی به کار رفته‌اند و داخل محصول یا وابستگی زمان اجرا نیستند.
