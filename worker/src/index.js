/**
 * NexiUP — Telegram → Cloudflare Worker → Google Apps Script gateway.
 *
 * This is the ONLY piece of the request path that talks to Telegram directly.
 * Its job is intentionally small and defensive:
 *
 *   1. Validate that the request really comes from Telegram by comparing the
 *      "X-Telegram-Bot-Api-Secret-Token" header against the TELEGRAM_WEBHOOK_SECRET
 *      secret (constant-time compare, no early-exit timing leak).
 *   2. Answer Telegram with a fast, real "200 OK" IMMEDIATELY — Telegram only
 *      cares that the webhook endpoint responds quickly with 2xx. It does not
 *      wait for (and does not care about) what happens to the update afterwards.
 *   3. Forward the raw update to the Google Apps Script Web App in the
 *      background via `ctx.waitUntil()`, so the forward never delays or can
 *      break the response already sent to Telegram.
 *   4. `fetch()` inside a Worker follows HTTP redirects by default
 *      (`redirect: "follow"`). Google Apps Script's `/exec` endpoint answers
 *      every request with an HTTP 302 to `script.googleusercontent.com`
 *      before returning the real body. Because the Worker follows that
 *      redirect transparently, Telegram never sees it — it only ever sees the
 *      Worker's own 200 response from step 2. This is what fixes the classic
 *      "Wrong response from the webhook: 302 Found" Telegram error.
 *
 * IMPORTANT — why this file previously "did nothing":
 *   `wrangler.toml` declares `main = "src/index.js"`, but this file did not
 *   exist in the repository. Any Worker actually deployed to Cloudflare was
 *   therefore either a stale/placeholder script created by hand in the
 *   dashboard (typically the default "Hello World" template, which always
 *   answers 200 without forwarding anything) or a build that could not have
 *   come from this repo. That fully explains the reported symptom: "Worker
 *   returns 200 OK, but doPost never runs on Apps Script". Restoring this
 *   file and redeploying with `wrangler deploy` is the actual fix.
 */

const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const FORWARD_TIMEOUT_MS = 20000;
const FORWARD_MAX_ATTEMPTS = 2;
const FORWARD_RETRY_DELAY_MS = 300;

/** Constant-time string comparison (mitigates timing attacks on the secret). */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(typeof a === "string" ? a : "");
  const bBytes = enc.encode(typeof b === "string" ? b : "");
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  }
  return diff === 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requestId() {
  try {
    return crypto.randomUUID();
  } catch (e) {
    return "rid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forwards the raw Telegram update to the Apps Script Web App.
 * Runs inside ctx.waitUntil() — Telegram has already received its 200 OK by
 * the time this executes, so latency/errors here never affect delivery.
 */
async function forwardToAppsScript(env, rawBody, rid, log) {
  const baseUrl = (env.APPS_SCRIPT_URL || "").trim();
  if (!baseUrl) {
    log("error", "APPS_SCRIPT_URL is not configured — update was NOT forwarded", { rid });
    return;
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(baseUrl)) {
    log("warn", "APPS_SCRIPT_URL does not look like a production /exec deployment URL", {
      rid,
      url: baseUrl,
    });
  }

  const secret = env.APPS_SCRIPT_SECRET || "";
  const separator = baseUrl.indexOf("?") === -1 ? "?" : "&";
  const targetUrl = baseUrl + separator + "s=" + encodeURIComponent(secret) + "&rid=" + encodeURIComponent(rid);

  for (let attempt = 1; attempt <= FORWARD_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(
        targetUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
          redirect: "follow", // transparently consumes Apps Script's 302 hop
        },
        FORWARD_TIMEOUT_MS
      );
      const text = await response.text().catch(() => "");
      const elapsedMs = Date.now() - startedAt;
      if (response.status >= 200 && response.status < 300) {
        log("info", "forwarded update to Apps Script", {
          rid,
          attempt,
          status: response.status,
          elapsedMs,
          bodyPreview: text.slice(0, 150),
        });
        return;
      }
      log("warn", "Apps Script responded with a non-2xx status", {
        rid,
        attempt,
        status: response.status,
        elapsedMs,
        bodyPreview: text.slice(0, 300),
      });
    } catch (err) {
      log("error", "forwarding to Apps Script failed", {
        rid,
        attempt,
        error: err && err.name === "AbortError" ? "timeout" : String((err && err.message) || err),
      });
    }
    if (attempt < FORWARD_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, FORWARD_RETRY_DELAY_MS));
    }
  }
  log("error", "gave up forwarding update to Apps Script after all retries", { rid });
}

function makeLogger(rid) {
  return function log(level, message, meta) {
    const line = JSON.stringify({
      level,
      message,
      rid,
      ts: new Date().toISOString(),
      ...meta,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
}

export default {
  async fetch(request, env, ctx) {
    const rid = requestId();
    const log = makeLogger(rid);
    const url = new URL(request.url);

    // Lightweight health check — also what Telegram/you can curl to confirm
    // the Worker itself is alive, independent of Apps Script.
    if (request.method === "GET" || request.method === "HEAD") {
      return json({
        ok: true,
        service: "nexiup-telegram-gateway",
        path: url.pathname,
        time: new Date().toISOString(),
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET || "";
    const receivedSecret = request.headers.get(TELEGRAM_SECRET_HEADER) || "";

    if (expectedSecret) {
      if (!timingSafeEqual(receivedSecret, expectedSecret)) {
        log("warn", "rejected request with invalid/missing secret token", {
          ip: request.headers.get("cf-connecting-ip") || "",
          hasHeader: !!receivedSecret,
        });
        return json({ ok: false, error: "unauthorized" }, 401);
      }
    } else {
      // No secret configured yet: warn loudly but do not hard-fail, so the
      // very first deployment is not accidentally bricked before secrets
      // are set with `wrangler secret put`.
      log("warn", "TELEGRAM_WEBHOOK_SECRET is not set — accepting request WITHOUT verification", {});
    }

    let rawBody = "";
    try {
      rawBody = await request.text();
    } catch (err) {
      log("error", "failed to read request body", { error: String((err && err.message) || err) });
    }

    // Fire-and-forget forward. ctx.waitUntil() keeps the Worker alive long
    // enough to finish the fetch() even though the response below is sent
    // to Telegram immediately.
    ctx.waitUntil(forwardToAppsScript(env, rawBody, rid, log));

    log("info", "accepted update, forwarding in background", { bytes: rawBody.length });

    return json({ ok: true, rid });
  },
};
