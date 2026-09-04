# NexiUP — Telegram Webhook Gateway (Cloudflare Worker + Google Apps Script)

این ریپازیتوری شامل نسخه‌ی **اصلاح‌شده و نهایی** معماری Webhook ربات تلگرام **NexiUP** است.
منطق اصلی ربات (کاربران، سفارش‌ها، کیف پول، پنل مدیریت، ۱۳ شیت گوگل‌شیت) دقیقاً همان چیزی است
که بود و **هیچ تغییری در دیتا یا منطق کسب‌وکار داده نشده**؛ فقط لایه‌ی دریافت Webhook تلگرام
پیدا، تشخیص و کامل رفع شد.

---

## 🔎 ریشه‌ی واقعی مشکل (Root Cause)

بعد از بررسی کامل ریپو مشخص شد مشکل چیزی نبود که در ابتدا حدس زده می‌شد (Secret اشتباه، تنظیمات
Deploy و غیره). مشکل این بود:

> **فایل `worker/src/index.js` — یعنی خودِ کد Cloudflare Worker — اصلاً داخل ریپو commit نشده بود.**

فایل `worker/wrangler.toml` به `main = "src/index.js"` اشاره می‌کرد، اما این فایل هرگز وجود نداشت.
در نتیجه هر Workerـی که واقعاً روی Cloudflare Deploy شده بود، یا نسخه‌ی پیش‌فرض/دستی «Hello World»
بود (که فقط `200 OK` برمی‌گرداند و هیچ‌کاری نمی‌کند) یا اصلاً از این ریپو build نشده بود. این دقیقاً
همان رفتاری است که مشاهده می‌شد: **«Worker پاسخ 200 می‌دهد ولی درخواست به Apps Script منتقل نمی‌شود
و doPost اجرا نمی‌شود.»**

راه‌حل: نوشتن و اضافه‌کردن `worker/src/index.js` (گیت‌وی واقعی) + `worker/package.json` که هر دو در
این نسخه اضافه شده‌اند، به‌همراه چند سخت‌گیری امنیتی/عملکردی اضافه در همان فایل و در Apps Script.

---

## معماری نهایی

```
Telegram
   │  POST + هدر X-Telegram-Bot-Api-Secret-Token
   ▼
Cloudflare Worker   (worker/src/index.js)
   │  ۱) اعتبارسنجی هدر Telegram با مقایسه‌ی constant-time
   │  ۲) پاسخ فوری 200 OK به تلگرام (بدون صبر برای Apps Script)
   │  ۳) ctx.waitUntil() → فوروارد async به Apps Script با ?s=<APPS_SCRIPT_SECRET>&rid=<id>
   │  ۴) fetch() داخل Worker به‌صورت پیش‌فرض 302 گوگل را دنبال می‌کند (redirect: "follow")
   │  ۵) تلاش مجدد خودکار (retry) در صورت خطای شبکه/timeout
   ▼
Google Apps Script Web App   (apps-script/Code.gs → doPost)
   │  اعتبارسنجی مستقل با ?s= (WEBHOOK_SECRET) — بدون تغییر نسبت به قبل
   │  correlation id (?rid=) در Logs ثبت می‌شود تا ردیابی سرتاسری ممکن باشد
   ▼
منطق اصلی NexiUP (بدون هیچ تغییری): کاربران، سفارش‌ها، کیف پول، پنل مدیریت، ۱۳ شیت گوگل‌شیت
```

نکتهٔ کلیدی که کل مشکل ۳۰۲ را حل می‌کند: **`fetch()` در Cloudflare Worker به‌صورت پیش‌فرض
Redirect را دنبال می‌کند.** پس هر ۳۰۲ که گوگل برمی‌گرداند فقط داخل Worker مصرف می‌شود و هرگز به
تلگرام نمی‌رسد. تلگرام فقط یک `200 OK` واقعی و فوری از Worker می‌بیند — مستقل از این‌که Apps Script
چقدر طول بکشد تا واقعاً پیام را پردازش کند.

---

## ساختار پروژه

```
.
├── apps-script/
│   ├── Code.gs            ← کل منطق ربات (بدون تغییر در منطق کسب‌وکار؛ فقط doPost/setupWebhook سخت‌تر شد)
│   └── appsscript.json    ← مانیفست پروژه Apps Script
├── worker/
│   ├── src/
│   │   └── index.js       ← ✅ فایل گمشده که اضافه شد — گیت‌وی واقعی Webhook
│   ├── package.json       ← ✅ اضافه شد (برای npm install / wrangler)
│   ├── wrangler.toml      ← اصلاح شد (+ observability/logs)
│   ├── .dev.vars.example  ← نمونه متغیرهای محیطی محلی (بدون Secret واقعی)
│   └── .gitignore
├── .gitignore
└── README.md              ← همین فایل
```

> این ریپو یک اسکلت Next.js/Drizzle هم در `src/` دارد که بخشی از سندباکس توسعه است و ربطی به
> ربات تلگرام ندارد؛ فقط پوشه‌های `apps-script/` و `worker/` را برای Deploy واقعی نیاز دارید.

---

## چه چیزی دقیقاً اصلاح شد

| # | مشکل | علت واقعی | راه‌حل اعمال‌شده |
|---|------|-----------|-------------------|
| 1 | Webhook مستقیم روی Apps Script → خطای `302 Found` | `/exec` همیشه یک ریدایرکت ۳۰۲ به `script.googleusercontent.com` برمی‌گرداند و تلگرام آن را دنبال نمی‌کند | Worker به‌عنوان لایه‌ی میانی که با `fetch(..., {redirect:"follow"})` ۳۰۲ را داخل خودش مصرف می‌کند و فقط `200 OK` واقعی را به تلگرام برمی‌گرداند |
| 2 | Worker پاسخ 200 می‌دهد ولی `doPost` هرگز اجرا نمی‌شود | **فایل `worker/src/index.js` اصلاً در ریپو وجود نداشت** — Worker واقعی روی Cloudflare از کد این پروژه build نشده بود | اضافه‌شدن کامل `worker/src/index.js` با منطق فوروارد واقعی + `worker/package.json` |
| 3 | نبود سیستم Retry برای فوروارد | فوروارد فقط یک تلاش داشت (در نسخه‌ی فرضی/قدیمی) | ۲ تلاش خودکار با فاصله‌ی ۳۰۰ میلی‌ثانیه + timeout ۲۰ ثانیه‌ای با `AbortController` |
| 4 | نبود Log/Debug قابل‌اتکا | هیچ ساختار لاگ JSON‌شده و correlation id‌ای بین Worker و Apps Script نبود | لاگ‌های ساختاریافته JSON در Worker (`console.log/warn/error`, قابل مشاهده با `wrangler tail` و Workers Logs) + `rid` مشترک که هم در لاگ Worker و هم در شیت `Logs` ثبت می‌شود |
| 5 | امنیت Secret | مقایسه‌ی رشته‌ای معمولی مستعد timing attack؛ خطر ست‌نشدن Secret و باز ماندن endpoint | مقایسه‌ی constant-time در Worker + هشدار صریح در لاگ اگر `TELEGRAM_WEBHOOK_SECRET` ست نشده باشد + دو Secret کاملاً مستقل (Telegram↔Worker و Worker↔Apps Script) |
| 6 | تنظیمات Deploy ناقص | `wrangler.toml` فاقد observability بود؛ بدون `package.json` نصب `wrangler` هم ناقص بود | `worker/package.json` اضافه شد؛ `[observability] enabled = true` برای فعال‌سازی Workers Logs اضافه شد |
| 7 | پاسخ کند به تلگرام | در حالت مستقیم (بدون Worker)، تلگرام باید کل زمان اجرای Apps Script را صبر می‌کرد | Worker بلافاصله (میلی‌ثانیه‌ای) `200 OK` برمی‌گرداند و فوروارد را در پس‌زمینه با `ctx.waitUntil()` انجام می‌دهد |

هیچ ستون، شیت، رکورد گوگل‌شیتی یا منطق کاربران/سفارش/کیف‌پول/پنل مدیریت حذف یا تغییر داده نشده است.

---

## راه‌اندازی از صفر

### پیش‌نیازها

- یک حساب Google (برای Apps Script + Google Sheets)
- یک حساب رایگان [Cloudflare](https://dash.cloudflare.com/sign-up)
- Node.js نسخه ۱۸ یا بالاتر (برای اجرای `npx wrangler`)
- توکن ربات از [@BotFather](https://t.me/BotFather)
- شناسه عددی تلگرام خودتان (برای `ADMIN_IDS`)

### مرحله ۱ — ساخت پروژه Google Apps Script

1. به [script.google.com](https://script.google.com) بروید و یک پروژه جدید بسازید (مثلاً `NexiUP`).
2. محتوای `apps-script/Code.gs` این ریپو را به‌طور کامل در فایل `Code.gs` پروژه جای‌گذاری کنید.
3. از **⚙️ Project Settings** گزینهٔ *Show "appsscript.json" manifest file in editor* را فعال کنید و
   محتوای `apps-script/appsscript.json` را در آن فایل جای‌گذاری کنید.
4. در **Project Settings → Script Properties** این دو مقدار را اضافه کنید:
   - `BOT_TOKEN` = توکن دریافتی از BotFather
   - `ADMIN_IDS` = شناسه عددی شما (چند نفر را با کاما جدا کنید)
5. تابع `initialSetup` را از نوار بالای ویرایشگر انتخاب و اجرا کنید (دسترسی Spreadsheets +
   External requests را تأیید کنید). خروجی، لینک اسپردشیت دیتابیس (۱۳ شیت) را می‌دهد.

### مرحله ۲ — Deploy کردن Web App

1. **Deploy → New deployment → نوع: Web app**
2. **Execute as: Me**
3. **Who has access: Anyone**
4. Deploy بزنید و آدرس `/exec` را کپی کنید (نه `/dev`).
5. همین آدرس را در **Script Properties** با کلید `WEB_APP_URL` ذخیره کنید.

> هر بار Code.gs را عوض کردید: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**
> (آدرس `/exec` ثابت می‌ماند).

هنوز Webhook تلگرام را ثبت **نکنید** — اول Worker را می‌سازیم.

### مرحله ۳ — ساخت Secretها (هیچ‌کدام را commit نکنید)

| نام | نحوهٔ ساخت |
| --- | --- |
| `WEBHOOK_SECRET` (Apps Script) | خودکار توسط `initialSetup()` ساخته می‌شود؛ از Script Properties کپی کنید |
| `APPS_SCRIPT_SECRET` (Worker) | همان مقدار `WEBHOOK_SECRET` بالا — باید کاراکتر به کاراکتر یکسان باشد |
| `TELEGRAM_WEBHOOK_SECRET` (Worker + Apps Script) | مقدار تصادفی جدید: `openssl rand -hex 32` |

### مرحله ۴ — نصب و پیکربندی Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
```

آدرس واقعی Web App خود را در `wrangler.toml` جایگزین placeholder کنید:

```toml
[vars]
APPS_SCRIPT_URL = "https://script.google.com/macros/s/XXXXXXXX/exec"
```

سپس Secretها را ثبت کنید (هرگز داخل فایل قرار نمی‌گیرند):

```bash
npx wrangler secret put APPS_SCRIPT_SECRET
# مقدار WEBHOOK_SECRET را paste کنید

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# مقدار تصادفی openssl را paste کنید
```

تست محلی (اختیاری):

```bash
cp .dev.vars.example .dev.vars
# مقادیر واقعی را داخل .dev.vars بنویسید (هرگز commit نمی‌شود)
npx wrangler dev
```

### مرحله ۵ — Deploy کردن Worker

```bash
npx wrangler deploy
```

خروجی:

```
Published nexiup-telegram-gateway
  https://nexiup-telegram-gateway.<your-subdomain>.workers.dev
```

همین آدرس، **Webhook نهایی** شماست.

### مرحله ۶ — ثبت آدرس Worker در Apps Script

در Script Properties اضافه کنید:

- `WORKER_URL` = `https://nexiup-telegram-gateway.<your-subdomain>.workers.dev`

و همان مقدار مرحله ۳ را هم اضافه کنید:

- `TELEGRAM_WEBHOOK_SECRET` = دقیقاً همان مقداری که با `wrangler secret put TELEGRAM_WEBHOOK_SECRET` ثبت کردید

سپس پروژه را دوباره Deploy کنید (New version).

### مرحله ۷ — ثبت Webhook روی تلگرام

**روش الف) از داخل ویرایشگر Apps Script:** تابع `setupWebhook()` را اجرا کنید (یا از پنل ربات:
`/admin → 🔧 ابزارهای سیستم → ♻️ تنظیم مجدد وبهوک`).

**روش ب) مستقیم با curl (توصیه‌شده، دقیق‌تر):**

```bash
curl -s -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "https://nexiup-telegram-gateway.<your-subdomain>.workers.dev",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": ["message", "callback_query"],
        "drop_pending_updates": true
      }'
```

پاسخ موفق: `{ "ok": true, "result": true, "description": "Webhook was set" }`

---

## تست و عیب‌یابی

**۱) Worker پاسخ 200 می‌دهد؟**

```bash
curl -i https://nexiup-telegram-gateway.<your-subdomain>.workers.dev/
```

باید `HTTP/2 200` با JSON شامل `"ok": true` ببینید.

**۲) وضعیت واقعی Webhook نزد تلگرام:**

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo" | jq
```

باید `url` = آدرس Worker، `last_error_message` خالی/قدیمی، و بعد از چند دقیقه `pending_update_count: 0` باشد.

**۳) تست end-to-end واقعی:** به ربات در تلگرام بروید و `/start` بفرستید — باید بلافاصله پاسخ بگیرید.

**۴) شبیه‌سازی Update مستقیم روی Worker:**

```bash
curl -i -X POST "https://nexiup-telegram-gateway.<your-subdomain>.workers.dev/" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>" \
  -d '{
        "update_id": 123456789,
        "message": {
          "message_id": 1, "date": 0,
          "chat": {"id": 111111, "type": "private"},
          "from": {"id": 111111, "is_bot": false, "first_name": "Test"},
          "text": "/start"
        }
      }'
```

باید فوراً `200 OK` بگیرید و چند ثانیه بعد ردِ Update را در شیت `Logs` (event: `webhook_received`) ببینید.

**۵) بررسی رد شدن Secret اشتباه (باید ۴۰۱ بگیرید):**

```bash
curl -i -X POST "https://nexiup-telegram-gateway.<your-subdomain>.workers.dev/" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: wrong-secret" \
  -d '{"update_id":1}'
```

**۶) لاگ زندهٔ Worker:**

```bash
cd worker
npx wrangler tail
```

خروجی JSON ساختاریافته می‌بینید با فیلدهای `level`, `message`, `rid`, `status`, `elapsedMs` و غیره —
همین `rid` در شیت `Logs` هم (ستون `data`) قابل جست‌وجوست، برای ردیابی یک Update خاص سرتاسر مسیر.

همچنین می‌توانید از داشبورد Cloudflare → Worker خود → **Logs** (Workers Logs) بدون نیاز به ترمینال
باز، لاگ‌ها را ببینید (به لطف `[observability] enabled = true` در `wrangler.toml`).

**۷) تست کامل سمت Apps Script:** از پنل ربات `/admin → 🩺 سلامت سیستم` یا اجرای `selfTest()` در ویرایشگر.

---

## چک‌لیست نهایی بعد از Deploy

- [ ] `curl` روی ریشهٔ Worker پاسخ `200 OK` با JSON برمی‌گرداند.
- [ ] `getWebhookInfo` تلگرام آدرس Worker را نشان می‌دهد، بدون `last_error_message` جدید.
- [ ] ارسال `/start` در تلگرام بلافاصله پاسخ فارسی و منو می‌دهد.
- [ ] پیام‌ها/دکمه‌های شیشه‌ای منو به‌درستی پردازش می‌شوند.
- [ ] Secret نادرست باعث `401` می‌شود.
- [ ] `wrangler tail` یا Workers Logs، فوروارد موفق (`status: 200`) به Apps Script را نشان می‌دهد.
- [ ] `selfTest()` در Apps Script همه‌چیز را ✅ نشان می‌دهد.
- [ ] هیچ Secret واقعی در گیت‌هاب/`wrangler.toml`/کد commit‌شده نیست (فقط placeholder).
- [ ] `worker/.dev.vars` (در صورت وجود) در `.gitignore` است و commit نشده.

---

## سوالات متداول عیب‌یابی

**«Webhook was set» می‌گیرم ولی `/start` جواب نمی‌دهد.**
→ `getWebhookInfo` را چک کنید. اگر `pending_update_count` بالا می‌رود، `wrangler tail` را باز کنید. اگر
آنجا خطایی نیست ولی هنوز مشکل هست، `APPS_SCRIPT_SECRET` (Worker) را با `WEBHOOK_SECRET` (Apps Script)
مقایسه کنید — باید کاراکتر به کاراکتر یکسان باشند.

**۴۰۱ از Worker می‌گیرم وقتی تلگرام واقعی درخواست می‌زند.**
→ یعنی `secret_token` ارسالی به `setWebhook` با `TELEGRAM_WEBHOOK_SECRET` ثبت‌شده در Cloudflare یکی
نیست. دوباره `setWebhook` را با مقدار درست اجرا کنید.

**Worker همیشه 200 می‌دهد ولی هیچ‌وقت در `Logs` شیت چیزی ثبت نمی‌شود.**
→ این دقیقاً همان باگی بود که این نسخه رفع کرد: مطمئن شوید `worker/src/index.js` واقعاً در همین حالت
(از این ریپو) روی Cloudflare با `npx wrangler deploy` منتشر شده — نه یک اسکریپت دستی قدیمی در داشبورد.
با `npx wrangler tail` بررسی کنید که پیام‌های `"forwarded update to Apps Script"` دیده می‌شوند.

**همه‌چیز درست است ولی کمی کند جواب می‌دهد.**
→ طبیعی است اگر Google Sheets API کمی کند باشد؛ چون تلگرام همان لحظه `200 OK` از Worker می‌گیرد، این
تأخیر مانع تحویل Update نمی‌شود، فقط ارسال پیام نهایی چند صدم ثانیه دیرتر می‌رسد.

---

## امنیت

- هیچ Secret واقعی در این ریپو نیست — فقط `REPLACE_WITH_...` و مقادیر نمونه.
- `BOT_TOKEN` فقط در Script Properties گوگل زندگی می‌کند؛ Worker اصلاً آن را نمی‌بیند و لازم ندارد.
- دو Secret مستقل (Telegram↔Worker و Worker↔Apps Script) یعنی لو رفتن یکی، دیگری را افشا نمی‌کند.
- مقایسهٔ Secret در Worker با الگوریتم **constant-time** انجام می‌شود تا در برابر timing attack مقاوم باشد.
- اگر `TELEGRAM_WEBHOOK_SECRET` ست نشده باشد، Worker به‌جای شکستن کامل، فقط هشدار لاگ می‌کند تا اولین
  Deploy هیچ‌وقت بدون دلیل قفل نشود؛ اما توصیه‌ی قطعی این است که همیشه این Secret را ست کنید.
- تابع `sanitize_()` در `Code.gs` قبل از هر `Logger.log` یا نوشتن در شیت `Logs`، مقادیر حساس را ماسک می‌کند.

---

## Migration از نسخهٔ در حال اجرا

اگر همین الان نسخه‌ی در حال اجرایی از NexiUP دارید، **هیچ داده‌ای در گوگل‌شیت از بین نمی‌رود**:

1. گوگل‌شیت دست‌نخورده می‌ماند (`SPREADSHEET_ID` همان قبلی است).
2. `Code.gs` را با نسخهٔ این ریپو جایگزین کنید (کل فایل).
3. `appsscript.json` را با نسخهٔ این ریپو جایگزین کنید.
4. Script Properties موجود (`BOT_TOKEN`, `ADMIN_IDS`, `SPREADSHEET_ID`, `WEB_APP_URL`, `WEBHOOK_SECRET`, ...) را دست نزنید.
5. `WORKER_URL` و `TELEGRAM_WEBHOOK_SECRET` را طبق مراحل بالا اضافه کنید.
6. پروژهٔ Apps Script را دوباره Deploy کنید (New version).
7. پوشهٔ `worker/` را طبق «مرحله ۴ و ۵» با `npx wrangler deploy` منتشر کنید — **این بار با فایل واقعی `src/index.js` که در این نسخه اضافه شده است.**
8. `setupWebhook()` را دوباره اجرا کنید یا دستور `curl` بالا را بزنید.

هیچ سرویس، سفارش، کاربر، کیف پول یا تنظیماتی جابه‌جا یا حذف نمی‌شود.
