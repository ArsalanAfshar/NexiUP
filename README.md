# NexiUP — ربات تلگرام | Telegram Bot

ربات فروش سرویس روی **Google Apps Script + Google Sheets + Cloudflare Worker**.
بدون سرور، بدون هزینه ماهانه، با پنل مدیریت کامل فارسی.

> **English summary:** A serverless Telegram store bot. Business logic runs on Google Apps
> Script, data lives in Google Sheets, and a Cloudflare Worker acts as a fast webhook gateway.
> Setup is a single wizard: `cd worker && npm run setup`.

---

## فهرست

1. [این ربات چه می‌کند](#۱-این-ربات-چه-می‌کند)
2. [معماری](#۲-معماری)
3. [نصب در ۴ گام](#۳-نصب-در-۴-گام)
4. [چک‌لیست انتشار](#۴-چک‌لیست-انتشار)
5. [بررسی سلامت و عیب‌یابی](#۵-بررسی-سلامت-و-عیب‌یابی)
6. [بروزرسانی از نسخه قبلی](#۶-بروزرسانی-از-نسخه-قبلی)
7. [کارایی](#۷-کارایی)
8. [امنیت](#۸-امنیت)
9. [ساختار پروژه](#۹-ساختار-پروژه)

---

## ۱. این ربات چه می‌کند

| بخش کاربر | بخش مدیر |
| --- | --- |
| 🛒 خرید سرویس | 👥 مدیریت کاربران (مسدودسازی، موجودی، سوابق) |
| 📦 سرویس‌های من | 📦 تأیید/رد سفارش و تحویل کانفیگ |
| 🧪 دریافت سرویس تست | 🛒 مدیریت سرویس‌ها و قیمت‌ها |
| 📖 راهنمای اتصال | 🎟 کدهای تخفیف |
| 👥 زیرمجموعه‌گیری و پورسانت | 💸 تأیید درخواست‌های برداشت |
| 💰 کیف پول و تراکنش‌ها | 📣 ارسال همگانی |
| 🎟 اعمال کد تخفیف | ⚙️ تنظیمات، متن‌ها و دکمه‌ها (بدون کدنویسی) |
| 💳 پرداخت کارت‌به‌کارت + کیف پول | 🩺 بررسی سلامت سیستم |

داده‌ها در ۱۳ شیت نگهداری می‌شوند:
`Settings, Users, Services, Orders, Configs, Discounts, Channels, Guides, Referrals, Wallet, Withdrawals, Transactions, Logs`

---

## ۲. معماری

```
تلگرام
  │  POST + هدر X-Telegram-Bot-Api-Secret-Token
  ▼
Cloudflare Worker  ── پاسخ 200 در چند میلی‌ثانیه ──▶ تلگرام
  │  (فوروارد در پس‌زمینه با ctx.waitUntil)
  ▼
Google Apps Script  (doPost)  ← اعتبارسنجی با ?s=WEBHOOK_SECRET
  ▼
Google Sheets (۱۳ شیت)
```

**چرا Worker لازم است؟** آدرس `/exec` گوگل به هر POST یک ریدایرکت `302` می‌دهد و تلگرام
ریدایرکت را دنبال نمی‌کند؛ نتیجه خطای معروف `Wrong response from the webhook: 302 Found`.
`fetch()` داخل Worker این ۳۰۲ را خودش مصرف می‌کند و تلگرام فقط یک `200 OK` سریع می‌بیند.

**دو کلید مستقل** (هرگز یکی نیستند):

| کلید | مسیر | نگهداری در |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_SECRET` | تلگرام ← Worker | Cloudflare Secret + Script Property |
| `WEBHOOK_SECRET` (در Worker با نام `APPS_SCRIPT_SECRET`) | Worker ← Apps Script | Script Property + Cloudflare Secret |

---

## ۳. نصب در ۴ گام

**پیش‌نیاز:** یک حساب Google، یک حساب رایگان Cloudflare، Node.js نسخه ۱۸+، و توکن ربات از
[@BotFather](https://t.me/BotFather).

### گام ۱ — ساخت پروژه Apps Script

1. به [script.google.com](https://script.google.com) بروید → **New project** → نامش را `NexiUP` بگذارید.
2. کل محتوای `apps-script/Code.gs` را در فایل `Code.gs` بچسبانید (محتوای قبلی را پاک کنید).
3. **⚙️ Project Settings** → تیک *Show "appsscript.json" manifest file in editor* را بزنید،
   سپس محتوای `apps-script/appsscript.json` را در آن فایل بچسبانید.
4. در همان صفحه، بخش **Script Properties** → **Add script property**، این دو را وارد کنید:

   | Property | Value |
   | --- | --- |
   | `BOT_TOKEN` | توکنی که BotFather داد |
   | `ADMIN_IDS` | شناسه عددی شما (چند مدیر را با `,` جدا کنید) |

   > شناسه عددی خود را نمی‌دانید؟ فعلاً `1` بگذارید؛ بعد از راه‌اندازی `/id` را به ربات بفرستید و اصلاحش کنید.

5. از منوی بالای ویرایشگر تابع **`initialSetup`** را انتخاب و **Run** بزنید و دسترسی‌ها را تأیید کنید.
   این کار اسپردشیت، هر ۱۳ شیت و `WEBHOOK_SECRET` را می‌سازد.

### گام ۲ — انتشار Web App

1. **Deploy → New deployment → ⚙️ → Web app**
2. **Execute as:** `Me` — **Who has access:** `Anyone`
3. **Deploy** → آدرس **Web app URL** را کپی کنید (باید به `/exec` ختم شود).
4. آن را در **Script Properties** با کلید `WEB_APP_URL` ذخیره کنید.
5. مقدار `WEBHOOK_SECRET` را هم از Script Properties کپی کنید (در گام بعد لازم است).

### گام ۳ — نصب خودکار Worker

```bash
cd worker
npm install
npx wrangler login     # مرورگر باز می‌شود
npm run setup          # ← جادوی اصلی اینجاست
```

جادوگر نصب از شما فقط سه چیز می‌پرسد و بقیه را خودش انجام می‌دهد:

| می‌پرسد | خودش انجام می‌دهد |
| --- | --- |
| آدرس `/exec` | نوشتن آن در `wrangler.toml` |
| مقدار `WEBHOOK_SECRET` | ذخیره رمزنگاری‌شده به‌عنوان `APPS_SCRIPT_SECRET` |
| توکن ربات | ساخت `TELEGRAM_WEBHOOK_SECRET` تصادفی، Deploy کردن Worker، و **ثبت وبهوک روی تلگرام** |

در پایان، جادوگر دو مقدار را چاپ می‌کند که باید در Apps Script ذخیره کنید.

### گام ۴ — تکمیل تنظیمات Apps Script

در **Script Properties** این دو را اضافه کنید (هر دو را جادوگر چاپ کرده):

| Property | Value |
| --- | --- |
| `WORKER_URL` | آدرس `https://...workers.dev` |
| `TELEGRAM_WEBHOOK_SECRET` | همان مقدار تصادفی چاپ‌شده |

سپس در ویرایشگر Apps Script تابع **`healthCheck`** را اجرا کنید.
اگر هر ۶ مورد ✅ بود، `/start` را به ربات بفرستید. تمام. 🎉

> **نکته مهم:** هر بار `Code.gs` را تغییر دادید، باید دوباره منتشر کنید:
> **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
> آدرس `/exec` ثابت می‌ماند، پس نیازی به تغییر Worker نیست.

---

## ۴. چک‌لیست انتشار

قبل از معرفی ربات به کاربران واقعی، این موارد را تیک بزنید:

**پیکربندی**
- [ ] `initialSetup()` اجرا شده و ۱۳ شیت ساخته شده
- [ ] `checkSetup()` همه موارد را ✅ نشان می‌دهد
- [ ] `ADMIN_IDS` شناسه عددی واقعی شماست (با `/id` بررسی کنید)
- [ ] Web App با **Execute as: Me** و **Access: Anyone** منتشر شده
- [ ] آخرین نسخه `Code.gs` با **New version** منتشر شده

**Worker**
- [ ] `npm run check -- <BOT_TOKEN>` بدون ✖ تمام می‌شود
- [ ] `wrangler.toml` هیچ Secretای داخلش ندارد
- [ ] باز کردن آدرس Worker در مرورگر `"ready": true` می‌دهد

**سلامت**
- [ ] `healthCheck()` هر ۶ مورد را ✅ می‌دهد
- [ ] `pending_update_count` صفر یا نزدیک صفر است
- [ ] `/start` در کمتر از ۲ ثانیه پاسخ می‌گیرد

**پیکربندی کسب‌وکار**
- [ ] `card_number` و `card_holder` در ⚙️ تنظیمات واقعی هستند
- [ ] سرویس‌های نمونه حذف یا با سرویس واقعی جایگزین شده‌اند
- [ ] `support_username` تنظیم شده
- [ ] یک خرید آزمایشی کامل انجام شده (سفارش → رسید → تأیید → تحویل کانفیگ)

**امنیت**
- [ ] هیچ توکن یا کلیدی در Git نیست (`git log -p | grep -i "bot[0-9]"` خالی باشد)
- [ ] `.dev.vars` در `.gitignore` هست و commit نشده

---

## ۵. بررسی سلامت و عیب‌یابی

### ابزارها

| ابزار | محل اجرا | کاربرد |
| --- | --- | --- |
| `checkSetup()` | ویرایشگر Apps Script | بررسی پیکربندی، بدون تماس شبکه. **همیشه اول این را اجرا کنید.** |
| `healthCheck()` | ویرایشگر Apps Script | بررسی زنده ۶ مورد: Apps Script، دیتابیس، تلگرام، Worker، وبهوک، کلیدها |
| `quickStart()` | ویرایشگر Apps Script | نصب + بررسی + ثبت وبهوک، همه با یک اجرا |
| `npm run check` | پوشه `worker` | بررسی Worker، آدرس‌ها و وضعیت وبهوک |
| `npm run logs` | پوشه `worker` | لاگ زنده Worker |
| 🔧 ابزارهای سیستم | داخل ربات | همان بررسی‌ها از داخل پنل مدیریت |

### جدول مشکلات رایج

| نشانه | علت | راه‌حل |
| --- | --- | --- |
| ربات اصلاً جواب نمی‌دهد | وبهوک ثبت نشده | `healthCheck()` → اگر مورد ۵ ❌ بود، `setupWebhook()` را اجرا کنید |
| `Wrong response ... 302 Found` | وبهوک مستقیم به `/exec` وصل است | باید به آدرس Worker وصل باشد → `npm run setup` |
| Worker پاسخ می‌دهد ولی ربات ساکت است | `APPS_SCRIPT_SECRET` با `WEBHOOK_SECRET` یکی نیست | `npm run logs` → دنبال `401`؛ سپس `npx wrangler secret put APPS_SCRIPT_SECRET` |
| `gateway_not_configured` (503) | `TELEGRAM_WEBHOOK_SECRET` در Worker ست نشده | `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` |
| تغییرات کد اثر ندارد | نسخه جدید منتشر نشده | Deploy → Manage deployments → ✏️ → **New version** |
| «دسترسی مدیریتی ندارید» | `ADMIN_IDS` اشتباه است | `/id` را به ربات بفرستید و همان عدد را ذخیره کنید |
| `pending_update_count` بالا می‌رود | Worker یا Apps Script پاسخ نمی‌دهد | `npm run logs` و شیت `Logs` را ببینید |

### بررسی دستی

```bash
# ۱) آیا Worker زنده و کامل پیکربندی شده؟
curl -s https://<your-worker>.workers.dev | jq
# انتظار: { "ok": true, "ready": true, ... }

# ۲) تلگرام چه فکری می‌کند؟
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq
# انتظار: url = آدرس Worker، last_error_message خالی

# ۳) آیا Web App بالاست؟
curl -sL "https://script.google.com/macros/s/<ID>/exec" | jq
```

---

## ۶. بروزرسانی از نسخه قبلی

این نسخه **کاملاً سازگار با نسخه قبل** است: هیچ ستون، شیت یا رکوردی تغییر نکرده و
هیچ Script Propertyای حذف یا تغییر نام نداده است. داده‌های شما دست‌نخورده می‌مانند.

⏱ حدود ۵ دقیقه · بدون توقف سرویس (به‌جز چند ثانیه هنگام Deploy).

### مرحله ۱ — پشتیبان (۱ دقیقه)

1. اسپردشیت را باز کنید → **File → Make a copy** → نامش را `NexiUP Backup <تاریخ>` بگذارید.
2. در Apps Script → **Project Settings → Script Properties** → از کل جدول اسکرین‌شات بگیرید.
   (به‌ویژه `WEBHOOK_SECRET`، `SPREADSHEET_ID`، `BOT_TOKEN`.)

### مرحله ۲ — بروزرسانی Apps Script (۲ دقیقه)

1. کل محتوای `Code.gs` قدیمی را انتخاب و حذف کنید.
2. محتوای جدید `apps-script/Code.gs` را بچسبانید و **ذخیره** کنید (Ctrl+S).
3. تابع **`checkSetup`** را اجرا کنید.
   - همه ✅ → ادامه دهید.
   - `TELEGRAM_WEBHOOK_SECRET` یا `WORKER_URL` ❌ بود → از تنظیمات فعلی Worker خود پرش کنید.
4. **Deploy → Manage deployments → ✏️ → Version: `New version` → Deploy**
   ⚠️ حتماً `New version`؛ در غیر این صورت کد قدیمی همچنان اجرا می‌شود.

### مرحله ۳ — بروزرسانی Worker (۲ دقیقه)

```bash
cd worker
npm install
npx wrangler deploy
```

فایل `wrangler.toml` شما دست‌نخورده می‌ماند و Secretهای موجود در Cloudflare حفظ می‌شوند —
نیازی به ثبت مجدد آن‌ها نیست.

> **فقط اگر** قبلاً `TELEGRAM_WEBHOOK_SECRET` را ست نکرده بودید: نسخه جدید عمداً
> «fail-closed» است و بدون آن همه ترافیک را رد می‌کند (این یک رفع آسیب‌پذیری است).
> در آن صورت اجرا کنید:
> ```bash
> npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
> ```
> و همان مقدار را در Script Properties و در `setWebhook` هم ثبت کنید (یا `setupWebhook()` را اجرا کنید).

### مرحله ۴ — تأیید (۱ دقیقه)

1. در Apps Script: **`healthCheck()`** → باید هر ۶ مورد ✅ باشد.
2. در ترمینال: `npm run check -- <BOT_TOKEN>` → بدون ✖.
3. در تلگرام: `/start` بفرستید — باید محسوس‌تر سریع‌تر از قبل باشد.
4. یک خرید آزمایشی کامل انجام دهید تا از سلامت جریان کسب‌وکار مطمئن شوید.

### بازگشت به عقب (Rollback)

اگر چیزی خراب شد:
**Deploy → Manage deployments → ✏️ → Version → نسخه قبلی را انتخاب کنید → Deploy**.
Worker را هم با `npx wrangler rollback` برگردانید. داده‌ها اصلاً لمس نشده‌اند.

---

## ۷. کارایی

ربات قبلاً حدود **۱۰ ثانیه** تأخیر داشت. علت اصلی، تعداد بسیار زیاد رفت‌وبرگشت به
سرویس‌های گوگل در هر پیام بود. هر تماس `SpreadsheetApp` بین ۱۵۰ تا ۴۰۰ میلی‌ثانیه و هر
تماس `PropertiesService` بین ۲۰ تا ۸۰ میلی‌ثانیه طول می‌کشد.

### اندازه‌گیری واقعی (شبیه‌ساز، شمارش تماس‌های API)

| عملیات | قبل | بعد | کاهش |
| --- | --- | --- | --- |
| `/start` (کاربر قدیمی) | ۲۷ تماس شیت + ۱۳ تماس Properties | **۸ + ۲** | **۷۴٪** |
| دکمه «خرید سرویس» | ۲۷ + ۱۲ | **۱۰ + ۲** | **۶۹٪** |
| دکمه شیشه‌ای (callback) | ۲۷ + ۱۳ | **۱۰ + ۲** | **۷۰٪** |
| کیف پول | ۳۲ + ۱۲ | **۱۴ + ۲** | **۶۴٪** |
| پنل مدیریت | ۶۰ + ۱۸ | **۲۳ + ۲** | **۶۸٪** |

### چه چیزی تغییر کرد

| # | مشکل | راه‌حل |
| --- | --- | --- |
| ۱ | هر `getUser_`/`getSetting_` کل شیت را دوباره می‌خواند | هر شیت **حداکثر یک‌بار** در هر اجرا خوانده می‌شود (`_rowsCache`) |
| ۲ | جستجوی کاربر/سفارش/سرویس، پیمایش کامل جدول بود | ایندکس هش `findBy_` با پیچیدگی **O(1)** |
| ۳ | تنظیمات ده‌ها بار از شیت خوانده می‌شد | سه‌لایه: حافظه ← `CacheService` (۵ دقیقه) ← شیت |
| ۴ | هر خط لاگ یک نوشتن جدا روی شیت بود | بافر + **یک** `setValues` بعد از ارسال پاسخ |
| ۵ | ده‌ها `getProperty()` جداگانه | یک `getProperties()` در ابتدای اجرا + نوشتن دسته‌ای |
| ۶ | `last_seen` در هر پیام نوشته می‌شد | فقط هنگام تغییر پروفایل یا هر ۳ دقیقه |
| ۷ | `patchRow_` کل ردیف را می‌خواند و می‌نوشت | فقط ستون‌های تغییرکرده، بدون خواندن مجدد |
| ۸ | اطلاع‌رسانی به N مدیر = N تماس پشت‌سرهم | `UrlFetchApp.fetchAll` → همه به‌صورت موازی |
| ۹ | بررسی N کانال عضویت، پشت‌سرهم | یک درخواست دسته‌ای موازی |
| ۱۰ | ارسال همگانی: ۱ پیام + ۶۰ms مکث برای هر کاربر | دسته‌های ۲۵تایی موازی |
| ۱۱ | نوشتن `LAST_UPDATE_*` روی مسیر پاسخ | به بعد از ارسال پاسخ منتقل شد |

**تضمین سازگاری:** یک هارنس شبیه‌سازی Apps Script نوشته شد که ۵۶ جریان کامل
(خرید، رسید، تخفیف، کیف پول، برداشت، زیرمجموعه، تست، و کل پنل مدیریت) را روی نسخه قدیم و
جدید اجرا می‌کند و **تمام پیام‌های تلگرام و وضعیت نهایی هر ۱۳ شیت** را مقایسه می‌کند.
نتیجه: خروجی کاملاً یکسان — تنها تفاوت، دو دکمه‌ای است که عمداً اضافه شده‌اند.

---

## ۸. امنیت

### آسیب‌پذیری‌های رفع‌شده در این نسخه

| # | مشکل | شدت | وضعیت |
| --- | --- | --- | --- |
| ۱ | **Worker بدون Secret همه‌چیز را می‌پذیرفت.** اگر `TELEGRAM_WEBHOOK_SECRET` ست نبود، هرکسی که آدرس Worker را می‌یافت می‌توانست آپدیت جعلی تلگرام تزریق کند (پرداخت جعلی، اقدام مدیریتی جعلی). | 🔴 بحرانی | حالا **fail-closed**: پاسخ `503` و لاگ صریح |
| ۲ | **`doPost` بدون `WEBHOOK_SECRET` باز بود.** همان حمله، مستقیم روی `/exec`. | 🔴 بحرانی | حالا کلید می‌سازد و درخواست را **رد** می‌کند |
| ۳ | **کلیدها با `Math.random()` ساخته می‌شدند** — قابل پیش‌بینی، مناسب رمز نیست. | 🟠 بالا | `Utilities.getUuid()` (CSPRNG) |
| ۴ | مقایسه کلید با `===` — نشت زمانی | 🟡 متوسط | مقایسه constant-time در هر دو سمت |
| ۵ | نبود سقف حجم بدنه درخواست | 🟡 متوسط | سقف ۱ مگابایت |
| ۶ | خطای ۴xx باعث تلاش مجدد بی‌فایده می‌شد | 🟢 پایین | فقط خطاهای گذرا retry می‌شوند |

### اصول رعایت‌شده

- **Secretها هرگز در Git نیستند.** `wrangler.toml` فقط آدرس دارد؛ کلیدها با
  `wrangler secret put` رمزنگاری‌شده ذخیره می‌شوند. `npm run check` وجود Secret در فایل را
  تشخیص می‌دهد و هشدار می‌دهد.
- **لاگ ایمن.** در Apps Script تابع `sanitize_()` و در Worker تابع `redact()` هر توکن یا کلید
  را پیش از رسیدن به لاگ حذف می‌کنند. الگوی `\d+:[A-Za-z0-9_-]{30,}` نیز به‌عنوان لایه دوم پاک می‌شود.
- **جادوگر نصب توکن را ذخیره نمی‌کند** — نه در فایل، نه در `argv` (که در لیست پروسه‌ها دیده می‌شود)؛
  Secretها از طریق `stdin` به wrangler داده می‌شوند.
- **گزارش‌های تشخیصی فقط بله/خیر می‌دهند**، هرگز مقدار کلید را نشان نمی‌دهند.
- **`?health=1` روی `/exec` نیازمند کلید است**؛ بدون آن فقط نسخه برنامه برگردانده می‌شود.
- **دو کلید مستقل** برای دو مرز اعتماد، تا لو رفتن یکی، دیگری را به خطر نیندازد.
- **کمترین دسترسی:** فقط دو scope در `appsscript.json` (`spreadsheets` و `script.external_request`).

### چرخش کلیدها (توصیه: هر ۶ ماه)

```bash
# کلید Worker ← Apps Script
# ۱) در Apps Script مقدار WEBHOOK_SECRET را با یک مقدار تصادفی جدید عوض کنید
# ۲) همان را در Cloudflare ثبت کنید:
npx wrangler secret put APPS_SCRIPT_SECRET

# کلید تلگرام ← Worker
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# سپس همان مقدار را در Script Properties بگذارید و setupWebhook() را اجرا کنید
```

اگر توکن ربات لو رفت: در BotFather دستور `/revoke` را بزنید، توکن جدید را در `BOT_TOKEN`
ذخیره کنید و `setupWebhook()` را دوباره اجرا کنید.

---

## ۹. ساختار پروژه

```
.
├── apps-script/
│   ├── Code.gs           منطق کامل ربات (تک‌فایل، برای چسباندن در ویرایشگر)
│   └── appsscript.json   مانیفست: منطقه زمانی و دسترسی‌های حداقلی
├── worker/
│   ├── src/index.js      گیت‌وی وبهوک (تنها فایلی که روی Cloudflare اجرا می‌شود)
│   ├── scripts/
│   │   ├── setup.mjs     جادوگر نصب — npm run setup
│   │   └── check.mjs     تأیید انتشار — npm run check
│   ├── wrangler.toml     تنظیمات Worker (بدون Secret)
│   ├── .dev.vars.example نمونه متغیرهای توسعه محلی
│   └── package.json
├── .gitignore
└── README.md
```

### نقاط ورود در `Code.gs`

| تابع | کاربرد |
| --- | --- |
| `quickStart()` | 🚀 نصب کامل با یک اجرا |
| `initialSetup()` | ساخت/تعمیر اسپردشیت و شیت‌ها (اجرای چندباره بی‌خطر) |
| `checkSetup()` | بررسی پیکربندی، بدون شبکه |
| `healthCheck()` | بررسی زنده ۶ موردی |
| `setupWebhook()` | ثبت وبهوک روی آدرس Worker |
| `repairDatabase()` | تعمیر غیرمخرب ساختار جداول |
| `selfTest()` | تست سرتاسری |
| `getDiagnostics()` | خروجی JSON تشخیصی (بدون Secret) |
| `doPost(e)` / `doGet(e)` | نقاط ورود Web App |

---

## مجوز

استفاده شخصی و تجاری آزاد است.

**نسخه:** 1.1.0 · **بیلد:** 2026.09.04 · **اسکیما:** 1 (بدون تغییر نسبت به نسخه قبل)
