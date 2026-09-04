#!/usr/bin/env node
/**
 * NexiUP — interactive Worker setup.
 *
 *   npm run setup
 *
 * Replaces a long list of manual steps with a short set of questions. It:
 *   1. writes APPS_SCRIPT_URL into wrangler.toml for you,
 *   2. stores both secrets with `wrangler secret put` (never on disk),
 *   3. deploys the Worker,
 *   4. registers the Telegram webhook on the deployed URL,
 *   5. verifies the result with getWebhookInfo.
 *
 * The bot token is only ever held in memory and sent to api.telegram.org.
 * It is never written to a file, never logged, and never passed on argv
 * (which would make it visible to other processes via the process list).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOML = join(ROOT, "wrangler.toml");

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, def = "") => {
  const a = (await rl.question(def ? `${q} ${c.d(`[${def}]`)}: ` : `${q}: `)).trim();
  return a || def;
};

/** Runs a command, inheriting stdio so wrangler can prompt/print normally. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: process.platform === "win32", ...opts });
    let out = "";
    if (opts.capture) {
      p.stdout.on("data", (d) => { out += d; stdout.write(d); });
      p.stderr.on("data", (d) => { out += d; stdout.write(d); });
    } else {
      p.stdout?.pipe(stdout);
      p.stderr?.pipe(stdout);
    }
    p.on("close", (code) => resolve({ code, out }));
  });
}

/** Feeds a secret to `wrangler secret put` over stdin — never via argv. */
function putSecret(name, value) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["wrangler", "secret", "put", name], {
      cwd: ROOT,
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    p.stdin.write(value + "\n");
    p.stdin.end();
    p.on("close", (code) => resolve(code === 0));
  });
}

const fail = (msg) => { console.log(`\n${c.r("✖")} ${msg}`); rl.close(); process.exit(1); };

console.log(`
${c.b("╔══════════════════════════════════════════════╗")}
${c.b("║   NexiUP — Cloudflare Worker setup wizard     ║")}
${c.b("╚══════════════════════════════════════════════╝")}

Have these ready (see README section 2):
  • Apps Script Web App URL   (ends in /exec)
  • WEBHOOK_SECRET            (from Apps Script → Project Settings)
  • Telegram bot token        (from @BotFather)
`);

if (!existsSync(TOML)) fail(`wrangler.toml not found. Run this from the worker/ folder.`);

/* ---- 1. Apps Script URL -------------------------------------------------- */
let toml = readFileSync(TOML, "utf8");
const currentUrl = (toml.match(/APPS_SCRIPT_URL\s*=\s*"([^"]*)"/) || [])[1] || "";
const isPlaceholder = !currentUrl || currentUrl.includes("REPLACE_WITH");

const execUrl = await ask(
  `${c.b("1/5")} Apps Script Web App URL (must end in /exec)`,
  isPlaceholder ? "" : currentUrl
);
if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(execUrl)) {
  fail(`That is not a production /exec URL.
   Expected: https://script.google.com/macros/s/AKfy.../exec
   In Apps Script use Deploy → Manage deployments and copy the Web app URL
   (the /exec one, not /dev).`);
}
toml = toml.replace(/APPS_SCRIPT_URL\s*=\s*"[^"]*"/, `APPS_SCRIPT_URL = "${execUrl}"`);
writeFileSync(TOML, toml);
console.log(`${c.g("✔")} wrangler.toml updated.\n`);

/* ---- 2. Secrets ---------------------------------------------------------- */
const appsSecret = await ask(`${c.b("2/5")} WEBHOOK_SECRET from Apps Script Script Properties`);
if (appsSecret.length < 16) fail("That secret looks too short. Copy the full WEBHOOK_SECRET value.");

// Generated locally with a CSPRNG so the user never has to invent one.
const tgSecret = [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
console.log(`${c.g("✔")} Generated a random TELEGRAM_WEBHOOK_SECRET for you.`);
console.log(`  ${c.y("Copy this into Apps Script → Script Properties → TELEGRAM_WEBHOOK_SECRET:")}`);
console.log(`  ${c.b(tgSecret)}\n`);
await ask(c.d("Press Enter once you have saved it in Apps Script"));

console.log(`\n${c.b("3/5")} Storing secrets in Cloudflare (encrypted, never written to disk)...`);
if (!(await putSecret("APPS_SCRIPT_SECRET", appsSecret))) fail("Failed to store APPS_SCRIPT_SECRET. Are you logged in? Try: npx wrangler login");
if (!(await putSecret("TELEGRAM_WEBHOOK_SECRET", tgSecret))) fail("Failed to store TELEGRAM_WEBHOOK_SECRET.");
console.log(`${c.g("✔")} Both secrets stored.\n`);

/* ---- 3. Deploy ----------------------------------------------------------- */
console.log(`${c.b("4/5")} Deploying the Worker...\n`);
const dep = await run("npx", ["wrangler", "deploy"], { capture: true });
if (dep.code !== 0) fail("Deploy failed. Read the wrangler output above.");

const found = dep.out.match(/https:\/\/[a-z0-9._-]+\.workers\.dev/i);
let workerUrl = found ? found[0] : "";
if (!workerUrl) workerUrl = await ask("\nCould not detect the Worker URL. Paste it");
console.log(`\n${c.g("✔")} Worker live at ${c.b(workerUrl)}\n`);

/* ---- 4. Register the webhook -------------------------------------------- */
const token = await ask(`${c.b("5/5")} Telegram bot token from @BotFather ${c.d("(not stored anywhere)")}`);
if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) fail("That does not look like a valid bot token.");

const api = (m, body) =>
  fetch(`https://api.telegram.org/bot${token}/${m}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

console.log("\nRegistering the webhook with Telegram...");
const set = await api("setWebhook", {
  url: workerUrl,
  secret_token: tgSecret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
  max_connections: 40,
});
if (!set.ok) fail(`Telegram rejected setWebhook: ${set.description}`);

const [me, info] = await Promise.all([api("getMe", {}), api("getWebhookInfo", {})]);

console.log(`
${c.g("╔══════════════════════════════════════════════╗")}
${c.g("║              SETUP COMPLETE  🎉              ║")}
${c.g("╚══════════════════════════════════════════════╝")}

  Bot         : @${me.ok ? me.result.username : "?"}
  Worker URL  : ${workerUrl}
  Webhook     : ${info.ok ? info.result.url : "?"}
  Pending     : ${info.ok ? info.result.pending_update_count : "?"}

${c.b("Two things left, in Apps Script → Project Settings → Script Properties:")}
  WORKER_URL              = ${workerUrl}
  TELEGRAM_WEBHOOK_SECRET = (the value printed above)

Then run ${c.b("healthCheck()")} in the Apps Script editor, and send /start to your bot.

${c.d("Live logs:  npm run logs")}
`);

rl.close();
