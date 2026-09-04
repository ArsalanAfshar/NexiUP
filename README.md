# NexiUP — Telegram Bot

**نکسی‌آپ** — a Telegram sales bot running on Google Apps Script with a Google Sheet as its
database and a Cloudflare Worker as the webhook gateway. Persian (RTL) user interface.

```
Telegram  ──▶  Cloudflare Worker  ──▶  Apps Script Web App  ──▶  Google Sheet
               answers 200 in ~5ms      all the bot logic         the database
```

Everything the bot does — services, orders, receipts, wallet, referrals, discount codes,
test configs, guides, forced channel join, broadcast and the full admin panel — lives in
one file: `apps-script/Code.gs`.

---

## Install in 6 steps (~15 minutes)

You need: a Telegram account, a Google account, and a free Cloudflare account.
No prior experience with any of them is assumed.

### Step 1 — Create the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Follow the prompts. BotFather replies with a **token** like `8123456789:AAH...`.
3. Keep that token handy. Treat it like a password.

### Step 2 — Create the Apps Script project

1. Go to <https://script.google.com> → **New project**.
2. Delete the sample code in `Code.gs`.
3. Copy the **entire contents** of [`apps-script/Code.gs`](apps-script/Code.gs) and paste it in.
4. Click the **Project Settings** (gear) icon → tick
   **"Show appsscript.json manifest file in editor"**.
5. Back in the editor, open `appsscript.json` and replace it with the contents of
   [`apps-script/appsscript.json`](apps-script/appsscript.json).
6. Save (Ctrl/Cmd + S).

### Step 3 — Add your token and admin id

In the editor, select the `configure` function from the dropdown and use the console, or
simply paste this into the top of the editor temporarily, run it once, then delete it:

```js
function myConfig() {
  configure({
    BOT_TOKEN: '8123456789:AAH...',   // from BotFather
    ADMIN_IDS: '123456789'            // your numeric Telegram id
  });
}
```

> **Don't know your Telegram id?** Message [@userinfobot](https://t.me/userinfobot),
> or finish the install and send `/id` to your own bot.

Alternatively, add them by hand under **Project Settings → Script Properties**.

### Step 4 — Run `setup()`

Select **`setup`** in the function dropdown and press **Run**. Approve the permissions
prompt (Google will warn that the app is unverified — that is expected for your own script;
choose *Advanced → Go to project*).

`setup()` creates the spreadsheet, all 13 sheets, the default settings and sample data,
then **prints the two secrets you need for Cloudflare**. Copy them from the execution log:

```
🔐 COPY THESE TWO SECRETS INTO CLOUDFLARE
     wrangler secret put APPS_SCRIPT_SECRET
       → <a long random string>
     wrangler secret put TELEGRAM_WEBHOOK_SECRET
       → <another long random string>
```

### Step 5 — Deploy the Web App, then the Worker

**5a. Deploy the Apps Script Web App**

1. **Deploy → New deployment → ⚙ → Web app**.
2. Set *Execute as* = **Me**, *Who has access* = **Anyone**.
3. Deploy, then copy the **/exec** URL.
4. Run `configure({ WEB_APP_URL: 'https://script.google.com/macros/s/.../exec' })`.

> It must end in `/exec`. A `/dev` URL requires a Google login and will never work.

**5b. Deploy the Cloudflare Worker**

```bash
cd worker
npm install
npx wrangler login

# Paste your /exec URL into wrangler.toml under [vars] APPS_SCRIPT_URL, then:
npx wrangler secret put APPS_SCRIPT_SECRET        # the 1st secret from step 4
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # the 2nd secret from step 4
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g.
`https://nexiup-telegram-gateway.yourname.workers.dev`.

Verify it in a browser — you should see `"ok": true`:

```bash
curl https://nexiup-telegram-gateway.yourname.workers.dev
```

Then save it back into Apps Script:

```js
configure({ WORKER_URL: 'https://nexiup-telegram-gateway.yourname.workers.dev' });
```

### Step 6 — Connect and verify

Run these two functions in the Apps Script editor:

```
connect()       →  registers the Telegram webhook on your Worker
healthCheck()   →  verifies every part of the deployment
```

`healthCheck()` prints a report. When every line is ✅, send `/start` to your bot.

---

## Deployment checklist

Print this and tick as you go.

| # | Task | How to verify |
|---|------|---------------|
| 1 | Bot created with @BotFather | You have a token `NNNNN:AA...` |
| 2 | `Code.gs` + `appsscript.json` pasted into a new Apps Script project | Editor shows both files |
| 3 | `BOT_TOKEN` and `ADMIN_IDS` configured | `checkConfig()` does not list them |
| 4 | `setup()` executed successfully | Spreadsheet link appears in the log |
| 5 | Both secrets copied out of the `setup()` log | You have two long random strings |
| 6 | Web App deployed with access = **Anyone** | You have an `/exec` URL |
| 7 | `WEB_APP_URL` saved in Script Properties | `checkConfig()` does not list it |
| 8 | `APPS_SCRIPT_URL` set in `worker/wrangler.toml` | Ends in `/exec` |
| 9 | Both Worker secrets set with `wrangler secret put` | `wrangler secret list` shows two |
| 10 | Worker deployed | `curl <worker-url>` returns `"ok": true` |
| 11 | `WORKER_URL` saved in Script Properties | `checkConfig()` returns `ok: true` |
| 12 | `connect()` executed | Report says webhook set |
| 13 | `healthCheck()` all green | Every line shows ✅ |
| 14 | `/start` in Telegram replies instantly | Main menu appears |
| 15 | `🛠 پنل مدیریت` button visible to you | Confirms `ADMIN_IDS` is right |

---

## Configuration reference

All configuration lives in **Script Properties** (Apps Script → Project Settings). Set them
with `configure({ KEY: 'value' })` or by hand. `checkConfig()` lists anything missing.

| Key | Required | Where it comes from |
|-----|----------|---------------------|
| `BOT_TOKEN` | ✅ | @BotFather |
| `ADMIN_IDS` | ✅ | Your numeric Telegram id; comma-separated for several |
| `SPREADSHEET_ID` | ✅ | Created automatically by `setup()` |
| `WEBHOOK_SECRET` | ✅ | Generated by `setup()`; must equal the Worker's `APPS_SCRIPT_SECRET` |
| `WEB_APP_URL` | ✅ | The `/exec` URL from Deploy |
| `WORKER_URL` | ✅ | The URL `wrangler deploy` printed |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | Generated by `setup()`; must equal the Worker's secret of the same name |

Worker bindings (in `worker/`):

| Binding | Type | Must match |
|---------|------|-----------|
| `APPS_SCRIPT_URL` | var in `wrangler.toml` | `WEB_APP_URL` above |
| `APPS_SCRIPT_SECRET` | secret | `WEBHOOK_SECRET` above |
| `TELEGRAM_WEBHOOK_SECRET` | secret | `TELEGRAM_WEBHOOK_SECRET` above |
| `ALLOW_UNVERIFIED` | var, optional | Local `wrangler dev` only — never in production |

Everything else (prices, texts, buttons, card number, referral percent, feature toggles) is
edited **inside the bot**, in the admin panel. Nothing else needs code changes.

---

## Diagnostics

| Tool | Where | What it checks |
|------|-------|----------------|
| `healthCheck()` | Apps Script editor, or 🛠 پنل مدیریت → 🔍 بررسی سلامت اتصال‌ها | Config, spreadsheet, bot token, webhook registration, live Worker probe, secrets, admins |
| `checkConfig()` | Apps Script editor | Which Script Properties are still missing |
| `getDiagnostics()` | Apps Script editor | Machine-readable status, row counts, last error — contains no secrets |
| `repairDatabase()` | Editor, or 🛠 → 🛠 تعمیر دیتابیس | Recreates missing sheets/columns without touching data |
| `curl <worker-url>` | Terminal | Worker liveness + which bindings are set |
| `npx wrangler tail` | Terminal, in `worker/` | Live Worker request log |
| `Logs` sheet | The spreadsheet | Every bot event, with secrets redacted |

Each forwarded update carries a correlation id (`rid`) that appears both in the Worker log
and in the `Logs` sheet, so a single interaction can be traced end to end.

---

## Troubleshooting

**Bot does not respond at all**
Run `healthCheck()`. It pinpoints the broken link. Most common causes: the Web App was
deployed with access set to *Only myself* instead of *Anyone*, or `WORKER_URL` was never saved.

**`curl <worker-url>` returns 503**
The Worker is missing a secret or `APPS_SCRIPT_URL`. The response body lists exactly which.

**Worker logs show `Apps Script returned a non-2xx status: 401/403`**
`APPS_SCRIPT_SECRET` in Cloudflare does not match `WEBHOOK_SECRET` in Apps Script. Re-copy it
from Script Properties and run `wrangler secret put APPS_SCRIPT_SECRET` again.

**Telegram reports "Wrong response from the webhook: 302 Found"**
The webhook is pointing straight at `/exec` instead of at the Worker. Set `WORKER_URL`
and run `connect()`.

**After changing `Code.gs`, nothing changes**
Apps Script serves the last *deployed* version. Use **Deploy → Manage deployments → ✏️ →
Version: New version → Deploy**. The `/exec` URL stays the same.

**Admin panel button is missing**
`ADMIN_IDS` does not contain your numeric id. Send `/id` to the bot and compare.

---

## Performance

The bot previously took around ten seconds to answer. The rewritten data layer brings a
warm interaction down to well under a second. Measured with a simulated Apps Script
runtime against a 400-user / 300-order dataset (`sheetOps` = spreadsheet round trips,
`cellsRead` = cells transferred):

| Interaction | Before | After |
|---|---|---|
| `/start` (returning user) | 11 ops · 13 property reads · 12,111 cells | **5 ops · 2 · 51 cells** |
| Main menu → buy | 10 ops · 12 · 6,123 cells | **6 ops · 2 · 63 cells** |
| Inline button (`U:buy:1`) | 10 ops · 13 · 6,123 cells | **6 ops · 2 · 63 cells** |
| Inline button (`U:menu`) | 8 ops · 13 · 6,096 cells | **4 ops · 2 · 36 cells** |
| Admin home | 20 ops · 18 · 31,360 cells | **13 ops · 2 · 13,279 cells** |
| Admin user card | 15 ops · 14 · 19,372 cells | **13 ops · 2 · 4,912 cells** |

What changed:

- **One spreadsheet open and one read per sheet per execution.** Every lookup used to
  re-read an entire sheet; results are now cached in memory for the request.
- **A `CacheService` row index** for users, orders, services and configs: a known record is
  fetched with a single one-row read instead of scanning the sheet.
- **Settings cached across executions** (6 min), invalidated on every write, so a warm
  update never touches the `Settings` sheet.
- **The whole property store is read once** per execution instead of 12–18 separate reads.
- **Logs are buffered** and written with one `setValues()` per request.
- **`UrlFetchApp.fetchAll()`** for admin notifications, channel-membership checks and
  broadcasts — these were sequential blocking calls.
- **No `LockService` on the hot path.** Dedupe is now a lock-free cache check; the lock had
  been serialising every update in the whole bot.
- **Callback queries are acknowledged first**, so the button spinner clears immediately.
- **`last_seen` is throttled** to one write per two minutes instead of one per keystroke.
- **Broadcasts send in concurrent batches of 25** instead of one-at-a-time with a sleep.

Business logic, the sheet schema and every feature are unchanged. A 51-check functional
regression suite covering registration, orders, discounts, wallet, referrals, config
delivery, test cooldown, wizards, gating, redaction and schema integrity passes against the
optimised build.

---

## Migrating from the previous version

Your data is safe — the schema is unchanged and nothing is deleted. Budget ten minutes.

1. **Back up first.** Open your NexiUP spreadsheet → *File → Make a copy*.

2. **Note your current secrets.** Apps Script → Project Settings → Script Properties.
   Write down `WEBHOOK_SECRET` and, if present, `TELEGRAM_WEBHOOK_SECRET`. Keeping the
   existing values means you do not have to touch your Cloudflare secrets at all.

3. **Replace the code.** In the Apps Script editor, select all of `Code.gs`, delete it, and
   paste the new version. Save. *(Script Properties are not affected by this.)*

4. **Re-deploy the Web App.** Deploy → Manage deployments → ✏️ → Version: **New version** →
   Deploy. The `/exec` URL does not change, so Cloudflare needs no update.

5. **Update the Worker.**
   ```bash
   cd worker && git pull && npx wrangler deploy
   ```
   The new Worker **fails closed** if `TELEGRAM_WEBHOOK_SECRET` is not set. If you never set
   it before, set it now and re-run `connect()` in Apps Script so Telegram starts sending it:
   ```bash
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

6. **Run `setup()` once.** It is idempotent: it repairs anything missing, adds the new
   `TELEGRAM_WEBHOOK_SECRET` if absent, and preserves all existing data and settings.

7. **Run `healthCheck()`.** Fix any ❌ lines, then send `/start` to confirm.

Notes:

- `initialSetup()` still exists as an alias for `setup()`, so old bookmarks keep working.
- Nothing in the `Settings` sheet is overwritten — your prices, texts and card number stay.
- Cached settings live for 6 minutes; a change made in the admin panel is applied
  immediately for the editing admin and within a few minutes everywhere else.

---

## Security

- **Secrets are never committed.** They live in Script Properties (Google) and Wrangler
  secrets (Cloudflare). `wrangler.toml` and `.dev.vars.example` contain placeholders only.
- **The Worker fails closed.** Without `TELEGRAM_WEBHOOK_SECRET` it returns 503 rather than
  forwarding unauthenticated traffic into your backend. The old build logged a warning and
  forwarded anyway.
- **Constant-time secret comparison** on the inbound header, so the value cannot be
  recovered by timing the endpoint.
- **Nothing sensitive is logged.** The Worker logs hostnames and booleans, never URLs with
  query strings, secret values, or rejected token attempts. Apps Script runs every log line
  through `sanitize_()`, which redacts the bot token and both secrets.
- **Misconfiguration returns 503, not 200.** Telegram keeps the update in its retry queue
  instead of discarding it.
- **Retries are bounded**, with backoff, and only for 5xx/429/network errors.
- **Request size is capped** at 1 MB.
- **Admin actions are authorised on every callback**, not just when the menu is drawn.
- **Diagnostics output is safe to share** — `healthCheck()` and `getDiagnostics()` report
  booleans and hostnames only.

The bot's Web App is necessarily "Anyone"-accessible (Telegram must reach it), which is why
`doPost` independently validates the `?s=` secret on every single request.

---

## Project structure

```
.
├── apps-script/
│   ├── Code.gs           all bot logic, the database layer and the admin panel
│   └── appsscript.json   runtime manifest, timezone and OAuth scopes
├── worker/
│   ├── src/index.js      the webhook gateway
│   ├── wrangler.toml     Worker config (no secrets)
│   ├── .dev.vars.example template for local development
│   └── package.json      wrangler scripts
├── .gitignore
└── README.md
```

## Database

Thirteen sheets, created automatically: `Settings`, `Users`, `Services`, `Orders`,
`Configs`, `Discounts`, `Channels`, `Guides`, `Referrals`, `Wallet`, `Withdrawals`,
`Transactions`, `Logs`. `repairDatabase()` restores any missing sheet or column
non-destructively.

## Day-to-day operation

Open the bot, press **🛠 پنل مدیریت**. From there you manage users, services, orders,
payments, test configs, guides, forced-join channels, referrals, wallets, withdrawals,
broadcasts, settings, texts, buttons, admins and system tools. No code editing required.
