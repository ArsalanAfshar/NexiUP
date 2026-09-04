#!/usr/bin/env node
/**
 * NexiUP — deployment verification.
 *
 *   npm run check                 # checks the Worker only
 *   npm run check -- <bot_token>  # also checks Telegram's view of the webhook
 *
 * Read-only: it changes nothing. Use it after setup, and any time the bot
 * misbehaves, to find out which of the moving parts is actually broken.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};

const results = [];
const ok = (n, d) => results.push({ s: "ok", n, d });
const warn = (n, d) => results.push({ s: "warn", n, d });
const bad = (n, d, fix) => results.push({ s: "bad", n, d, fix });

console.log(`\n${c.b("NexiUP — deployment check")}\n`);

/* ---- 1. wrangler.toml ---------------------------------------------------- */
const tomlPath = join(ROOT, "wrangler.toml");
let execUrl = "";
if (!existsSync(tomlPath)) {
  bad("wrangler.toml", "not found", "Run this from the worker/ folder.");
} else {
  const toml = readFileSync(tomlPath, "utf8");
  execUrl = (toml.match(/APPS_SCRIPT_URL\s*=\s*"([^"]*)"/) || [])[1] || "";
  if (!execUrl || execUrl.includes("REPLACE_WITH")) {
    bad("APPS_SCRIPT_URL", "still the placeholder", "Run: npm run setup");
  } else if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(execUrl)) {
    bad("APPS_SCRIPT_URL", `not a production /exec URL (${execUrl})`, "It must end in /exec, not /dev.");
  } else {
    ok("APPS_SCRIPT_URL", execUrl);
  }
  // A secret in a committed file is a real incident, so check loudly.
  if (/^\s*(APPS_SCRIPT_SECRET|TELEGRAM_WEBHOOK_SECRET)\s*=/m.test(toml)) {
    bad("Secret hygiene", "a secret is hard-coded in wrangler.toml",
      "Delete that line, rotate the value, and use: npx wrangler secret put <NAME>");
  } else {
    ok("Secret hygiene", "no secrets in wrangler.toml");
  }
}

/* ---- 2. Apps Script Web App --------------------------------------------- */
if (execUrl && !execUrl.includes("REPLACE_WITH")) {
  try {
    const r = await fetch(execUrl, { redirect: "follow" });
    const body = await r.text();
    let j = null;
    try { j = JSON.parse(body); } catch { /* not JSON */ }
    if (j && j.ok && j.app) ok("Apps Script Web App", `reachable — ${j.app} v${j.version} (build ${j.build})`);
    else if (r.status === 200) warn("Apps Script Web App", "responded 200 but not the expected JSON — is the latest version deployed?");
    else bad("Apps Script Web App", `HTTP ${r.status}`,
      "Deploy → Manage deployments → Edit → New version. Access must be 'Anyone'.");
  } catch (e) {
    bad("Apps Script Web App", String(e.message), "Check the URL and that the deployment exists.");
  }
}

/* ---- 3. The deployed Worker --------------------------------------------- */
const tokenArg = process.argv[2];
let workerUrl = process.env.WORKER_URL || "";
if (!workerUrl && existsSync(tomlPath)) {
  const name = (readFileSync(tomlPath, "utf8").match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1];
  if (name) console.log(c.d(`  (tip: set WORKER_URL=... to check the Worker directly; guessing from name "${name}")\n`));
}

if (workerUrl) {
  try {
    const r = await fetch(workerUrl);
    const j = await r.json();
    if (j.ok && j.ready) ok("Worker", `live and fully configured — ${workerUrl}`);
    else if (j.ok) {
      const missing = Object.entries(j.configured || {}).filter(([, v]) => !v).map(([k]) => k);
      bad("Worker", `live but missing: ${missing.join(", ")}`,
        "npx wrangler secret put APPS_SCRIPT_SECRET / TELEGRAM_WEBHOOK_SECRET");
    } else bad("Worker", `unexpected response (HTTP ${r.status})`, "npx wrangler deploy");
  } catch (e) {
    bad("Worker", String(e.message), "Is it deployed? npx wrangler deploy");
  }
}

/* ---- 4. Telegram's view -------------------------------------------------- */
if (tokenArg) {
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(tokenArg)) {
    bad("Bot token", "malformed", "Copy the full token from @BotFather.");
  } else {
    const api = (m) => fetch(`https://api.telegram.org/bot${tokenArg}/${m}`).then((r) => r.json());
    try {
      const me = await api("getMe");
      if (me.ok) ok("Telegram bot", `@${me.result.username}`);
      else bad("Telegram bot", me.description, "Verify BOT_TOKEN.");

      const info = await api("getWebhookInfo");
      if (info.ok) {
        const r = info.result;
        if (!r.url) bad("Webhook", "not registered", "Run: npm run setup");
        else {
          ok("Webhook", r.url);
          if (r.pending_update_count > 20)
            warn("Pending updates", `${r.pending_update_count} queued — the Worker or Apps Script is not keeping up`);
          else ok("Pending updates", String(r.pending_update_count));
          if (r.last_error_message)
            bad("Last webhook error", `${r.last_error_message} (${new Date(r.last_error_date * 1000).toISOString()})`,
              r.last_error_message.includes("302")
                ? "The webhook points at /exec directly. It must point at the Worker URL."
                : "Check `npm run logs` while sending a message.");
          else ok("Webhook errors", "none reported");
          if (!r.has_custom_certificate && r.url && workerUrl && !r.url.startsWith(workerUrl))
            warn("Webhook target", `points at ${r.url}, not your Worker (${workerUrl})`);
        }
      }
    } catch (e) {
      bad("Telegram API", String(e.message), "Check network access.");
    }
  }
} else {
  console.log(c.d("  (pass your bot token to also verify the webhook: npm run check -- <token>)\n"));
}

/* ---- report -------------------------------------------------------------- */
for (const r of results) {
  const icon = r.s === "ok" ? c.g("✔") : r.s === "warn" ? c.y("!") : c.r("✖");
  console.log(`  ${icon} ${c.b(r.n)}  ${r.d}`);
  if (r.fix) console.log(`      ${c.y("→")} ${r.fix}`);
}

const bads = results.filter((r) => r.s === "bad").length;
const warns = results.filter((r) => r.s === "warn").length;
console.log(
  bads === 0
    ? `\n${c.g(`All checks passed${warns ? ` (${warns} warning${warns > 1 ? "s" : ""})` : ""}.`)}\n`
    : `\n${c.r(`${bads} problem${bads > 1 ? "s" : ""} found.`)} Fix the ✖ items above and re-run.\n`
);
process.exit(bads === 0 ? 0 : 1);
