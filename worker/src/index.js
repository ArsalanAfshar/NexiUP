/**
 * NexiUP — Telegram webhook gateway.
 *
 *     Telegram  ──▶  this Worker  ──▶  Google Apps Script Web App (/exec)
 *
 * The Worker exists for two reasons:
 *
 *   1. LATENCY. Telegram measures webhook health by how fast the endpoint
 *      answers. Apps Script needs a few hundred milliseconds to boot and run
 *      the bot logic; if Telegram had to wait for that on every update it
 *      would throttle delivery and eventually disable the webhook. The Worker
 *      answers 200 OK in single-digit milliseconds and forwards the update in
 *      the background via ctx.waitUntil().
 *
 *   2. REDIRECTS. Apps Script's /exec endpoint answers POSTs with an HTTP 302
 *      to script.googleusercontent.com. Telegram does not follow redirects and
 *      reports "Wrong response from the webhook: 302 Found". The Worker's own
 *      fetch() follows that hop transparently, so Telegram never sees it.
 *
 * SECURITY MODEL
 *   Inbound  (Telegram → Worker): the X-Telegram-Bot-Api-Secret-Token header
 *            must equal TELEGRAM_WEBHOOK_SECRET. Compared in constant time.
 *            Unless ALLOW_UNVERIFIED is explicitly set to "true", a request
 *            without a configured secret is REJECTED — the endpoint fails
 *            closed, never open.
 *   Outbound (Worker → Apps Script): APPS_SCRIPT_SECRET is appended as the
 *            "?s=" query parameter, because Apps Script cannot read custom
 *            request headers.
 *   Neither secret is ever logged; only booleans and hostnames are.
 *
 * BINDINGS
 *   APPS_SCRIPT_URL            var    the /exec URL of the Web App
 *   APPS_SCRIPT_SECRET         secret must equal WEBHOOK_SECRET in Apps Script
 *   TELEGRAM_WEBHOOK_SECRET    secret must equal the same-named Script Property
 *   ALLOW_UNVERIFIED           var    optional, "true" only for local testing
 */

const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/* Apps Script cold starts can be slow; give the background forward room to
 * finish, but never long enough to hold a Worker invocation open forever. */
const FORWARD_TIMEOUT_MS = 25000;
const FORWARD_MAX_ATTEMPTS = 3;
const FORWARD_BASE_DELAY_MS = 400;

/* Telegram updates are small; anything larger is not a real update. */
const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------ utilities ------------------------------ */

/** Constant-time string comparison (no early exit, no timing leak). */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(typeof a === "string" ? a : "");
  const bBytes = enc.encode(typeof b === "string" ? b : "");
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < len; i++) diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      /* This endpoint is machine-to-machine only. */
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function requestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return "rid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }
}

/** Hostname only — never log a full URL, it may carry the "?s=" secret. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid-url)";
  }
}

/**
 * Structured single-line JSON logging, readable in `wrangler tail` and in the
 * Workers Logs dashboard. Values are allow-listed by the call sites, so no
 * secret or message content can leak in here.
 */
function makeLogger(rid) {
  return function log(level, message, meta = {}) {
    const line = JSON.stringify({ level, message, rid, ts: new Date().toISOString(), ...meta });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- config validation -------------------------- */

/**
 * Validates the bindings once per request. Returns a list of problems so a
 * misconfigured deployment reports precisely what is wrong instead of
 * silently dropping every update.
 */
function validateEnv(env) {
  const problems = [];
  const url = (env.APPS_SCRIPT_URL || "").trim();

  if (!url) {
    problems.push("APPS_SCRIPT_URL is not set (wrangler.toml [vars])");
  } else if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
    problems.push(
      "APPS_SCRIPT_URL must be the production Web App URL ending in /exec " +
        "(not /dev, and not the editor URL)"
    );
  }
  if (!(env.APPS_SCRIPT_SECRET || "").trim()) {
    problems.push("APPS_SCRIPT_SECRET is not set (wrangler secret put APPS_SCRIPT_SECRET)");
  }
  if (!(env.TELEGRAM_WEBHOOK_SECRET || "").trim() && env.ALLOW_UNVERIFIED !== "true") {
    problems.push(
      "TELEGRAM_WEBHOOK_SECRET is not set (wrangler secret put TELEGRAM_WEBHOOK_SECRET)"
    );
  }
  return problems;
}

/* ------------------------------ forwarding ------------------------------ */

/**
 * Forwards the raw update to Apps Script. Runs inside ctx.waitUntil(), so
 * Telegram already has its 200 OK and nothing here can affect delivery.
 * Retries with exponential backoff on network errors and 5xx responses only —
 * a 4xx means the request itself is wrong and retrying cannot help.
 */
async function forwardToAppsScript(env, rawBody, rid, log) {
  const baseUrl = (env.APPS_SCRIPT_URL || "").trim();
  const secret = (env.APPS_SCRIPT_SECRET || "").trim();
  if (!baseUrl) {
    log("error", "update dropped: APPS_SCRIPT_URL is not configured");
    return;
  }

  const separator = baseUrl.includes("?") ? "&" : "?";
  const targetUrl =
    baseUrl + separator + "s=" + encodeURIComponent(secret) + "&rid=" + encodeURIComponent(rid);
  const targetHost = hostOf(baseUrl);

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
        log("info", "forwarded to Apps Script", {
          attempt,
          status: response.status,
          elapsedMs,
          host: targetHost,
        });
        return;
      }

      /* Read a short excerpt only for diagnostics; Apps Script replies "OK". */
      const excerpt = (await response.text().catch(() => "")).slice(0, 200);
      const retryable = response.status >= 500 || response.status === 429;
      log(retryable ? "warn" : "error", "Apps Script returned a non-2xx status", {
        attempt,
        status: response.status,
        elapsedMs,
        retryable,
        host: targetHost,
        excerpt,
      });
      if (!retryable) return; // 4xx: usually a wrong secret or wrong URL
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      log("error", "forwarding to Apps Script failed", {
        attempt,
        elapsedMs: Date.now() - startedAt,
        host: targetHost,
        error: timedOut ? "timeout after " + FORWARD_TIMEOUT_MS + "ms" : String(err?.message || err),
      });
    }

    if (attempt < FORWARD_MAX_ATTEMPTS) {
      await sleep(FORWARD_BASE_DELAY_MS * Math.pow(2, attempt - 1)); // 400ms, 800ms
    }
  }
  log("error", "gave up forwarding update", { attempts: FORWARD_MAX_ATTEMPTS, host: targetHost });
}

/* -------------------------------- handler ------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const rid = requestId();
    const log = makeLogger(rid);
    const url = new URL(request.url);
    const problems = validateEnv(env);

    /* ---- health endpoint: GET/HEAD ------------------------------------ *
     * Safe to expose and to poll. Reports configuration problems as
     * booleans and messages, never any secret value. Apps Script's
     * healthCheck() probes exactly this endpoint.                          */
    if (request.method === "GET" || request.method === "HEAD") {
      return json(
        {
          ok: problems.length === 0,
          service: "nexiup-telegram-gateway",
          path: url.pathname,
          time: new Date().toISOString(),
          config: {
            apps_script_url_set: Boolean((env.APPS_SCRIPT_URL || "").trim()),
            apps_script_secret_set: Boolean((env.APPS_SCRIPT_SECRET || "").trim()),
            telegram_secret_set: Boolean((env.TELEGRAM_WEBHOOK_SECRET || "").trim()),
            upstream_host: hostOf(env.APPS_SCRIPT_URL || ""),
          },
          problems,
        },
        problems.length === 0 ? 200 : 503
      );
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    /* ---- authenticate the caller -------------------------------------- */
    const expectedSecret = (env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    const receivedSecret = request.headers.get(TELEGRAM_SECRET_HEADER) || "";

    if (expectedSecret) {
      if (!timingSafeEqual(receivedSecret, expectedSecret)) {
        /* Log the fact, never the value or a prefix of it. */
        log("warn", "rejected: invalid or missing secret token", {
          ip: request.headers.get("cf-connecting-ip") || "",
          country: request.cf?.country || "",
          hasHeader: Boolean(receivedSecret),
        });
        return json({ ok: false, error: "unauthorized" }, 401);
      }
    } else if (env.ALLOW_UNVERIFIED === "true") {
      /* Escape hatch for local `wrangler dev` only. */
      log("warn", "accepting UNVERIFIED request: ALLOW_UNVERIFIED=true");
    } else {
      /* Fail CLOSED. An unauthenticated public endpoint that forwards into
       * your bot backend is a real vulnerability, so refuse to serve until
       * the secret is configured. */
      log("error", "rejected: TELEGRAM_WEBHOOK_SECRET is not configured on this Worker");
      return json({ ok: false, error: "webhook_not_configured" }, 503);
    }

    /* ---- misconfiguration guard --------------------------------------- *
     * Returning 200 here would make Telegram discard the update forever.
     * A 503 keeps it in Telegram's retry queue until the Worker is fixed.  */
    if (problems.length) {
      log("error", "rejected: worker is misconfigured", { problems });
      return json({ ok: false, error: "misconfigured", problems }, 503);
    }

    /* ---- read the body ------------------------------------------------- */
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      log("warn", "rejected: body too large", { declaredLength });
      return json({ ok: false, error: "payload_too_large" }, 413);
    }

    let rawBody = "";
    try {
      rawBody = await request.text();
    } catch (err) {
      log("error", "failed to read request body", { error: String(err?.message || err) });
      return json({ ok: false, error: "bad_request" }, 400);
    }
    if (rawBody.length > MAX_BODY_BYTES) {
      log("warn", "rejected: body too large", { bytes: rawBody.length });
      return json({ ok: false, error: "payload_too_large" }, 413);
    }

    /* Cheap sanity check + a correlation id we can match in the Logs sheet. */
    let updateId = null;
    try {
      updateId = JSON.parse(rawBody)?.update_id ?? null;
    } catch {
      log("warn", "body is not valid JSON — forwarding anyway", { bytes: rawBody.length });
    }

    /* Fire-and-forget: waitUntil keeps the Worker alive for the forward
     * while the 200 below is already on its way back to Telegram. */
    ctx.waitUntil(forwardToAppsScript(env, rawBody, rid, log));
    log("info", "accepted update", { bytes: rawBody.length, updateId });

    return json({ ok: true, rid });
  },
};
