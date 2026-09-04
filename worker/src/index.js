/**
 * NexiUP — Telegram → Cloudflare Worker → Google Apps Script gateway.
 *
 * WHY THIS WORKER EXISTS
 * ----------------------
 * 1. Google Apps Script's `/exec` endpoint answers a POST with an HTTP 302
 *    redirect to script.googleusercontent.com. Telegram does not follow
 *    redirects and marks the webhook broken ("Wrong response ... 302 Found").
 *    `fetch()` inside a Worker DOES follow redirects, so the hop is consumed
 *    here and Telegram never sees it.
 * 2. Apps Script can take seconds to run. Telegram only needs a fast 2xx from
 *    the webhook; it does not care what happens to the update afterwards.
 *    We answer in single-digit milliseconds and forward in the background via
 *    `ctx.waitUntil()`, so bot latency is bounded by Apps Script alone — never
 *    by Telegram's webhook timeout or retries.
 *
 * DESIGN RULES
 * ------------
 * - The request path stays microscopic. Nothing between reading the body and
 *   returning 200 may block, allocate heavily, or await the network.
 * - Secrets never appear in a response body, a log line, or an error message.
 * - Failures are logged as structured JSON and are always non-fatal: Telegram
 *   still gets its 200 so it does not retry-storm us.
 *
 * BINDINGS
 *   APPS_SCRIPT_URL          [var]    the /exec Web App URL
 *   APPS_SCRIPT_SECRET       [secret] == Apps Script's WEBHOOK_SECRET
 *   TELEGRAM_WEBHOOK_SECRET  [secret] == the secret_token given to setWebhook
 */

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** Forwarding budget. Apps Script is slow; Workers allow generous waitUntil. */
const FORWARD_TIMEOUT_MS = 25000;
const FORWARD_MAX_ATTEMPTS = 3;
const FORWARD_BASE_DELAY_MS = 250;

/** Refuse absurd bodies outright — a real Telegram update is a few KB. */
const MAX_BODY_BYTES = 1024 * 1024;

/* ----------------------------- small helpers ----------------------------- */

/**
 * Constant-time string comparison. A plain `a === b` short-circuits on the
 * first differing byte, which leaks the secret one character at a time to an
 * attacker who can measure response times.
 */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(typeof a === "string" ? a : "");
  const y = enc.encode(typeof b === "string" ? b : "");
  const len = Math.max(x.length, y.length, 1);
  let diff = x.length === y.length ? 0 : 1;
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function requestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `rid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Structured JSON logger (visible via `wrangler tail` and Workers Logs).
 * `redact()` is applied to every value so a secret can never reach a log line,
 * even if a future code path accidentally passes one in.
 */
function makeLogger(rid, env) {
  const secrets = [env.APPS_SCRIPT_SECRET, env.TELEGRAM_WEBHOOK_SECRET].filter(
    (v) => typeof v === "string" && v.length >= 8
  );
  const redact = (value) => {
    if (typeof value !== "string") return value;
    let out = value;
    for (const s of secrets) out = out.split(s).join("[REDACTED]");
    // Defence in depth: never log a Telegram bot token even if one appears.
    return out.replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TOKEN]");
  };

  return function log(level, message, meta = {}) {
    const safeMeta = {};
    for (const [k, v] of Object.entries(meta)) safeMeta[k] = redact(v);
    const line = JSON.stringify({
      level,
      message: redact(message),
      rid,
      ts: new Date().toISOString(),
      ...safeMeta,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extracts just enough from an update to make logs useful — never content. */
function summarizeUpdate(rawBody) {
  try {
    const u = JSON.parse(rawBody);
    return {
      updateId: u.update_id,
      kind: u.message ? "message" : u.callback_query ? "callback_query" : "other",
    };
  } catch {
    return { updateId: null, kind: "unparseable" };
  }
}

/* ------------------------------ forwarding ------------------------------- */

/**
 * Forwards the raw update to the Apps Script Web App.
 * Runs inside ctx.waitUntil(): Telegram already has its 200, so latency and
 * errors here can never affect delivery or trigger a Telegram retry.
 */
async function forwardToAppsScript(env, rawBody, rid, log) {
  const baseUrl = (env.APPS_SCRIPT_URL || "").trim();
  if (!baseUrl) {
    log("error", "APPS_SCRIPT_URL is not configured — update was NOT forwarded", {
      fix: "wrangler.toml [vars] APPS_SCRIPT_URL, then `npx wrangler deploy`",
    });
    return;
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(baseUrl)) {
    log("warn", "APPS_SCRIPT_URL does not look like a production /exec URL", {
      // The URL is not a secret, but truncate so logs stay readable.
      url: baseUrl.slice(0, 80),
    });
  }
  if (!env.APPS_SCRIPT_SECRET) {
    log("warn", "APPS_SCRIPT_SECRET is not set — Apps Script will reject this update", {
      fix: "npx wrangler secret put APPS_SCRIPT_SECRET",
    });
  }

  const sep = baseUrl.includes("?") ? "&" : "?";
  const targetUrl =
    baseUrl +
    sep +
    "s=" + encodeURIComponent(env.APPS_SCRIPT_SECRET || "") +
    "&rid=" + encodeURIComponent(rid);

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
      const elapsedMs = Date.now() - startedAt;

      if (response.ok) {
        log("info", "forwarded update to Apps Script", {
          attempt,
          status: response.status,
          elapsedMs,
        });
        return;
      }

      // Read the body only on failure — on success it is always "OK".
      const text = await response.text().catch(() => "");
      log("warn", "Apps Script returned a non-2xx status", {
        attempt,
        status: response.status,
        elapsedMs,
        bodyPreview: text.slice(0, 200),
      });

      // 4xx (except 429) means our request is wrong; retrying cannot help.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        log("error", "permanent error from Apps Script — not retrying", {
          status: response.status,
          hint:
            response.status === 401 || response.status === 403
              ? "APPS_SCRIPT_SECRET probably does not match Apps Script's WEBHOOK_SECRET"
              : "check the Web App deployment (Execute as: Me, Access: Anyone)",
        });
        return;
      }
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      log("error", "forwarding to Apps Script failed", {
        attempt,
        error: timedOut ? "timeout" : String((err && err.message) || err),
      });
    }

    if (attempt < FORWARD_MAX_ATTEMPTS) {
      // Exponential backoff: 250 ms, 500 ms.
      await new Promise((r) => setTimeout(r, FORWARD_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
  log("error", "gave up forwarding update after all retries", {
    attempts: FORWARD_MAX_ATTEMPTS,
  });
}

/* -------------------------------- handler -------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const rid = requestId();
    const log = makeLogger(rid, env);

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json({ ok: false, error: "bad_request" }, 400);
    }

    /* ---- GET/HEAD: health endpoint. Reports configuration presence only,
       never a secret value, so it is safe to expose publicly. ------------- */
    if (request.method === "GET" || request.method === "HEAD") {
      const configured = {
        apps_script_url: Boolean((env.APPS_SCRIPT_URL || "").trim()),
        apps_script_secret: Boolean(env.APPS_SCRIPT_SECRET),
        telegram_webhook_secret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      };
      const ready = configured.apps_script_url && configured.apps_script_secret && configured.telegram_webhook_secret;
      return json({
        ok: true,
        ready,
        service: "nexiup-telegram-gateway",
        configured, // booleans only — deliberately never the values
        time: new Date().toISOString(),
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "GET, HEAD, POST" });
    }

    /* ---- Authenticate the caller as Telegram. -------------------------- */
    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET || "";
    const receivedSecret = request.headers.get(TELEGRAM_SECRET_HEADER) || "";

    if (!expectedSecret) {
      /* FAIL CLOSED. Previously an unset secret meant "accept everything",
       * which let anyone who found the Worker URL inject forged Telegram
       * updates straight into the bot (fake payments, fake admin actions).
       * We now refuse, and say exactly how to fix it. */
      log("error", "TELEGRAM_WEBHOOK_SECRET is not set — rejecting all webhook traffic", {
        fix: "npx wrangler secret put TELEGRAM_WEBHOOK_SECRET",
      });
      return json({ ok: false, error: "gateway_not_configured" }, 503);
    }

    if (!timingSafeEqual(receivedSecret, expectedSecret)) {
      log("warn", "rejected request with invalid or missing secret token", {
        ip: request.headers.get("cf-connecting-ip") || "",
        country: request.headers.get("cf-ipcountry") || "",
        hasHeader: Boolean(receivedSecret),
      });
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---- Read the body. ------------------------------------------------ */
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      log("warn", "rejected oversized body", { bytes: declaredLength });
      return json({ ok: false, error: "payload_too_large" }, 413);
    }

    let rawBody = "";
    try {
      rawBody = await request.text();
    } catch (err) {
      log("error", "failed to read request body", { error: String((err && err.message) || err) });
      // Still 200: a retry from Telegram would almost certainly fail the same way.
      return json({ ok: true, rid, forwarded: false });
    }

    if (!rawBody) {
      log("warn", "empty body — nothing to forward", {});
      return json({ ok: true, rid, forwarded: false });
    }

    /* ---- Fire-and-forget forward, then answer Telegram immediately. ----- */
    ctx.waitUntil(forwardToAppsScript(env, rawBody, rid, log));

    const { updateId, kind } = summarizeUpdate(rawBody);
    log("info", "accepted update, forwarding in background", {
      bytes: rawBody.length,
      updateId,
      kind,
    });

    return json({ ok: true, rid });
  },
};
