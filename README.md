# NexiUP | نکسی آپ 🚀

> ربات تلگرام متن‌باز، حرفه‌ای و کامل برای فروش و مدیریت سرویس‌های اشتراکی با پرداخت و تحویل دستی، پیاده‌سازی شده بر روی زیرساخت کاملاً رایگان Cloudflare Workers و دیتابیس Cloudflare D1.
>
> A complete, production-ready, open-source Telegram bot for selling and managing subscription services (manual payment & manual delivery), built on 100% free Cloudflare Workers and Cloudflare D1 database.

---

### 🌐 انتخاب زبان / Select Language
- [🇮🇷 راهنمای فارسی (مطالعه به زبان فارسی)](#-راهنمای-فارسی)
- [🇬🇧 English Guide (Read in English)](#-english-guide)

---

<div id="-راهنمای-فارسی" dir="rtl">

# 🇮🇷 راهنمای فارسی

## ۱. معرفی پروژه

**نکسی آپ (NexiUP)** یک پلتفرم جامع، مدرن و کاملاً مستقل برای فروش و مدیریت انواع سرویس‌های اشتراکی (نظیر کانفیگ‌های V2Ray، پروکسی، اکانت‌های اختصاصی و غیره) در بستر تلگرام است. این ربات به صورت **تک‌فایلی (`worker.js`)**، با معماری ماژولار و بدون نیاز به هیچ‌گونه سرور اختصاصی، هاست پولی، داکر یا بسته‌های سنگین npm طراحی شده است و به طور کامل روی لایه **رایگان (Free Tier)** سرویس‌های ابری Cloudflare اجرا می‌شود.

هدف این پروژه، ارائه یک ابزار پایدار، امن و در عین حال به شدت پرسرعت است که هم برای کسب‌وکارهای فروش واقعی ایده‌آل باشد و هم جامعه برنامه‌نویسان بتوانند به سادگی آن را توسعه دهند.

### ویژگی‌های کلیدی
- **تک‌فایلی و بدون وابستگی**: تمام منطق ربات در قالب یک فایل جاوااسکریپت خالص (`worker.js`) قرار دارد.
- **دیتابیس ابری رایگان**: ذخیره‌سازی داده‌ها در Cloudflare D1 (پایگاه داده SQL توزیع‌شده با عملکرد فوق‌العاده).
- **راه‌اندازی فوق سریع (کمتر از ۵ دقیقه)**: صرفاً از طریق داشبورد کلودفلر و بدون نیاز به نصب هیچ نرم‌افزار، ترمینال یا دستور Wrangler.
- **پرداخت کاملاً دستی و واقعی**: پشتیبانی از شماره کارت‌های متعدد، آدرس‌های ارز دیجیتال (تتر TRC20، تون و...) و تایید نهایی فیش توسط مدیریت بدون درگاه‌های ناپایدار.
- **تحویل دستی و امن**: ارسال دقیق کانفیگ یا لینک سابسکرایب توسط مدیر با قابلیت کپی آسان (Monospace) و دسترسی همیشگی خریدار در بخش سرویس‌های من.
- **عضویت اجباری پیشرفته (چند کاناله)**: امکان تعریف بی‌نهایت کانال عمومی یا خصوصی با بررسی موازی و فوق‌سریع عضویت و رهگیری اعضا.
- **پنل مدیریت ۱۹ گانه درون تلگرام**: دسترسی به تمام ابزارهای مدیریتی بدون نیاز به محیط وب مجزا.
- **داشبورد تحلیلی و آماری جامع**: گزارش‌های دوره‌ای (امروز، ۷ روز، ۳۰ روز، کل) با یک کوئری تجمیعی بسیار بهینه.
- **سیستم کیف پول اتمیک**: واریز، برداشت، پرداخت ترکیبی و تاریخچه دوطرفه دقیق بدون ایجاد خطای تراکنش همزمان.
- **سیستم رفرال و کمیسیون**: لینک اختصاصی برای هر کاربر، پورسانت نقدی درصدی و واریز خودکار به کیف پول با محافظت ضدتقلب.
- **کدهای تخفیف منعطف**: تعریف تخفیف‌های درصدی یا ثابت با محدودیت تعداد مصرف، حداقل سفارش و تاریخ انقضا.
- **امکانات خلاقانه هوشمند**: یادآورهای خودکار انقضای سرویس (۳ روز و ۱ روز قبل)، گزارش روزانه خودکار، سیستم تیکت و پیام مستقیم، لغو خودکار سفارش‌های معلق، بنر اطلاعیه سنجاق‌شده و پشتیبان‌گیری یک‌کلیکه در تلگرام.

---

## ۲. بررسی محدودیت‌های پلن رایگان کلودفلر

این پروژه به گونه‌ای معماری شده است که حتی در ترافیک‌های بالا به هیچ عنوان از سقف پلن رایگان Cloudflare عبور نکند:

| شاخصه پلن رایگان | سقف مجاز کلودفلر | مصرف هوشمند نکسی آپ |
| :--- | :--- | :--- |
| **درخواست‌های Worker** | ۱۰۰,۰۰۰ درخواست در روز | پاسخ آنی با کد ۲۰۰ و انجام فرآیندها در پس‌زمینه با `waitUntil` |
| **کوئری خواندن دیتابیس D1** | ۵,۰۰۰,۰۰۰ ردیف در روز | کش درون‌حافظه‌ای ایزوله برای تنظیمات، متن‌ها و عضویت‌ها (کاهش ۹۰٪ کوئری‌ها) |
| **کوئری نوشتن دیتابیس D1** | ۱۰۰,۰۰۰ ردیف در روز | عدم درج رکورد اضافی در پیام‌های عادی و اجرای دسته‌ای کوئری‌ها با `db.batch()` |
| **فضای ذخیره‌سازی D1** | ۵ گیگابایت | ذخیره فیش‌ها به عنوان `file_id` تلگرام بدون اشغال فضای دیتابیس |
| **تعداد Subrequest در هر اجرا** | ۵۰ ساب‌ریکوئست | ارسال پیام‌های همگانی در بسته‌های ۲۵ تایی ایمن و سازگار |

---

## ۳. راهنمای نصب گام‌به‌گام (فقط از داشبورد کلودفلر در ۵ دقیقه)

برای راه‌اندازی این ربات نیازی به نصب نرم‌افزار، Node.js، گیت یا ترمینال ندارید. مراحل را به ترتیب زیر در داشبورد [Cloudflare Dashboard](https://dash.cloudflare.com) دنبال کنید:

### گام اول: ساخت دیتابیس D1
1. وارد حساب کلودفلر خود شوید.
2. از منوی کناری به بخش **Storage & Databases** > **D1 SQL Database** بروید.
3. روی دکمه **Create Database** کلیک کرده و نام آن را مثلاً `nexiup-db` قرار دهید.

### گام دوم: ساخت Worker و بارگذاری کد
1. از منوی کناری به بخش **Compute (Workers)** > **Workers & Pages** بروید.
2. روی دکمه **Create Application** و سپس **Create Worker** کلیک کنید.
3. یک نام دلخواه (مثلاً `nexiup-bot`) انتخاب کرده و روی **Deploy** بزنید.
4. وارد صفحه Worker ساخته شده شوید و روی تب **Settings** کلیک کنید.
5. به بخش **Bindings** بروید، روی **Add Binding** کلیک کرده و گزینه **D1 Database** را انتخاب نمایید:
   - **Variable name**: دقیقاً عبارت `DB` (با حروف بزرگ).
   - **D1 Database**: دیتابیسی که در گام اول ساختید (`nexiup-db`) را انتخاب کنید.
   - روی **Save** کلیک نمایید.

### گام سوم: تنظیم متغیرهای محیطی (Environment Variables)
در همان تب **Settings** از صفحه Worker، به بخش **Variables and Secrets** بروید و متغیرهای زیر را اضافه کنید:

| نام متغیر | نوع | اجباری؟ | توضیحات |
| :--- | :--- | :--- | :--- |
| `BOT_TOKEN` | Secret / Plaintext | **بله** | توکن ربات تلگرام دریافتی از BotFather@ |
| `ADMIN_IDS` | Plaintext | **بله** | شناسه عددی تلگرام مدیران اصلی (با کاما جدا شوند: `12345678,98765432`) |
| `WEBHOOK_SECRET` | Secret / Plaintext | اختیاری | یک رشته دلخواه و امن برای تایید اصالت درخواست‌های ارسالی تلگرام |
| `SETUP_KEY` | Secret / Plaintext | اختیاری | کلید امنیتی جهت محافظت از آدرس نصب (مثلاً `mysecretsetup123`) |

### گام چهارم: ذخیره کد و استقرار نهایی
1. روی دکمه **Edit code** در گوشه بالای صفحه Worker کلیک کنید.
2. تمام محتوای فایل `worker.js` موجود در این مخزن را کپی کرده و جایگزین محتوای ادیتور نمایید.
3. دکمه **Deploy** را بزنید تا کد مستقر شود.

### گام پنجم: اجرای جادوگر راه‌اندازی خودکار (/setup)
آدرس اینترنتی Worker خود را بردارید (مثلاً `https://nexiup-bot.yourname.workers.dev`) و یک بار در مرورگر به این صورت باز کنید:
```text
https://nexiup-bot.yourname.workers.dev/setup
```
*(اگر متغیر `SETUP_KEY` را تنظیم کرده‌اید، آن را به عنوان پارامتر اضافه کنید: `?key=mysecretsetup123`)*

با باز کردن این آدرس:
- تمام ۲۳ جدول و ایندکس‌های دیتابیس به صورت خودکار ساخته می‌شوند.
- وبهوک تلگرام به همراه کلید مخفی و لیست رویدادها فعال می‌گردد.
- دستورات استاندارد ربات تلگرام ثبت می‌شوند.
- صفحه خوش‌آمدگویی و تایید موفقیت نصب به زبان فارسی نمایش داده خواهد شد!

---

## ۴. فعال‌سازی Cron Trigger برای وظایف هوشمند (اختیاری و رایگان)

ربات بدون کران جاب هم کاملاً کار می‌کند؛ اما برای فعال شدن ارسال همگانی در پس‌زمینه، یادآورهای انقضای اشتراک (۳ روز و ۱ روز قبل)، لغو سفارش‌های پرداخت‌نشده و گزارش روزانه مدیریت، می‌توانید یک تریگر رایگان اضافه فرمایید:
1. در صفحه Worker به تب **Settings** > **Triggers** بروید.
2. در بخش **Cron Triggers** روی دکمه **Add Cron Trigger** کلیک کنید.
3. الگوی زیر را ثبت فرمایید (اجرا هر ۱۰ دقیقه):
   ```text
   */10 * * * *
   ```

---

## ۵. راهنمای مدیران ربات (اولین ورود)

1. وارد ربات تلگرام خود شوید و دستور `/start` یا `/admin` را ارسال نمایید.
2. اگر آیدی عددی شما در متغیر `ADMIN_IDS` باشد، دکمه **👑 پنل مدیریت ربات** به منوی اصلی اضافه می‌گردد.
3. در منوی مدیریت:
   - از بخش **💳 روش‌های پرداخت**: شماره کارت یا آدرس کیف پول تتر خود را اضافه کنید.
   - از بخش **🛒 سرویس‌ها**: پلن‌های پیش‌فرض را ویرایش یا پلن‌های جدید اضافه فرمایید.
   - از بخش **📢 کانال اجباری**: در صورت تمایل، کانال‌های اسپانسر یا اطلاع‌رسانی خود را ثبت نمایید (ربات باید در کانال ادمین باشد).
   - از بخش **📖 راهنماها**: متن‌های راهنمای نرم‌افزارهای اتصال برای اندروید، آیفون و ویندوز را طبق نیاز تغییر دهید.

---

## ۶. گردش کار خرید و تحویل سفارش‌ها

1. **انتخاب سرویس**: کاربر سرویس مورد نظر را مشاهده و انتخاب می‌کند.
2. **پیش‌فاکتور و کد تخفیف**: سیستم فاکتور را صادر کرده و کاربر می‌تواند کد تخفیف خود را ثبت کند یا از موجودی کیف پول خود استفاده نماید.
3. **پرداخت دستی یا ترکیبی**: کاربر بخشی یا کل مبلغ را پرداخت کرده و فیش بانکی را به صورت تصویر یا شماره پیگیری ارسال می‌کند.
4. **هشدار آنی به تمام مدیران**: پیام حاوی مشخصات خریدار، مبلغ و تصویر فیش بلافاصله برای تمام مدیران ارسال می‌شود.
5. **ارسال کانفیگ و تحویل**: مدیر دکمه **«✅ تایید و ارسال کانفیگ»** را لمس کرده، متن کانفیگ یا لینک سابسکرایب را می‌فرستد و ربات فوراً با فونت مونو و راهنمای اتصال آن را تحویل کاربر می‌دهد.
6. **تمدید**: کاربر هر زمان با مراجعه به «سرویس‌های من» می‌تواند اشتراک خود را با یک کلیک تمدید نماید.

---

## ۷. راهنمای بروزرسانی کد بدون از دست رفتن داده‌ها

پایگاه داده D1 کاملاً مستقل از کد Worker ذخیره می‌شود. بنابراین:
1. هر زمان نسخه جدیدی از `worker.js` در مخزن منتشر شد، کافیست به ویرایشگر کد Worker در کلودفلر بروید.
2. کل کد جدید را جایگزین کرده و **Deploy** را بزنید.
3. یک‌بار آدرس `/setup` را در مرورگر باز کنید تا مهاجرت‌های ساختار دیتابیس (در صورت وجود نسخه جدید) خودکار اجرا شوند.
- هیچ داده، سفارش یا کاربری پاک نخواهد شد!

---

## ۸. پشتیبان‌گیری و بازگردانی اطلاعات (Backup & Restore)

### روش اول: پشتیبان‌گیری درون‌ربات (یک کلیک)
- در پنل مدیریت ربات، به بخش **🔧 ابزارهای سیستم** بروید و دکمه **💾 دریافت فایل پشتیبان (Backup)** را بزنید. ربات یک فایل `.json` کامل شامل تمام تنظیمات، تعرفه‌ها، روش‌های پرداخت، متن‌ها، کانال‌ها و کدهای تخفیف به شما تحویل می‌دهد.
- برای بازگردانی کافیست همان فایل را با کپشن `#import_nexiup` در پیوی ربات برای ادمین ارسال کنید.

### روش دوم: خروجی کامل D1 از داشبورد
- در داشبورد کلودفلر وارد بخش **D1 SQL Database** شده، روی دیتابیس خود کلیک نمایید و از بخش **Settings** یا کنسول، دستور صادرات داده را اجرا فرمایید.

---

## ۹. سوالات متداول و عیب‌یابی (FAQ)

**سؤال: پس از ارسال پیام به ربات، هیچ پاسخی دریافت نمی‌کنم.**
> **پاسخ:** مطمئن شوید توکن `BOT_TOKEN` درست است و یک‌بار آدرس `https://<worker-url>/setup` را باز کرده‌اید تا وبهوک در تلگرام فعال شود. همچنین بررسی کنید نام بایندینگ D1 دقیقاً با حروف بزرگ `DB` باشد.

**سؤال: ربات عضویت کاربران در کانال را تشخیص نمی‌دهد.**
> **پاسخ:** ربات حتماً باید در کانال مذکور عضو و دارای دسترسی ادمین (Administrator) باشد تا دسترسی متد `getChatMember` برای آن باز شود. در پنل مدیریت از دکمه «🧪 تست دسترسی ربات» استفاده فرمایید.

**سؤال: چگونه شناسه عددی تلگرام خود را پیدا کنم؟**
> **پاسخ:** به ربات‌های نمایش شناسه مانند userinfobot@ پیام دهید تا آیدی عددی شما را نمایش دهد.

---

## ۱۰. چک‌لیست آزمایش سلامت سیستم (Testing Checklist)

- [ ] باز شدن صفحه `/setup` و دریافت نشان سبز برای هر ۳ مورد (دیتابیس، وبهوک، دستورات).
- [ ] پاسخ صحیح به دستور `/start` و نمایش منوی اصلی.
- [ ] باز شدن پنل مدیریت با ارسال `/admin` برای شناسه‌های موجود در `ADMIN_IDS`.
- [ ] امکان ثبت سفارش تستی و رسیدن هشدار فیش برای مدیر.
- [ ] تایید سفارش توسط مدیر و تحویل کانفیگ با فرمت کپی‌شونده به خریدار.
- [ ] فعال بودن استعلام کانال اجباری و مسدود ماندن کاربر تا زمان عضویت.
- [ ] کارکرد صحیح شارژ کیف پول و اعمال کد تخفیف.

</div>

---

<div id="-english-guide" dir="ltr">

# 🇬🇧 English Guide

## 1. Project Introduction

**NexiUP** is a complete, production-ready, open-source Telegram bot designed for selling and managing subscription services (e.g. V2Ray configs, VPN subscriptions, proxy credentials, premium accounts) using a **manual payment verification and manual delivery** model.

It is engineered as a **single-file ES Module (`worker.js`)** running on Cloudflare's serverless edge infrastructure with **Cloudflare D1 SQL Database** as its sole storage backend. NexiUP requires no external servers, no paid third-party dependencies, no Docker containers, and no Wrangler CLI setup.

### Key Highlights
- **Single-File Architecture**: The whole system is organized in `worker.js` with clearly documented sections for easy community maintenance.
- **100% Free Tier Compliant**: Engineered specifically to fit comfortably within Cloudflare's generous free quotas (100k requests/day, 5M D1 read rows/day).
- **Fast Dashboard-Only Setup**: Non-technical administrators can deploy and launch the bot in under 5 minutes directly from the Cloudflare web dashboard.
- **Manual Payment Flow**: Support for bank card transfers, cryptocurrencies (USDT TRC20, TON, etc.), and transaction slip verification via Telegram photo receipts.
- **Manual Subscription Delivery**: Admins review payment receipts, approve orders, and submit connection keys directly in Telegram; configs are formatted with one-tap copy blocks (`<code>...</code>`).
- **Multi-Channel Forced Join**: Protect your service behind unlimited public or private channels with parallel membership checks and join/leave event tracking.
- **Comprehensive In-Bot Admin Panel**: 19 operational submenus covering user profiles, order approvals, catalog management, guides, coupons, and wallet settlements.
- **High-Performance Analytics Dashboard**: Real-time aggregated business metrics across multiple timeframes (today, 7 days, 30 days, all time) using single batch queries.
- **Strict Double-Entry Ledger Wallet**: Atomic deposits, withdrawals, split payments, and referral commission bonuses without race conditions.
- **Smart Automations**: Background broadcast queue processor, subscription expiry notifications (3-day and 1-day reminders), abandoned order auto-cancellation, and automated daily admin summaries.

---

## 2. Cloudflare Free Tier Compliance

| Free Tier Resource | Cloudflare Daily Allowance | NexiUP Architectural Optimization |
| :--- | :--- | :--- |
| **Worker Invocations** | 100,000 req/day | Immediate 200 OK webhook response; background processing via `ctx.waitUntil`. |
| **D1 Read Rows** | 5,000,000 rows/day | In-memory isolate caching for settings, text templates, and membership status (~90% query reduction). |
| **D1 Write Rows** | 100,000 rows/day | Atomic batch statements (`db.batch`), deduplication checks, and zero writes on routine read events. |
| **D1 Database Storage** | 5 GB | Photos and receipts are stored as Telegram `file_id` references, keeping database storage negligible. |
| **Subrequests Per Run** | 50 subrequests | Broadcasts process in safe chunks of 25 users with rate-limit backoff. |

---

## 3. Step-by-Step Installation (Dashboard Only, < 5 Mins)

No coding, local compilation, or command-line tools are required. Follow these steps in the [Cloudflare Dashboard](https://dash.cloudflare.com):

### Step 1: Create a D1 Database
1. Go to **Storage & Databases** > **D1 SQL Database** in the left sidebar.
2. Click **Create Database**, name it (e.g. `nexiup-db`), and click **Create**.

### Step 2: Create Worker and Bind D1
1. Go to **Compute (Workers)** > **Workers & Pages**.
2. Click **Create Application** > **Create Worker**, assign a name (e.g. `nexiup-bot`), and click **Deploy**.
3. Open your newly created Worker and navigate to **Settings** > **Bindings**.
4. Click **Add Binding** > **D1 Database**:
   - **Variable name**: Type exactly `DB` (uppercase).
   - **D1 Database**: Select your database (`nexiup-db`).
   - Click **Save**.

### Step 3: Configure Environment Variables
In the same Worker **Settings** tab, open **Variables and Secrets** and add:

| Variable | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `BOT_TOKEN` | Secret / Text | **Yes** | Telegram Bot API token obtained from @BotFather |
| `ADMIN_IDS` | Text | **Yes** | Comma-separated list of numerical Telegram admin user IDs (e.g. `12345678,98765432`) |
| `WEBHOOK_SECRET` | Secret / Text | Optional | Optional secret string to authenticate incoming Telegram webhooks |
| `SETUP_KEY` | Secret / Text | Optional | Secret key parameter required to run or rerun the setup route (e.g. `mysecretkey`) |

### Step 4: Paste Code and Deploy
1. Click **Edit code** in the top right corner of the Worker page.
2. Copy the entire contents of `worker.js` from this repository and paste it into the editor, replacing the placeholder code.
3. Click **Deploy**.

### Step 5: Execute One-Time Setup Route
Open your Worker's public URL in your browser at the `/setup` endpoint:
```text
https://nexiup-bot.yourname.workers.dev/setup
```
*(If you set a `SETUP_KEY`, append it to the URL: `?key=mysecretkey`)*

The setup script automatically:
- Creates all 23 database tables, indexes, and initial seed catalog entries.
- Registers the Telegram webhook with secret token verification and allowed update types.
- Configures default Telegram bot commands (`/start`, `/services`, `/myservices`, `/wallet`, `/test`, `/help`, `/admin`).
- Displays a confirmation dashboard with step-by-step next actions.

---

## 4. Optional Cron Trigger Setup

To enable automated background tasks (broadcast queue execution, subscription expiration reminders, and abandoned order cleanups):
1. In your Worker's dashboard, go to **Settings** > **Triggers**.
2. Under **Cron Triggers**, click **Add Cron Trigger**.
3. Set the schedule to run every 10 minutes:
   ```text
   */10 * * * *
   ```

---

## 5. First-Time Admin Workflow

1. Open your Telegram bot and type `/start` or `/admin`.
2. As long as your numerical user ID is present in `ADMIN_IDS`, you will see the **👑 پنل مدیریت ربات** button.
3. Access the admin panel to:
   - Configure your payment details (bank card or crypto wallet) under **💳 روش‌های پرداخت**.
   - Review or modify default plans under **🛒 سرویس‌ها**.
   - Register required announcement channels under **📢 کانال اجباری** (make sure the bot is an admin in those channels).
   - Customize connection guides under **📖 راهنماها**.

---

## 6. Upgrade & Migration Guide

Because Cloudflare D1 storage exists independently of Worker code:
1. When a new version of `worker.js` is released, simply copy the updated file and paste it into the Cloudflare Worker editor.
2. Click **Deploy**.
3. Open `https://<worker-url>/setup` in your browser once to apply any new database schema migrations.
- Existing customers, orders, balances, and subscriptions remain intact!

---

## 7. Backup and Restore

- **In-Bot JSON Backup**: Go to **🔧 ابزارهای سیستم** in the Telegram admin panel and click **💾 دریافت فایل پشتیبان (Backup)**. The bot compiles a complete snapshot of settings, services, payment methods, texts, channels, and coupons, delivering it directly to your Telegram chat.
- **In-Bot Restore**: Simply send the backup JSON file back to the bot with the caption `#import_nexiup`.
- **D1 Console Export**: Full SQL exports can be performed from the Cloudflare Dashboard under D1 settings.

---

## 8. Security Considerations

- **Webhook Verification**: Validates the `X-Telegram-Bot-Api-Secret-Token` header on every request when `WEBHOOK_SECRET` is configured.
- **Strict Role-Based Access Control**: Verifies admin status on every admin callback and message before executing privileged actions.
- **Parameterized SQL Queries**: All database interactions use prepared statements (`db.prepare().bind()`) preventing SQL injection.
- **HTML Sanitization**: All user inputs (names, descriptions, rejection notes) are HTML-escaped before embedding in messages.
- **Token Masking**: Bot tokens and secrets are never exposed in user responses, error logs, or diagnostics cards.
- **Atomic Concurrency Controls**: Balance debits and status transitions check precondition locks to prevent double-spending or duplicate order approvals.

---

## 9. Contributing

Contributions are welcome! Please follow these guidelines:
1. Fork the repository and create a feature branch (`git checkout -b feature/amazing-feature`).
2. Adhere to the single-file modular architecture within `worker.js`.
3. Keep all customer-facing texts natural and RTL-friendly in Persian.
4. Test changes locally or in a sandbox before opening a Pull Request.

---

## 10. License

This project is open-source software licensed under the [MIT License](LICENSE).
Copyright (c) 2026 NexiUP Contributors.
</div>
