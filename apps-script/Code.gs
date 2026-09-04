/**
 * ============================================================================
 *  NexiUP | نکسی آپ
 *  Telegram bot · Google Apps Script backend · Google Sheets database
 *  Single-file production build. Persian (RTL) user interface.
 * ----------------------------------------------------------------------------
 *  ARCHITECTURE
 *
 *      Telegram  ──▶  Cloudflare Worker  ──▶  this Web App (/exec)  ──▶  Sheets
 *                     (public webhook)        (all the bot logic)
 *
 *  Why the Worker exists: Google's /exec endpoint answers a POST with an HTTP
 *  302 redirect to script.googleusercontent.com. Telegram does not follow
 *  redirects and marks such a webhook as broken ("Wrong response ... 302
 *  Found"). The Worker follows that redirect itself and always answers
 *  Telegram with an immediate 200 OK. See worker/src/index.js.
 *
 *  Security model:
 *    Telegram → Worker      authenticated by TELEGRAM_WEBHOOK_SECRET, sent as
 *                           the X-Telegram-Bot-Api-Secret-Token header.
 *    Worker  → Apps Script  authenticated by WEBHOOK_SECRET, sent as the
 *                           "?s=" query parameter (Apps Script cannot read
 *                           custom request headers, hence the query string).
 *  No secret is ever written to the spreadsheet or to a log line; see
 *  sanitize_(), which redacts them from every message before it is stored.
 * ----------------------------------------------------------------------------
 *  INSTALL — run these from the Apps Script editor, in order:
 *
 *    1. setup()          create/repair the database, generate both secrets,
 *                        and print whatever configuration is still missing.
 *    2. connect()        register the Telegram webhook on the Worker URL.
 *    3. healthCheck()    verify config, sheets, bot, webhook and Worker.
 *
 *  Other editor entry points (all optional, all safe to re-run):
 *    configure({...})    save Script Properties without leaving the editor
 *    checkConfig()       list missing configuration keys
 *    repairDatabase()    non-destructive schema repair
 *    selfTest()          legacy Persian self-test report
 *    getDiagnostics()    machine-readable diagnostics (contains no secrets)
 *
 *  Web App endpoints:
 *    doPost(e)           Telegram webhook receiver (the single hot path)
 *    doGet(e)            public, secret-free liveness endpoint
 * ----------------------------------------------------------------------------
 *  PERFORMANCE NOTES (why this build is fast)
 *
 *  Every Google service call is a network round trip. A Telegram update must
 *  finish in well under a second to feel instant, so this build enforces:
 *    • one SpreadsheetApp.openById() per execution;
 *    • one getValues() per sheet per execution, cached in `_table`;
 *    • CacheService for settings (cross-execution) and for a self-healing
 *      row index, so a hot user/order is a single 1-row read, not a scan;
 *    • one PropertiesService read per execution (the whole store at once);
 *    • buffered logs flushed with a single setValues() per request;
 *    • UrlFetchApp.fetchAll() wherever several Telegram calls are needed;
 *    • no LockService on the hot path (dedupe is a lock-free cache CAS).
 *  Read the DATA LAYER banner further down before changing any of it.
 * ============================================================================
 */

/* ============================== VERSIONING ============================== */

var APP_NAME = 'NexiUP';
var APP_TITLE = 'نکسی آپ';
var APP_VERSION = '1.0.0';
var BUILD_VERSION = '2026.09.04.1';
var SCHEMA_VERSION = '1';

var TZ = 'Asia/Tehran';
var TG_API = 'https://api.telegram.org/bot';

var DEDUPE_TTL_SEC = 21600;      /* 6h - CacheService maximum */
var MEMBER_CACHE_SEC = 300;
var LOCK_WAIT_MS = 4000;
var SEQ_LOCK_WAIT_MS = 1500;
var MAX_LOG_ROWS = 5000;
var BROADCAST_MAX_PER_RUN = 1200;
var BROADCAST_SLEEP_MS = 250;    /* pause between concurrent chunks */
var BROADCAST_CHUNK = 25;        /* messages sent per fetchAll() batch */
var PAGE_SIZE = 6;

/* ============================ SCRIPT PROPERTIES ========================= */
/*
 * PERFORMANCE NOTE
 * Every PropertiesService call is a round trip to a Google backend (~10-30ms).
 * The old build called getProperty() dozens of times per Telegram update
 * (botToken_() on every API call, three reads inside sanitize_() for every log
 * line, ...). We now read the WHOLE property store once per execution and
 * serve every later read from memory. Writes still go straight through, but
 * are batched whenever more than one key changes at a time.
 */

var _propsCache = null;   /* full property store, loaded lazily once */

function props_() { return PropertiesService.getScriptProperties(); }

/** Loads (once per execution) and returns every script property as an object. */
function allProps_() {
  if (_propsCache) return _propsCache;
  try { _propsCache = props_().getProperties() || {}; }
  catch (e) { _propsCache = {}; }
  return _propsCache;
}

function prop_(key, def) {
  var v = allProps_()[key];
  if (v === null || v === undefined || v === '') return (def === undefined ? '' : def);
  return v;
}

/** Single property write (also refreshes the in-memory copy). */
function setProp_(key, value) {
  var patch = {};
  patch[key] = String(value);
  setProps_(patch);
}

/** Batched property write — one service call for any number of keys. */
function setProps_(patch) {
  if (!patch) return;
  var clean = {};
  var count = 0;
  for (var k in patch) {
    if (!patch.hasOwnProperty(k)) continue;
    clean[k] = String(patch[k]);
    count++;
  }
  if (!count) return;
  props_().setProperties(clean, false);
  var cache = allProps_();
  for (var k2 in clean) cache[k2] = clean[k2];
}

function botToken_() { return prop_('BOT_TOKEN'); }
function webhookSecret_() { return prop_('WEBHOOK_SECRET'); }
function spreadsheetId_() { return prop_('SPREADSHEET_ID'); }
function webAppUrl_() { return prop_('WEB_APP_URL'); }
/** Public URL of the Cloudflare Worker that sits in front of this Web App (recommended). */
function workerUrl_() { return prop_('WORKER_URL'); }
/** Secret Telegram sends back as the "X-Telegram-Bot-Api-Secret-Token" header to the Worker.
 *  Apps Script itself never reads this header (Worker validates it); it is only stored here
 *  so the in-panel setupWebhook() helper can register it with Telegram on your behalf. */
function telegramWebhookSecret_() { return prop_('TELEGRAM_WEBHOOK_SECRET'); }

/** Root admins from Script Properties + extra admins managed inside the panel. */
function rootAdminIds_() { return splitIds_(prop_('ADMIN_IDS', '')); }
function extraAdminIds_() { return splitIds_(getSetting_('admins', '')); }

/* isAdmin_() is called several times per update (routing, gates, keyboards).
 * The merged list is computed once per execution. */
var _adminIdsCache = null;
function allAdminIds_() {
  if (_adminIdsCache) return _adminIdsCache;
  _adminIdsCache = uniq_(rootAdminIds_().concat(extraAdminIds_()));
  return _adminIdsCache;
}
function forgetAdminCache_() { _adminIdsCache = null; }

function isAdmin_(userId) { return allAdminIds_().indexOf(String(userId)) !== -1; }
function isRootAdmin_(userId) { return rootAdminIds_().indexOf(String(userId)) !== -1; }

function splitIds_(raw) {
  return String(raw || '').split(/[,\s;]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== '' && /^-?\d+$/.test(x); });
}

/* ================================ UTILS ================================= */

function s_(v) { return (v === null || v === undefined) ? '' : String(v); }

function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  var str = String(v).replace(/[,\s]/g, '').replace(/[۰-۹]/g, function (d) {
    return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  });
  var n = Number(str);
  return isNaN(n) ? 0 : n;
}

function int_(v) { return Math.round(num_(v)); }
function bool_(v) { var x = s_(v).toLowerCase(); return x === '1' || x === 'true' || x === 'yes' || x === 'on'; }

function iso_(d) {
  try { return Utilities.formatDate(d || new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
  catch (err) { return ''; }
}

function nowIso_() { return iso_(new Date()); }

function parseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(s_(v).trim().replace(' ', 'T'));
  if (isNaN(d.getTime())) d = new Date(s_(v));
  return isNaN(d.getTime()) ? null : d;
}

function addDays_(d, days) { return new Date((d || new Date()).getTime() + days * 86400000); }

function comma_(n) {
  var x = Math.round(num_(n));
  var neg = x < 0;
  x = Math.abs(x);
  var str = String(x), out = '';
  while (str.length > 3) { out = ',' + str.slice(-3) + out; str = str.slice(0, -3); }
  return (neg ? '-' : '') + str + out;
}

function money_(n) { return comma_(n) + ' ' + getSetting_('currency', 'تومان'); }

/** Gregorian to Jalali (Persian) calendar. */
function toJalali_(gy, gm, gd) {
  var gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  var gy2 = (gm > 2) ? (gy + 1) : gy;
  var days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  var jy = -1595 + (33 * Math.floor(days / 12053));
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  var jm, jd;
  if (days < 186) { jm = 1 + Math.floor(days / 31); jd = 1 + (days % 31); }
  else { jm = 7 + Math.floor((days - 186) / 30); jd = 1 + ((days - 186) % 30); }
  return [jy, jm, jd];
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function jDate_(v) {
  var d = parseDate_(v);
  if (!d) return '—';
  var parts = Utilities.formatDate(d, TZ, 'yyyy-MM-dd').split('-');
  var j = toJalali_(int_(parts[0]), int_(parts[1]), int_(parts[2]));
  return j[0] + '/' + pad2_(j[1]) + '/' + pad2_(j[2]);
}

function jDateTime_(v) {
  var d = parseDate_(v);
  if (!d) return '—';
  return jDate_(d) + ' - ' + Utilities.formatDate(d, TZ, 'HH:mm');
}

function esc_(text) {
  return s_(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json_(o) { try { return JSON.stringify(o); } catch (e) { return '{}'; } }

function parseJson_(str, def) {
  try {
    var v = JSON.parse(s_(str));
    return (v && typeof v === 'object') ? v : (def || {});
  } catch (e) { return def || {}; }
}

function uniq_(arr) {
  var seen = {}, out = [];
  (arr || []).forEach(function (x) {
    var k = String(x);
    if (!seen[k]) { seen[k] = 1; out.push(k); }
  });
  return out;
}

function randomToken_(len) {
  var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var out = '';
  for (var i = 0; i < (len || 32); i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function truncate_(text, max) {
  var t = s_(text);
  return t.length > max ? t.substring(0, max - 1) + '…' : t;
}

function paginate_(arr, page, size) {
  var per = size || PAGE_SIZE;
  var total = Math.max(1, Math.ceil(arr.length / per));
  var p = Math.min(Math.max(1, int_(page) || 1), total);
  return { items: arr.slice((p - 1) * per, p * per), page: p, pages: total, total: arr.length };
}

/**
 * Removes anything secret-looking before it can ever reach the Logs sheet.
 * Property reads are served from the in-memory property cache, so this is
 * free to call on every log line.
 */
function sanitize_(text) {
  var out = s_(text);
  if (!out) return out;
  var token = botToken_(), secret = webhookSecret_(), tgSecret = telegramWebhookSecret_();
  if (token) {
    out = out.split(token).join('[REDACTED_TOKEN]');
    var bare = token.indexOf(':') > -1 ? token.split(':')[1] : '';
    if (bare) out = out.split(bare).join('[REDACTED]');
  }
  if (secret) out = out.split(secret).join('[REDACTED_SECRET]');
  if (tgSecret) out = out.split(tgSecret).join('[REDACTED_TG_SECRET]');
  return out.replace(/bot\d{5,}:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
}

/* ============================ DATABASE SCHEMA =========================== */

var SCHEMA = {
  Settings: ['key', 'value', 'updated_at'],
  Users: ['user_id', 'username', 'first_name', 'last_name', 'joined_at', 'last_seen',
    'is_blocked', 'ref_code', 'ref_by', 'ref_count', 'last_test_at',
    'state', 'state_data', 'state_at', 'note'],
  Services: ['id', 'name', 'description', 'volume', 'duration', 'price',
    'is_active', 'sort_order', 'created_at'],
  Orders: ['id', 'kind', 'user_id', 'service_id', 'service_name', 'amount', 'discount_code',
    'discount_amount', 'final_amount', 'status', 'pay_method', 'payment_ref',
    'created_at', 'updated_at', 'handled_by', 'note'],
  Configs: ['id', 'order_id', 'user_id', 'kind', 'service_name', 'config_text', 'volume',
    'duration', 'delivered_at', 'expires_at', 'status', 'delivered_by'],
  Discounts: ['code', 'kind', 'value', 'usage_limit', 'used_count', 'expires_at',
    'is_active', 'created_at', 'note'],
  Channels: ['id', 'title', 'username', 'chat_id', 'is_required', 'is_active', 'created_at'],
  Guides: ['id', 'title', 'content', 'sort_order', 'is_active', 'created_at'],
  Referrals: ['id', 'referrer_id', 'referred_id', 'order_id', 'commission', 'created_at'],
  Wallet: ['user_id', 'balance', 'total_charged', 'total_spent', 'ref_income', 'updated_at'],
  Withdrawals: ['id', 'user_id', 'amount', 'dest', 'status', 'created_at', 'processed_at',
    'handled_by', 'note'],
  Transactions: ['id', 'user_id', 'type', 'amount', 'balance_after', 'description',
    'ref_id', 'created_at'],
  Logs: ['created_at', 'level', 'event', 'user_id', 'message', 'data']
};

var SHEET_ORDER = ['Settings', 'Users', 'Services', 'Orders', 'Configs', 'Discounts', 'Channels',
  'Guides', 'Referrals', 'Wallet', 'Withdrawals', 'Transactions', 'Logs'];

/* ============================== DATA LAYER ==============================
 * PERFORMANCE MODEL (this is where the old ~10s latency came from)
 * ------------------------------------------------------------------------
 * The previous build re-read a whole sheet on EVERY helper call:
 *   getUser_()            → full Users sheet read
 *   getSetting_()         → full Settings sheet read (first call per exec)
 *   findRows_('Orders')   → full Orders sheet read, three times in adminHome_
 * A single /start therefore issued 15-40 SpreadsheetApp round trips.
 *
 * The new layer guarantees:
 *   1. ONE SpreadsheetApp.openById() per execution (`_ss`).
 *   2. ONE getValues() per sheet per execution (`_table`), reused by every
 *      later read. All writes update that in-memory table too, so reads
 *      after writes stay correct without re-reading.
 *   3. Settings are additionally cached in CacheService ACROSS executions
 *      (6 min) — a warm update never touches the Settings sheet at all.
 *   4. Row lookups by key (user_id, order id, ...) use a CacheService row
 *      index, so a hot user is fetched with a single 1-row getRange()
 *      instead of a full-sheet scan. The index is always verified against
 *      the actual row and self-heals when rows move.
 *   5. Log rows are buffered in memory and flushed with ONE setValues()
 *      at the end of the request instead of one appendRow() per line.
 * ======================================================================= */

/* Per-execution memory caches. Reset by resetCaches_(). */
var _ss = null;          /* Spreadsheet handle                          */
var _shCache = {};       /* name -> Sheet object                        */
var _hdrCache = {};      /* name -> header array                        */
var _table = {};         /* name -> array of row objects (with __row)   */
var _settingsCache = null;

/* Cross-execution CacheService keys / TTLs. */
var SETTINGS_CACHE_KEY = 'nx.settings.v1';
var SETTINGS_CACHE_SEC = 360;      /* 6 min; invalidated on every write   */
var ROWIDX_CACHE_SEC = 1800;       /* 30 min; self-healing row index      */

function scriptCache_() {
  try { return CacheService.getScriptCache(); } catch (e) { return null; }
}

function cacheGet_(key) {
  var c = scriptCache_();
  if (!c) return null;
  try { return c.get(key); } catch (e) { return null; }
}

function cachePut_(key, value, ttl) {
  var c = scriptCache_();
  if (!c) return;
  try { c.put(key, String(value), ttl); } catch (e) { /* cache is best effort */ }
}

function cacheRemove_(key) {
  var c = scriptCache_();
  if (!c) return;
  try { c.remove(key); } catch (e) { /* ignore */ }
}

/** The one and only spreadsheet handle for this execution. */
function ss_() {
  if (_ss) return _ss;
  var id = spreadsheetId_();
  if (!id) throw new Error('SPREADSHEET_ID is not configured. Run setup() first.');
  _ss = SpreadsheetApp.openById(id);
  return _ss;
}

/** Cached Sheet object; creates/repairs the sheet only when it is missing. */
function sh_(name) {
  if (_shCache[name]) return _shCache[name];
  var sheet = ss_().getSheetByName(name);
  if (!sheet) sheet = ensureSheet_(name);
  _shCache[name] = sheet;
  return sheet;
}

function ensureSheet_(name) {
  var book = ss_();
  var cols = SCHEMA[name];
  if (!cols) throw new Error('Unknown sheet: ' + name);
  var sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    _shCache[name] = sheet;
    _hdrCache[name] = cols.slice();
    return sheet;
  }
  /* Non-destructive header repair: keep existing columns, append missing ones. */
  var lastCol = Math.max(1, sheet.getLastColumn());
  var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return s_(h).trim(); });
  if (current.length === 1 && current[0] === '') {
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    _shCache[name] = sheet;
    _hdrCache[name] = cols.slice();
    return sheet;
  }
  var missing = cols.filter(function (c) { return current.indexOf(c) === -1; });
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, 1, 1, current.length + missing.length).setFontWeight('bold');
    current = current.concat(missing);
    delete _table[name];
  }
  _shCache[name] = sheet;
  _hdrCache[name] = current;
  return sheet;
}

/** Header row (read at most once per sheet per execution). */
function hdr_(name) {
  if (_hdrCache[name]) return _hdrCache[name];
  var sheet = sh_(name);
  var lastCol = Math.max(1, sheet.getLastColumn());
  var row = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return s_(h).trim(); });
  if (!row.length || row.join('') === '') { ensureSheet_(name); row = SCHEMA[name].slice(); }
  _hdrCache[name] = row;
  return row;
}

/** Turns one raw value array into a row object. */
function rowObject_(headers, raw, rowNum) {
  var obj = { __row: rowNum };
  for (var c = 0; c < headers.length; c++) if (headers[c]) obj[headers[c]] = raw[c];
  return obj;
}

/**
 * All rows as objects. The full sheet is read ONCE per execution; every later
 * call (and every write) is served from / applied to the in-memory table.
 */
function allRows_(name) {
  if (_table[name]) return _table[name];
  var sheet = sh_(name);
  var headers = hdr_(name);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { _table[name] = []; return _table[name]; }
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var raw = values[i];
    if (raw.join('') === '') continue;
    out.push(rowObject_(headers, raw, i + 2));
  }
  _table[name] = out;
  return out;
}

function findRows_(name, predicate) {
  return allRows_(name).filter(function (r) {
    try { return !!predicate(r); } catch (e) { return false; }
  });
}

function findOne_(name, predicate) {
  var rows = findRows_(name, predicate);
  return rows.length ? rows[0] : null;
}

/**
 * Fast single-row lookup by key column, backed by a CacheService row index.
 *
 * Cost when the index hits: ONE getRange() of a single row.
 * Cost on a miss: one full-table read (which is then reused for the rest of
 * the execution anyway) plus an index refresh.
 * The index is always verified against the real cell, so a stale entry
 * (rows deleted/shifted by an admin) can never return the wrong record.
 */
function rowByKey_(name, keyCol, keyVal) {
  var wanted = s_(keyVal);
  if (!wanted) return null;

  /* Already have the whole table in memory: no service call at all. */
  if (_table[name]) {
    var rows = _table[name];
    for (var i = 0; i < rows.length; i++) if (s_(rows[i][keyCol]) === wanted) return rows[i];
    return null;
  }

  var idxKey = 'nx.idx.' + name + '.' + keyCol + '.' + wanted;
  var cachedRow = int_(cacheGet_(idxKey));
  if (cachedRow >= 2) {
    var sheet = sh_(name);
    if (cachedRow <= sheet.getLastRow()) {
      var headers = hdr_(name);
      var raw = sheet.getRange(cachedRow, 1, 1, headers.length).getValues()[0];
      var obj = rowObject_(headers, raw, cachedRow);
      if (s_(obj[keyCol]) === wanted) return obj;   /* verified hit */
    }
    cacheRemove_(idxKey);                            /* stale: drop it */
  }

  var found = findOne_(name, function (r) { return s_(r[keyCol]) === wanted; });
  if (found) cachePut_(idxKey, found.__row, ROWIDX_CACHE_SEC);
  return found;
}

function forgetRowIndex_(name, keyCol, keyVal) {
  cacheRemove_('nx.idx.' + name + '.' + keyCol + '.' + s_(keyVal));
}

/**
 * Appends a row with a single setValues() (appendRow() is slower and forces a
 * flush) and keeps the in-memory table in sync.
 */
function appendRow_(name, obj) {
  var sheet = sh_(name);
  var headers = hdr_(name);
  var values = headers.map(function (h) {
    var v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  });
  var rowNum = sheet.getLastRow() + 1;
  if (rowNum < 2) rowNum = 2;
  sheet.getRange(rowNum, 1, 1, headers.length).setValues([values]);
  if (_table[name]) _table[name].push(rowObject_(headers, values, rowNum));
  return obj;
}

/** Appends many rows in ONE setValues() call. Used by logging and seeding. */
function appendRows_(name, objects) {
  if (!objects || !objects.length) return 0;
  var sheet = sh_(name);
  var headers = hdr_(name);
  var matrix = objects.map(function (obj) {
    return headers.map(function (h) {
      var v = obj[h];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  var startRow = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(startRow, 1, matrix.length, headers.length).setValues(matrix);
  if (_table[name]) {
    for (var i = 0; i < matrix.length; i++) {
      _table[name].push(rowObject_(headers, matrix[i], startRow + i));
    }
  }
  return matrix.length;
}

/**
 * Updates only the columns present in `patch`. Writes the smallest possible
 * range: a single cell when one column changed, otherwise the changed span.
 * Reads the current values from the in-memory table when available.
 */
function patchRow_(name, rowNum, patch) {
  if (!rowNum || rowNum < 2) return false;
  var sheet = sh_(name);
  var headers = hdr_(name);

  /* Current row values: from memory if we already loaded the table. */
  var cached = null;
  if (_table[name]) {
    for (var i = 0; i < _table[name].length; i++) {
      if (_table[name][i].__row === rowNum) { cached = _table[name][i]; break; }
    }
  }
  var values;
  if (cached) values = headers.map(function (h) { return cached[h]; });
  else values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];

  var minIdx = -1, maxIdx = -1, changed = false;
  for (var k in patch) {
    if (!patch.hasOwnProperty(k)) continue;
    var idx = headers.indexOf(k);
    if (idx === -1) continue;
    var v = patch[k];
    values[idx] = (v === undefined || v === null) ? '' : v;
    if (cached) cached[k] = values[idx];
    if (minIdx === -1 || idx < minIdx) minIdx = idx;
    if (idx > maxIdx) maxIdx = idx;
    changed = true;
  }
  if (!changed) return false;

  var width = maxIdx - minIdx + 1;
  sheet.getRange(rowNum, minIdx + 1, 1, width)
    .setValues([values.slice(minIdx, maxIdx + 1)]);
  return true;
}

function deleteRow_(name, rowNum) {
  if (!rowNum || rowNum < 2) return false;
  sh_(name).deleteRow(rowNum);
  /* Row numbers below the deleted row shift: drop caches for this sheet. */
  delete _table[name];
  return true;
}

function countRows_(name) {
  if (_table[name]) return _table[name].length;
  var sheet = ss_().getSheetByName(name);
  if (!sheet) return 0;
  return Math.max(0, sheet.getLastRow() - 1);
}

/** Monotonic ids kept in Script Properties. Fast and collision-safe. */
function nextSeq_(name) {
  var key = 'SEQ_' + name.toUpperCase();
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(SEQ_LOCK_WAIT_MS); } catch (e) { locked = false; }
  try {
    /* Read through the service (not the memory cache) so parallel executions
     * that already bumped the counter are respected. */
    var cur = int_(props_().getProperty(key) || '0');
    if (!cur) cur = maxNumericId_(name);
    var next = cur + 1;
    setProp_(key, next);
    return next;
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e2) { /* ignore */ } }
  }
}

function maxNumericId_(name) {
  var idCol = 'id';
  if (hdr_(name).indexOf(idCol) === -1) return 0;
  var max = 0;
  allRows_(name).forEach(function (r) { var v = int_(r[idCol]); if (v > max) max = v; });
  return max;
}

/* ================================ SETTINGS ============================== */

var DEFAULT_SETTINGS = {
  bot_title: 'نکسی آپ',
  currency: 'تومان',
  support_username: '',
  maintenance: '0',
  wallet_enabled: '1',
  test_enabled: '1',
  test_cooldown_hours: '24',
  referral_enabled: '1',
  referral_percent: '10',
  payment_enabled: '1',
  card_number: '0000-0000-0000-0000',
  card_holder: 'نام صاحب حساب',
  payment_note: 'پس از واریز، تصویر رسید یا شماره پیگیری را ارسال کنید.',
  channel_required: '0',
  min_withdraw: '50000',
  state_timeout_min: '15',
  admin_notify: '1',
  admins: '',
  schema_version: SCHEMA_VERSION
};

/**
 * Settings are read on almost every code path (texts, buttons, currency,
 * feature flags), so they get TWO cache layers:
 *   1. `_settingsCache` — per execution, zero cost.
 *   2. CacheService     — shared across executions for 6 minutes, so a warm
 *                         update never reads the Settings sheet at all.
 * Any write (setSetting_) invalidates layer 2 immediately.
 */
function settingsMap_() {
  if (_settingsCache) return _settingsCache;

  var cached = cacheGet_(SETTINGS_CACHE_KEY);
  if (cached) {
    var parsed = parseJson_(cached, null);
    if (parsed && typeof parsed === 'object') { _settingsCache = parsed; return _settingsCache; }
  }

  var map = {};
  try {
    allRows_('Settings').forEach(function (r) {
      var k = s_(r.key).trim();
      if (k) map[k] = s_(r.value);
    });
    cachePut_(SETTINGS_CACHE_KEY, json_(map), SETTINGS_CACHE_SEC);
  } catch (e) { map = {}; }
  _settingsCache = map;
  return map;
}

/** Drops the shared settings cache so the next read sees fresh values. */
function invalidateSettingsCache_() {
  _settingsCache = null;
  cacheRemove_(SETTINGS_CACHE_KEY);
}

function getSetting_(key, def) {
  var map = settingsMap_();
  if (map.hasOwnProperty(key) && map[key] !== '') return map[key];
  if (def === undefined && DEFAULT_SETTINGS.hasOwnProperty(key)) return DEFAULT_SETTINGS[key];
  return (def === undefined ? '' : def);
}

function getBool_(key, def) { return bool_(getSetting_(key, def === undefined ? '' : (def ? '1' : '0'))); }

function getInt_(key, def) {
  var v = getSetting_(key, '');
  return v === '' ? int_(def) : int_(v);
}

function setSetting_(key, value) {
  var existing = findOne_('Settings', function (r) { return s_(r.key).trim() === key; });
  if (existing) patchRow_('Settings', existing.__row, { value: s_(value), updated_at: nowIso_() });
  else appendRow_('Settings', { key: key, value: s_(value), updated_at: nowIso_() });
  /* Refresh the in-memory map and drop the shared cache so other executions
   * (and the admin panel) immediately see the new value. */
  if (_settingsCache) _settingsCache[key] = s_(value);
  cacheRemove_(SETTINGS_CACHE_KEY);
  return true;
}

/* ============================== TEXTS & BUTTONS ========================= */

var DEFAULT_TEXTS = {
  welcome: '🌟 <b>به نکسی آپ خوش آمدید!</b>\n\n' +
    'سلام {name} عزیز 👋\n' +
    'اینجا می‌توانید سرویس دلخواه خود را تهیه کنید، سرویس تست بگیرید، ' +
    'راهنمای اتصال را ببینید و از زیرمجموعه‌گیری درآمد کسب کنید.\n\n' +
    'از منوی پایین یکی از گزینه‌ها را انتخاب کنید 👇',
  main_menu: '📋 <b>منوی اصلی</b>\nیکی از گزینه‌ها را انتخاب کنید:',
  maintenance: '🛠 <b>ربات در حال بروزرسانی است</b>\n\nلطفاً چند دقیقه دیگر مجدداً تلاش کنید. از صبر شما سپاسگزاریم 🙏',
  blocked: '⛔️ <b>دسترسی شما به ربات محدود شده است.</b>\nدر صورت نیاز با پشتیبانی در تماس باشید.',
  buy_intro: '🛒 <b>خرید سرویس</b>\n\nیکی از سرویس‌های زیر را انتخاب کنید:',
  no_service: '😔 در حال حاضر سرویس فعالی برای فروش وجود ندارد.\nلطفاً بعداً مراجعه کنید.',
  payment_instructions: '💳 <b>راهنمای پرداخت</b>\n\n' +
    'مبلغ سفارش را به کارت زیر واریز کنید و سپس رسید پرداخت را ارسال نمایید.\n\n' +
    '🔢 شماره کارت:\n<code>{card}</code>\n' +
    '👤 به نام: <b>{holder}</b>\n' +
    '💰 مبلغ قابل پرداخت: <b>{amount}</b>\n\n{note}',
  payment_disabled: '⚠️ پرداخت در حال حاضر غیرفعال است. لطفاً بعداً تلاش کنید.',
  receipt_ask: '📤 <b>ارسال رسید پرداخت</b>\n\n' +
    'تصویر رسید یا شماره پیگیری تراکنش را در همین گفتگو ارسال کنید.\nبرای انصراف /cancel را بفرستید.',
  receipt_received: '✅ <b>رسید شما ثبت شد.</b>\n\nسفارش شما در صف بررسی مدیران قرار گرفت و نتیجه به‌زودی همین‌جا اعلام می‌شود 🙏',
  order_approved: '✅ <b>پرداخت سفارش {order} تأیید شد.</b>\n\nسرویس شما به‌زودی ارسال می‌شود. سپاس از خرید شما 🌹',
  order_rejected: '❌ <b>پرداخت سفارش {order} تأیید نشد.</b>\n\n{reason}',
  order_cancelled: '🚫 سفارش {order} لغو شد.',
  config_delivered: '🎁 <b>سرویس شما آماده است!</b>\n\n' +
    '📦 سرویس: <b>{service}</b>\n🗓 مدت: <b>{duration}</b>\n📊 حجم: <b>{volume}</b>\n\n' +
    'کانفیگ در پیام بعدی ارسال می‌شود. برای اتصال، «📖 راهنمای اتصال» را ببینید.',
  my_services_empty: '📭 هنوز سرویسی ثبت نشده است.\nبا «🛒 خرید سرویس» اولین سرویس خود را تهیه کنید.',
  test_intro: '🧪 <b>سرویس تست</b>\n\n' +
    'با ثبت درخواست، یک کانفیگ تست برای شما ارسال می‌شود.\nهر کاربر هر {hours} ساعت یک‌بار می‌تواند سرویس تست دریافت کند.',
  test_disabled: '⚠️ سرویس تست در حال حاضر غیرفعال است.',
  test_requested: '📨 <b>درخواست سرویس تست ثبت شد.</b>\n\nبه‌محض بررسی مدیران، کانفیگ تست برای شما ارسال می‌شود 🙏',
  test_pending: '⏳ یک درخواست تست در حال بررسی دارید. لطفاً منتظر پاسخ بمانید.',
  test_cooldown: '⏱ شما به‌تازگی سرویس تست دریافت کرده‌اید.\nزمان باقی‌مانده تا درخواست بعدی: <b>{remain}</b>',
  test_rejected: '❌ درخواست سرویس تست شما تأیید نشد.\n{reason}',
  test_delivered: '🧪 <b>سرویس تست شما آماده است!</b>\nکانفیگ در پیام بعدی ارسال می‌شود.',
  guide_intro: '📖 <b>راهنمای اتصال</b>\n\nیکی از راهنماهای زیر را انتخاب کنید:',
  guide_empty: '📭 هنوز راهنمایی ثبت نشده است.',
  referral_info: '👥 <b>زیرمجموعه‌گیری</b>\n\n' +
    'با دعوت دوستان خود، از هر خرید آن‌ها <b>{percent}٪</b> پورسانت می‌گیرید.\n\n' +
    '🔗 لینک دعوت شما:\n<code>{link}</code>\n\n' +
    '👤 تعداد زیرمجموعه‌ها: <b>{count}</b>\n💵 درآمد کل: <b>{income}</b>',
  referral_disabled: '⚠️ سیستم زیرمجموعه‌گیری در حال حاضر غیرفعال است.',
  wallet_info: '💰 <b>کیف پول</b>\n\n' +
    '💳 موجودی: <b>{balance}</b>\n👥 درآمد زیرمجموعه: <b>{ref}</b>\n🧾 مجموع خرید: <b>{spent}</b>',
  wallet_disabled: '⚠️ کیف پول در حال حاضر غیرفعال است.',
  wallet_empty_tx: '📭 تراکنشی ثبت نشده است.',
  withdraw_ask_amount: '💸 <b>درخواست برداشت</b>\n\n' +
    'مبلغ درخواستی را ارسال کنید ({currency}).\nحداقل مبلغ برداشت: <b>{min}</b>\nبرای انصراف /cancel را بفرستید.',
  withdraw_ask_dest: '🏦 شماره کارت یا شبا برای واریز را ارسال کنید.',
  withdraw_saved: '✅ درخواست برداشت شما ثبت شد و پس از بررسی مدیران واریز می‌شود.',
  withdraw_approved: '✅ درخواست برداشت شما به مبلغ <b>{amount}</b> تأیید و واریز شد.',
  withdraw_rejected: '❌ درخواست برداشت شما به مبلغ <b>{amount}</b> تأیید نشد.\n{reason}',
  insufficient_balance: '⚠️ موجودی کیف پول شما کافی نیست.',
  channel_join: '📢 <b>عضویت در کانال</b>\n\nبرای استفاده از ربات ابتدا در کانال(های) زیر عضو شوید، سپس روی «بررسی عضویت» بزنید.',
  channel_ok: '✅ عضویت شما تأیید شد. خوش آمدید!',
  channel_fail: '❌ هنوز عضویت شما تأیید نشد. لطفاً ابتدا عضو شوید و سپس دوباره بررسی کنید.',
  discount_ask: '🎟 <b>کد تخفیف</b>\n\nکد تخفیف خود را ارسال کنید.\nبرای انصراف /cancel را بفرستید.',
  discount_ok: '✅ کد تخفیف اعمال شد. تخفیف: <b>{amount}</b>',
  discount_bad: '❌ کد تخفیف نامعتبر، منقضی یا تکمیل‌شده است.',
  error_generic: '⚠️ خطایی رخ داد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.',
  cancelled: '🚫 عملیات لغو شد.',
  unknown: '🤔 متوجه نشدم. از منوی پایین استفاده کنید یا /start را بفرستید.',
  state_expired: '⌛️ زمان این عملیات به پایان رسید. لطفاً از ابتدا شروع کنید.'
};

var DEFAULT_BUTTONS = {
  buy: '🛒 خرید سرویس',
  my: '📦 سرویس‌های من',
  test: '🧪 دریافت سرویس تست',
  guide: '📖 راهنمای اتصال',
  referral: '👥 زیرمجموعه‌گیری',
  wallet: '💰 کیف پول',
  back: '🔙 بازگشت',
  home: '🏠 منوی اصلی',
  pay_receipt: '📤 ارسال رسید',
  pay_wallet: '👛 پرداخت از کیف پول',
  discount: '🎟 کد تخفیف',
  cancel_order: '🚫 لغو سفارش',
  join_check: '✅ بررسی عضویت',
  test_request: '🧪 ثبت درخواست تست',
  wallet_tx: '🧾 تراکنش‌ها',
  wallet_withdraw: '💸 درخواست برداشت',
  buy_now: '✅ ثبت سفارش'
};

var TEXT_KEYS = Object.keys(DEFAULT_TEXTS);
var BUTTON_KEYS = Object.keys(DEFAULT_BUTTONS);

function fill_(template, vars) {
  var out = s_(template);
  if (!vars) return out;
  for (var k in vars) out = out.split('{' + k + '}').join(s_(vars[k]));
  return out;
}

function t_(key, vars) {
  var raw = getSetting_('txt.' + key, '');
  if (raw === '') raw = (DEFAULT_TEXTS[key] === undefined) ? key : DEFAULT_TEXTS[key];
  return fill_(raw, vars);
}

function b_(key) {
  var raw = getSetting_('btn.' + key, '');
  if (raw === '') raw = (DEFAULT_BUTTONS[key] === undefined) ? key : DEFAULT_BUTTONS[key];
  return raw;
}

/* ================================ LOGGING =============================== */

/*
 * Logs are BUFFERED in memory and written with a single setValues() at the
 * end of the request (see flushLogs_, called from doPost's finally block).
 * The old build issued one appendRow() — i.e. one spreadsheet write plus an
 * implicit flush — per log line, and a normal update produces 2-5 lines.
 */
var _logBuffer = [];
var LOG_BUFFER_MAX = 40;   /* hard safety valve for long admin operations */

function log_(level, event, userId, message, data) {
  try {
    _logBuffer.push({
      created_at: nowIso_(),
      level: s_(level).toUpperCase(),
      event: s_(event),
      user_id: s_(userId),
      message: truncate_(sanitize_(message), 900),
      data: truncate_(sanitize_(typeof data === 'string' ? data : json_(data || {})), 900)
    });
    if (_logBuffer.length >= LOG_BUFFER_MAX) flushLogs_();
  } catch (e) { /* logging must never break the bot */ }
}

/** Writes every buffered log line in ONE spreadsheet call. Never throws. */
function flushLogs_() {
  if (!_logBuffer.length) return 0;
  var pending = _logBuffer;
  _logBuffer = [];
  try { return appendRows_('Logs', pending); }
  catch (e) { return 0; }
}

function logInfo_(event, userId, message, data) { log_('INFO', event, userId, message, data); }
function logWarn_(event, userId, message, data) { log_('WARN', event, userId, message, data); }
function logErr_(event, userId, message, data) { log_('ERROR', event, userId, message, data); }

function trimLogs_() {
  try {
    var sheet = ss_().getSheetByName('Logs');
    if (!sheet) return 0;
    var rows = sheet.getLastRow() - 1;
    if (rows <= MAX_LOG_ROWS) return 0;
    var extra = rows - MAX_LOG_ROWS;
    sheet.deleteRows(2, extra);
    return extra;
  } catch (e) { return 0; }
}

/* =========================== TELEGRAM API LAYER ========================= */
/* Single wrapper. Every Telegram call in this project goes through tg_(). */

/** Builds the UrlFetchApp request object for a Telegram method. */
function tgRequest_(method, payload) {
  return {
    url: TG_API + botToken_() + '/' + method,
    method: 'post',
    contentType: 'application/json',
    payload: json_(payload || {}),
    muteHttpExceptions: true,
    followRedirects: true
  };
}

/** Parses one Telegram HTTP response into the usual { ok, result } object. */
function tgParse_(method, payload, res) {
  var out;
  try { out = JSON.parse(res.getContentText()); }
  catch (e) { out = { ok: false, description: 'bad json' }; }
  if (!out.ok) {
    setProp_('LAST_TG_ERROR', iso_(new Date()) + ' | ' + method + ' | ' + truncate_(sanitize_(out.description), 200));
    logWarn_('tg_error', s_(payload && payload.chat_id), method + ': ' + s_(out.description), {
      code: out.error_code || 0
    });
  }
  return out;
}

/**
 * Sends N Telegram calls CONCURRENTLY with a single UrlFetchApp.fetchAll().
 * Used wherever the old build looped over sequential fetches (admin
 * notifications, broadcast batches): 8 admins used to mean 8 × ~250ms of
 * blocking latency, now it is one round trip for all of them.
 *
 * `calls` is an array of { method, payload }.
 */
function tgAll_(calls) {
  if (!calls || !calls.length) return [];
  if (!botToken_()) return calls.map(function () { return { ok: false, description: 'BOT_TOKEN missing' }; });
  var requests = calls.map(function (c) { return tgRequest_(c.method, c.payload); });
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    setProp_('LAST_TG_ERROR', iso_(new Date()) + ' | fetchAll | ' + sanitize_(err && err.message));
    logErr_('tg_fetch_all', '', 'fetchAll failed: ' + (err && err.message), { count: calls.length });
    return calls.map(function () { return { ok: false, description: 'network error' }; });
  }
  return responses.map(function (res, i) {
    return tgParse_(calls[i].method, calls[i].payload, res);
  });
}

function tg_(method, payload) {
  var token = botToken_();
  if (!token) return { ok: false, description: 'BOT_TOKEN missing' };
  var url = TG_API + token + '/' + method;
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: json_(payload || {}),
    muteHttpExceptions: true,
    followRedirects: true
  };
  var res;
  try {
    res = UrlFetchApp.fetch(url, options);
  } catch (err) {
    setProp_('LAST_TG_ERROR', iso_(new Date()) + ' | ' + method + ' | ' + sanitize_(err && err.message));
    logErr_('tg_fetch', '', method + ' failed: ' + (err && err.message), {});
    return { ok: false, description: 'network error' };
  }
  return tgParse_(method, payload, res);
}

function tgSendMessage_(chatId, text, opts) {
  var o = opts || {};
  var payload = {
    chat_id: chatId,
    text: s_(text),
    disable_web_page_preview: o.preview ? false : true
  };
  if (o.parse !== null) payload.parse_mode = o.parse || 'HTML';
  if (o.kb) payload.reply_markup = { inline_keyboard: o.kb };
  else if (o.menu) payload.reply_markup = o.menu;
  if (o.replyTo) payload.reply_to_message_id = o.replyTo;
  return tg_('sendMessage', payload);
}

function tgEditMessageText_(chatId, messageId, text, opts) {
  var o = opts || {};
  var payload = {
    chat_id: chatId,
    message_id: messageId,
    text: s_(text),
    disable_web_page_preview: true
  };
  if (o.parse !== null) payload.parse_mode = o.parse || 'HTML';
  if (o.kb) payload.reply_markup = { inline_keyboard: o.kb };
  return tg_('editMessageText', payload);
}

function tgAnswerCallbackQuery_(id, text, alert) {
  return tg_('answerCallbackQuery', {
    callback_query_id: id,
    text: s_(text).substring(0, 190),
    show_alert: !!alert
  });
}

function tgGetChatMember_(chatId, userId) {
  return tg_('getChatMember', { chat_id: chatId, user_id: userId });
}

function tgGetWebhookInfo_() { return tg_('getWebhookInfo', {}); }

function tgSetWebhook_(url, secret) {
  var payload = {
    url: url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    max_connections: 40
  };
  if (secret) payload.secret_token = secret;
  return tg_('setWebhook', payload);
}

function tgDeleteWebhook_() { return tg_('deleteWebhook', { drop_pending_updates: false }); }
function tgGetMe_() { return tg_('getMe', {}); }
function tgSendPhoto_(chatId, fileId, caption, opts) {
  var o = opts || {};
  var payload = { chat_id: chatId, photo: fileId, caption: s_(caption).substring(0, 1000) };
  if (o.parse !== null) payload.parse_mode = o.parse || 'HTML';
  if (o.kb) payload.reply_markup = { inline_keyboard: o.kb };
  return tg_('sendPhoto', payload);
}
function tgSendDocument_(chatId, fileId, caption, opts) {
  var o = opts || {};
  var payload = { chat_id: chatId, document: fileId, caption: s_(caption).substring(0, 1000) };
  if (o.parse !== null) payload.parse_mode = o.parse || 'HTML';
  if (o.kb) payload.reply_markup = { inline_keyboard: o.kb };
  return tg_('sendDocument', payload);
}

/* Convenience helpers built on the wrapper. */

function send_(chatId, text, opts) { return tgSendMessage_(chatId, text, opts); }

function sendMenu_(chatId, text, userId) {
  return tgSendMessage_(chatId, text, { menu: mainMenuMarkup_(userId) });
}

/** Sends a config/subscription string exactly as provided (no parse_mode). */
function sendRaw_(chatId, text) { return tgSendMessage_(chatId, s_(text), { parse: null }); }

function editOrSend_(ctx, text, kb) {
  if (ctx && ctx.messageId) {
    var res = tgEditMessageText_(ctx.chatId, ctx.messageId, text, { kb: kb });
    if (res && res.ok) return res;
  }
  return tgSendMessage_(ctx.chatId, text, { kb: kb });
}

/** Notifies every admin CONCURRENTLY (one fetchAll instead of N fetches). */
function notifyAdmins_(text, kb) {
  if (!getBool_('admin_notify', true)) return 0;
  var admins = allAdminIds_();
  if (!admins.length) return 0;
  var calls = admins.map(function (id) {
    var payload = { chat_id: id, text: s_(text), parse_mode: 'HTML', disable_web_page_preview: true };
    if (kb) payload.reply_markup = { inline_keyboard: kb };
    return { method: 'sendMessage', payload: payload };
  });
  var results = tgAll_(calls);
  var sent = 0;
  results.forEach(function (r) { if (r && r.ok) sent++; });
  return sent;
}

/* ============================== KEYBOARDS =============================== */

function btn_(text, data) { return { text: s_(text), callback_data: s_(data) }; }
function urlBtn_(text, url) { return { text: s_(text), url: s_(url) }; }

function menuLabels_() {
  return [b_('buy'), b_('my'), b_('test'), b_('guide'), b_('referral'), b_('wallet'), '🛠 پنل مدیریت'];
}

function isMenuLabel_(text) {
  return menuLabels_().indexOf(s_(text).trim()) !== -1;
}

function mainMenuMarkup_(userId) {
  var rows = [
    [{ text: b_('buy') }, { text: b_('my') }],
    [{ text: b_('test') }, { text: b_('guide') }],
    [{ text: b_('referral') }, { text: b_('wallet') }]
  ];
  if (userId && isAdmin_(userId)) rows.push([{ text: '🛠 پنل مدیریت' }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

function homeKb_() { return [[btn_(b_('home'), 'U:menu')]]; }
function backKb_(data) { return [[btn_(b_('back'), data)]]; }

function pagerRow_(prefix, page, pages, backData) {
  var row = [];
  if (page > 1) row.push(btn_('« قبلی', prefix + (page - 1)));
  if (pages > 1) row.push(btn_(page + '/' + pages, 'U:noop'));
  if (page < pages) row.push(btn_('بعدی »', prefix + (page + 1)));
  var rows = [];
  if (row.length) rows.push(row);
  if (backData) rows.push([btn_(b_('back'), backData)]);
  return rows;
}

/* ============================ USERS & WALLET ============================ */

/** Single-row user lookup (cached row index → one 1-row read, not a scan). */
function getUser_(userId) {
  return rowByKey_('Users', 'user_id', userId);
}

/** How often `last_seen` is actually written when nothing else changed. */
var LAST_SEEN_THROTTLE_SEC = 120;

function ensureUser_(from, refBy) {
  var userId = s_(from.id);
  var existing = getUser_(userId);
  if (existing) {
    var patch = {};
    if (s_(existing.username) !== s_(from.username)) patch.username = s_(from.username);
    if (s_(existing.first_name) !== s_(from.first_name)) patch.first_name = s_(from.first_name);
    if (s_(existing.last_name) !== s_(from.last_name)) patch.last_name = s_(from.last_name);

    /* `last_seen` on its own is written at most once every two minutes: it is
     * a display-only field and writing it on every keystroke cost one full
     * spreadsheet write per update. Any real profile change is written
     * immediately, together with a fresh last_seen. */
    var seenKey = 'nx.seen.' + userId;
    if (Object.keys(patch).length || !cacheGet_(seenKey)) {
      patch.last_seen = nowIso_();
      cachePut_(seenKey, '1', LAST_SEEN_THROTTLE_SEC);
    }
    if (Object.keys(patch).length) {
      patchRow_('Users', existing.__row, patch);
      for (var f in patch) existing[f] = patch[f];
    }
    return { user: existing, created: false };
  }
  var validRef = '';
  if (refBy && s_(refBy) !== userId && getUser_(refBy)) validRef = s_(refBy);
  var row = {
    user_id: userId,
    username: s_(from.username),
    first_name: s_(from.first_name),
    last_name: s_(from.last_name),
    joined_at: nowIso_(),
    last_seen: nowIso_(),
    is_blocked: '0',
    ref_code: userId,
    ref_by: validRef,
    ref_count: 0,
    last_test_at: '',
    state: '',
    state_data: '',
    state_at: '',
    note: ''
  };
  appendRow_('Users', row);
  /* Remember where the new row landed so the very next lookup is a 1-row read. */
  var appendedRow = sh_('Users').getLastRow();
  row.__row = appendedRow;
  cachePut_('nx.idx.Users.user_id.' + userId, appendedRow, ROWIDX_CACHE_SEC);
  ensureWallet_(userId);
  if (validRef) {
    var parent = getUser_(validRef);
    if (parent) patchRow_('Users', parent.__row, { ref_count: int_(parent.ref_count) + 1 });
    appendRow_('Referrals', {
      id: nextSeq_('Referrals'),
      referrer_id: validRef,
      referred_id: userId,
      order_id: '',
      commission: 0,
      created_at: nowIso_()
    });
    tgSendMessage_(validRef, '🎉 یک کاربر جدید با لینک دعوت شما وارد ربات شد!\n' +
      'با اولین خرید او، پورسانت به کیف پول شما اضافه می‌شود.', {});
  }
  logInfo_('user_new', userId, 'کاربر جدید ثبت شد', { ref_by: validRef });
  /* `row` already carries __row, so no re-read of the sheet is needed. */
  return { user: row, created: true };
}

function userName_(user) {
  if (!user) return 'کاربر';
  var name = (s_(user.first_name) + ' ' + s_(user.last_name)).trim();
  if (!name) name = s_(user.username) ? '@' + s_(user.username) : ('کاربر ' + s_(user.user_id));
  return name;
}

function userLabel_(user) {
  var parts = [userName_(user)];
  if (s_(user.username)) parts.push('@' + s_(user.username));
  parts.push('کد: ' + s_(user.user_id));
  return parts.join(' | ');
}

function ensureWallet_(userId) {
  var w = rowByKey_('Wallet', 'user_id', userId);
  if (w) return w;
  var row = {
    user_id: s_(userId), balance: 0, total_charged: 0, total_spent: 0,
    ref_income: 0, updated_at: nowIso_()
  };
  appendRow_('Wallet', row);
  /* Build the object locally instead of re-reading the sheet. */
  row.__row = sh_('Wallet').getLastRow();
  cachePut_('nx.idx.Wallet.user_id.' + s_(userId), row.__row, ROWIDX_CACHE_SEC);
  return row;
}

/**
 * Atomic-ish balance change. Holds the script lock for the sheet write only,
 * never around Telegram calls. Every change is written to Transactions.
 */
function changeBalance_(userId, amount, type, description, refId) {
  var txId = nextSeq_('Transactions');   /* allocated outside the lock */
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(LOCK_WAIT_MS); } catch (e) { locked = false; }
  try {
    var w = ensureWallet_(userId);
    var delta = num_(amount);
    var balance = num_(w.balance) + delta;
    if (balance < 0) balance = 0;
    var patch = { balance: balance, updated_at: nowIso_() };
    if (type === 'ref_commission') patch.ref_income = num_(w.ref_income) + delta;
    if (delta > 0 && type !== 'ref_commission') patch.total_charged = num_(w.total_charged) + delta;
    if (delta < 0) patch.total_spent = num_(w.total_spent) + Math.abs(delta);
    patchRow_('Wallet', w.__row, patch);
    appendRow_('Transactions', {
      id: txId,
      user_id: s_(userId),
      type: s_(type),
      amount: delta,
      balance_after: balance,
      description: s_(description),
      ref_id: s_(refId || ''),
      created_at: nowIso_()
    });
    return balance;
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e2) { /* ignore */ } }
  }
}

function walletOf_(userId) {
  var w = ensureWallet_(userId);
  return {
    balance: num_(w.balance),
    total_charged: num_(w.total_charged),
    total_spent: num_(w.total_spent),
    ref_income: num_(w.ref_income)
  };
}

/* =============================== STATES ================================= */

/* The three state columns are adjacent in the schema, so patchRow_ updates
 * them with a single 3-cell setValues() instead of rewriting the whole row. */
function setState_(userId, state, data) {
  var user = getUser_(userId);
  if (!user) return false;
  var patch = { state: s_(state), state_data: json_(data || {}), state_at: nowIso_() };
  var ok = patchRow_('Users', user.__row, patch);
  for (var k in patch) user[k] = patch[k];
  return ok;
}

/**
 * Clearing an already-empty state is a no-op. This matters: /start, /cancel
 * and every main-menu button called clearState_ unconditionally, costing one
 * spreadsheet write per tap for users who had no wizard running at all.
 */
function clearState_(userId) {
  var user = getUser_(userId);
  if (!user) return false;
  if (!s_(user.state) && !s_(user.state_data) && !s_(user.state_at)) return false;
  var ok = patchRow_('Users', user.__row, { state: '', state_data: '', state_at: '' });
  user.state = ''; user.state_data = ''; user.state_at = '';
  return ok;
}

/** Returns null when there is no state or the state has timed out. */
function readState_(user) {
  if (!user || !s_(user.state)) return null;
  var minutes = getInt_('state_timeout_min', 15);
  var at = parseDate_(user.state_at);
  if (at && minutes > 0 && (new Date().getTime() - at.getTime()) > minutes * 60000) {
    clearState_(user.user_id);
    return { expired: true, name: s_(user.state), data: {} };
  }
  return { expired: false, name: s_(user.state), data: parseJson_(user.state_data, {}) };
}

/* ============================ WEBHOOK PIPELINE ========================== */

/**
 * Public liveness endpoint. Deliberately cheap (no spreadsheet access) and
 * secret-free, so it is safe to expose and to poll from an uptime monitor.
 * Deeper diagnostics live behind the admin panel / editor functions.
 */
function doGet(e) {
  var body = {
    ok: true,
    app: APP_NAME,
    title: APP_TITLE,
    version: APP_VERSION,
    build: BUILD_VERSION,
    schema: SCHEMA_VERSION,
    time: nowIso_()
  };
  return ContentService.createTextOutput(json_(body)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out = ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  /* Correlation id set by the Cloudflare Worker (?rid=...) so a single update
   * can be traced across `wrangler tail` (Worker logs) and the `Logs` sheet
   * (Apps Script logs) without exposing any secret. Optional: stays empty
   * in legacy direct-mode (no Worker) and everything still works. */
  var rid = s_(e && e.parameter && e.parameter.rid);
  try {
    if (!verifyRequest_(e)) {
      logWarn_('webhook_reject', '', 'درخواست بدون کلید معتبر رد شد', { rid: rid });
      return out;
    }
    var update = parseJson_(e && e.postData ? e.postData.contents : '', null);
    if (!update || update.update_id === undefined) {
      logWarn_('webhook_bad_payload', '', 'بدنه درخواست نامعتبر یا فاقد update_id بود', { rid: rid });
      return out;
    }
    if (isDuplicateUpdate_(update.update_id)) {
      logInfo_('update_duplicate', '', 'آپدیت تکراری نادیده گرفته شد', { update_id: update.update_id, rid: rid });
      return out;
    }
    /* One batched property write instead of two round trips. */
    setProps_({ LAST_UPDATE_ID: update.update_id, LAST_UPDATE_AT: nowIso_() });
    logInfo_('webhook_received', '', 'آپدیت دریافت و پردازش شد', { update_id: update.update_id, rid: rid });
    processUpdate_(update);
  } catch (err) {
    logErr_('webhook_fatal', '', 'خطای بحرانی در پردازش آپدیت: ' + (err && err.message), {
      rid: rid,
      stack: truncate_(s_(err && err.stack), 500)
    });
  } finally {
    /* Single batched write for everything logged during this update. */
    flushLogs_();
  }
  return out;
}

/** Query-string secret check (Apps Script cannot read Telegram's header). */
function verifyRequest_(e) {
  var expected = webhookSecret_();
  if (!expected) return true; /* not configured yet: allow, setupWebhook() will set one */
  var params = (e && e.parameter) ? e.parameter : {};
  var got = s_(params.s || params.secret || params.token);
  return got === expected;
}

/**
 * Duplicate protection — LOCK-FREE.
 *
 * The old version grabbed the script lock (up to 2s) for every single update,
 * which serialised the whole bot: two users pressing a button at the same
 * moment queued behind each other before any work started. Telegram assigns
 * a unique, monotonically increasing update_id and the Worker only retries a
 * forward when Apps Script did NOT answer 2xx, so a plain compare-and-set on
 * CacheService is sufficient here and costs a single fast cache round trip.
 */
function isDuplicateUpdate_(updateId) {
  var key = 'upd_' + s_(updateId);
  if (cacheGet_(key)) return true;
  cachePut_(key, '1', DEDUPE_TTL_SEC);
  return false;
}

function processUpdate_(update) {
  try {
    if (update.message) { onMessage_(update.message); return; }
    if (update.callback_query) { onCallback_(update.callback_query); return; }
  } catch (err) {
    var chatId = 0;
    try {
      chatId = update.message ? update.message.chat.id : update.callback_query.message.chat.id;
    } catch (e) { chatId = 0; }
    logErr_('update_error', chatId, 'خطا در پردازش: ' + (err && err.message), {
      stack: truncate_(s_(err && err.stack), 500)
    });
    if (chatId) tgSendMessage_(chatId, t_('error_generic'), {});
  }
}

/* ================================ GATES ================================= */

function requiredChannels_() {
  if (!getBool_('channel_required', false)) return [];
  return findRows_('Channels', function (r) {
    return bool_(r.is_active) && bool_(r.is_required);
  });
}

function channelRef_(ch) {
  var chatId = s_(ch.chat_id).trim();
  if (chatId) return chatId;
  var username = s_(ch.username).trim().replace('@', '');
  return username ? '@' + username : '';
}

function channelLink_(ch) {
  var username = s_(ch.username).trim().replace('@', '');
  return username ? 'https://t.me/' + username : '';
}

var MEMBER_STATUSES_OK = ['creator', 'administrator', 'member', 'restricted'];

/**
 * Checks membership in ALL required channels with one concurrent fetchAll
 * instead of one blocking getChatMember per channel, and caches a positive
 * result for MEMBER_CACHE_SEC.
 */
function isMemberEverywhere_(userId) {
  var channels = requiredChannels_();
  if (!channels.length) return true;
  var key = 'mem_' + s_(userId);
  if (cacheGet_(key) === '1') return true;

  var calls = [];
  channels.forEach(function (ch) {
    var ref = channelRef_(ch);
    if (ref) calls.push({ method: 'getChatMember', payload: { chat_id: ref, user_id: userId } });
  });
  if (!calls.length) return true;

  var ok = true;
  tgAll_(calls).forEach(function (res) {
    if (!ok) return;
    if (!res || !res.ok || !res.result) { ok = false; return; }
    if (MEMBER_STATUSES_OK.indexOf(s_(res.result.status)) === -1) ok = false;
  });
  if (ok) cachePut_(key, '1', MEMBER_CACHE_SEC);
  return ok;
}

function showJoinPrompt_(ctx) {
  var kb = [];
  requiredChannels_().forEach(function (ch) {
    var link = channelLink_(ch);
    var title = s_(ch.title) || s_(ch.username) || 'کانال';
    if (link) kb.push([urlBtn_('📢 عضویت در ' + title, link)]);
  });
  kb.push([btn_(b_('join_check'), 'U:chk')]);
  send_(ctx.chatId, t_('channel_join'), { kb: kb });
}

/**
 * Central access gate for regular features.
 * Admins bypass maintenance mode and channel membership.
 */
function passGate_(ctx, user) {
  if (bool_(user.is_blocked)) { send_(ctx.chatId, t_('blocked'), {}); return false; }
  if (ctx.isAdmin) return true;
  if (getBool_('maintenance', false)) { send_(ctx.chatId, t_('maintenance'), {}); return false; }
  if (!isMemberEverywhere_(ctx.userId)) { showJoinPrompt_(ctx); return false; }
  return true;
}

/* ============================ MESSAGE ROUTER ============================ */

function onMessage_(msg) {
  if (!msg || !msg.from || msg.from.is_bot) return;
  if (!msg.chat || msg.chat.type !== 'private') return;

  var text = s_(msg.text).trim();
  var refBy = '';
  var startMatch = text.match(/^\/start(?:@\w+)?\s+ref(\d+)$/i);
  if (startMatch) refBy = startMatch[1];

  var res = ensureUser_(msg.from, refBy);
  var user = res.user;
  var ctx = {
    chatId: msg.chat.id,
    userId: s_(msg.from.id),
    messageId: msg.message_id,
    isAdmin: isAdmin_(msg.from.id),
    msg: msg,
    user: user
  };

  if (bool_(user.is_blocked)) { send_(ctx.chatId, t_('blocked'), {}); return; }

  /* Universal escapes: always available, always clear the wizard. */
  if (/^\/start(?:@\w+)?(\s|$)/i.test(text)) {
    clearState_(ctx.userId);
    startCommand_(ctx, res.created);
    return;
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    clearState_(ctx.userId);
    sendMenu_(ctx.chatId, t_('cancelled'), ctx.userId);
    return;
  }
  if (/^\/id(?:@\w+)?$/i.test(text)) {
    send_(ctx.chatId, '🆔 شناسه عددی شما: <code>' + esc_(ctx.userId) + '</code>', {});
    return;
  }
  if (/^\/(admin|panel)(?:@\w+)?$/i.test(text)) {
    if (ctx.isAdmin) adminHome_(ctx, false);
    else send_(ctx.chatId, t_('unknown'), {});
    return;
  }
  if (/^\/help(?:@\w+)?$/i.test(text)) {
    sendMenu_(ctx.chatId, t_('main_menu'), ctx.userId);
    return;
  }

  /* Active wizard state has priority, except when a main menu button is pressed. */
  var state = readState_(user);
  if (state && state.name && !state.expired && isMenuLabel_(text)) {
    clearState_(ctx.userId);
    state = null;
  }
  if (state && state.expired) {
    sendMenu_(ctx.chatId, t_('state_expired'), ctx.userId);
    return;
  }
  if (state && state.name) {
    handleState_(ctx, state);
    return;
  }

  /* Main menu (reply keyboard) */
  if (text === b_('buy')) { if (passGate_(ctx, user)) buyList_(ctx, 1, false); return; }
  if (text === b_('my')) { if (passGate_(ctx, user)) myServices_(ctx, 1, false); return; }
  if (text === b_('test')) { if (passGate_(ctx, user)) testIntro_(ctx, false); return; }
  if (text === b_('guide')) { if (passGate_(ctx, user)) guideList_(ctx, 1, false); return; }
  if (text === b_('referral')) { if (passGate_(ctx, user)) referralView_(ctx, false); return; }
  if (text === b_('wallet')) { if (passGate_(ctx, user)) walletView_(ctx, false); return; }
  if (text === '🛠 پنل مدیریت') {
    if (ctx.isAdmin) adminHome_(ctx, false);
    else send_(ctx.chatId, t_('unknown'), {});
    return;
  }

  if (getBool_('maintenance', false) && !ctx.isAdmin) { send_(ctx.chatId, t_('maintenance'), {}); return; }
  sendMenu_(ctx.chatId, t_('unknown'), ctx.userId);
}

function startCommand_(ctx, isNew) {
  if (getBool_('maintenance', false) && !ctx.isAdmin) {
    send_(ctx.chatId, t_('maintenance'), {});
    return;
  }
  var welcome = t_('welcome', { name: esc_(userName_(ctx.user)) });
  sendMenu_(ctx.chatId, welcome, ctx.userId);
  if (!ctx.isAdmin && !isMemberEverywhere_(ctx.userId)) showJoinPrompt_(ctx);
  if (isNew) {
    notifyAdmins_('🆕 <b>کاربر جدید</b>\n' + esc_(userLabel_(ctx.user)), [
      [btn_('👤 مشاهده کاربر', 'A:usr:v:' + ctx.userId)]
    ]);
  }
}

/* =========================== CALLBACK ROUTER =========================== */

function onCallback_(cq) {
  if (!cq || !cq.from) return;
  var data = s_(cq.data);

  /* Answer the callback FIRST. Telegram keeps the little loading spinner on
   * the button until it gets this call, so acknowledging before any
   * spreadsheet work makes the UI feel instant even while the rest of the
   * handler is still running. Denials below are delivered as chat messages
   * instead of alerts, because the query is already answered. */
  tgAnswerCallbackQuery_(cq.id, '', false);
  if (data === 'U:noop') return;

  var res = ensureUser_(cq.from, '');
  var user = res.user;
  var ctx = {
    chatId: cq.message ? cq.message.chat.id : cq.from.id,
    messageId: cq.message ? cq.message.message_id : 0,
    userId: s_(cq.from.id),
    isAdmin: isAdmin_(cq.from.id),
    cqId: cq.id,
    user: user,
    cq: cq
  };

  if (bool_(user.is_blocked)) {
    send_(ctx.chatId, t_('blocked'), {});
    return;
  }

  var parts = data.split(':');
  var scope = parts[0];

  try {
    if (scope === 'A') {
      if (!ctx.isAdmin) {
        send_(ctx.chatId, '⛔️ دسترسی مدیریتی ندارید.', {});
        logWarn_('admin_denied', ctx.userId, 'تلاش غیرمجاز برای پنل مدیریت', { data: data });
        return;
      }
      routeAdmin_(ctx, parts);
      return;
    }
    if (scope === 'U') {
      routeUser_(ctx, parts);
      return;
    }
    send_(ctx.chatId, t_('unknown'), {});
  } catch (err) {
    logErr_('callback_error', ctx.userId, 'خطا در دکمه: ' + (err && err.message), { data: data });
    send_(ctx.chatId, t_('error_generic'), {});
  }
}

function routeUser_(ctx, p) {
  var action = p[1] || 'menu';

  if (action === 'chk') {
    cacheRemove_('mem_' + ctx.userId);
    if (isMemberEverywhere_(ctx.userId)) sendMenu_(ctx.chatId, t_('channel_ok'), ctx.userId);
    else showJoinPrompt_(ctx);
    return;
  }
  if (action === 'menu') {
    if (!passGate_(ctx, ctx.user)) return;
    editOrSend_(ctx, t_('main_menu'), userHomeKb_());
    return;
  }
  if (!passGate_(ctx, ctx.user)) return;

  switch (action) {
    case 'buy': buyList_(ctx, int_(p[2]) || 1, true); return;
    case 'svc': serviceView_(ctx, p[2]); return;
    case 'ord': createOrder_(ctx, p[2]); return;
    case 'pay': paymentView_(ctx, p[2], true); return;
    case 'rcpt': askReceipt_(ctx, p[2]); return;
    case 'disc': askDiscount_(ctx, p[2]); return;
    case 'wpay': payWithWallet_(ctx, p[2]); return;
    case 'ocan': cancelOrderByUser_(ctx, p[2]); return;
    case 'my': myServices_(ctx, int_(p[2]) || 1, true); return;
    case 'cfg': configView_(ctx, p[2]); return;
    case 'test': testIntro_(ctx, true); return;
    case 'treq': testRequest_(ctx); return;
    case 'guide': guideList_(ctx, int_(p[2]) || 1, true); return;
    case 'gv': guideView_(ctx, p[2]); return;
    case 'ref': referralView_(ctx, true); return;
    case 'wal': walletView_(ctx, true); return;
    case 'wtx': walletTx_(ctx, int_(p[2]) || 1); return;
    case 'wwd': askWithdraw_(ctx); return;
    default:
      editOrSend_(ctx, t_('main_menu'), userHomeKb_());
  }
}

function userHomeKb_() {
  return [
    [btn_(b_('buy'), 'U:buy:1'), btn_(b_('my'), 'U:my:1')],
    [btn_(b_('test'), 'U:test'), btn_(b_('guide'), 'U:guide:1')],
    [btn_(b_('referral'), 'U:ref'), btn_(b_('wallet'), 'U:wal')]
  ];
}

/* ============================== BUY / SERVICES ========================== */

function activeServices_() {
  return findRows_('Services', function (r) { return bool_(r.is_active); })
    .sort(function (a, b) { return int_(a.sort_order) - int_(b.sort_order) || int_(a.id) - int_(b.id); });
}

function serviceById_(id) { return rowByKey_('Services', 'id', id); }

function buyList_(ctx, page, edit) {
  var services = activeServices_();
  if (!services.length) {
    if (edit) editOrSend_(ctx, t_('no_service'), homeKb_());
    else send_(ctx.chatId, t_('no_service'), { kb: homeKb_() });
    return;
  }
  var pg = paginate_(services, page);
  var kb = pg.items.map(function (svc) {
    return [btn_('📦 ' + s_(svc.name) + ' — ' + money_(svc.price), 'U:svc:' + s_(svc.id))];
  });
  kb = kb.concat(pagerRow_('U:buy:', pg.page, pg.pages, 'U:menu'));
  var text = t_('buy_intro');
  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

function serviceCard_(svc) {
  return '📦 <b>' + esc_(svc.name) + '</b>\n\n' +
    (s_(svc.description) ? esc_(svc.description) + '\n\n' : '') +
    '📊 حجم: <b>' + esc_(s_(svc.volume) || 'نامحدود') + '</b>\n' +
    '🗓 مدت: <b>' + esc_(s_(svc.duration) || '-') + '</b>\n' +
    '💰 قیمت: <b>' + money_(svc.price) + '</b>';
}

function serviceView_(ctx, serviceId) {
  var svc = serviceById_(serviceId);
  if (!svc || !bool_(svc.is_active)) {
    editOrSend_(ctx, '⚠️ این سرویس در دسترس نیست.', backKb_('U:buy:1'));
    return;
  }
  var kb = [
    [btn_(b_('buy_now'), 'U:ord:' + s_(svc.id))],
    [btn_(b_('back'), 'U:buy:1')]
  ];
  editOrSend_(ctx, serviceCard_(svc), kb);
}

/* ================================ ORDERS =============================== */

/** Indexed single-order lookup (1-row read on a cache hit). */
function orderById_(id) { return rowByKey_('Orders', 'id', id); }

function orderCode_(order) { return '#' + s_(order.id); }

var ORDER_STATUS_FA = {
  awaiting_payment: '⏳ در انتظار پرداخت',
  pending_review: '🔍 در حال بررسی',
  paid: '✅ پرداخت‌شده',
  delivered: '🎁 تحویل‌شده',
  rejected: '❌ رد‌شده',
  cancelled: '🚫 لغو‌شده'
};

function orderStatusFa_(status) {
  var key = s_(status);
  return ORDER_STATUS_FA[key] || key || '-';
}

function createOrder_(ctx, serviceId) {
  var svc = serviceById_(serviceId);
  if (!svc || !bool_(svc.is_active)) {
    editOrSend_(ctx, '⚠️ این سرویس در دسترس نیست.', backKb_('U:buy:1'));
    return;
  }
  if (!getBool_('payment_enabled', true) && !getBool_('wallet_enabled', true)) {
    editOrSend_(ctx, t_('payment_disabled'), homeKb_());
    return;
  }
  var open = findRows_('Orders', function (r) {
    return s_(r.user_id) === ctx.userId && s_(r.kind) === 'purchase' &&
      s_(r.service_id) === s_(svc.id) && s_(r.status) === 'awaiting_payment';
  });
  var order;
  if (open.length) {
    order = open[open.length - 1];
  } else {
    var id = nextSeq_('Orders');
    appendRow_('Orders', {
      id: id,
      kind: 'purchase',
      user_id: ctx.userId,
      service_id: s_(svc.id),
      service_name: s_(svc.name),
      amount: num_(svc.price),
      discount_code: '',
      discount_amount: 0,
      final_amount: num_(svc.price),
      status: 'awaiting_payment',
      pay_method: '',
      payment_ref: '',
      created_at: nowIso_(),
      updated_at: nowIso_(),
      handled_by: '',
      note: ''
    });
    order = orderById_(id);
    logInfo_('order_new', ctx.userId, 'سفارش جدید ثبت شد', { order_id: id, service: s_(svc.name) });
  }
  paymentView_(ctx, order.id, true);
}

function paymentView_(ctx, orderId, edit) {
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId) {
    editOrSend_(ctx, '⚠️ سفارش یافت نشد.', homeKb_());
    return;
  }
  if (s_(order.status) !== 'awaiting_payment') {
    editOrSend_(ctx, orderCardUser_(order), homeKb_());
    return;
  }
  var text = '🧾 <b>سفارش ' + orderCode_(order) + '</b>\n' +
    '📦 سرویس: <b>' + esc_(order.service_name) + '</b>\n' +
    '💰 مبلغ: <b>' + money_(order.amount) + '</b>\n' +
    (num_(order.discount_amount) > 0 ?
      '🎟 تخفیف: <b>' + money_(order.discount_amount) + '</b>\n' +
      '💵 مبلغ نهایی: <b>' + money_(order.final_amount) + '</b>\n' : '') +
    '\n' + t_('payment_instructions', {
      card: s_(getSetting_('card_number', '')),
      holder: esc_(getSetting_('card_holder', '')),
      amount: money_(order.final_amount),
      note: esc_(getSetting_('payment_note', ''))
    });

  var kb = [];
  if (getBool_('payment_enabled', true)) kb.push([btn_(b_('pay_receipt'), 'U:rcpt:' + s_(order.id))]);
  if (getBool_('wallet_enabled', true)) kb.push([btn_(b_('pay_wallet') + ' (' + money_(walletOf_(ctx.userId).balance) + ')', 'U:wpay:' + s_(order.id))]);
  if (!s_(order.discount_code)) kb.push([btn_(b_('discount'), 'U:disc:' + s_(order.id))]);
  kb.push([btn_(b_('cancel_order'), 'U:ocan:' + s_(order.id))]);
  kb.push([btn_(b_('home'), 'U:menu')]);

  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

function orderCardUser_(order) {
  return '🧾 <b>سفارش ' + orderCode_(order) + '</b>\n' +
    '📦 سرویس: <b>' + esc_(order.service_name) + '</b>\n' +
    '💵 مبلغ نهایی: <b>' + money_(order.final_amount) + '</b>\n' +
    '📌 وضعیت: <b>' + orderStatusFa_(order.status) + '</b>\n' +
    '🗓 تاریخ: ' + jDateTime_(order.created_at);
}

function askDiscount_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId || s_(order.status) !== 'awaiting_payment') {
    editOrSend_(ctx, '⚠️ سفارش قابل تغییر نیست.', homeKb_());
    return;
  }
  setState_(ctx.userId, 'u.discount', { orderId: s_(order.id) });
  send_(ctx.chatId, t_('discount_ask'), {});
}

function discountByCode_(code) {
  var wanted = s_(code).trim().toUpperCase();
  return findOne_('Discounts', function (r) { return s_(r.code).trim().toUpperCase() === wanted; });
}

function discountUsable_(d) {
  if (!d || !bool_(d.is_active)) return false;
  var limit = int_(d.usage_limit);
  if (limit > 0 && int_(d.used_count) >= limit) return false;
  var exp = parseDate_(d.expires_at);
  if (exp && exp.getTime() < new Date().getTime()) return false;
  return true;
}

function discountAmountFor_(d, amount) {
  var value = num_(d.value);
  var off = (s_(d.kind) === 'percent') ? Math.round(num_(amount) * value / 100) : value;
  if (off > num_(amount)) off = num_(amount);
  return off < 0 ? 0 : off;
}

function applyDiscountToOrder_(ctx, orderId, code) {
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId || s_(order.status) !== 'awaiting_payment') {
    send_(ctx.chatId, '⚠️ سفارش قابل تغییر نیست.', { kb: homeKb_() });
    return;
  }
  var d = discountByCode_(code);
  if (!discountUsable_(d)) {
    send_(ctx.chatId, t_('discount_bad'), {});
    paymentView_(ctx, orderId, false);
    return;
  }
  var off = discountAmountFor_(d, order.amount);
  patchRow_('Orders', order.__row, {
    discount_code: s_(d.code),
    discount_amount: off,
    final_amount: num_(order.amount) - off,
    updated_at: nowIso_()
  });
  patchRow_('Discounts', d.__row, { used_count: int_(d.used_count) + 1 });
  logInfo_('discount_used', ctx.userId, 'کد تخفیف اعمال شد', { order_id: s_(order.id), code: s_(d.code) });
  send_(ctx.chatId, t_('discount_ok', { amount: money_(off) }), {});
  paymentView_(ctx, orderId, false);
}

function askReceipt_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId || s_(order.status) !== 'awaiting_payment') {
    editOrSend_(ctx, '⚠️ این سفارش در وضعیت انتظار پرداخت نیست.', homeKb_());
    return;
  }
  if (!getBool_('payment_enabled', true)) { editOrSend_(ctx, t_('payment_disabled'), homeKb_()); return; }
  setState_(ctx.userId, 'u.receipt', { orderId: s_(order.id) });
  send_(ctx.chatId, t_('receipt_ask'), {});
}

function submitReceipt_(ctx, orderId, msg) {
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId) {
    clearState_(ctx.userId);
    sendMenu_(ctx.chatId, '⚠️ سفارش یافت نشد.', ctx.userId);
    return;
  }
  var ref = '';
  var photoId = '';
  var docId = '';
  if (msg.photo && msg.photo.length) { photoId = s_(msg.photo[msg.photo.length - 1].file_id); ref = 'photo'; }
  else if (msg.document) { docId = s_(msg.document.file_id); ref = 'document'; }
  else if (s_(msg.text)) { ref = truncate_(s_(msg.text), 300); }
  else { send_(ctx.chatId, 'لطفاً تصویر رسید یا شماره پیگیری را ارسال کنید.', {}); return; }

  patchRow_('Orders', order.__row, {
    status: 'pending_review',
    pay_method: 'card',
    payment_ref: photoId ? ('photo:' + photoId) : (docId ? ('document:' + docId) : ref),
    updated_at: nowIso_()
  });
  clearState_(ctx.userId);
  sendMenu_(ctx.chatId, t_('receipt_received'), ctx.userId);
  logInfo_('payment_submitted', ctx.userId, 'رسید پرداخت ارسال شد', { order_id: s_(order.id) });

  var caption = '💳 <b>رسید پرداخت جدید</b>\n' +
    '🧾 سفارش: <b>' + orderCode_(order) + '</b>\n' +
    '📦 سرویس: <b>' + esc_(order.service_name) + '</b>\n' +
    '💵 مبلغ: <b>' + money_(order.final_amount) + '</b>\n' +
    '👤 کاربر: ' + esc_(userLabel_(ctx.user)) +
    (photoId || docId ? '' : '\n📝 اطلاعات: <code>' + esc_(ref) + '</code>');
  /* All admins are notified in one concurrent batch. */
  var kb = adminOrderKb_(order.id);
  tgAll_(allAdminIds_().map(function (adminId) {
    var payload = { chat_id: adminId, parse_mode: 'HTML' };
    if (kb) payload.reply_markup = { inline_keyboard: kb };
    if (photoId) {
      payload.photo = photoId;
      payload.caption = s_(caption).substring(0, 1000);
      return { method: 'sendPhoto', payload: payload };
    }
    if (docId) {
      payload.document = docId;
      payload.caption = s_(caption).substring(0, 1000);
      return { method: 'sendDocument', payload: payload };
    }
    payload.text = s_(caption);
    payload.disable_web_page_preview = true;
    return { method: 'sendMessage', payload: payload };
  }));
}

function payWithWallet_(ctx, orderId) {
  if (!getBool_('wallet_enabled', true)) { editOrSend_(ctx, t_('wallet_disabled'), homeKb_()); return; }
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId || s_(order.status) !== 'awaiting_payment') {
    editOrSend_(ctx, '⚠️ این سفارش قابل پرداخت نیست.', homeKb_());
    return;
  }
  var balance = walletOf_(ctx.userId).balance;
  var amount = num_(order.final_amount);
  if (balance < amount) {
    editOrSend_(ctx, t_('insufficient_balance') + '\n\n💳 موجودی: <b>' + money_(balance) + '</b>\n' +
      '💵 مبلغ سفارش: <b>' + money_(amount) + '</b>', [[btn_(b_('back'), 'U:pay:' + s_(order.id))]]);
    return;
  }
  changeBalance_(ctx.userId, -amount, 'purchase', 'پرداخت سفارش ' + orderCode_(order), s_(order.id));
  patchRow_('Orders', order.__row, {
    status: 'paid', pay_method: 'wallet', payment_ref: 'wallet', updated_at: nowIso_()
  });
  payReferralCommission_(order);
  logInfo_('payment_wallet', ctx.userId, 'پرداخت از کیف پول انجام شد', { order_id: s_(order.id) });
  editOrSend_(ctx, '✅ <b>پرداخت از کیف پول انجام شد.</b>\n\nسفارش ' + orderCode_(order) +
    ' در صف تحویل قرار گرفت و کانفیگ به‌زودی ارسال می‌شود 🙏', homeKb_());
  notifyAdmins_('👛 <b>پرداخت از کیف پول</b>\n🧾 سفارش: <b>' + orderCode_(order) + '</b>\n' +
    '📦 ' + esc_(order.service_name) + '\n💵 ' + money_(order.final_amount) + '\n' +
    '👤 ' + esc_(userLabel_(ctx.user)), adminOrderKb_(order.id));
}

function cancelOrderByUser_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order || s_(order.user_id) !== ctx.userId) { editOrSend_(ctx, '⚠️ سفارش یافت نشد.', homeKb_()); return; }
  if (['awaiting_payment', 'pending_review'].indexOf(s_(order.status)) === -1) {
    editOrSend_(ctx, '⚠️ این سفارش قابل لغو نیست.', homeKb_());
    return;
  }
  patchRow_('Orders', order.__row, { status: 'cancelled', updated_at: nowIso_(), note: 'لغو توسط کاربر' });
  releaseDiscount_(order);
  clearState_(ctx.userId);
  editOrSend_(ctx, t_('order_cancelled', { order: orderCode_(order) }), homeKb_());
  logInfo_('order_cancel_user', ctx.userId, 'سفارش توسط کاربر لغو شد', { order_id: s_(order.id) });
}

function releaseDiscount_(order) {
  if (!s_(order.discount_code)) return;
  var d = discountByCode_(order.discount_code);
  if (d && int_(d.used_count) > 0) patchRow_('Discounts', d.__row, { used_count: int_(d.used_count) - 1 });
}

/** Referral commission is paid once, when an order is actually paid. */
function payReferralCommission_(order) {
  if (!getBool_('referral_enabled', true)) return 0;
  var buyer = getUser_(order.user_id);
  if (!buyer || !s_(buyer.ref_by)) return 0;
  var already = findOne_('Referrals', function (r) {
    return s_(r.order_id) === s_(order.id) && num_(r.commission) > 0;
  });
  if (already) return 0;
  var percent = getInt_('referral_percent', 10);
  if (percent <= 0) return 0;
  var commission = Math.round(num_(order.final_amount) * percent / 100);
  if (commission <= 0) return 0;
  changeBalance_(buyer.ref_by, commission, 'ref_commission',
    'پورسانت خرید زیرمجموعه ' + s_(order.user_id), s_(order.id));
  appendRow_('Referrals', {
    id: nextSeq_('Referrals'),
    referrer_id: s_(buyer.ref_by),
    referred_id: s_(order.user_id),
    order_id: s_(order.id),
    commission: commission,
    created_at: nowIso_()
  });
  tgSendMessage_(buyer.ref_by, '🎉 <b>پورسانت زیرمجموعه</b>\n\n' +
    'مبلغ <b>' + money_(commission) + '</b> بابت خرید زیرمجموعه شما به کیف پولتان اضافه شد.', {});
  logInfo_('ref_commission', s_(buyer.ref_by), 'پورسانت پرداخت شد', {
    order_id: s_(order.id), amount: commission
  });
  return commission;
}

/* ============================== MY SERVICES ============================= */

function myServices_(ctx, page, edit) {
  var configs = findRows_('Configs', function (r) {
    return s_(r.user_id) === ctx.userId;
  }).sort(function (a, b) { return int_(b.id) - int_(a.id); });

  if (!configs.length) {
    var pending = findRows_('Orders', function (r) {
      return s_(r.user_id) === ctx.userId &&
        ['awaiting_payment', 'pending_review', 'paid'].indexOf(s_(r.status)) !== -1;
    });
    var msg = t_('my_services_empty');
    if (pending.length) {
      msg += '\n\n⏳ سفارش‌های در جریان:\n';
      pending.slice(0, 5).forEach(function (o) {
        msg += '• ' + orderCode_(o) + ' — ' + esc_(o.service_name) + ' — ' + orderStatusFa_(o.status) + '\n';
      });
    }
    if (edit) editOrSend_(ctx, msg, homeKb_());
    else send_(ctx.chatId, msg, { kb: homeKb_() });
    return;
  }
  var pg = paginate_(configs, page);
  var kb = pg.items.map(function (c) {
    var icon = (s_(c.kind) === 'test') ? '🧪' : '📦';
    return [btn_(icon + ' ' + s_(c.service_name) + ' — ' + configStatusFa_(c), 'U:cfg:' + s_(c.id))];
  });
  kb = kb.concat(pagerRow_('U:my:', pg.page, pg.pages, 'U:menu'));
  var text = '📦 <b>سرویس‌های من</b>\n\nتعداد: <b>' + pg.total + '</b>\nبرای مشاهده جزئیات انتخاب کنید:';
  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

function configStatusFa_(cfg) {
  var exp = parseDate_(cfg.expires_at);
  if (s_(cfg.status) === 'revoked') return '⛔️ باطل‌شده';
  if (exp && exp.getTime() < new Date().getTime()) return '🔴 منقضی';
  return '🟢 فعال';
}

function configById_(id) { return rowByKey_('Configs', 'id', id); }

function configView_(ctx, configId) {
  var cfg = configById_(configId);
  if (!cfg || s_(cfg.user_id) !== ctx.userId) {
    editOrSend_(ctx, '⚠️ سرویس یافت نشد.', backKb_('U:my:1'));
    return;
  }
  var text = (s_(cfg.kind) === 'test' ? '🧪' : '📦') + ' <b>' + esc_(cfg.service_name) + '</b>\n\n' +
    '📌 وضعیت: <b>' + configStatusFa_(cfg) + '</b>\n' +
    '🗓 تاریخ خرید: <b>' + jDate_(cfg.delivered_at) + '</b>\n' +
    '⏳ تاریخ انقضا: <b>' + jDate_(cfg.expires_at) + '</b>\n' +
    '📊 حجم: <b>' + esc_(s_(cfg.volume) || 'نامحدود') + '</b>\n' +
    '🕒 مدت: <b>' + esc_(s_(cfg.duration) || '-') + '</b>\n\n' +
    '🔐 اطلاعات سرویس در پیام بعدی ارسال می‌شود.';
  editOrSend_(ctx, text, [[btn_(b_('back'), 'U:my:1')], [btn_(b_('home'), 'U:menu')]]);
  sendRaw_(ctx.chatId, s_(cfg.config_text));
}

/* ============================= TEST SERVICE ============================ */

function testIntro_(ctx, edit) {
  if (!getBool_('test_enabled', true)) {
    if (edit) editOrSend_(ctx, t_('test_disabled'), homeKb_());
    else send_(ctx.chatId, t_('test_disabled'), { kb: homeKb_() });
    return;
  }
  var hours = getInt_('test_cooldown_hours', 24);
  var text = t_('test_intro', { hours: hours });
  var kb = [[btn_(b_('test_request'), 'U:treq')], [btn_(b_('home'), 'U:menu')]];
  var remain = testCooldownRemain_(ctx.user, hours);
  if (remain) { text = t_('test_cooldown', { remain: remain }); kb = homeKb_(); }
  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

/** Cooldown counts from last SUCCESSFUL delivery only (last_test_at). */
function testCooldownRemain_(user, hours) {
  var last = parseDate_(user.last_test_at);
  if (!last || hours <= 0) return '';
  var passedMs = new Date().getTime() - last.getTime();
  var totalMs = hours * 3600000;
  if (passedMs >= totalMs) return '';
  var leftMin = Math.ceil((totalMs - passedMs) / 60000);
  var h = Math.floor(leftMin / 60), m = leftMin % 60;
  return (h ? h + ' ساعت ' : '') + m + ' دقیقه';
}

function testRequest_(ctx) {
  if (!getBool_('test_enabled', true)) { editOrSend_(ctx, t_('test_disabled'), homeKb_()); return; }
  var hours = getInt_('test_cooldown_hours', 24);
  var user = getUser_(ctx.userId);
  var remain = testCooldownRemain_(user, hours);
  if (remain) { editOrSend_(ctx, t_('test_cooldown', { remain: remain }), homeKb_()); return; }
  var pending = findOne_('Orders', function (r) {
    return s_(r.user_id) === ctx.userId && s_(r.kind) === 'test' && s_(r.status) === 'pending_review';
  });
  if (pending) { editOrSend_(ctx, t_('test_pending'), homeKb_()); return; }

  var id = nextSeq_('Orders');
  appendRow_('Orders', {
    id: id, kind: 'test', user_id: ctx.userId, service_id: '', service_name: 'سرویس تست',
    amount: 0, discount_code: '', discount_amount: 0, final_amount: 0,
    status: 'pending_review', pay_method: 'none', payment_ref: '',
    created_at: nowIso_(), updated_at: nowIso_(), handled_by: '', note: ''
  });
  logInfo_('test_request', ctx.userId, 'درخواست سرویس تست ثبت شد', { order_id: id });
  editOrSend_(ctx, t_('test_requested'), homeKb_());
  notifyAdmins_('🧪 <b>درخواست سرویس تست</b>\n🧾 شماره: <b>#' + id + '</b>\n' +
    '👤 ' + esc_(userLabel_(ctx.user)), [
    [btn_('📤 ارسال کانفیگ تست', 'A:test:dl:' + id)],
    [btn_('❌ رد درخواست', 'A:test:no:' + id)],
    [btn_('👤 پروفایل کاربر', 'A:usr:v:' + ctx.userId)]
  ]);
}

/* ================================ GUIDES =============================== */

function guideList_(ctx, page, edit) {
  var guides = findRows_('Guides', function (r) { return bool_(r.is_active); })
    .sort(function (a, b) { return int_(a.sort_order) - int_(b.sort_order) || int_(a.id) - int_(b.id); });
  if (!guides.length) {
    if (edit) editOrSend_(ctx, t_('guide_empty'), homeKb_());
    else send_(ctx.chatId, t_('guide_empty'), { kb: homeKb_() });
    return;
  }
  var pg = paginate_(guides, page);
  var kb = pg.items.map(function (g) { return [btn_('📖 ' + s_(g.title), 'U:gv:' + s_(g.id))]; });
  kb = kb.concat(pagerRow_('U:guide:', pg.page, pg.pages, 'U:menu'));
  if (edit) editOrSend_(ctx, t_('guide_intro'), kb);
  else send_(ctx.chatId, t_('guide_intro'), { kb: kb });
}

function guideById_(id) { return rowByKey_('Guides', 'id', id); }

function guideView_(ctx, guideId) {
  var g = guideById_(guideId);
  if (!g || !bool_(g.is_active)) { editOrSend_(ctx, '⚠️ راهنما یافت نشد.', backKb_('U:guide:1')); return; }
  var text = '📖 <b>' + esc_(g.title) + '</b>\n\n' + esc_(g.content);
  editOrSend_(ctx, truncate_(text, 3900), [[btn_(b_('back'), 'U:guide:1')], [btn_(b_('home'), 'U:menu')]]);
}

/* =============================== REFERRAL ============================== */

function botUsername_() {
  var cached = prop_('BOT_USERNAME', '');
  if (cached) return cached;
  var me = tgGetMe_();
  if (me && me.ok && me.result && me.result.username) {
    setProp_('BOT_USERNAME', me.result.username);
    return me.result.username;
  }
  return '';
}

function referralView_(ctx, edit) {
  if (!getBool_('referral_enabled', true)) {
    if (edit) editOrSend_(ctx, t_('referral_disabled'), homeKb_());
    else send_(ctx.chatId, t_('referral_disabled'), { kb: homeKb_() });
    return;
  }
  var username = botUsername_();
  var link = username ? ('https://t.me/' + username + '?start=ref' + ctx.userId) : ('کد دعوت شما: ' + ctx.userId);
  var refs = findRows_('Referrals', function (r) { return s_(r.referrer_id) === ctx.userId; });
  var members = uniq_(refs.map(function (r) { return s_(r.referred_id); })).length;
  var income = 0;
  refs.forEach(function (r) { income += num_(r.commission); });
  var text = t_('referral_info', {
    percent: getInt_('referral_percent', 10),
    link: link,
    count: members,
    income: money_(income)
  }) + '\n💰 موجودی کیف پول: <b>' + money_(walletOf_(ctx.userId).balance) + '</b>';
  var kb = [[btn_(b_('wallet'), 'U:wal')], [btn_(b_('home'), 'U:menu')]];
  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

/* ================================ WALLET =============================== */

function walletView_(ctx, edit) {
  if (!getBool_('wallet_enabled', true)) {
    if (edit) editOrSend_(ctx, t_('wallet_disabled'), homeKb_());
    else send_(ctx.chatId, t_('wallet_disabled'), { kb: homeKb_() });
    return;
  }
  var w = walletOf_(ctx.userId);
  var text = t_('wallet_info', {
    balance: money_(w.balance), ref: money_(w.ref_income), spent: money_(w.total_spent)
  });
  var pendingWd = findRows_('Withdrawals', function (r) {
    return s_(r.user_id) === ctx.userId && s_(r.status) === 'pending';
  });
  if (pendingWd.length) text += '\n\n⏳ درخواست برداشت در حال بررسی: <b>' + money_(pendingWd[0].amount) + '</b>';
  var kb = [
    [btn_(b_('wallet_tx'), 'U:wtx:1')],
    [btn_(b_('wallet_withdraw'), 'U:wwd')],
    [btn_(b_('home'), 'U:menu')]
  ];
  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

var TX_TYPE_FA = {
  purchase: '🛒 خرید',
  ref_commission: '👥 پورسانت زیرمجموعه',
  admin_credit: '➕ افزایش توسط مدیر',
  admin_debit: '➖ کاهش توسط مدیر',
  withdraw_hold: '💸 برداشت',
  withdraw_refund: '↩️ بازگشت برداشت',
  refund: '↩️ بازگشت وجه'
};

function txTypeFa_(type) { return TX_TYPE_FA[s_(type)] || s_(type); }

function walletTx_(ctx, page) {
  var txs = findRows_('Transactions', function (r) { return s_(r.user_id) === ctx.userId; })
    .sort(function (a, b) { return int_(b.id) - int_(a.id); });
  if (!txs.length) { editOrSend_(ctx, t_('wallet_empty_tx'), backKb_('U:wal')); return; }
  var pg = paginate_(txs, page, 8);
  var text = '🧾 <b>تراکنش‌های کیف پول</b>\n\n';
  pg.items.forEach(function (tx) {
    var sign = num_(tx.amount) >= 0 ? '➕' : '➖';
    text += sign + ' <b>' + money_(Math.abs(num_(tx.amount))) + '</b> — ' + txTypeFa_(tx.type) + '\n' +
      '   🗓 ' + jDateTime_(tx.created_at) + '\n';
  });
  text += '\nصفحه ' + pg.page + ' از ' + pg.pages;
  var kb = pagerRow_('U:wtx:', pg.page, pg.pages, 'U:wal');
  editOrSend_(ctx, text, kb);
}

function askWithdraw_(ctx) {
  if (!getBool_('wallet_enabled', true)) { editOrSend_(ctx, t_('wallet_disabled'), homeKb_()); return; }
  var w = walletOf_(ctx.userId);
  var min = getInt_('min_withdraw', 50000);
  if (w.balance < min) {
    editOrSend_(ctx, '⚠️ حداقل مبلغ قابل برداشت <b>' + money_(min) + '</b> است.\n' +
      'موجودی فعلی شما: <b>' + money_(w.balance) + '</b>', backKb_('U:wal'));
    return;
  }
  var pending = findOne_('Withdrawals', function (r) {
    return s_(r.user_id) === ctx.userId && s_(r.status) === 'pending';
  });
  if (pending) {
    editOrSend_(ctx, '⏳ یک درخواست برداشت در حال بررسی دارید.', backKb_('U:wal'));
    return;
  }
  setState_(ctx.userId, 'u.wd_amount', {});
  send_(ctx.chatId, t_('withdraw_ask_amount', {
    currency: getSetting_('currency', 'تومان'), min: money_(min)
  }), {});
}

/* ============================ STATE DISPATCH =========================== */

var HINT_CANCEL = '\n\n<i>برای انصراف /cancel را بفرستید.</i>';

function handleState_(ctx, state) {
  var name = s_(state.name);
  if (name.indexOf('a.') === 0 && !ctx.isAdmin) {
    clearState_(ctx.userId);
    sendMenu_(ctx.chatId, t_('unknown'), ctx.userId);
    return;
  }
  if (WIZARDS[name]) { wizardStep_(ctx, state, WIZARDS[name]); return; }

  var text = s_(ctx.msg.text).trim();
  switch (name) {
    /* ---------- user states ---------- */
    case 'u.discount':
      clearState_(ctx.userId);
      applyDiscountToOrder_(ctx, state.data.orderId, text);
      return;
    case 'u.receipt':
      submitReceipt_(ctx, state.data.orderId, ctx.msg);
      return;
    case 'u.wd_amount':
      userWithdrawAmount_(ctx, text);
      return;
    case 'u.wd_dest':
      userWithdrawDest_(ctx, state.data, text);
      return;

    /* ---------- admin states ---------- */
    case 'a.user_search':
      clearState_(ctx.userId);
      adminUserSearch_(ctx, text);
      return;
    case 'a.order_search':
      clearState_(ctx.userId);
      adminOrderSearch_(ctx, text);
      return;
    case 'a.svc_edit':
      clearState_(ctx.userId);
      adminServiceSaveField_(ctx, state.data, text);
      return;
    case 'a.guide_edit':
      clearState_(ctx.userId);
      adminGuideSaveField_(ctx, state.data, text);
      return;
    case 'a.deliver':
      clearState_(ctx.userId);
      adminDeliverConfig_(ctx, state.data.orderId, ctx.msg);
      return;
    case 'a.test_deliver':
      clearState_(ctx.userId);
      adminDeliverTest_(ctx, state.data.orderId, ctx.msg);
      return;
    case 'a.reject':
      clearState_(ctx.userId);
      adminRejectOrder_(ctx, state.data.orderId, text);
      return;
    case 'a.test_reject':
      clearState_(ctx.userId);
      adminRejectTest_(ctx, state.data.orderId, text);
      return;
    case 'a.wd_reject':
      clearState_(ctx.userId);
      adminWithdrawReject_(ctx, state.data.id, text);
      return;
    case 'a.set':
      clearState_(ctx.userId);
      adminSaveSetting_(ctx, state.data.key, text);
      return;
    case 'a.txt':
      clearState_(ctx.userId);
      adminSaveText_(ctx, state.data.key, ctx.msg.text);
      return;
    case 'a.btn':
      clearState_(ctx.userId);
      adminSaveButton_(ctx, state.data.key, text);
      return;
    case 'a.bal':
      clearState_(ctx.userId);
      adminAdjustBalance_(ctx, state.data.userId, text);
      return;
    case 'a.admin_add':
      clearState_(ctx.userId);
      adminAddAdmin_(ctx, text);
      return;
    case 'a.broadcast':
      adminBroadcastPreview_(ctx, ctx.msg);
      return;
    default:
      clearState_(ctx.userId);
      sendMenu_(ctx.chatId, t_('unknown'), ctx.userId);
  }
}

/* ============================ WIZARD ENGINE ============================ */

function wizardStart_(ctx, name, seed) {
  var spec = WIZARDS[name];
  if (!spec) return;
  setState_(ctx.userId, name, { step: 0, values: seed || {} });
  send_(ctx.chatId, '📝 <b>' + spec.title + '</b>\n\n' + spec.steps[0].prompt + HINT_CANCEL, {});
}

function wizardStep_(ctx, state, spec) {
  var data = state.data || {};
  if (!data.values) data.values = {};
  var idx = int_(data.step);
  var step = spec.steps[idx];
  if (!step) { clearState_(ctx.userId); sendMenu_(ctx.chatId, t_('cancelled'), ctx.userId); return; }

  var text = s_(ctx.msg.text).trim();
  if (step.optional && (text === '-' || text === '' || text === 'خالی')) text = '';
  else if (!text) { send_(ctx.chatId, '⚠️ لطفاً یک مقدار متنی ارسال کنید.' + HINT_CANCEL, {}); return; }

  if (step.type === 'number' && text !== '' && num_(text) < 0) {
    send_(ctx.chatId, '⚠️ عدد نامعتبر است. یک عدد صحیح ارسال کنید.' + HINT_CANCEL, {});
    return;
  }
  if (step.type === 'choice' && step.choices.indexOf(text) === -1) {
    send_(ctx.chatId, '⚠️ فقط یکی از این مقادیر مجاز است: ' + step.choices.join(' یا ') + HINT_CANCEL, {});
    return;
  }
  data.values[step.field] = (step.type === 'number' && text !== '') ? num_(text) : text;

  idx++;
  if (idx < spec.steps.length) {
    data.step = idx;
    setState_(ctx.userId, state.name, data);
    send_(ctx.chatId, spec.steps[idx].prompt + HINT_CANCEL, {});
    return;
  }
  clearState_(ctx.userId);
  spec.done(ctx, data.values);
}

var WIZARDS = {
  'a.svc_add': {
    title: 'افزودن سرویس جدید',
    steps: [
      { field: 'name', prompt: '1️⃣ نام سرویس را ارسال کنید:' },
      { field: 'description', prompt: '2️⃣ توضیحات سرویس را ارسال کنید (برای خالی گذاشتن «-»):', optional: true },
      { field: 'volume', prompt: '3️⃣ حجم سرویس را ارسال کنید (مثلاً ۵۰ گیگابایت):' },
      { field: 'duration', prompt: '4️⃣ مدت زمان را ارسال کنید (مثلاً ۳۰ روزه):' },
      { field: 'price', prompt: '5️⃣ قیمت را به عدد ارسال کنید:', type: 'number' },
      { field: 'sort_order', prompt: '6️⃣ ترتیب نمایش را به عدد ارسال کنید:', type: 'number' }
    ],
    done: function (ctx, v) {
      var id = nextSeq_('Services');
      appendRow_('Services', {
        id: id, name: v.name, description: v.description, volume: v.volume,
        duration: v.duration, price: num_(v.price), is_active: '1',
        sort_order: int_(v.sort_order), created_at: nowIso_()
      });
      logInfo_('admin_service_add', ctx.userId, 'سرویس جدید ایجاد شد', { id: id, name: v.name });
      send_(ctx.chatId, '✅ سرویس <b>' + esc_(v.name) + '</b> با شماره <b>' + id + '</b> ساخته و فعال شد.', {
        kb: [[btn_('👁 مشاهده سرویس', 'A:svc:v:' + id)], [btn_('🛒 مدیریت سرویس‌ها', 'A:svc')]]
      });
    }
  },
  'a.guide_add': {
    title: 'افزودن راهنما',
    steps: [
      { field: 'title', prompt: '1️⃣ عنوان راهنما را ارسال کنید:' },
      { field: 'content', prompt: '2️⃣ متن کامل راهنما را ارسال کنید:' },
      { field: 'sort_order', prompt: '3️⃣ ترتیب نمایش را به عدد ارسال کنید:', type: 'number' }
    ],
    done: function (ctx, v) {
      var id = nextSeq_('Guides');
      appendRow_('Guides', {
        id: id, title: v.title, content: v.content, sort_order: int_(v.sort_order),
        is_active: '1', created_at: nowIso_()
      });
      logInfo_('admin_guide_add', ctx.userId, 'راهنمای جدید ایجاد شد', { id: id });
      send_(ctx.chatId, '✅ راهنمای <b>' + esc_(v.title) + '</b> ثبت و فعال شد.', {
        kb: [[btn_('📖 مدیریت راهنماها', 'A:guide')]]
      });
    }
  },
  'a.disc_add': {
    title: 'ساخت کد تخفیف',
    steps: [
      { field: 'code', prompt: '1️⃣ کد تخفیف را ارسال کنید (انگلیسی/عدد، مثلاً NEXI20):' },
      { field: 'kind', prompt: '2️⃣ نوع تخفیف: کلمه «percent» برای درصدی یا «fixed» برای مبلغ ثابت:', type: 'choice', choices: ['percent', 'fixed'] },
      { field: 'value', prompt: '3️⃣ مقدار تخفیف را به عدد ارسال کنید (درصد یا مبلغ):', type: 'number' },
      { field: 'usage_limit', prompt: '4️⃣ سقف تعداد استفاده را به عدد ارسال کنید (۰ = بی‌نهایت):', type: 'number' },
      { field: 'expires_at', prompt: '5️⃣ تاریخ انقضا به شکل YYYY-MM-DD میلادی (برای بدون انقضا «-»):', optional: true }
    ],
    done: function (ctx, v) {
      var code = s_(v.code).trim().toUpperCase();
      if (discountByCode_(code)) {
        send_(ctx.chatId, '⚠️ این کد از قبل وجود دارد. کد دیگری انتخاب کنید.', { kb: [[btn_('🎟 کدهای تخفیف', 'A:disc')]] });
        return;
      }
      appendRow_('Discounts', {
        code: code, kind: v.kind, value: num_(v.value), usage_limit: int_(v.usage_limit),
        used_count: 0, expires_at: s_(v.expires_at), is_active: '1',
        created_at: nowIso_(), note: 'ساخته‌شده توسط ' + ctx.userId
      });
      logInfo_('admin_discount_add', ctx.userId, 'کد تخفیف ساخته شد', { code: code });
      send_(ctx.chatId, '✅ کد تخفیف <code>' + esc_(code) + '</code> ساخته و فعال شد.', {
        kb: [[btn_('🎟 کدهای تخفیف', 'A:disc')]]
      });
    }
  },
  'a.ch_add': {
    title: 'افزودن کانال اجباری',
    steps: [
      { field: 'title', prompt: '1️⃣ نام نمایشی کانال را ارسال کنید:' },
      { field: 'username', prompt: '2️⃣ یوزرنیم کانال را بدون @ ارسال کنید (برای کانال خصوصی «-»):', optional: true },
      { field: 'chat_id', prompt: '3️⃣ شناسه عددی کانال را ارسال کنید (مثل -1001234567890، اگر ندارید «-»):', optional: true }
    ],
    done: function (ctx, v) {
      if (!s_(v.username) && !s_(v.chat_id)) {
        send_(ctx.chatId, '⚠️ حداقل یکی از یوزرنیم یا شناسه عددی لازم است.', { kb: [[btn_('📢 کانال اجباری', 'A:ch')]] });
        return;
      }
      var id = nextSeq_('Channels');
      appendRow_('Channels', {
        id: id, title: v.title, username: s_(v.username).replace('@', ''), chat_id: s_(v.chat_id),
        is_required: '1', is_active: '1', created_at: nowIso_()
      });
      logInfo_('admin_channel_add', ctx.userId, 'کانال اجباری اضافه شد', { id: id });
      send_(ctx.chatId, '✅ کانال <b>' + esc_(v.title) + '</b> اضافه شد.\n' +
        '⚠️ ربات باید در کانال ادمین باشد تا بتواند عضویت را بررسی کند.', {
        kb: [[btn_('📢 کانال اجباری', 'A:ch')]]
      });
    }
  }
};

/* ======================= USER WITHDRAWAL STATE ========================= */

function userWithdrawAmount_(ctx, text) {
  var amount = int_(text);
  var min = getInt_('min_withdraw', 50000);
  var balance = walletOf_(ctx.userId).balance;
  if (amount <= 0) { send_(ctx.chatId, '⚠️ مبلغ نامعتبر است. فقط عدد ارسال کنید.' + HINT_CANCEL, {}); return; }
  if (amount < min) { send_(ctx.chatId, '⚠️ حداقل مبلغ برداشت <b>' + money_(min) + '</b> است.' + HINT_CANCEL, {}); return; }
  if (amount > balance) {
    send_(ctx.chatId, t_('insufficient_balance') + '\n💳 موجودی: <b>' + money_(balance) + '</b>' + HINT_CANCEL, {});
    return;
  }
  setState_(ctx.userId, 'u.wd_dest', { amount: amount });
  send_(ctx.chatId, t_('withdraw_ask_dest') + HINT_CANCEL, {});
}

function userWithdrawDest_(ctx, data, text) {
  var amount = int_(data.amount);
  var dest = s_(text).trim();
  if (dest.length < 8) { send_(ctx.chatId, '⚠️ شماره کارت یا شبا نامعتبر است.' + HINT_CANCEL, {}); return; }
  var balance = walletOf_(ctx.userId).balance;
  if (amount <= 0 || amount > balance) {
    clearState_(ctx.userId);
    sendMenu_(ctx.chatId, t_('insufficient_balance'), ctx.userId);
    return;
  }
  var id = nextSeq_('Withdrawals');
  changeBalance_(ctx.userId, -amount, 'withdraw_hold', 'درخواست برداشت #' + id, s_(id));
  appendRow_('Withdrawals', {
    id: id, user_id: ctx.userId, amount: amount, dest: dest, status: 'pending',
    created_at: nowIso_(), processed_at: '', handled_by: '', note: ''
  });
  clearState_(ctx.userId);
  sendMenu_(ctx.chatId, t_('withdraw_saved') + '\n\n🧾 شماره درخواست: <b>#' + id + '</b>\n' +
    '💸 مبلغ: <b>' + money_(amount) + '</b>', ctx.userId);
  logInfo_('withdraw_request', ctx.userId, 'درخواست برداشت ثبت شد', { id: id, amount: amount });
  notifyAdmins_('💸 <b>درخواست برداشت جدید</b>\n' +
    '🧾 شماره: <b>#' + id + '</b>\n💰 مبلغ: <b>' + money_(amount) + '</b>\n' +
    '🏦 مقصد: <code>' + esc_(dest) + '</code>\n👤 ' + esc_(userLabel_(ctx.user)), [
    [btn_('✅ تأیید و واریز', 'A:wd:ok:' + id), btn_('❌ رد', 'A:wd:no:' + id)],
    [btn_('💸 مدیریت برداشت‌ها', 'A:wd')]
  ]);
}

/* ============================== ADMIN ROUTER =========================== */

function routeAdmin_(ctx, p) {
  var section = p[1] || '';
  var a = p[2] || '';
  var b = p[3] || '';
  var c = p[4] || '';

  switch (section) {
    case '': case 'home': adminHome_(ctx, true); return;
    case 'health': adminHealth_(ctx); return;

    case 'usr':
      if (a === 's') { setState_(ctx.userId, 'a.user_search', {}); send_(ctx.chatId, '🔎 شناسه عددی، یوزرنیم یا نام کاربر را ارسال کنید:' + HINT_CANCEL, {}); return; }
      if (a === 'l') { adminUserList_(ctx, int_(b) || 1); return; }
      if (a === 'v') { adminUserView_(ctx, b); return; }
      if (a === 'svc') { adminUserServices_(ctx, b); return; }
      if (a === 'ord') { adminUserOrders_(ctx, b); return; }
      if (a === 'wal') { adminUserWallet_(ctx, b); return; }
      if (a === 'ref') { adminUserReferrals_(ctx, b); return; }
      if (a === 'blk') { adminToggleBlock_(ctx, b); return; }
      if (a === 'bal') {
        setState_(ctx.userId, 'a.bal', { userId: b });
        send_(ctx.chatId, '💰 مبلغ تغییر موجودی را ارسال کنید.\n' +
          'عدد مثبت برای افزایش و عدد منفی برای کاهش (مثلاً 50000 یا -20000):' + HINT_CANCEL, {});
        return;
      }
      adminUsersMenu_(ctx); return;

    case 'svc':
      if (a === 'add') { wizardStart_(ctx, 'a.svc_add', {}); return; }
      if (a === 'l') { adminServiceList_(ctx, int_(b) || 1); return; }
      if (a === 'v') { adminServiceView_(ctx, b); return; }
      if (a === 't') { adminServiceToggle_(ctx, b); return; }
      if (a === 'del') { adminConfirmDelete_(ctx, 'سرویس', 'A:svc:delc:' + b, 'A:svc:v:' + b); return; }
      if (a === 'delc') { adminServiceDelete_(ctx, b); return; }
      if (a === 'e') { adminServiceEditAsk_(ctx, b, c); return; }
      adminServiceList_(ctx, 1); return;

    case 'disc':
      if (a === 'add') { wizardStart_(ctx, 'a.disc_add', {}); return; }
      if (a === 'v') { adminDiscountView_(ctx, b); return; }
      if (a === 't') { adminDiscountToggle_(ctx, b); return; }
      if (a === 'del') { adminConfirmDelete_(ctx, 'کد تخفیف', 'A:disc:delc:' + b, 'A:disc:v:' + b); return; }
      if (a === 'delc') { adminDiscountDelete_(ctx, b); return; }
      adminDiscountList_(ctx, int_(b) || 1); return;

    case 'ord':
      if (a === 'l') { adminOrderList_(ctx, b || 'all', int_(c) || 1); return; }
      if (a === 'v') { adminOrderView_(ctx, b); return; }
      if (a === 'ok') { adminApproveOrder_(ctx, b); return; }
      if (a === 'no') {
        setState_(ctx.userId, 'a.reject', { orderId: b });
        send_(ctx.chatId, '✍️ دلیل رد پرداخت را ارسال کنید (برای بدون دلیل «-»):' + HINT_CANCEL, {});
        return;
      }
      if (a === 'cn') { adminCancelOrder_(ctx, b); return; }
      if (a === 'dl') { adminAskConfig_(ctx, b); return; }
      if (a === 'rc') { adminShowReceipt_(ctx, b); return; }
      if (a === 's') {
        setState_(ctx.userId, 'a.order_search', {});
        send_(ctx.chatId, '🔎 شماره سفارش یا شناسه کاربر را ارسال کنید:' + HINT_CANCEL, {});
        return;
      }
      adminOrdersMenu_(ctx); return;

    case 'pay': adminPaymentsMenu_(ctx); return;

    case 'test':
      if (a === 'l') { adminTestList_(ctx, int_(b) || 1); return; }
      if (a === 'v') { adminTestView_(ctx, b); return; }
      if (a === 'dl') { adminAskTestConfig_(ctx, b); return; }
      if (a === 'no') {
        setState_(ctx.userId, 'a.test_reject', { orderId: b });
        send_(ctx.chatId, '✍️ دلیل رد درخواست تست را ارسال کنید (برای بدون دلیل «-»):' + HINT_CANCEL, {});
        return;
      }
      if (a === 'rst') { adminResetTestCooldown_(ctx, b); return; }
      adminTestMenu_(ctx); return;

    case 'guide':
      if (a === 'add') { wizardStart_(ctx, 'a.guide_add', {}); return; }
      if (a === 'v') { adminGuideView_(ctx, b); return; }
      if (a === 't') { adminGuideToggle_(ctx, b); return; }
      if (a === 'e') { adminGuideEditAsk_(ctx, b, c); return; }
      if (a === 'del') { adminConfirmDelete_(ctx, 'راهنما', 'A:guide:delc:' + b, 'A:guide:v:' + b); return; }
      if (a === 'delc') { adminGuideDelete_(ctx, b); return; }
      adminGuideList_(ctx, int_(b) || 1); return;

    case 'ch':
      if (a === 'add') { wizardStart_(ctx, 'a.ch_add', {}); return; }
      if (a === 't') { adminChannelToggle_(ctx, b); return; }
      if (a === 'del') { adminConfirmDelete_(ctx, 'کانال', 'A:ch:delc:' + b, 'A:ch'); return; }
      if (a === 'delc') { adminChannelDelete_(ctx, b); return; }
      adminChannelsMenu_(ctx); return;

    case 'ref': adminReferralMenu_(ctx); return;

    case 'wal':
      if (a === 'tx') { adminWalletTx_(ctx, int_(b) || 1); return; }
      if (a === 'top') { adminWalletTop_(ctx); return; }
      adminWalletMenu_(ctx); return;

    case 'wd':
      if (a === 'l') { adminWithdrawList_(ctx, b || 'pending', int_(c) || 1); return; }
      if (a === 'v') { adminWithdrawView_(ctx, b); return; }
      if (a === 'ok') { adminWithdrawApprove_(ctx, b); return; }
      if (a === 'no') {
        setState_(ctx.userId, 'a.wd_reject', { id: b });
        send_(ctx.chatId, '✍️ دلیل رد درخواست برداشت را ارسال کنید (برای بدون دلیل «-»):' + HINT_CANCEL, {});
        return;
      }
      adminWithdrawList_(ctx, 'pending', 1); return;

    case 'bc':
      if (a === 'new') {
        setState_(ctx.userId, 'a.broadcast', {});
        send_(ctx.chatId, '📣 <b>ارسال همگانی</b>\n\nمتن پیام را ارسال کنید.\n' +
          'قالب‌بندی تلگرام (<b>bold</b>، <i>italic</i>، <code>code</code>) پشتیبانی می‌شود.' + HINT_CANCEL, {});
        return;
      }
      if (a === 'go') { adminBroadcastRun_(ctx, false); return; }
      if (a === 'cont') { adminBroadcastRun_(ctx, true); return; }
      adminBroadcastMenu_(ctx); return;

    case 'set':
      if (a === 'e') { adminSettingAsk_(ctx, b); return; }
      if (a === 't') { adminSettingToggle_(ctx, b); return; }
      adminSettingsMenu_(ctx, int_(b) || 1); return;

    case 'txt':
      if (a === 'l') { adminTextList_(ctx, int_(b) || 1); return; }
      if (a === 'e') { adminTextAsk_(ctx, b); return; }
      if (a === 'r') { adminTextReset_(ctx, b); return; }
      adminContentMenu_(ctx); return;

    case 'btn':
      if (a === 'l') { adminButtonList_(ctx, int_(b) || 1); return; }
      if (a === 'e') { adminButtonAsk_(ctx, b); return; }
      if (a === 'r') { adminButtonReset_(ctx, b); return; }
      adminButtonList_(ctx, 1); return;

    case 'adm':
      if (a === 'add') {
        setState_(ctx.userId, 'a.admin_add', {});
        send_(ctx.chatId, '👮 شناسه عددی مدیر جدید را ارسال کنید:' + HINT_CANCEL, {});
        return;
      }
      if (a === 'del') { adminRemoveAdmin_(ctx, b); return; }
      adminAdminsMenu_(ctx); return;

    case 'sys':
      if (a === 'repair') { adminRunRepair_(ctx); return; }
      if (a === 'hc') { adminRunHealthCheck_(ctx); return; }
      if (a === 'test') { adminRunSelfTest_(ctx); return; }
      if (a === 'wh') { adminWebhookInfo_(ctx); return; }
      if (a === 'setwh') { adminSetWebhook_(ctx); return; }
      if (a === 'delwh') { adminDeleteWebhook_(ctx); return; }
      if (a === 'clr') { adminClearStates_(ctx); return; }
      if (a === 'logs') { adminTrimLogs_(ctx); return; }
      adminSystemMenu_(ctx); return;

    default:
      adminHome_(ctx, true);
  }
}

/* =============================== ADMIN HOME ============================ */

function adminHomeKb_() {
  return [
    [btn_('🩺 سلامت سیستم', 'A:health'), btn_('👥 کاربران', 'A:usr')],
    [btn_('🛒 سرویس‌ها', 'A:svc'), btn_('📦 سفارش‌ها', 'A:ord')],
    [btn_('💳 پرداخت‌ها', 'A:pay'), btn_('🧪 سرویس تست', 'A:test')],
    [btn_('📖 راهنماها', 'A:guide'), btn_('📢 کانال اجباری', 'A:ch')],
    [btn_('👥 زیرمجموعه‌ها', 'A:ref'), btn_('💰 کیف پول', 'A:wal')],
    [btn_('💸 برداشت‌ها', 'A:wd'), btn_('📣 ارسال همگانی', 'A:bc')],
    [btn_('⚙️ تنظیمات', 'A:set'), btn_('📝 متن‌ها و دکمه‌ها', 'A:txt')],
    [btn_('👮 مدیران', 'A:adm'), btn_('🔧 ابزارهای سیستم', 'A:sys')]
  ];
}

function adminHome_(ctx, edit) {
  /* All four counters come from a SINGLE pass over the (already cached)
   * Orders table instead of three separate full scans. */
  var pendingPay = 0, pendingDeliver = 0, pendingTest = 0;
  allRows_('Orders').forEach(function (r) {
    var kind = s_(r.kind), status = s_(r.status);
    if (kind === 'purchase' && status === 'pending_review') pendingPay++;
    else if (kind === 'purchase' && status === 'paid') pendingDeliver++;
    else if (kind === 'test' && status === 'pending_review') pendingTest++;
  });
  var pendingWd = findRows_('Withdrawals', function (r) { return s_(r.status) === 'pending'; }).length;

  var text = '🛠 <b>پنل مدیریت ' + esc_(getSetting_('bot_title', APP_TITLE)) + '</b>\n' +
    '<i>نسخه ' + APP_VERSION + ' | بیلد ' + BUILD_VERSION + '</i>\n\n' +
    '👥 کاربران: <b>' + countRows_('Users') + '</b>\n' +
    '🛒 سرویس‌های فعال: <b>' + activeServices_().length + '</b>\n' +
    '📦 کل سفارش‌ها: <b>' + countRows_('Orders') + '</b>\n\n' +
    '<b>کارهای در انتظار شما:</b>\n' +
    '💳 بررسی پرداخت: <b>' + pendingPay + '</b>\n' +
    '🎁 تحویل کانفیگ: <b>' + pendingDeliver + '</b>\n' +
    '🧪 درخواست تست: <b>' + pendingTest + '</b>\n' +
    '💸 درخواست برداشت: <b>' + pendingWd + '</b>' +
    (getBool_('maintenance', false) ? '\n\n🛠 <b>حالت تعمیر فعال است.</b>' : '');

  if (edit) editOrSend_(ctx, text, adminHomeKb_());
  else send_(ctx.chatId, text, { kb: adminHomeKb_() });
}

function adminBackKb_(extraRows, backData) {
  var rows = (extraRows || []).slice();
  rows.push([btn_(b_('back'), backData || 'A:home')]);
  return rows;
}

function adminConfirmDelete_(ctx, label, confirmData, backData) {
  editOrSend_(ctx, '⚠️ <b>حذف ' + esc_(label) + '</b>\n\nاین عملیات قابل بازگشت نیست. مطمئن هستید؟', [
    [btn_('🗑 بله، حذف کن', confirmData)],
    [btn_('انصراف', backData)]
  ]);
}

/* ============================ ADMIN · USERS ============================ */

function adminUsersMenu_(ctx) {
  var users = allRows_('Users');
  var blocked = users.filter(function (u) { return bool_(u.is_blocked); }).length;
  var text = '👥 <b>مدیریت کاربران</b>\n\n' +
    '📊 کل کاربران: <b>' + users.length + '</b>\n' +
    '⛔️ مسدود: <b>' + blocked + '</b>\n' +
    '👮 مدیران: <b>' + allAdminIds_().length + '</b>';
  editOrSend_(ctx, text, adminBackKb_([
    [btn_('🔎 جستجوی کاربر', 'A:usr:s')],
    [btn_('📋 آخرین کاربران', 'A:usr:l:1')]
  ]));
}

function adminUserList_(ctx, page) {
  var users = allRows_('Users').sort(function (a, b) { return int_(b.__row) - int_(a.__row); });
  if (!users.length) { editOrSend_(ctx, 'کاربری ثبت نشده است.', adminBackKb_([], 'A:usr')); return; }
  var pg = paginate_(users, page, 8);
  var kb = pg.items.map(function (u) {
    return [btn_((bool_(u.is_blocked) ? '⛔️ ' : '👤 ') + truncate_(userName_(u), 25) + ' | ' + s_(u.user_id), 'A:usr:v:' + s_(u.user_id))];
  });
  kb = kb.concat(pagerRow_('A:usr:l:', pg.page, pg.pages, 'A:usr'));
  editOrSend_(ctx, '📋 <b>آخرین کاربران</b> (' + pg.total + ' نفر)', kb);
}

function adminUserSearch_(ctx, query) {
  var q = s_(query).trim().replace('@', '').toLowerCase();
  if (!q) { send_(ctx.chatId, '⚠️ عبارت جستجو خالی بود.', { kb: adminBackKb_([], 'A:usr') }); return; }
  var found = findRows_('Users', function (u) {
    return s_(u.user_id) === q ||
      s_(u.username).toLowerCase().indexOf(q) !== -1 ||
      (s_(u.first_name) + ' ' + s_(u.last_name)).toLowerCase().indexOf(q) !== -1;
  });
  if (!found.length) { send_(ctx.chatId, '❌ کاربری پیدا نشد.', { kb: adminBackKb_([], 'A:usr') }); return; }
  if (found.length === 1) {
    adminUserCard_(ctx, found[0], false);
    return;
  }
  var kb = found.slice(0, 10).map(function (u) {
    return [btn_('👤 ' + truncate_(userName_(u), 25) + ' | ' + s_(u.user_id), 'A:usr:v:' + s_(u.user_id))];
  });
  kb.push([btn_(b_('back'), 'A:usr')]);
  send_(ctx.chatId, '🔎 <b>' + found.length + ' نتیجه پیدا شد:</b>', { kb: kb });
}

function adminUserView_(ctx, userId) {
  var user = getUser_(userId);
  if (!user) { editOrSend_(ctx, '❌ کاربر یافت نشد.', adminBackKb_([], 'A:usr')); return; }
  adminUserCard_(ctx, user, true);
}

function adminUserCard_(ctx, user, edit) {
  var w = walletOf_(user.user_id);
  var orders = findRows_('Orders', function (r) { return s_(r.user_id) === s_(user.user_id); });
  var configs = findRows_('Configs', function (r) { return s_(r.user_id) === s_(user.user_id); });
  var refs = findRows_('Referrals', function (r) { return s_(r.referrer_id) === s_(user.user_id) && num_(r.commission) > 0; });
  var text = '👤 <b>پروفایل کاربر</b>\n\n' +
    '🆔 شناسه: <code>' + esc_(user.user_id) + '</code>\n' +
    '📛 نام: <b>' + esc_(userName_(user)) + '</b>\n' +
    '🔗 یوزرنیم: ' + (s_(user.username) ? '@' + esc_(user.username) : '—') + '\n' +
    '🗓 عضویت: ' + jDateTime_(user.joined_at) + '\n' +
    '👁 آخرین فعالیت: ' + jDateTime_(user.last_seen) + '\n' +
    '📌 وضعیت: <b>' + (bool_(user.is_blocked) ? '⛔️ مسدود' : '✅ فعال') + '</b>\n' +
    (isAdmin_(user.user_id) ? '👮 <b>این کاربر مدیر است.</b>\n' : '') +
    '\n💳 موجودی: <b>' + money_(w.balance) + '</b>\n' +
    '👥 زیرمجموعه: <b>' + int_(user.ref_count) + '</b> نفر (پورسانت: ' + money_(w.ref_income) + ')\n' +
    '🎯 معرف: ' + (s_(user.ref_by) ? '<code>' + esc_(user.ref_by) + '</code>' : '—') + '\n' +
    '📦 سفارش‌ها: <b>' + orders.length + '</b> | سرویس‌ها: <b>' + configs.length + '</b>\n' +
    '🧪 آخرین تست: ' + (s_(user.last_test_at) ? jDateTime_(user.last_test_at) : '—');
  var uid = s_(user.user_id);
  var kb = [
    [btn_('📦 سرویس‌ها', 'A:usr:svc:' + uid), btn_('🧾 سفارش‌ها', 'A:usr:ord:' + uid)],
    [btn_('💰 کیف پول', 'A:usr:wal:' + uid), btn_('👥 زیرمجموعه‌ها', 'A:usr:ref:' + uid)],
    [btn_('➕➖ تغییر موجودی', 'A:usr:bal:' + uid)],
    [btn_(bool_(user.is_blocked) ? '✅ رفع مسدودی' : '⛔️ مسدود کردن', 'A:usr:blk:' + uid)],
    [btn_('🧪 صفر کردن محدودیت تست', 'A:test:rst:' + uid)],
    [btn_(b_('back'), 'A:usr')]
  ];
  if (edit) editOrSend_(ctx, text, kb);
  else send_(ctx.chatId, text, { kb: kb });
}

function adminUserServices_(ctx, userId) {
  var configs = findRows_('Configs', function (r) { return s_(r.user_id) === s_(userId); })
    .sort(function (a, b) { return int_(b.id) - int_(a.id); });
  var text = '📦 <b>سرویس‌های کاربر</b> <code>' + esc_(userId) + '</code>\n\n';
  if (!configs.length) text += 'سرویسی ثبت نشده است.';
  configs.slice(0, 15).forEach(function (c) {
    text += (s_(c.kind) === 'test' ? '🧪' : '📦') + ' <b>' + esc_(c.service_name) + '</b> — ' + configStatusFa_(c) + '\n' +
      '   🗓 ' + jDate_(c.delivered_at) + ' → ' + jDate_(c.expires_at) + '\n' +
      '   <code>' + esc_(truncate_(s_(c.config_text), 90)) + '</code>\n';
  });
  editOrSend_(ctx, truncate_(text, 3900), adminBackKb_([], 'A:usr:v:' + userId));
}

function adminUserOrders_(ctx, userId) {
  var orders = findRows_('Orders', function (r) { return s_(r.user_id) === s_(userId); })
    .sort(function (a, b) { return int_(b.id) - int_(a.id); });
  var text = '🧾 <b>سفارش‌های کاربر</b> <code>' + esc_(userId) + '</code>\n\n';
  if (!orders.length) text += 'سفارشی ثبت نشده است.';
  var kb = [];
  orders.slice(0, 10).forEach(function (o) {
    text += orderCode_(o) + ' — ' + esc_(o.service_name) + ' — ' + money_(o.final_amount) + '\n' +
      '   ' + orderStatusFa_(o.status) + ' | ' + jDateTime_(o.created_at) + '\n';
    kb.push([btn_('🧾 سفارش ' + orderCode_(o), 'A:ord:v:' + s_(o.id))]);
  });
  kb = kb.slice(0, 6);
  kb.push([btn_(b_('back'), 'A:usr:v:' + userId)]);
  editOrSend_(ctx, truncate_(text, 3900), kb);
}

function adminUserWallet_(ctx, userId) {
  var w = walletOf_(userId);
  var txs = findRows_('Transactions', function (r) { return s_(r.user_id) === s_(userId); })
    .sort(function (a, b) { return int_(b.id) - int_(a.id); }).slice(0, 10);
  var text = '💰 <b>کیف پول کاربر</b> <code>' + esc_(userId) + '</code>\n\n' +
    '💳 موجودی: <b>' + money_(w.balance) + '</b>\n' +
    '⬆️ کل شارژ: <b>' + money_(w.total_charged) + '</b>\n' +
    '⬇️ کل خرید: <b>' + money_(w.total_spent) + '</b>\n' +
    '👥 پورسانت: <b>' + money_(w.ref_income) + '</b>\n\n<b>آخرین تراکنش‌ها:</b>\n';
  if (!txs.length) text += 'تراکنشی ثبت نشده است.';
  txs.forEach(function (tx) {
    text += (num_(tx.amount) >= 0 ? '➕' : '➖') + ' ' + money_(Math.abs(num_(tx.amount))) +
      ' — ' + txTypeFa_(tx.type) + ' — ' + jDateTime_(tx.created_at) + '\n';
  });
  editOrSend_(ctx, truncate_(text, 3900), adminBackKb_([
    [btn_('➕➖ تغییر موجودی', 'A:usr:bal:' + userId)]
  ], 'A:usr:v:' + userId));
}

function adminUserReferrals_(ctx, userId) {
  var refs = findRows_('Referrals', function (r) { return s_(r.referrer_id) === s_(userId); });
  var members = uniq_(refs.map(function (r) { return s_(r.referred_id); }));
  var income = 0;
  refs.forEach(function (r) { income += num_(r.commission); });
  var text = '👥 <b>زیرمجموعه‌های کاربر</b> <code>' + esc_(userId) + '</code>\n\n' +
    '👤 تعداد: <b>' + members.length + '</b>\n💵 پورسانت پرداخت‌شده: <b>' + money_(income) + '</b>\n\n';
  members.slice(0, 20).forEach(function (m) {
    var u = getUser_(m);
    text += '• <code>' + esc_(m) + '</code> — ' + esc_(u ? userName_(u) : 'نامشخص') + '\n';
  });
  editOrSend_(ctx, truncate_(text, 3900), adminBackKb_([], 'A:usr:v:' + userId));
}

function adminToggleBlock_(ctx, userId) {
  var user = getUser_(userId);
  if (!user) { editOrSend_(ctx, '❌ کاربر یافت نشد.', adminBackKb_([], 'A:usr')); return; }
  if (isAdmin_(userId)) { editOrSend_(ctx, '⚠️ مدیران را نمی‌توان مسدود کرد.', adminBackKb_([], 'A:usr:v:' + userId)); return; }
  var blocked = !bool_(user.is_blocked);
  patchRow_('Users', user.__row, { is_blocked: blocked ? '1' : '0' });
  logInfo_('admin_block', ctx.userId, (blocked ? 'کاربر مسدود شد' : 'مسدودی کاربر رفع شد'), { target: s_(userId) });
  var fresh = getUser_(userId);
  adminUserCard_(ctx, fresh, true);
  if (!blocked) tgSendMessage_(userId, '✅ دسترسی شما به ربات دوباره فعال شد. /start', {});
}

function adminAdjustBalance_(ctx, userId, text) {
  var user = getUser_(userId);
  if (!user) { send_(ctx.chatId, '❌ کاربر یافت نشد.', { kb: adminBackKb_([], 'A:usr') }); return; }
  var amount = int_(text);
  if (!amount) { send_(ctx.chatId, '⚠️ مبلغ نامعتبر بود. عملیات انجام نشد.', { kb: adminBackKb_([], 'A:usr:v:' + userId) }); return; }
  var balance = changeBalance_(userId, amount, amount > 0 ? 'admin_credit' : 'admin_debit',
    'تغییر موجودی توسط مدیر ' + ctx.userId, '');
  logInfo_('admin_balance', ctx.userId, 'موجودی کاربر تغییر کرد', { target: s_(userId), amount: amount });
  send_(ctx.chatId, '✅ موجودی کاربر <code>' + esc_(userId) + '</code> تغییر کرد.\n' +
    'مبلغ: <b>' + money_(amount) + '</b>\nموجودی جدید: <b>' + money_(balance) + '</b>', {
    kb: adminBackKb_([], 'A:usr:v:' + userId)
  });
  tgSendMessage_(userId, (amount > 0 ? '➕ مبلغ <b>' + money_(amount) + '</b> به کیف پول شما اضافه شد.' :
    '➖ مبلغ <b>' + money_(Math.abs(amount)) + '</b> از کیف پول شما کسر شد.') +
    '\n💳 موجودی فعلی: <b>' + money_(balance) + '</b>', {});
}

/* =========================== ADMIN · SERVICES ========================== */

function adminServiceList_(ctx, page) {
  var services = allRows_('Services').sort(function (a, b) {
    return int_(a.sort_order) - int_(b.sort_order) || int_(a.id) - int_(b.id);
  });
  var kb = [];
  var pg = paginate_(services, page, 8);
  pg.items.forEach(function (svc) {
    kb.push([btn_((bool_(svc.is_active) ? '🟢 ' : '🔴 ') + s_(svc.name) + ' — ' + money_(svc.price), 'A:svc:v:' + s_(svc.id))]);
  });
  kb = kb.concat(pagerRow_('A:svc:l:', pg.page, pg.pages, 'A:home'));
  kb.unshift([btn_('➕ افزودن سرویس', 'A:svc:add'), btn_('🎟 کدهای تخفیف', 'A:disc')]);
  var text = '🛒 <b>مدیریت سرویس‌ها</b>\n\nکل: <b>' + pg.total + '</b> | فعال: <b>' + activeServices_().length + '</b>';
  editOrSend_(ctx, text, kb);
}

function adminServiceView_(ctx, id) {
  var svc = serviceById_(id);
  if (!svc) { editOrSend_(ctx, '❌ سرویس یافت نشد.', adminBackKb_([], 'A:svc')); return; }
  var sold = findRows_('Orders', function (r) {
    return s_(r.service_id) === s_(svc.id) && ['paid', 'delivered'].indexOf(s_(r.status)) !== -1;
  }).length;
  var text = '📦 <b>' + esc_(svc.name) + '</b> (شماره ' + s_(svc.id) + ')\n\n' +
    '📝 توضیحات: ' + (s_(svc.description) ? esc_(svc.description) : '—') + '\n' +
    '📊 حجم: <b>' + esc_(s_(svc.volume) || '—') + '</b>\n' +
    '🗓 مدت: <b>' + esc_(s_(svc.duration) || '—') + '</b>\n' +
    '💰 قیمت: <b>' + money_(svc.price) + '</b>\n' +
    '🔢 ترتیب نمایش: <b>' + int_(svc.sort_order) + '</b>\n' +
    '📌 وضعیت: <b>' + (bool_(svc.is_active) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n' +
    '🧾 فروش موفق: <b>' + sold + '</b>';
  var id2 = s_(svc.id);
  editOrSend_(ctx, text, [
    [btn_('✏️ نام', 'A:svc:e:' + id2 + ':name'), btn_('📝 توضیحات', 'A:svc:e:' + id2 + ':description')],
    [btn_('📊 حجم', 'A:svc:e:' + id2 + ':volume'), btn_('🗓 مدت', 'A:svc:e:' + id2 + ':duration')],
    [btn_('💰 قیمت', 'A:svc:e:' + id2 + ':price'), btn_('🔢 ترتیب', 'A:svc:e:' + id2 + ':sort_order')],
    [btn_(bool_(svc.is_active) ? '🔴 غیرفعال کردن' : '🟢 فعال کردن', 'A:svc:t:' + id2)],
    [btn_('🗑 حذف سرویس', 'A:svc:del:' + id2)],
    [btn_(b_('back'), 'A:svc')]
  ]);
}

var SERVICE_FIELD_FA = {
  name: 'نام سرویس', description: 'توضیحات', volume: 'حجم',
  duration: 'مدت زمان', price: 'قیمت (عدد)', sort_order: 'ترتیب نمایش (عدد)'
};

function adminServiceEditAsk_(ctx, id, field) {
  var svc = serviceById_(id);
  if (!svc || !SERVICE_FIELD_FA[field]) { editOrSend_(ctx, '❌ درخواست نامعتبر.', adminBackKb_([], 'A:svc')); return; }
  setState_(ctx.userId, 'a.svc_edit', { id: s_(id), field: field });
  send_(ctx.chatId, '✏️ مقدار جدید برای <b>' + SERVICE_FIELD_FA[field] + '</b> سرویس «' + esc_(svc.name) + '» را ارسال کنید.\n' +
    'مقدار فعلی: <code>' + esc_(s_(svc[field]) || '—') + '</code>' + HINT_CANCEL, {});
}

function adminServiceSaveField_(ctx, data, text) {
  var svc = serviceById_(data.id);
  if (!svc) { send_(ctx.chatId, '❌ سرویس یافت نشد.', { kb: adminBackKb_([], 'A:svc') }); return; }
  var field = s_(data.field);
  if (!SERVICE_FIELD_FA[field]) { send_(ctx.chatId, '❌ فیلد نامعتبر.', { kb: adminBackKb_([], 'A:svc') }); return; }
  var value = s_(text).trim();
  if ((field === 'price' || field === 'sort_order')) {
    if (num_(value) < 0) { send_(ctx.chatId, '⚠️ عدد نامعتبر است. تغییری انجام نشد.', { kb: adminBackKb_([], 'A:svc:v:' + data.id) }); return; }
    value = num_(value);
  }
  var patch = {};
  patch[field] = value;
  patchRow_('Services', svc.__row, patch);
  logInfo_('admin_service_edit', ctx.userId, 'سرویس ویرایش شد', { id: s_(data.id), field: field });
  send_(ctx.chatId, '✅ <b>' + SERVICE_FIELD_FA[field] + '</b> با موفقیت بروزرسانی شد.', {
    kb: [[btn_('👁 مشاهده سرویس', 'A:svc:v:' + s_(data.id))], [btn_('🛒 سرویس‌ها', 'A:svc')]]
  });
}

function adminServiceToggle_(ctx, id) {
  var svc = serviceById_(id);
  if (!svc) { editOrSend_(ctx, '❌ سرویس یافت نشد.', adminBackKb_([], 'A:svc')); return; }
  patchRow_('Services', svc.__row, { is_active: bool_(svc.is_active) ? '0' : '1' });
  logInfo_('admin_service_toggle', ctx.userId, 'وضعیت سرویس تغییر کرد', { id: s_(id) });
  adminServiceView_(ctx, id);
}

function adminServiceDelete_(ctx, id) {
  var svc = serviceById_(id);
  if (!svc) { editOrSend_(ctx, '❌ سرویس یافت نشد.', adminBackKb_([], 'A:svc')); return; }
  deleteRow_('Services', svc.__row);
  logInfo_('admin_service_delete', ctx.userId, 'سرویس حذف شد', { id: s_(id), name: s_(svc.name) });
  editOrSend_(ctx, '🗑 سرویس <b>' + esc_(svc.name) + '</b> حذف شد.', adminBackKb_([], 'A:svc'));
}

/* =========================== ADMIN · DISCOUNTS ========================= */

function adminDiscountList_(ctx, page) {
  var list = allRows_('Discounts');
  var pg = paginate_(list, page, 8);
  var kb = pg.items.map(function (d) {
    return [btn_((bool_(d.is_active) ? '🟢 ' : '🔴 ') + s_(d.code) + ' — ' +
      (s_(d.kind) === 'percent' ? int_(d.value) + '٪' : money_(d.value)), 'A:disc:v:' + s_(d.code))];
  });
  kb = kb.concat(pagerRow_('A:disc:l:', pg.page, pg.pages, 'A:svc'));
  kb.unshift([btn_('➕ ساخت کد تخفیف', 'A:disc:add')]);
  editOrSend_(ctx, '🎟 <b>کدهای تخفیف</b>\n\nتعداد: <b>' + pg.total + '</b>', kb);
}

function adminDiscountView_(ctx, code) {
  var d = discountByCode_(code);
  if (!d) { editOrSend_(ctx, '❌ کد تخفیف یافت نشد.', adminBackKb_([], 'A:disc')); return; }
  var text = '🎟 <b>کد تخفیف</b> <code>' + esc_(d.code) + '</code>\n\n' +
    '🔢 نوع: <b>' + (s_(d.kind) === 'percent' ? 'درصدی' : 'مبلغ ثابت') + '</b>\n' +
    '💵 مقدار: <b>' + (s_(d.kind) === 'percent' ? int_(d.value) + '٪' : money_(d.value)) + '</b>\n' +
    '📊 استفاده: <b>' + int_(d.used_count) + '</b> از ' + (int_(d.usage_limit) > 0 ? int_(d.usage_limit) : 'بی‌نهایت') + '\n' +
    '⏳ انقضا: <b>' + (s_(d.expires_at) ? jDate_(d.expires_at) : 'بدون انقضا') + '</b>\n' +
    '📌 وضعیت: <b>' + (discountUsable_(d) ? '🟢 قابل استفاده' : '🔴 غیرفعال/تمام‌شده') + '</b>';
  editOrSend_(ctx, text, [
    [btn_(bool_(d.is_active) ? '🔴 غیرفعال کردن' : '🟢 فعال کردن', 'A:disc:t:' + s_(d.code))],
    [btn_('🗑 حذف کد', 'A:disc:del:' + s_(d.code))],
    [btn_(b_('back'), 'A:disc')]
  ]);
}

function adminDiscountToggle_(ctx, code) {
  var d = discountByCode_(code);
  if (!d) { editOrSend_(ctx, '❌ کد تخفیف یافت نشد.', adminBackKb_([], 'A:disc')); return; }
  patchRow_('Discounts', d.__row, { is_active: bool_(d.is_active) ? '0' : '1' });
  logInfo_('admin_discount_toggle', ctx.userId, 'وضعیت کد تخفیف تغییر کرد', { code: s_(code) });
  adminDiscountView_(ctx, code);
}

function adminDiscountDelete_(ctx, code) {
  var d = discountByCode_(code);
  if (!d) { editOrSend_(ctx, '❌ کد تخفیف یافت نشد.', adminBackKb_([], 'A:disc')); return; }
  deleteRow_('Discounts', d.__row);
  logInfo_('admin_discount_delete', ctx.userId, 'کد تخفیف حذف شد', { code: s_(code) });
  editOrSend_(ctx, '🗑 کد تخفیف <code>' + esc_(code) + '</code> حذف شد.', adminBackKb_([], 'A:disc'));
}

/* ============================ ADMIN · ORDERS =========================== */

function adminOrderKb_(orderId) {
  return [
    [btn_('✅ تأیید پرداخت', 'A:ord:ok:' + s_(orderId)), btn_('❌ رد پرداخت', 'A:ord:no:' + s_(orderId))],
    [btn_('🎁 تحویل کانفیگ', 'A:ord:dl:' + s_(orderId))],
    [btn_('🧾 جزئیات سفارش', 'A:ord:v:' + s_(orderId))]
  ];
}

function adminOrdersMenu_(ctx) {
  var orders = findRows_('Orders', function (r) { return s_(r.kind) === 'purchase'; });
  function countBy(status) {
    return orders.filter(function (o) { return s_(o.status) === status; }).length;
  }
  var revenue = 0;
  orders.forEach(function (o) {
    if (['paid', 'delivered'].indexOf(s_(o.status)) !== -1) revenue += num_(o.final_amount);
  });
  var text = '📦 <b>مدیریت سفارش‌ها</b>\n\n' +
    '🧾 کل سفارش‌ها: <b>' + orders.length + '</b>\n' +
    '⏳ در انتظار پرداخت: <b>' + countBy('awaiting_payment') + '</b>\n' +
    '🔍 در حال بررسی: <b>' + countBy('pending_review') + '</b>\n' +
    '✅ پرداخت‌شده: <b>' + countBy('paid') + '</b>\n' +
    '🎁 تحویل‌شده: <b>' + countBy('delivered') + '</b>\n' +
    '❌ رد‌شده: <b>' + countBy('rejected') + '</b>\n' +
    '🚫 لغو‌شده: <b>' + countBy('cancelled') + '</b>\n\n' +
    '💰 درآمد تأییدشده: <b>' + money_(revenue) + '</b>';
  editOrSend_(ctx, text, adminBackKb_([
    [btn_('🔍 در حال بررسی', 'A:ord:l:pending_review:1'), btn_('✅ آماده تحویل', 'A:ord:l:paid:1')],
    [btn_('🎁 تحویل‌شده', 'A:ord:l:delivered:1'), btn_('⏳ در انتظار پرداخت', 'A:ord:l:awaiting_payment:1')],
    [btn_('📋 همه سفارش‌ها', 'A:ord:l:all:1'), btn_('🔎 جستجوی سفارش', 'A:ord:s')]
  ]));
}

function adminOrderList_(ctx, status, page) {
  var orders = findRows_('Orders', function (r) {
    if (s_(r.kind) !== 'purchase') return false;
    return status === 'all' ? true : s_(r.status) === status;
  }).sort(function (a, b) { return int_(b.id) - int_(a.id); });

  if (!orders.length) {
    editOrSend_(ctx, '📭 سفارشی در این وضعیت وجود ندارد.', adminBackKb_([], 'A:ord'));
    return;
  }
  var pg = paginate_(orders, page, 8);
  var kb = pg.items.map(function (o) {
    return [btn_(orderCode_(o) + ' | ' + truncate_(s_(o.service_name), 18) + ' | ' + money_(o.final_amount), 'A:ord:v:' + s_(o.id))];
  });
  kb = kb.concat(pagerRow_('A:ord:l:' + status + ':', pg.page, pg.pages, 'A:ord'));
  editOrSend_(ctx, '📦 <b>سفارش‌ها</b> (' + orderStatusFa_(status === 'all' ? 'همه' : status) + ')\n' +
    'تعداد: <b>' + pg.total + '</b> | صفحه ' + pg.page + ' از ' + pg.pages, kb);
}

function adminOrderSearch_(ctx, query) {
  var q = s_(query).trim().replace('#', '');
  var orders = findRows_('Orders', function (r) {
    return s_(r.id) === q || s_(r.user_id) === q || s_(r.service_name).indexOf(q) !== -1;
  }).sort(function (a, b) { return int_(b.id) - int_(a.id); });
  if (!orders.length) { send_(ctx.chatId, '❌ سفارشی پیدا نشد.', { kb: adminBackKb_([], 'A:ord') }); return; }
  var kb = orders.slice(0, 10).map(function (o) {
    return [btn_(orderCode_(o) + ' | ' + orderStatusFa_(o.status) + ' | ' + money_(o.final_amount), 'A:ord:v:' + s_(o.id))];
  });
  kb.push([btn_(b_('back'), 'A:ord')]);
  send_(ctx.chatId, '🔎 <b>' + orders.length + ' سفارش پیدا شد:</b>', { kb: kb });
}

function adminOrderCard_(order) {
  var user = getUser_(order.user_id);
  var ref = s_(order.payment_ref);
  var refText = ref.indexOf('photo:') === 0 ? 'تصویر رسید (دکمه مشاهده)' :
    (ref.indexOf('document:') === 0 ? 'فایل رسید (دکمه مشاهده)' : (ref || '—'));
  return '🧾 <b>سفارش ' + orderCode_(order) + '</b>\n\n' +
    '📦 سرویس: <b>' + esc_(order.service_name) + '</b>\n' +
    '💰 مبلغ: <b>' + money_(order.amount) + '</b>\n' +
    (num_(order.discount_amount) > 0 ? '🎟 تخفیف: <b>' + money_(order.discount_amount) +
      '</b> (کد ' + esc_(order.discount_code) + ')\n' : '') +
    '💵 مبلغ نهایی: <b>' + money_(order.final_amount) + '</b>\n' +
    '📌 وضعیت: <b>' + orderStatusFa_(order.status) + '</b>\n' +
    '💳 روش پرداخت: <b>' + (s_(order.pay_method) === 'wallet' ? 'کیف پول' : (s_(order.pay_method) === 'card' ? 'کارت به کارت' : '—')) + '</b>\n' +
    '📎 رسید: ' + esc_(refText) + '\n' +
    '🗓 ثبت: ' + jDateTime_(order.created_at) + '\n' +
    '♻️ بروزرسانی: ' + jDateTime_(order.updated_at) + '\n' +
    (s_(order.handled_by) ? '👮 بررسی‌کننده: <code>' + esc_(order.handled_by) + '</code>\n' : '') +
    (s_(order.note) ? '📝 یادداشت: ' + esc_(order.note) + '\n' : '') +
    '\n👤 کاربر: ' + esc_(user ? userLabel_(user) : s_(order.user_id));
}

function adminOrderView_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order) { editOrSend_(ctx, '❌ سفارش یافت نشد.', adminBackKb_([], 'A:ord')); return; }
  if (s_(order.kind) === 'test') { adminTestView_(ctx, orderId); return; }
  var id = s_(order.id);
  var kb = [];
  var status = s_(order.status);
  if (status === 'pending_review') {
    kb.push([btn_('✅ تأیید پرداخت', 'A:ord:ok:' + id), btn_('❌ رد پرداخت', 'A:ord:no:' + id)]);
  }
  if (s_(order.payment_ref).indexOf('photo:') === 0 || s_(order.payment_ref).indexOf('document:') === 0) {
    kb.push([btn_('📎 مشاهده رسید', 'A:ord:rc:' + id)]);
  }
  if (['paid', 'pending_review'].indexOf(status) !== -1) kb.push([btn_('🎁 تحویل کانفیگ', 'A:ord:dl:' + id)]);
  if (status === 'delivered') kb.push([btn_('🔁 ارسال مجدد کانفیگ', 'A:ord:dl:' + id)]);
  if (['awaiting_payment', 'pending_review', 'paid'].indexOf(status) !== -1) {
    kb.push([btn_('🚫 لغو سفارش', 'A:ord:cn:' + id)]);
  }
  kb.push([btn_('👤 پروفایل کاربر', 'A:usr:v:' + s_(order.user_id))]);
  kb.push([btn_(b_('back'), 'A:ord')]);
  editOrSend_(ctx, adminOrderCard_(order), kb);
}

function adminShowReceipt_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order) { editOrSend_(ctx, '❌ سفارش یافت نشد.', adminBackKb_([], 'A:ord')); return; }
  var ref = s_(order.payment_ref);
  var caption = '📎 رسید سفارش ' + orderCode_(order);
  var kb = [[btn_('🧾 جزئیات سفارش', 'A:ord:v:' + s_(order.id))]];
  if (ref.indexOf('photo:') === 0) tgSendPhoto_(ctx.chatId, ref.substring(6), caption, { kb: kb });
  else if (ref.indexOf('document:') === 0) tgSendDocument_(ctx.chatId, ref.substring(9), caption, { kb: kb });
  else send_(ctx.chatId, caption + '\n<code>' + esc_(ref || '—') + '</code>', { kb: kb });
}

function adminApproveOrder_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order) { editOrSend_(ctx, '❌ سفارش یافت نشد.', adminBackKb_([], 'A:ord')); return; }
  if (['paid', 'delivered'].indexOf(s_(order.status)) !== -1) {
    editOrSend_(ctx, 'ℹ️ این سفارش قبلاً تأیید شده است.', adminBackKb_([
      [btn_('🎁 تحویل کانفیگ', 'A:ord:dl:' + s_(order.id))]
    ], 'A:ord:v:' + s_(order.id)));
    return;
  }
  patchRow_('Orders', order.__row, {
    status: 'paid', handled_by: ctx.userId, updated_at: nowIso_()
  });
  var fresh = orderById_(orderId);
  payReferralCommission_(fresh);
  logInfo_('payment_approved', ctx.userId, 'پرداخت تأیید شد', { order_id: s_(order.id) });
  tgSendMessage_(order.user_id, t_('order_approved', { order: orderCode_(order) }), {});
  editOrSend_(ctx, '✅ پرداخت سفارش <b>' + orderCode_(order) + '</b> تأیید شد و به کاربر اطلاع داده شد.\n\n' +
    'اکنون کانفیگ را برای کاربر ارسال کنید.', [
    [btn_('🎁 تحویل کانفیگ', 'A:ord:dl:' + s_(order.id))],
    [btn_('🧾 جزئیات سفارش', 'A:ord:v:' + s_(order.id))],
    [btn_(b_('back'), 'A:ord')]
  ]);
}

function adminRejectOrder_(ctx, orderId, reason) {
  var order = orderById_(orderId);
  if (!order) { send_(ctx.chatId, '❌ سفارش یافت نشد.', { kb: adminBackKb_([], 'A:ord') }); return; }
  var note = (s_(reason) === '-' || !s_(reason)) ? '' : s_(reason);
  patchRow_('Orders', order.__row, {
    status: 'rejected', handled_by: ctx.userId, updated_at: nowIso_(), note: note
  });
  releaseDiscount_(order);
  logInfo_('payment_rejected', ctx.userId, 'پرداخت رد شد', { order_id: s_(order.id) });
  tgSendMessage_(order.user_id, t_('order_rejected', {
    order: orderCode_(order),
    reason: note ? ('📝 دلیل: ' + esc_(note)) : 'در صورت نیاز با پشتیبانی در تماس باشید.'
  }), {});
  send_(ctx.chatId, '❌ سفارش <b>' + orderCode_(order) + '</b> رد شد و به کاربر اطلاع داده شد.', {
    kb: adminBackKb_([[btn_('🧾 جزئیات سفارش', 'A:ord:v:' + s_(order.id))]], 'A:ord')
  });
}

function adminCancelOrder_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order) { editOrSend_(ctx, '❌ سفارش یافت نشد.', adminBackKb_([], 'A:ord')); return; }
  if (s_(order.status) === 'paid' && s_(order.pay_method) === 'wallet') {
    changeBalance_(order.user_id, num_(order.final_amount), 'refund',
      'بازگشت وجه سفارش ' + orderCode_(order), s_(order.id));
  }
  patchRow_('Orders', order.__row, {
    status: 'cancelled', handled_by: ctx.userId, updated_at: nowIso_(), note: 'لغو توسط مدیر'
  });
  releaseDiscount_(order);
  logInfo_('order_cancel_admin', ctx.userId, 'سفارش توسط مدیر لغو شد', { order_id: s_(order.id) });
  tgSendMessage_(order.user_id, t_('order_cancelled', { order: orderCode_(order) }), {});
  editOrSend_(ctx, '🚫 سفارش <b>' + orderCode_(order) + '</b> لغو شد.', adminBackKb_([], 'A:ord'));
}

/* ========================= CONFIG DELIVERY (MANUAL) ==================== */

function adminAskConfig_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order) { editOrSend_(ctx, '❌ سفارش یافت نشد.', adminBackKb_([], 'A:ord')); return; }
  setState_(ctx.userId, 'a.deliver', { orderId: s_(order.id) });
  send_(ctx.chatId, '🎁 <b>تحویل کانفیگ سفارش ' + orderCode_(order) + '</b>\n\n' +
    '📦 سرویس: <b>' + esc_(order.service_name) + '</b>\n' +
    '👤 کاربر: <code>' + esc_(order.user_id) + '</code>\n\n' +
    'کانفیگ یا لینک ساب‌اسکریپشن را ارسال کنید. متن شما <b>بدون هیچ تغییری</b> برای کاربر ارسال می‌شود.' + HINT_CANCEL, {});
}

function parseDurationDays_(text) {
  var digits = s_(text).replace(/[۰-۹]/g, function (d) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); })
    .match(/\d+/);
  var days = digits ? int_(digits[0]) : 0;
  if (!days) days = 30;
  if (/ماه/.test(s_(text)) && days <= 12) days = days * 30;
  return days;
}

function adminDeliverConfig_(ctx, orderId, msg) {
  var order = orderById_(orderId);
  if (!order) { send_(ctx.chatId, '❌ سفارش یافت نشد.', { kb: adminBackKb_([], 'A:ord') }); return; }
  var configText = s_(msg.text);
  if (!configText.trim()) {
    send_(ctx.chatId, '⚠️ کانفیگ باید متنی باشد. عملیات لغو شد.', {
      kb: adminBackKb_([[btn_('🔁 تلاش مجدد', 'A:ord:dl:' + s_(order.id))]], 'A:ord')
    });
    return;
  }
  var svc = serviceById_(order.service_id);
  var duration = svc ? s_(svc.duration) : '';
  var volume = svc ? s_(svc.volume) : '';
  var days = parseDurationDays_(duration);

  /* 1) tell the customer, 2) send the config exactly as provided */
  var info = tgSendMessage_(order.user_id, t_('config_delivered', {
    service: esc_(order.service_name),
    duration: esc_(duration || days + ' روز'),
    volume: esc_(volume || 'نامحدود')
  }), {});
  var raw = sendRaw_(order.user_id, configText);

  if (!raw || !raw.ok) {
    logWarn_('config_delivery_failed', ctx.userId, 'ارسال کانفیگ به کاربر ناموفق بود', { order_id: s_(order.id) });
    send_(ctx.chatId, '⚠️ ارسال کانفیگ به کاربر <b>ناموفق</b> بود (کاربر ربات را بلاک کرده یا گفتگو را نبسته).\n' +
      'وضعیت سفارش تغییر نکرد. می‌توانید دوباره تلاش کنید.', {
      kb: adminBackKb_([[btn_('🔁 تلاش مجدد', 'A:ord:dl:' + s_(order.id))]], 'A:ord:v:' + s_(order.id))
    });
    return;
  }
  var cfgId = nextSeq_('Configs');
  var deliveredAt = new Date();
  appendRow_('Configs', {
    id: cfgId, order_id: s_(order.id), user_id: s_(order.user_id), kind: 'purchase',
    service_name: s_(order.service_name), config_text: configText, volume: volume,
    duration: duration, delivered_at: iso_(deliveredAt), expires_at: iso_(addDays_(deliveredAt, days)),
    status: 'active', delivered_by: ctx.userId
  });
  patchRow_('Orders', order.__row, { status: 'delivered', handled_by: ctx.userId, updated_at: nowIso_() });
  logInfo_('config_delivered', ctx.userId, 'کانفیگ تحویل داده شد', {
    order_id: s_(order.id), config_id: cfgId, user_id: s_(order.user_id)
  });
  send_(ctx.chatId, '✅ کانفیگ برای کاربر <code>' + esc_(order.user_id) + '</code> ارسال شد.\n' +
    '🧾 سفارش ' + orderCode_(order) + ' به وضعیت «تحویل‌شده» تغییر یافت.\n' +
    '⏳ انقضا: <b>' + jDate_(addDays_(deliveredAt, days)) + '</b>', {
    kb: adminBackKb_([[btn_('🧾 جزئیات سفارش', 'A:ord:v:' + s_(order.id))]], 'A:ord')
  });
  if (info && !info.ok) logWarn_('config_info_failed', ctx.userId, 'پیام اطلاع‌رسانی ارسال نشد', { order_id: s_(order.id) });
}

/* ========================== ADMIN · TEST SERVICE ======================= */

function adminTestMenu_(ctx) {
  var tests = findRows_('Orders', function (r) { return s_(r.kind) === 'test'; });
  var pending = tests.filter(function (o) { return s_(o.status) === 'pending_review'; }).length;
  var delivered = tests.filter(function (o) { return s_(o.status) === 'delivered'; }).length;
  var text = '🧪 <b>مدیریت سرویس تست</b>\n\n' +
    '📌 وضعیت سرویس تست: <b>' + (getBool_('test_enabled', true) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n' +
    '⏱ فاصله مجاز بین درخواست‌ها: <b>' + getInt_('test_cooldown_hours', 24) + ' ساعت</b>\n\n' +
    '📨 در انتظار بررسی: <b>' + pending + '</b>\n' +
    '🎁 تحویل‌شده: <b>' + delivered + '</b>\n' +
    '📊 کل درخواست‌ها: <b>' + tests.length + '</b>\n\n' +
    '<i>محدودیت زمانی فقط پس از تحویل موفق کانفیگ تست شروع می‌شود.</i>';
  editOrSend_(ctx, text, adminBackKb_([
    [btn_('📨 درخواست‌های در انتظار', 'A:test:l:1')],
    [btn_(getBool_('test_enabled', true) ? '🔴 غیرفعال کردن تست' : '🟢 فعال کردن تست', 'A:set:t:test_enabled')],
    [btn_('⏱ تغییر فاصله زمانی', 'A:set:e:test_cooldown_hours')]
  ]));
}

function adminTestList_(ctx, page) {
  var tests = findRows_('Orders', function (r) {
    return s_(r.kind) === 'test' && s_(r.status) === 'pending_review';
  }).sort(function (a, b) { return int_(a.id) - int_(b.id); });
  if (!tests.length) { editOrSend_(ctx, '📭 درخواست تستی در انتظار بررسی نیست.', adminBackKb_([], 'A:test')); return; }
  var pg = paginate_(tests, page, 8);
  var kb = pg.items.map(function (o) {
    var u = getUser_(o.user_id);
    return [btn_('#' + s_(o.id) + ' | ' + truncate_(u ? userName_(u) : s_(o.user_id), 22), 'A:test:v:' + s_(o.id))];
  });
  kb = kb.concat(pagerRow_('A:test:l:', pg.page, pg.pages, 'A:test'));
  editOrSend_(ctx, '📨 <b>درخواست‌های تست</b> (' + pg.total + ')', kb);
}

function adminTestView_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order || s_(order.kind) !== 'test') { editOrSend_(ctx, '❌ درخواست یافت نشد.', adminBackKb_([], 'A:test')); return; }
  var user = getUser_(order.user_id);
  var text = '🧪 <b>درخواست تست #' + s_(order.id) + '</b>\n\n' +
    '📌 وضعیت: <b>' + orderStatusFa_(order.status) + '</b>\n' +
    '🗓 ثبت: ' + jDateTime_(order.created_at) + '\n' +
    (s_(order.note) ? '📝 یادداشت: ' + esc_(order.note) + '\n' : '') +
    '\n👤 کاربر: ' + esc_(user ? userLabel_(user) : s_(order.user_id)) + '\n' +
    '🧪 آخرین تست دریافتی: ' + (user && s_(user.last_test_at) ? jDateTime_(user.last_test_at) : '—');
  var kb = [];
  if (s_(order.status) === 'pending_review') {
    kb.push([btn_('📤 ارسال کانفیگ تست', 'A:test:dl:' + s_(order.id))]);
    kb.push([btn_('❌ رد درخواست', 'A:test:no:' + s_(order.id))]);
  }
  kb.push([btn_('👤 پروفایل کاربر', 'A:usr:v:' + s_(order.user_id))]);
  kb.push([btn_(b_('back'), 'A:test:l:1')]);
  editOrSend_(ctx, text, kb);
}

function adminAskTestConfig_(ctx, orderId) {
  var order = orderById_(orderId);
  if (!order || s_(order.kind) !== 'test') { editOrSend_(ctx, '❌ درخواست یافت نشد.', adminBackKb_([], 'A:test')); return; }
  setState_(ctx.userId, 'a.test_deliver', { orderId: s_(order.id) });
  send_(ctx.chatId, '📤 <b>ارسال کانفیگ تست #' + s_(order.id) + '</b>\n\n' +
    '👤 کاربر: <code>' + esc_(order.user_id) + '</code>\n\n' +
    'کانفیگ تست را ارسال کنید. متن شما <b>بدون تغییر</b> برای کاربر فرستاده می‌شود.\n' +
    '<i>محدودیت زمانی تست فقط در صورت ارسال موفق اعمال می‌شود.</i>' + HINT_CANCEL, {});
}

function adminDeliverTest_(ctx, orderId, msg) {
  var order = orderById_(orderId);
  if (!order || s_(order.kind) !== 'test') { send_(ctx.chatId, '❌ درخواست یافت نشد.', { kb: adminBackKb_([], 'A:test') }); return; }
  var configText = s_(msg.text);
  if (!configText.trim()) {
    send_(ctx.chatId, '⚠️ کانفیگ تست باید متنی باشد. محدودیت زمانی کاربر مصرف نشد.', {
      kb: adminBackKb_([[btn_('🔁 تلاش مجدد', 'A:test:dl:' + s_(order.id))]], 'A:test')
    });
    return;
  }
  var notice = tgSendMessage_(order.user_id, t_('test_delivered'), {});
  var raw = sendRaw_(order.user_id, configText);
  if (!raw || !raw.ok) {
    logWarn_('test_delivery_failed', ctx.userId, 'ارسال کانفیگ تست ناموفق بود', { order_id: s_(order.id) });
    send_(ctx.chatId, '⚠️ ارسال کانفیگ تست <b>ناموفق</b> بود.\n' +
      'محدودیت زمانی کاربر <b>مصرف نشد</b> و درخواست باز است.', {
      kb: adminBackKb_([[btn_('🔁 تلاش مجدد', 'A:test:dl:' + s_(order.id))]], 'A:test')
    });
    return;
  }
  var deliveredAt = new Date();
  var cfgId = nextSeq_('Configs');
  appendRow_('Configs', {
    id: cfgId, order_id: s_(order.id), user_id: s_(order.user_id), kind: 'test',
    service_name: 'سرویس تست', config_text: configText, volume: 'تست',
    duration: '۱ روز', delivered_at: iso_(deliveredAt),
    expires_at: iso_(addDays_(deliveredAt, 1)), status: 'active', delivered_by: ctx.userId
  });
  patchRow_('Orders', order.__row, { status: 'delivered', handled_by: ctx.userId, updated_at: nowIso_() });
  var user = getUser_(order.user_id);
  if (user) patchRow_('Users', user.__row, { last_test_at: iso_(deliveredAt) });
  logInfo_('test_delivered', ctx.userId, 'کانفیگ تست تحویل شد و محدودیت زمانی شروع شد', {
    order_id: s_(order.id), user_id: s_(order.user_id)
  });
  send_(ctx.chatId, '✅ کانفیگ تست ارسال شد.\n' +
    '⏱ محدودیت ' + getInt_('test_cooldown_hours', 24) + ' ساعته برای این کاربر از همین لحظه شروع شد.', {
    kb: adminBackKb_([[btn_('📨 درخواست‌های تست', 'A:test:l:1')]], 'A:test')
  });
  if (notice && !notice.ok) logWarn_('test_notice_failed', ctx.userId, 'پیام اطلاع‌رسانی تست ارسال نشد', { order_id: s_(order.id) });
}

function adminRejectTest_(ctx, orderId, reason) {
  var order = orderById_(orderId);
  if (!order || s_(order.kind) !== 'test') { send_(ctx.chatId, '❌ درخواست یافت نشد.', { kb: adminBackKb_([], 'A:test') }); return; }
  var note = (s_(reason) === '-' || !s_(reason)) ? '' : s_(reason);
  patchRow_('Orders', order.__row, {
    status: 'rejected', handled_by: ctx.userId, updated_at: nowIso_(), note: note
  });
  logInfo_('test_rejected', ctx.userId, 'درخواست تست رد شد (بدون مصرف محدودیت)', { order_id: s_(order.id) });
  tgSendMessage_(order.user_id, t_('test_rejected', {
    reason: note ? ('📝 دلیل: ' + esc_(note)) : ''
  }), {});
  send_(ctx.chatId, '❌ درخواست تست #' + s_(order.id) + ' رد شد.\n' +
    'ℹ️ محدودیت زمانی کاربر مصرف نشد و می‌تواند دوباره درخواست دهد.', {
    kb: adminBackKb_([[btn_('📨 درخواست‌های تست', 'A:test:l:1')]], 'A:test')
  });
}

function adminResetTestCooldown_(ctx, userId) {
  var user = getUser_(userId);
  if (!user) { editOrSend_(ctx, '❌ کاربر یافت نشد.', adminBackKb_([], 'A:usr')); return; }
  patchRow_('Users', user.__row, { last_test_at: '' });
  logInfo_('admin_test_reset', ctx.userId, 'محدودیت تست کاربر صفر شد', { target: s_(userId) });
  editOrSend_(ctx, '✅ محدودیت زمانی سرویس تست برای کاربر <code>' + esc_(userId) + '</code> صفر شد.',
    adminBackKb_([], 'A:usr:v:' + s_(userId)));
}

/* =========================== ADMIN · PAYMENTS ========================== */

function adminPaymentsMenu_(ctx) {
  var pending = findRows_('Orders', function (r) {
    return s_(r.kind) === 'purchase' && s_(r.status) === 'pending_review';
  }).length;
  var text = '💳 <b>مدیریت پرداخت‌ها</b>\n\n' +
    '📌 وضعیت پرداخت: <b>' + (getBool_('payment_enabled', true) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n' +
    '👛 پرداخت با کیف پول: <b>' + (getBool_('wallet_enabled', true) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n\n' +
    '🔢 شماره کارت: <code>' + esc_(getSetting_('card_number', '')) + '</code>\n' +
    '👤 صاحب حساب: <b>' + esc_(getSetting_('card_holder', '')) + '</b>\n' +
    '📝 توضیح پرداخت: ' + esc_(truncate_(getSetting_('payment_note', ''), 200)) + '\n\n' +
    '🔍 رسیدهای در انتظار بررسی: <b>' + pending + '</b>';
  editOrSend_(ctx, text, adminBackKb_([
    [btn_('🔍 بررسی رسیدها', 'A:ord:l:pending_review:1')],
    [btn_('🔢 تغییر شماره کارت', 'A:set:e:card_number')],
    [btn_('👤 تغییر نام صاحب حساب', 'A:set:e:card_holder')],
    [btn_('📝 تغییر توضیح پرداخت', 'A:set:e:payment_note')],
    [btn_('🧾 تغییر متن راهنمای پرداخت', 'A:txt:e:payment_instructions')],
    [btn_(getBool_('payment_enabled', true) ? '🔴 غیرفعال کردن پرداخت' : '🟢 فعال کردن پرداخت', 'A:set:t:payment_enabled')]
  ]));
}

/* ============================ ADMIN · GUIDES =========================== */

function adminGuideList_(ctx, page) {
  var guides = allRows_('Guides').sort(function (a, b) {
    return int_(a.sort_order) - int_(b.sort_order) || int_(a.id) - int_(b.id);
  });
  var pg = paginate_(guides, page, 8);
  var kb = pg.items.map(function (g) {
    return [btn_((bool_(g.is_active) ? '🟢 ' : '🔴 ') + s_(g.title), 'A:guide:v:' + s_(g.id))];
  });
  kb = kb.concat(pagerRow_('A:guide:l:', pg.page, pg.pages, 'A:home'));
  kb.unshift([btn_('➕ افزودن راهنما', 'A:guide:add')]);
  editOrSend_(ctx, '📖 <b>مدیریت راهنماها</b>\n\nتعداد: <b>' + pg.total + '</b>', kb);
}

function adminGuideView_(ctx, id) {
  var g = guideById_(id);
  if (!g) { editOrSend_(ctx, '❌ راهنما یافت نشد.', adminBackKb_([], 'A:guide')); return; }
  var text = '📖 <b>' + esc_(g.title) + '</b> (شماره ' + s_(g.id) + ')\n\n' +
    esc_(truncate_(s_(g.content), 2500)) + '\n\n' +
    '🔢 ترتیب: <b>' + int_(g.sort_order) + '</b>\n' +
    '📌 وضعیت: <b>' + (bool_(g.is_active) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>';
  var gid = s_(g.id);
  editOrSend_(ctx, text, [
    [btn_('✏️ عنوان', 'A:guide:e:' + gid + ':title'), btn_('📝 متن', 'A:guide:e:' + gid + ':content')],
    [btn_('🔢 ترتیب', 'A:guide:e:' + gid + ':sort_order')],
    [btn_(bool_(g.is_active) ? '🔴 غیرفعال کردن' : '🟢 فعال کردن', 'A:guide:t:' + gid)],
    [btn_('🗑 حذف راهنما', 'A:guide:del:' + gid)],
    [btn_(b_('back'), 'A:guide')]
  ]);
}

var GUIDE_FIELD_FA = { title: 'عنوان', content: 'متن راهنما', sort_order: 'ترتیب نمایش (عدد)' };

function adminGuideEditAsk_(ctx, id, field) {
  var g = guideById_(id);
  if (!g || !GUIDE_FIELD_FA[field]) { editOrSend_(ctx, '❌ درخواست نامعتبر.', adminBackKb_([], 'A:guide')); return; }
  setState_(ctx.userId, 'a.guide_edit', { id: s_(id), field: field });
  send_(ctx.chatId, '✏️ مقدار جدید برای <b>' + GUIDE_FIELD_FA[field] + '</b> را ارسال کنید.' + HINT_CANCEL, {});
}

function adminGuideSaveField_(ctx, data, text) {
  var g = guideById_(data.id);
  if (!g) { send_(ctx.chatId, '❌ راهنما یافت نشد.', { kb: adminBackKb_([], 'A:guide') }); return; }
  var field = s_(data.field);
  if (!GUIDE_FIELD_FA[field]) { send_(ctx.chatId, '❌ فیلد نامعتبر.', { kb: adminBackKb_([], 'A:guide') }); return; }
  var value = (field === 'content') ? s_(ctx.msg.text) : s_(text).trim();
  if (field === 'sort_order') value = int_(value);
  var patch = {};
  patch[field] = value;
  patchRow_('Guides', g.__row, patch);
  logInfo_('admin_guide_edit', ctx.userId, 'راهنما ویرایش شد', { id: s_(data.id), field: field });
  send_(ctx.chatId, '✅ <b>' + GUIDE_FIELD_FA[field] + '</b> بروزرسانی شد.', {
    kb: [[btn_('👁 مشاهده راهنما', 'A:guide:v:' + s_(data.id))], [btn_('📖 راهنماها', 'A:guide')]]
  });
}

function adminGuideToggle_(ctx, id) {
  var g = guideById_(id);
  if (!g) { editOrSend_(ctx, '❌ راهنما یافت نشد.', adminBackKb_([], 'A:guide')); return; }
  patchRow_('Guides', g.__row, { is_active: bool_(g.is_active) ? '0' : '1' });
  logInfo_('admin_guide_toggle', ctx.userId, 'وضعیت راهنما تغییر کرد', { id: s_(id) });
  adminGuideView_(ctx, id);
}

function adminGuideDelete_(ctx, id) {
  var g = guideById_(id);
  if (!g) { editOrSend_(ctx, '❌ راهنما یافت نشد.', adminBackKb_([], 'A:guide')); return; }
  deleteRow_('Guides', g.__row);
  logInfo_('admin_guide_delete', ctx.userId, 'راهنما حذف شد', { id: s_(id) });
  editOrSend_(ctx, '🗑 راهنما حذف شد.', adminBackKb_([], 'A:guide'));
}

/* =========================== ADMIN · CHANNELS ========================== */

function adminChannelsMenu_(ctx) {
  var channels = allRows_('Channels');
  var text = '📢 <b>کانال اجباری</b>\n\n' +
    '📌 وضعیت عضویت اجباری: <b>' + (getBool_('channel_required', false) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n' +
    '📋 تعداد کانال‌ها: <b>' + channels.length + '</b>\n\n';
  if (!channels.length) text += 'هنوز کانالی اضافه نشده است.\n';
  channels.forEach(function (ch) {
    text += (bool_(ch.is_active) ? '🟢 ' : '🔴 ') + '<b>' + esc_(ch.title) + '</b>' +
      (s_(ch.username) ? ' — @' + esc_(ch.username) : '') +
      (s_(ch.chat_id) ? ' — <code>' + esc_(ch.chat_id) + '</code>' : '') + '\n';
  });
  text += '\n<i>ربات باید در کانال ادمین باشد تا بررسی عضویت کار کند.</i>';
  var kb = [[btn_('➕ افزودن کانال', 'A:ch:add')]];
  channels.slice(0, 8).forEach(function (ch) {
    kb.push([
      btn_((bool_(ch.is_active) ? '🔴 غیرفعال: ' : '🟢 فعال: ') + truncate_(s_(ch.title), 18), 'A:ch:t:' + s_(ch.id)),
      btn_('🗑', 'A:ch:del:' + s_(ch.id))
    ]);
  });
  kb.push([btn_(getBool_('channel_required', false) ? '🔴 غیرفعال کردن اجبار' : '🟢 فعال کردن اجبار', 'A:set:t:channel_required')]);
  editOrSend_(ctx, text, adminBackKb_(kb));
}

function channelById_(id) { return rowByKey_('Channels', 'id', id); }

function adminChannelToggle_(ctx, id) {
  var ch = channelById_(id);
  if (!ch) { editOrSend_(ctx, '❌ کانال یافت نشد.', adminBackKb_([], 'A:ch')); return; }
  patchRow_('Channels', ch.__row, { is_active: bool_(ch.is_active) ? '0' : '1' });
  logInfo_('admin_channel_toggle', ctx.userId, 'وضعیت کانال تغییر کرد', { id: s_(id) });
  adminChannelsMenu_(ctx);
}

function adminChannelDelete_(ctx, id) {
  var ch = channelById_(id);
  if (!ch) { editOrSend_(ctx, '❌ کانال یافت نشد.', adminBackKb_([], 'A:ch')); return; }
  deleteRow_('Channels', ch.__row);
  logInfo_('admin_channel_delete', ctx.userId, 'کانال حذف شد', { id: s_(id) });
  adminChannelsMenu_(ctx);
}

/* ========================== ADMIN · REFERRALS ========================== */

function adminReferralMenu_(ctx) {
  var refs = allRows_('Referrals');
  var paid = refs.filter(function (r) { return num_(r.commission) > 0; });
  var total = 0;
  paid.forEach(function (r) { total += num_(r.commission); });
  var byRef = {};
  paid.forEach(function (r) {
    var k = s_(r.referrer_id);
    byRef[k] = (byRef[k] || 0) + num_(r.commission);
  });
  var top = Object.keys(byRef).map(function (k) { return { id: k, sum: byRef[k] }; })
    .sort(function (a, b) { return b.sum - a.sum; }).slice(0, 10);
  var text = '👥 <b>مدیریت زیرمجموعه‌ها</b>\n\n' +
    '📌 وضعیت: <b>' + (getBool_('referral_enabled', true) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n' +
    '💯 درصد پورسانت: <b>' + getInt_('referral_percent', 10) + '٪</b>\n' +
    '🔗 کل دعوت‌ها: <b>' + refs.length + '</b>\n' +
    '💵 کل پورسانت پرداخت‌شده: <b>' + money_(total) + '</b>\n\n' +
    '<b>برترین معرف‌ها:</b>\n';
  if (!top.length) text += '—\n';
  top.forEach(function (row, i) {
    var u = getUser_(row.id);
    text += (i + 1) + '. ' + esc_(u ? userName_(u) : row.id) + ' — ' + money_(row.sum) + '\n';
  });
  editOrSend_(ctx, truncate_(text, 3900), adminBackKb_([
    [btn_('💯 تغییر درصد پورسانت', 'A:set:e:referral_percent')],
    [btn_(getBool_('referral_enabled', true) ? '🔴 غیرفعال کردن' : '🟢 فعال کردن', 'A:set:t:referral_enabled')]
  ]));
}

/* ============================ ADMIN · WALLET =========================== */

function adminWalletMenu_(ctx) {
  var wallets = allRows_('Wallet');
  var totalBalance = 0, totalCharged = 0, totalSpent = 0, totalRef = 0;
  wallets.forEach(function (w) {
    totalBalance += num_(w.balance);
    totalCharged += num_(w.total_charged);
    totalSpent += num_(w.total_spent);
    totalRef += num_(w.ref_income);
  });
  var text = '💰 <b>مدیریت کیف پول</b>\n\n' +
    '📌 وضعیت: <b>' + (getBool_('wallet_enabled', true) ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n' +
    '👛 مجموع موجودی کاربران: <b>' + money_(totalBalance) + '</b>\n' +
    '⬆️ مجموع شارژ: <b>' + money_(totalCharged) + '</b>\n' +
    '⬇️ مجموع خرید: <b>' + money_(totalSpent) + '</b>\n' +
    '👥 مجموع پورسانت: <b>' + money_(totalRef) + '</b>\n' +
    '🧾 تعداد تراکنش‌ها: <b>' + countRows_('Transactions') + '</b>\n' +
    '💸 حداقل برداشت: <b>' + money_(getInt_('min_withdraw', 50000)) + '</b>';
  editOrSend_(ctx, text, adminBackKb_([
    [btn_('🧾 آخرین تراکنش‌ها', 'A:wal:tx:1')],
    [btn_('🏆 بیشترین موجودی', 'A:wal:top')],
    [btn_('💸 درخواست‌های برداشت', 'A:wd')],
    [btn_('➕➖ تغییر موجودی کاربر', 'A:usr:s')],
    [btn_('💸 تغییر حداقل برداشت', 'A:set:e:min_withdraw')],
    [btn_(getBool_('wallet_enabled', true) ? '🔴 غیرفعال کردن کیف پول' : '🟢 فعال کردن کیف پول', 'A:set:t:wallet_enabled')]
  ]));
}

function adminWalletTx_(ctx, page) {
  var txs = allRows_('Transactions').sort(function (a, b) { return int_(b.id) - int_(a.id); });
  if (!txs.length) { editOrSend_(ctx, '📭 تراکنشی ثبت نشده است.', adminBackKb_([], 'A:wal')); return; }
  var pg = paginate_(txs, page, 10);
  var text = '🧾 <b>آخرین تراکنش‌ها</b>\n\n';
  pg.items.forEach(function (tx) {
    text += (num_(tx.amount) >= 0 ? '➕' : '➖') + ' <b>' + money_(Math.abs(num_(tx.amount))) + '</b> — ' +
      txTypeFa_(tx.type) + '\n   👤 <code>' + esc_(tx.user_id) + '</code> | ' + jDateTime_(tx.created_at) + '\n';
  });
  text += '\nصفحه ' + pg.page + ' از ' + pg.pages;
  editOrSend_(ctx, truncate_(text, 3900), pagerRow_('A:wal:tx:', pg.page, pg.pages, 'A:wal'));
}

function adminWalletTop_(ctx) {
  var wallets = allRows_('Wallet').sort(function (a, b) { return num_(b.balance) - num_(a.balance); }).slice(0, 15);
  var text = '🏆 <b>بیشترین موجودی</b>\n\n';
  if (!wallets.length) text += '—';
  var kb = [];
  wallets.forEach(function (w, i) {
    var u = getUser_(w.user_id);
    text += (i + 1) + '. ' + esc_(u ? userName_(u) : s_(w.user_id)) + ' — <b>' + money_(w.balance) + '</b>\n';
    if (i < 5) kb.push([btn_('👤 ' + truncate_(u ? userName_(u) : s_(w.user_id), 24), 'A:usr:v:' + s_(w.user_id))]);
  });
  editOrSend_(ctx, truncate_(text, 3900), adminBackKb_(kb, 'A:wal'));
}

/* ========================= ADMIN · WITHDRAWALS ========================= */

var WD_STATUS_FA = { pending: '⏳ در انتظار بررسی', approved: '✅ تأییدشده', rejected: '❌ رد‌شده' };

function withdrawById_(id) { return rowByKey_('Withdrawals', 'id', id); }

function adminWithdrawList_(ctx, status, page) {
  var list = findRows_('Withdrawals', function (r) {
    return status === 'all' ? true : s_(r.status) === status;
  }).sort(function (a, b) { return int_(b.id) - int_(a.id); });
  var pendingCount = findRows_('Withdrawals', function (r) { return s_(r.status) === 'pending'; }).length;
  var head = '💸 <b>درخواست‌های برداشت</b>\n\n' +
    'وضعیت نمایش: <b>' + (WD_STATUS_FA[status] || 'همه') + '</b>\n' +
    '⏳ در انتظار بررسی: <b>' + pendingCount + '</b>\n';
  if (!list.length) {
    editOrSend_(ctx, head + '\n📭 موردی یافت نشد.', adminBackKb_([
      [btn_('📋 همه درخواست‌ها', 'A:wd:l:all:1')]
    ]));
    return;
  }
  var pg = paginate_(list, page, 8);
  var kb = pg.items.map(function (w) {
    return [btn_('#' + s_(w.id) + ' | ' + money_(w.amount) + ' | ' + (WD_STATUS_FA[s_(w.status)] || ''), 'A:wd:v:' + s_(w.id))];
  });
  kb = kb.concat(pagerRow_('A:wd:l:' + status + ':', pg.page, pg.pages, 'A:home'));
  kb.unshift([btn_('⏳ در انتظار', 'A:wd:l:pending:1'), btn_('📋 همه', 'A:wd:l:all:1')]);
  editOrSend_(ctx, head + 'تعداد نمایش: <b>' + pg.total + '</b>', kb);
}

function adminWithdrawView_(ctx, id) {
  var w = withdrawById_(id);
  if (!w) { editOrSend_(ctx, '❌ درخواست یافت نشد.', adminBackKb_([], 'A:wd')); return; }
  var user = getUser_(w.user_id);
  var text = '💸 <b>درخواست برداشت #' + s_(w.id) + '</b>\n\n' +
    '💰 مبلغ: <b>' + money_(w.amount) + '</b>\n' +
    '🏦 مقصد: <code>' + esc_(w.dest) + '</code>\n' +
    '📌 وضعیت: <b>' + (WD_STATUS_FA[s_(w.status)] || s_(w.status)) + '</b>\n' +
    '🗓 ثبت: ' + jDateTime_(w.created_at) + '\n' +
    (s_(w.processed_at) ? '✅ بررسی: ' + jDateTime_(w.processed_at) + '\n' : '') +
    (s_(w.note) ? '📝 یادداشت: ' + esc_(w.note) + '\n' : '') +
    '\n👤 کاربر: ' + esc_(user ? userLabel_(user) : s_(w.user_id)) +
    '\n💳 موجودی فعلی: <b>' + money_(walletOf_(w.user_id).balance) + '</b>';
  var kb = [];
  if (s_(w.status) === 'pending') {
    kb.push([btn_('✅ تأیید و واریز', 'A:wd:ok:' + s_(w.id)), btn_('❌ رد درخواست', 'A:wd:no:' + s_(w.id))]);
  }
  kb.push([btn_('👤 پروفایل کاربر', 'A:usr:v:' + s_(w.user_id))]);
  kb.push([btn_(b_('back'), 'A:wd:l:pending:1')]);
  editOrSend_(ctx, text, kb);
}

function adminWithdrawApprove_(ctx, id) {
  var w = withdrawById_(id);
  if (!w) { editOrSend_(ctx, '❌ درخواست یافت نشد.', adminBackKb_([], 'A:wd')); return; }
  if (s_(w.status) !== 'pending') { editOrSend_(ctx, 'ℹ️ این درخواست قبلاً بررسی شده است.', adminBackKb_([], 'A:wd')); return; }
  patchRow_('Withdrawals', w.__row, {
    status: 'approved', processed_at: nowIso_(), handled_by: ctx.userId
  });
  logInfo_('withdraw_approved', ctx.userId, 'درخواست برداشت تأیید شد', { id: s_(id), amount: num_(w.amount) });
  tgSendMessage_(w.user_id, t_('withdraw_approved', { amount: money_(w.amount) }), {});
  editOrSend_(ctx, '✅ درخواست برداشت #' + s_(id) + ' تأیید شد.\n' +
    'مبلغ در زمان ثبت درخواست از موجودی کاربر کسر شده بود.', adminBackKb_([], 'A:wd:l:pending:1'));
}

function adminWithdrawReject_(ctx, id, reason) {
  var w = withdrawById_(id);
  if (!w) { send_(ctx.chatId, '❌ درخواست یافت نشد.', { kb: adminBackKb_([], 'A:wd') }); return; }
  if (s_(w.status) !== 'pending') { send_(ctx.chatId, 'ℹ️ این درخواست قبلاً بررسی شده است.', { kb: adminBackKb_([], 'A:wd') }); return; }
  var note = (s_(reason) === '-' || !s_(reason)) ? '' : s_(reason);
  changeBalance_(w.user_id, num_(w.amount), 'withdraw_refund', 'بازگشت مبلغ برداشت رد‌شده #' + s_(id), s_(id));
  patchRow_('Withdrawals', w.__row, {
    status: 'rejected', processed_at: nowIso_(), handled_by: ctx.userId, note: note
  });
  logInfo_('withdraw_rejected', ctx.userId, 'درخواست برداشت رد شد و مبلغ برگشت', { id: s_(id) });
  tgSendMessage_(w.user_id, t_('withdraw_rejected', {
    amount: money_(w.amount),
    reason: note ? ('📝 دلیل: ' + esc_(note)) : ''
  }) + '\n💳 مبلغ به کیف پول شما بازگشت.', {});
  send_(ctx.chatId, '❌ درخواست #' + s_(id) + ' رد شد و مبلغ به کیف پول کاربر بازگشت.', {
    kb: adminBackKb_([], 'A:wd:l:pending:1')
  });
}

/* ========================== ADMIN · BROADCAST ========================== */

function adminBroadcastMenu_(ctx) {
  var saved = prop_('BC_TEXT', '');
  var offset = int_(prop_('BC_OFFSET', '0'));
  var text = '📣 <b>ارسال همگانی</b>\n\n' +
    '👥 مخاطبان: <b>' + countRows_('Users') + '</b> کاربر\n' +
    '📦 حداکثر ارسال در هر اجرا: <b>' + BROADCAST_MAX_PER_RUN + '</b>\n\n' +
    (saved ? '📝 <b>آخرین پیام ذخیره‌شده:</b>\n' + esc_(truncate_(saved, 500)) + '\n\n' : '') +
    (offset > 0 ? '⏸ ارسال ناتمام از ردیف <b>' + offset + '</b>\n\n' : '') +
    '<i>ارسال با فاصله زمانی انجام می‌شود تا محدودیت تلگرام رعایت شود.</i>';
  var kb = [[btn_('✍️ پیام جدید', 'A:bc:new')]];
  if (saved) kb.push([btn_('🚀 ارسال همان پیام از ابتدا', 'A:bc:go')]);
  if (saved && offset > 0) kb.push([btn_('▶️ ادامه ارسال', 'A:bc:cont')]);
  editOrSend_(ctx, text, adminBackKb_(kb));
}

function adminBroadcastPreview_(ctx, msg) {
  var text = s_(msg.text);
  if (!text.trim()) { send_(ctx.chatId, '⚠️ فقط پیام متنی پشتیبانی می‌شود. دوباره ارسال کنید.' + HINT_CANCEL, {}); return; }
  clearState_(ctx.userId);
  setProp_('BC_TEXT', text);
  setProp_('BC_OFFSET', '0');
  var users = countRows_('Users');
  send_(ctx.chatId, '👁 <b>پیش‌نمایش پیام همگانی</b>\n' +
    '───────────────\n' + text + '\n───────────────\n' +
    '👥 گیرندگان: <b>' + users + '</b>\n\nارسال شود؟', {
    kb: [[btn_('🚀 بله، ارسال کن', 'A:bc:go')], [btn_('انصراف', 'A:bc')]]
  });
}

function adminBroadcastRun_(ctx, resume) {
  var text = prop_('BC_TEXT', '');
  if (!text) { editOrSend_(ctx, '⚠️ پیامی برای ارسال ذخیره نشده است.', adminBackKb_([], 'A:bc')); return; }
  var users = allRows_('Users');
  var start = resume ? int_(prop_('BC_OFFSET', '0')) : 0;
  if (start >= users.length) start = 0;
  var end = Math.min(users.length, start + BROADCAST_MAX_PER_RUN);
  editOrSend_(ctx, '🚀 ارسال آغاز شد...\nاز ردیف <b>' + (start + 1) + '</b> تا <b>' + end + '</b>', []);

  /* Sent in concurrent chunks (fetchAll) instead of one blocking fetch per
   * user. A short pause between chunks keeps us inside Telegram's ~30 msg/s
   * limit, but a 1000-user broadcast now takes seconds, not minutes. */
  var sent = 0, failed = 0, skipped = 0;
  var batch = [];
  for (var i = start; i < end; i++) {
    var u = users[i];
    if (bool_(u.is_blocked)) { skipped++; continue; }
    batch.push({
      method: 'sendMessage',
      payload: {
        chat_id: u.user_id, text: text, parse_mode: 'HTML',
        disable_web_page_preview: true
      }
    });
    if (batch.length >= BROADCAST_CHUNK) {
      tgAll_(batch).forEach(function (r) { if (r && r.ok) sent++; else failed++; });
      batch = [];
      Utilities.sleep(BROADCAST_SLEEP_MS);
    }
  }
  if (batch.length) {
    tgAll_(batch).forEach(function (r) { if (r && r.ok) sent++; else failed++; });
  }
  setProp_('BC_OFFSET', end);
  var remaining = users.length - end;
  logInfo_('broadcast', ctx.userId, 'ارسال همگانی انجام شد', {
    sent: sent, failed: failed, skipped: skipped, from: start, to: end
  });
  var kb = [];
  if (remaining > 0) kb.push([btn_('▶️ ادامه ارسال (' + remaining + ' نفر)', 'A:bc:cont')]);
  kb.push([btn_('📣 ارسال همگانی', 'A:bc')]);
  send_(ctx.chatId, '📊 <b>گزارش ارسال همگانی</b>\n\n' +
    '✅ ارسال موفق: <b>' + sent + '</b>\n' +
    '❌ ناموفق: <b>' + failed + '</b>\n' +
    '⛔️ رد‌شده (مسدود): <b>' + skipped + '</b>\n' +
    '⏳ باقی‌مانده: <b>' + remaining + '</b>', { kb: kb });
}

/* =========================== ADMIN · SETTINGS ========================== */

var SETTING_META = [
  { key: 'bot_title', label: 'نام ربات', type: 'text' },
  { key: 'currency', label: 'واحد پول', type: 'text' },
  { key: 'support_username', label: 'یوزرنیم پشتیبانی', type: 'text' },
  { key: 'maintenance', label: 'حالت تعمیر', type: 'bool' },
  { key: 'payment_enabled', label: 'پرداخت کارت به کارت', type: 'bool' },
  { key: 'card_number', label: 'شماره کارت', type: 'text' },
  { key: 'card_holder', label: 'نام صاحب حساب', type: 'text' },
  { key: 'payment_note', label: 'توضیح پرداخت', type: 'text' },
  { key: 'wallet_enabled', label: 'کیف پول', type: 'bool' },
  { key: 'min_withdraw', label: 'حداقل مبلغ برداشت', type: 'number' },
  { key: 'test_enabled', label: 'سرویس تست', type: 'bool' },
  { key: 'test_cooldown_hours', label: 'فاصله مجاز تست (ساعت)', type: 'number' },
  { key: 'referral_enabled', label: 'زیرمجموعه‌گیری', type: 'bool' },
  { key: 'referral_percent', label: 'درصد پورسانت', type: 'number' },
  { key: 'channel_required', label: 'عضویت اجباری کانال', type: 'bool' },
  { key: 'state_timeout_min', label: 'انقضای عملیات چندمرحله‌ای (دقیقه)', type: 'number' },
  { key: 'admin_notify', label: 'اطلاع‌رسانی به مدیران', type: 'bool' }
];

function settingMeta_(key) {
  for (var i = 0; i < SETTING_META.length; i++) if (SETTING_META[i].key === key) return SETTING_META[i];
  return null;
}

function adminSettingsMenu_(ctx, page) {
  var pg = paginate_(SETTING_META, page, 9);
  var text = '⚙️ <b>تنظیمات ربات</b>\n\n';
  var kb = [];
  pg.items.forEach(function (m) {
    var value = getSetting_(m.key, '');
    if (m.type === 'bool') {
      text += (bool_(value) ? '🟢 ' : '🔴 ') + m.label + '\n';
      kb.push([btn_((bool_(value) ? '🟢 ' : '🔴 ') + m.label, 'A:set:t:' + m.key)]);
    } else {
      var shown = m.type === 'number' ? comma_(value) : truncate_(s_(value) || '—', 30);
      text += '• ' + m.label + ': <b>' + esc_(shown) + '</b>\n';
      kb.push([btn_('✏️ ' + m.label, 'A:set:e:' + m.key)]);
    }
  });
  text += '\n<i>مقادیر بلافاصله اعمال می‌شوند.</i>';
  kb = kb.concat(pagerRow_('A:set:l:', pg.page, pg.pages, 'A:home'));
  editOrSend_(ctx, text, kb);
}

function adminSettingAsk_(ctx, key) {
  var meta = settingMeta_(key);
  if (!meta) { editOrSend_(ctx, '❌ تنظیم نامعتبر است.', adminBackKb_([], 'A:set')); return; }
  setState_(ctx.userId, 'a.set', { key: key });
  send_(ctx.chatId, '⚙️ مقدار جدید برای <b>' + meta.label + '</b> را ارسال کنید.\n' +
    'مقدار فعلی: <code>' + esc_(getSetting_(key, '—')) + '</code>' +
    (meta.type === 'number' ? '\n<i>فقط عدد ارسال کنید.</i>' : '') + HINT_CANCEL, {});
}

function adminSaveSetting_(ctx, key, text) {
  var meta = settingMeta_(key);
  if (!meta) { send_(ctx.chatId, '❌ تنظیم نامعتبر است.', { kb: adminBackKb_([], 'A:set') }); return; }
  var value = s_(text).trim();
  if (meta.type === 'number') {
    if (num_(value) < 0 || (value !== '0' && !num_(value))) {
      send_(ctx.chatId, '⚠️ عدد نامعتبر است. تغییری ثبت نشد.', { kb: adminBackKb_([], 'A:set') });
      return;
    }
    value = String(int_(value));
  }
  if (meta.type === 'bool') value = bool_(value) ? '1' : '0';
  setSetting_(key, value);
  logInfo_('admin_setting', ctx.userId, 'تنظیم تغییر کرد', { key: key });
  send_(ctx.chatId, '✅ <b>' + meta.label + '</b> ذخیره شد.\nمقدار جدید: <code>' + esc_(value) + '</code>', {
    kb: adminBackKb_([[btn_('⚙️ تنظیمات', 'A:set')]], 'A:home')
  });
}

function adminSettingToggle_(ctx, key) {
  var meta = settingMeta_(key);
  if (!meta || meta.type !== 'bool') { editOrSend_(ctx, '❌ تنظیم نامعتبر است.', adminBackKb_([], 'A:set')); return; }
  var next = getBool_(key, false) ? '0' : '1';
  setSetting_(key, next);
  logInfo_('admin_setting_toggle', ctx.userId, 'تنظیم سوییچ شد', { key: key, value: next });
  editOrSend_(ctx, '✅ <b>' + meta.label + '</b> ' + (next === '1' ? '🟢 فعال' : '🔴 غیرفعال') + ' شد.',
    adminBackKb_([[btn_('⚙️ تنظیمات', 'A:set')]], 'A:home'));
}

/* ======================= ADMIN · TEXTS AND BUTTONS ===================== */

var TEXT_LABEL_FA = {
  welcome: 'پیام خوش‌آمدگویی',
  main_menu: 'متن منوی اصلی',
  maintenance: 'پیام حالت تعمیر',
  blocked: 'پیام کاربر مسدود',
  buy_intro: 'متن صفحه خرید',
  no_service: 'پیام نبودن سرویس',
  payment_instructions: 'راهنمای پرداخت',
  receipt_ask: 'درخواست رسید',
  receipt_received: 'تأیید دریافت رسید',
  order_approved: 'تأیید سفارش',
  order_rejected: 'رد سفارش',
  config_delivered: 'پیام تحویل سرویس',
  my_services_empty: 'خالی بودن سرویس‌های من',
  test_intro: 'متن سرویس تست',
  test_requested: 'ثبت درخواست تست',
  test_cooldown: 'پیام محدودیت تست',
  guide_intro: 'متن راهنمای اتصال',
  referral_info: 'متن زیرمجموعه‌گیری',
  wallet_info: 'متن کیف پول',
  withdraw_ask_amount: 'درخواست مبلغ برداشت',
  channel_join: 'پیام عضویت کانال',
  discount_ask: 'درخواست کد تخفیف',
  error_generic: 'پیام خطای عمومی',
  unknown: 'پیام دستور ناشناخته'
};

function textLabel_(key) { return TEXT_LABEL_FA[key] || key; }

function adminContentMenu_(ctx) {
  var overrides = 0;
  var map = settingsMap_();
  Object.keys(map).forEach(function (k) {
    if (k.indexOf('txt.') === 0 || k.indexOf('btn.') === 0) overrides++;
  });
  editOrSend_(ctx, '📝 <b>متن‌ها و دکمه‌ها</b>\n\n' +
    'متن‌های قابل ویرایش: <b>' + TEXT_KEYS.length + '</b>\n' +
    'دکمه‌های قابل ویرایش: <b>' + BUTTON_KEYS.length + '</b>\n' +
    'موارد سفارشی‌شده: <b>' + overrides + '</b>\n\n' +
    '<i>در متن‌ها می‌توانید از متغیرهایی مثل {name}، {amount}، {link} استفاده کنید. ' +
    'با حذف مقدار سفارشی، متن پیش‌فرض برمی‌گردد.</i>', adminBackKb_([
    [btn_('✍️ ویرایش متن‌ها', 'A:txt:l:1')],
    [btn_('🔘 ویرایش دکمه‌ها', 'A:btn:l:1')]
  ]));
}

function adminTextList_(ctx, page) {
  var pg = paginate_(TEXT_KEYS, page, 8);
  var kb = pg.items.map(function (k) {
    var custom = getSetting_('txt.' + k, '') !== '';
    return [btn_((custom ? '✏️ ' : '• ') + textLabel_(k), 'A:txt:e:' + k)];
  });
  kb = kb.concat(pagerRow_('A:txt:l:', pg.page, pg.pages, 'A:txt'));
  editOrSend_(ctx, '✍️ <b>ویرایش متن‌ها</b>\n\nمتن مورد نظر را انتخاب کنید.\n' +
    '(✏️ = سفارشی‌شده)', kb);
}

function adminTextAsk_(ctx, key) {
  if (DEFAULT_TEXTS[key] === undefined) { editOrSend_(ctx, '❌ کلید متن نامعتبر است.', adminBackKb_([], 'A:txt')); return; }
  setState_(ctx.userId, 'a.txt', { key: key });
  var current = t_(key);
  send_(ctx.chatId, '✍️ <b>' + textLabel_(key) + '</b>\n\n<b>متن فعلی:</b>\n───────\n' + current +
    '\n───────\n\nمتن جدید را ارسال کنید. برای بازگشت به متن پیش‌فرض عدد <code>0</code> را بفرستید.' + HINT_CANCEL, {});
}

function adminSaveText_(ctx, key, newText) {
  if (DEFAULT_TEXTS[key] === undefined) { send_(ctx.chatId, '❌ کلید متن نامعتبر است.', { kb: adminBackKb_([], 'A:txt') }); return; }
  var value = s_(newText);
  if (value.trim() === '0') {
    setSetting_('txt.' + key, '');
    send_(ctx.chatId, '♻️ متن <b>' + textLabel_(key) + '</b> به حالت پیش‌فرض بازگشت.', {
      kb: adminBackKb_([[btn_('✍️ متن‌ها', 'A:txt:l:1')]], 'A:txt')
    });
    return;
  }
  setSetting_('txt.' + key, value);
  logInfo_('admin_text_edit', ctx.userId, 'متن ربات تغییر کرد', { key: key });
  send_(ctx.chatId, '✅ متن <b>' + textLabel_(key) + '</b> ذخیره شد.\n\n<b>پیش‌نمایش:</b>\n' + t_(key), {
    kb: adminBackKb_([[btn_('✍️ متن‌ها', 'A:txt:l:1')], [btn_('♻️ بازگشت به پیش‌فرض', 'A:txt:r:' + key)]], 'A:txt')
  });
}

function adminTextReset_(ctx, key) {
  if (DEFAULT_TEXTS[key] === undefined) { editOrSend_(ctx, '❌ کلید متن نامعتبر است.', adminBackKb_([], 'A:txt')); return; }
  setSetting_('txt.' + key, '');
  editOrSend_(ctx, '♻️ متن <b>' + textLabel_(key) + '</b> به حالت پیش‌فرض بازگشت.', adminBackKb_([
    [btn_('✍️ متن‌ها', 'A:txt:l:1')]
  ], 'A:txt'));
}

function adminButtonList_(ctx, page) {
  var pg = paginate_(BUTTON_KEYS, page, 8);
  var kb = pg.items.map(function (k) {
    var custom = getSetting_('btn.' + k, '') !== '';
    return [btn_((custom ? '✏️ ' : '• ') + b_(k), 'A:btn:e:' + k)];
  });
  kb = kb.concat(pagerRow_('A:btn:l:', pg.page, pg.pages, 'A:txt'));
  editOrSend_(ctx, '🔘 <b>ویرایش دکمه‌ها</b>\n\nدکمه مورد نظر را انتخاب کنید.\n' +
    '<i>پس از تغییر دکمه‌های منوی اصلی، ربات همچنان پایدار می‌ماند و /start منو را بازسازی می‌کند.</i>', kb);
}

function adminButtonAsk_(ctx, key) {
  if (DEFAULT_BUTTONS[key] === undefined) { editOrSend_(ctx, '❌ کلید دکمه نامعتبر است.', adminBackKb_([], 'A:btn:l:1')); return; }
  setState_(ctx.userId, 'a.btn', { key: key });
  send_(ctx.chatId, '🔘 برچسب جدید دکمه را ارسال کنید.\n' +
    'برچسب فعلی: <b>' + esc_(b_(key)) + '</b>\n' +
    'پیش‌فرض: <b>' + esc_(DEFAULT_BUTTONS[key]) + '</b>\n' +
    'برای بازگشت به پیش‌فرض عدد <code>0</code> را بفرستید.' + HINT_CANCEL, {});
}

function adminSaveButton_(ctx, key, text) {
  if (DEFAULT_BUTTONS[key] === undefined) { send_(ctx.chatId, '❌ کلید دکمه نامعتبر است.', { kb: adminBackKb_([], 'A:btn:l:1') }); return; }
  var value = s_(text).trim();
  if (value === '0') {
    setSetting_('btn.' + key, '');
    send_(ctx.chatId, '♻️ برچسب دکمه به پیش‌فرض بازگشت: <b>' + esc_(DEFAULT_BUTTONS[key]) + '</b>', {
      kb: adminBackKb_([[btn_('🔘 دکمه‌ها', 'A:btn:l:1')]], 'A:txt')
    });
    return;
  }
  if (value.length > 40) { send_(ctx.chatId, '⚠️ برچسب دکمه باید کوتاه‌تر از ۴۰ کاراکتر باشد.', { kb: adminBackKb_([], 'A:btn:l:1') }); return; }
  setSetting_('btn.' + key, value);
  logInfo_('admin_button_edit', ctx.userId, 'برچسب دکمه تغییر کرد', { key: key });
  send_(ctx.chatId, '✅ برچسب دکمه ذخیره شد: <b>' + esc_(value) + '</b>', {
    kb: adminBackKb_([[btn_('🔘 دکمه‌ها', 'A:btn:l:1')]], 'A:txt')
  });
  sendMenu_(ctx.chatId, '🔄 منوی اصلی بروزرسانی شد.', ctx.userId);
}

function adminButtonReset_(ctx, key) {
  if (DEFAULT_BUTTONS[key] === undefined) { editOrSend_(ctx, '❌ کلید دکمه نامعتبر است.', adminBackKb_([], 'A:btn:l:1')); return; }
  setSetting_('btn.' + key, '');
  editOrSend_(ctx, '♻️ برچسب دکمه به پیش‌فرض بازگشت.', adminBackKb_([[btn_('🔘 دکمه‌ها', 'A:btn:l:1')]], 'A:txt'));
}

/* ============================ ADMIN · ADMINS =========================== */

function adminAdminsMenu_(ctx) {
  var roots = rootAdminIds_();
  var extras = extraAdminIds_();
  var text = '👮 <b>مدیران ربات</b>\n\n<b>مدیران اصلی (از Script Properties):</b>\n';
  if (!roots.length) text += '—\n';
  roots.forEach(function (id) {
    var u = getUser_(id);
    text += '• <code>' + esc_(id) + '</code> ' + (u ? '— ' + esc_(userName_(u)) : '') + '\n';
  });
  text += '\n<b>مدیران افزوده‌شده از پنل:</b>\n';
  if (!extras.length) text += '—\n';
  extras.forEach(function (id) {
    var u = getUser_(id);
    text += '• <code>' + esc_(id) + '</code> ' + (u ? '— ' + esc_(userName_(u)) : '') + '\n';
  });
  text += '\n<i>مدیران اصلی فقط از طریق Script Properties قابل تغییر هستند.</i>';
  var kb = [[btn_('➕ افزودن مدیر', 'A:adm:add')]];
  extras.forEach(function (id) {
    kb.push([btn_('🗑 حذف مدیر ' + id, 'A:adm:del:' + id)]);
  });
  editOrSend_(ctx, text, adminBackKb_(kb));
}

function adminAddAdmin_(ctx, text) {
  var id = s_(text).trim();
  if (!/^\d{5,15}$/.test(id)) {
    send_(ctx.chatId, '⚠️ شناسه نامعتبر است. فقط عدد ارسال کنید.', { kb: adminBackKb_([], 'A:adm') });
    return;
  }
  if (isAdmin_(id)) { send_(ctx.chatId, 'ℹ️ این کاربر از قبل مدیر است.', { kb: adminBackKb_([], 'A:adm') }); return; }
  var extras = extraAdminIds_();
  extras.push(id);
  setSetting_('admins', uniq_(extras).join(','));
  forgetAdminCache_();
  logInfo_('admin_add', ctx.userId, 'مدیر جدید اضافه شد', { target: id });
  send_(ctx.chatId, '✅ کاربر <code>' + esc_(id) + '</code> به مدیران اضافه شد.', { kb: adminBackKb_([], 'A:adm') });
  tgSendMessage_(id, '👮 شما به‌عنوان مدیر ربات انتخاب شدید.\nبرای ورود به پنل، دستور /admin را بفرستید.', {});
}

function adminRemoveAdmin_(ctx, id) {
  if (isRootAdmin_(id)) {
    editOrSend_(ctx, '⛔️ مدیر اصلی را نمی‌توان از پنل حذف کرد. از Script Properties استفاده کنید.',
      adminBackKb_([], 'A:adm'));
    return;
  }
  var extras = extraAdminIds_().filter(function (x) { return x !== s_(id); });
  setSetting_('admins', extras.join(','));
  forgetAdminCache_();
  logInfo_('admin_remove', ctx.userId, 'مدیر حذف شد', { target: s_(id) });
  editOrSend_(ctx, '🗑 دسترسی مدیریت کاربر <code>' + esc_(id) + '</code> حذف شد.', adminBackKb_([], 'A:adm'));
}

/* ========================= ADMIN · SYSTEM TOOLS ======================== */

function adminSystemMenu_(ctx) {
  editOrSend_(ctx, '🔧 <b>ابزارهای سیستم</b>\n\n' +
    '📛 نسخه برنامه: <b>' + APP_VERSION + '</b>\n' +
    '🏗 بیلد: <b>' + BUILD_VERSION + '</b>\n' +
    '🗄 نسخه دیتابیس: <b>' + SCHEMA_VERSION + '</b>\n' +
    '🕒 زمان سرور: ' + jDateTime_(new Date()) + '\n\n' +
    '<i>همه ابزارها امن هستند و اجرای چندباره آن‌ها مشکلی ایجاد نمی‌کند.</i>', adminBackKb_([
    [btn_('🩺 تشخیص کامل سیستم', 'A:health')],
    [btn_('🔍 بررسی سلامت اتصال‌ها', 'A:sys:hc')],
    [btn_('🧪 اجرای تست خودکار', 'A:sys:test')],
    [btn_('🛠 تعمیر دیتابیس', 'A:sys:repair')],
    [btn_('🔗 وضعیت وبهوک', 'A:sys:wh')],
    [btn_('♻️ تنظیم مجدد وبهوک', 'A:sys:setwh')],
    [btn_('⛔️ حذف وبهوک', 'A:sys:delwh')],
    [btn_('🧹 پاک‌سازی وضعیت کاربران', 'A:sys:clr')],
    [btn_('📚 کوتاه کردن لاگ‌ها', 'A:sys:logs')]
  ]));
}

function adminRunRepair_(ctx) {
  var report;
  try { report = repairDatabase(); }
  catch (err) { report = '❌ خطا در تعمیر: ' + s_(err && err.message); }
  logInfo_('admin_repair', ctx.userId, 'تعمیر دیتابیس اجرا شد', {});
  editOrSend_(ctx, report, adminBackKb_([], 'A:sys'));
}

/**
 * Runs the full connectivity health check from inside the bot.
 * The report contains no secrets, so it is safe to show in a chat.
 */
function adminRunHealthCheck_(ctx) {
  var report;
  try { report = healthCheck(); }
  catch (err) { report = '❌ خطا در بررسی سلامت: ' + s_(err && err.message); }
  editOrSend_(ctx, '<pre>' + esc_(truncate_(report, 3700)) + '</pre>',
    adminBackKb_([[btn_('🔄 بررسی مجدد', 'A:sys:hc')]], 'A:sys'));
}

function adminRunSelfTest_(ctx) {
  var report;
  try { report = selfTest(); }
  catch (err) { report = '❌ خطا در تست: ' + s_(err && err.message); }
  editOrSend_(ctx, report, adminBackKb_([], 'A:sys'));
}

function adminWebhookInfo_(ctx) {
  var info = tgGetWebhookInfo_();
  if (!info || !info.ok) {
    editOrSend_(ctx, '❌ دریافت وضعیت وبهوک ناموفق بود.', adminBackKb_([], 'A:sys'));
    return;
  }
  var r = info.result || {};
  var text = '🔗 <b>وضعیت وبهوک</b>\n\n' +
    '🌐 آدرس تنظیم‌شده: <b>' + (s_(r.url) ? '✅ دارد' : '❌ ندارد') + '</b>\n' +
    '☁️ معماری: <b>' + (workerUrl_() ? 'Cloudflare Worker (پیشنهادی)' : 'مستقیم روی Apps Script (قدیمی)') + '</b>\n' +
    '📥 آپدیت‌های در انتظار: <b>' + int_(r.pending_update_count) + '</b>\n' +
    '🔐 کلید Worker↔Apps Script: <b>' + (webhookSecret_() ? '✅ فعال' : '❌ تنظیم نشده') + '</b>\n' +
    '🔐 کلید Telegram↔Worker: <b>' + (telegramWebhookSecret_() ? '✅ فعال' : (workerUrl_() ? '❌ تنظیم نشده' : '—')) + '</b>\n' +
    '🔌 حداکثر اتصال: <b>' + int_(r.max_connections || 0) + '</b>\n' +
    (r.last_error_message ? '⚠️ آخرین خطا: <code>' + esc_(truncate_(sanitize_(r.last_error_message), 150)) + '</code>\n' : '✅ خطای اخیری ثبت نشده\n') +
    (r.last_error_date ? '🕒 زمان خطا: ' + jDateTime_(new Date(int_(r.last_error_date) * 1000)) + '\n' : '');
  editOrSend_(ctx, text, adminBackKb_([[btn_('♻️ تنظیم مجدد وبهوک', 'A:sys:setwh')]], 'A:sys'));
}

function adminSetWebhook_(ctx) {
  var report;
  try { report = setupWebhook(); }
  catch (err) { report = '❌ خطا: ' + s_(err && err.message); }
  logInfo_('admin_setwebhook', ctx.userId, 'وبهوک از پنل تنظیم شد', {});
  editOrSend_(ctx, report, adminBackKb_([[btn_('🔗 وضعیت وبهوک', 'A:sys:wh')]], 'A:sys'));
}

function adminDeleteWebhook_(ctx) {
  var res = tgDeleteWebhook_();
  logWarn_('admin_delwebhook', ctx.userId, 'وبهوک حذف شد', {});
  editOrSend_(ctx, (res && res.ok) ? '⛔️ وبهوک حذف شد. ربات تا تنظیم مجدد پاسخ نمی‌دهد.' : '❌ حذف وبهوک ناموفق بود.',
    adminBackKb_([[btn_('♻️ تنظیم مجدد وبهوک', 'A:sys:setwh')]], 'A:sys'));
}

function adminClearStates_(ctx) {
  /* Writes the three state columns for ALL stuck users as contiguous blocks
   * instead of one setValues() per user. */
  var stuck = findRows_('Users', function (u) { return s_(u.state) !== ''; });
  var cleared = stuck.length;
  if (cleared) {
    var headers = hdr_('Users');
    var i0 = headers.indexOf('state');
    /* Fast path only when the three columns really are adjacent (they are in
     * the shipped schema; an older repaired sheet might differ). */
    var adjacent = i0 !== -1 && headers[i0 + 1] === 'state_data' && headers[i0 + 2] === 'state_at';
    var sheet = sh_('Users');
    stuck.forEach(function (u) {
      if (adjacent) sheet.getRange(u.__row, i0 + 1, 1, 3).setValues([['', '', '']]);
      else patchRow_('Users', u.__row, { state: '', state_data: '', state_at: '' });
      u.state = ''; u.state_data = ''; u.state_at = '';
    });
  }
  logInfo_('admin_clear_states', ctx.userId, 'وضعیت کاربران پاک شد', { count: cleared });
  editOrSend_(ctx, '🧹 وضعیت چندمرحله‌ای <b>' + cleared + '</b> کاربر پاک شد.\n' +
    'هیچ کاربری در میانه فرآیند گیر نمی‌ماند.', adminBackKb_([], 'A:sys'));
}

function adminTrimLogs_(ctx) {
  var removed = trimLogs_();
  editOrSend_(ctx, '📚 <b>' + removed + '</b> ردیف لاگ قدیمی حذف شد.\n' +
    'تعداد لاگ فعلی: <b>' + countRows_('Logs') + '</b>', adminBackKb_([], 'A:sys'));
}

/* ========================== ADMIN · HEALTH PAGE ======================== */

function adminHealth_(ctx) {
  var d = diagnosticsData_();
  var text = '🩺 <b>سلامت سیستم</b>\n\n' +
    '🤖 اتصال ربات: <b>' + (d.bot_connected ? '✅ برقرار' : '❌ قطع') + '</b>\n' +
    '🏷 یوزرنیم ربات: <b>' + (d.bot_username ? '@' + esc_(d.bot_username) : '—') + '</b>\n' +
    '📄 اتصال گوگل شیت: <b>' + (d.sheets_connected ? '✅ برقرار' : '❌ قطع') + '</b>\n' +
    '🗄 وضعیت دیتابیس: <b>' + (d.db_ok ? '✅ سالم' : '⚠️ نیازمند تعمیر') + '</b>\n' +
    '🔗 وبهوک: <b>' + (d.webhook_set ? '✅ تنظیم‌شده' : '❌ تنظیم نشده') + '</b>\n' +
    '📥 آپدیت‌های در انتظار: <b>' + d.pending_updates + '</b>\n' +
    '🔐 کلید امنیتی وبهوک: <b>' + (d.secret_set ? '✅ فعال' : '❌ ندارد') + '</b>\n' +
    '🔒 سلامت قفل: <b>' + (d.lock_ok ? '✅ آزاد' : '⚠️ مشغول') + '</b>\n' +
    '🧾 آخرین آپدیت پردازش‌شده: <b>' + esc_(d.last_update_id || '—') + '</b>' +
    (d.last_update_at ? ' (' + jDateTime_(d.last_update_at) + ')' : '') + '\n' +
    '⚠️ آخرین خطای تلگرام: ' + (d.last_tg_error ? '<code>' + esc_(truncate_(d.last_tg_error, 140)) + '</code>' : '—') + '\n' +
    '🛠 حالت تعمیر: <b>' + (d.maintenance ? '🟢 فعال' : '🔴 غیرفعال') + '</b>\n\n' +
    '<b>📊 تعداد ردیف‌ها:</b>\n';
  SHEET_ORDER.forEach(function (name) {
    text += '• ' + name + ': <b>' + int_(d.rows[name]) + '</b>' + (d.missing_sheets.indexOf(name) !== -1 ? ' ⚠️ ناقص' : '') + '\n';
  });
  text += '\n📛 نسخه برنامه: <b>' + d.app_version + '</b>\n' +
    '🏗 بیلد: <b>' + d.build_version + '</b>\n' +
    '🗄 نسخه اسکیما: <b>' + d.schema_version + '</b> (ثبت‌شده: ' + d.schema_saved + ')\n' +
    '🕒 زمان سرور: ' + jDateTime_(d.time) + '\n\n' +
    '<i>هیچ اطلاعات محرمانه‌ای در این گزارش نمایش داده نمی‌شود.</i>';
  editOrSend_(ctx, truncate_(text, 3900), adminBackKb_([
    [btn_('🧪 اجرای تست خودکار', 'A:sys:test')],
    [btn_('🛠 تعمیر دیتابیس', 'A:sys:repair')],
    [btn_('🔗 وضعیت وبهوک', 'A:sys:wh')]
  ]));
}

/* ========================== SETUP & MAINTENANCE ======================== */
/*
 * THE SHORT VERSION — run these two functions from the Apps Script editor:
 *
 *   1. setup()          → creates everything, generates the secrets, and
 *                         prints exactly what is still missing.
 *   2. connect()        → registers the Telegram webhook once the Worker URL
 *                         is in place.
 *
 * Anything else (repairDatabase, healthCheck, selfTest) is optional
 * maintenance. See README.md for the full walkthrough.
 */

/** Every configuration key, whether it is required, and how to obtain it. */
var CONFIG_KEYS = [
  { key: 'BOT_TOKEN', required: true, secret: true,
    help: 'Token from @BotFather (looks like 8123456789:AA...).' },
  { key: 'ADMIN_IDS', required: true, secret: false,
    help: 'Your numeric Telegram id. Get it by sending /id to the bot, or use @userinfobot. Comma-separated for several admins.' },
  { key: 'SPREADSHEET_ID', required: true, secret: false,
    help: 'Created automatically by setup(). Do not edit by hand.' },
  { key: 'WEBHOOK_SECRET', required: true, secret: true,
    help: 'Generated automatically by setup(). Must equal the Worker secret APPS_SCRIPT_SECRET.' },
  { key: 'WEB_APP_URL', required: true, secret: false,
    help: 'Deploy > New deployment > Web app, then paste the /exec URL here.' },
  { key: 'WORKER_URL', required: true, secret: false,
    help: 'Public URL of your Cloudflare Worker, e.g. https://nexiup-telegram-gateway.<you>.workers.dev' },
  { key: 'TELEGRAM_WEBHOOK_SECRET', required: false, secret: true,
    help: 'Generated automatically. Must equal the Worker secret TELEGRAM_WEBHOOK_SECRET.' }
];

/**
 * Reports which configuration values are still missing.
 * Returns { ok, missing: [{key, help}], present: [key] } — never any secret value.
 */
function checkConfig() {
  var missing = [], present = [];
  CONFIG_KEYS.forEach(function (c) {
    if (prop_(c.key, '')) present.push(c.key);
    else if (c.required) missing.push({ key: c.key, help: c.help });
  });
  return { ok: missing.length === 0, missing: missing, present: present };
}

/**
 * ONE-TIME CONFIGURATION HELPER.
 *
 * Instead of clicking through the Script Properties UI you can call this once
 * from the editor, then DELETE the values from your call so they are not left
 * in the source:
 *
 *   configure({ BOT_TOKEN: '8123:AA...', ADMIN_IDS: '123456789' });
 *
 * Values are stored as Script Properties (encrypted at rest by Google) and
 * are never written to the spreadsheet or to any log.
 */
function configure(values) {
  if (!values || typeof values !== 'object') {
    return '❌ configure({ BOT_TOKEN: "...", ADMIN_IDS: "..." }) — pass an object.';
  }
  var known = CONFIG_KEYS.map(function (c) { return c.key; });
  var patch = {}, accepted = [], ignored = [];
  Object.keys(values).forEach(function (k) {
    if (known.indexOf(k) === -1) { ignored.push(k); return; }
    var v = s_(values[k]).trim();
    if (!v) return;
    patch[k] = v;
    accepted.push(k);
  });
  if (accepted.length) setProps_(patch);
  forgetAdminCache_();
  var lines = ['✅ Saved: ' + (accepted.join(', ') || '(nothing)')];
  if (ignored.length) lines.push('⚠️ Ignored unknown keys: ' + ignored.join(', '));
  var state = checkConfig();
  if (state.ok) lines.push('🎉 All required configuration is present. Next: run setup() then connect().');
  else lines.push('⏳ Still missing: ' + state.missing.map(function (m) { return m.key; }).join(', '));
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * Registers the Telegram webhook on the Cloudflare Worker.
 * Thin, friendly wrapper around setupWebhook() — this is the name used in the
 * README so a first-time installer only has to remember setup() + connect().
 */
function connect() { return setupWebhook(); }

/**
 * HEALTH CHECK — verifies every moving part of the deployment and returns a
 * human-readable report. Also available in the bot's admin panel
 * (🛠 پنل مدیریت → 🩺 سلامت سیستم) and as machine-readable getDiagnostics().
 *
 * Verifies: configuration, spreadsheet, Telegram/bot token, webhook
 * registration, and the live Cloudflare Worker endpoint.
 * Contains no secret values — safe to copy/paste when asking for help.
 */
function healthCheck() {
  var checks = [];
  function add(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: s_(detail) }); }

  /* --- 1. configuration ------------------------------------------------ */
  var cfg = checkConfig();
  CONFIG_KEYS.forEach(function (c) {
    var set = !!prop_(c.key, '');
    if (c.required || set) add('config: ' + c.key, set, set ? 'configured' : c.help);
  });

  /* --- 2. spreadsheet -------------------------------------------------- */
  var sheetsOk = true, missingBits = [];
  try {
    resetCaches_();
    ss_();
    SHEET_ORDER.forEach(function (name) {
      var sheet = ss_().getSheetByName(name);
      if (!sheet) { sheetsOk = false; missingBits.push(name); return; }
      var headers = hdr_(name);
      SCHEMA[name].forEach(function (col) {
        if (headers.indexOf(col) === -1) { sheetsOk = false; missingBits.push(name + '.' + col); }
      });
    });
  } catch (err) {
    sheetsOk = false;
    missingBits.push(s_(err && err.message));
  }
  add('spreadsheet reachable & schema complete', sheetsOk,
    sheetsOk ? SHEET_ORDER.length + ' sheets OK' : 'run repairDatabase() — ' + missingBits.join(', '));

  /* --- 3. Telegram bot ------------------------------------------------- */
  var me = tgGetMe_();
  add('Telegram bot token valid', !!(me && me.ok),
    (me && me.ok) ? '@' + s_(me.result.username) : s_(me && me.description));

  /* --- 4. webhook ------------------------------------------------------ */
  var info = tgGetWebhookInfo_();
  var r = (info && info.ok && info.result) ? info.result : {};
  var hookUrl = s_(r.url);
  add('webhook registered', !!hookUrl, hookUrl ? 'points at ' + hostOf_(hookUrl) : 'run connect()');
  var worker = workerUrl_();
  if (worker) {
    add('webhook points at the Worker', hookUrl.indexOf(worker.replace(/\/+$/, '')) === 0,
      hookUrl ? 'registered host: ' + hostOf_(hookUrl) : 'not registered');
  }
  add('no recent Telegram delivery error', !r.last_error_message,
    r.last_error_message ? truncate_(sanitize_(r.last_error_message), 160) : 'clean');
  add('webhook backlog is empty', int_(r.pending_update_count) === 0,
    int_(r.pending_update_count) + ' pending updates');

  /* --- 5. Cloudflare Worker (live probe) -------------------------------- */
  if (worker) {
    var probe = probeWorker_(worker);
    add('Cloudflare Worker responding', probe.ok, probe.detail);
  } else {
    add('Cloudflare Worker responding', false, 'WORKER_URL is not configured');
  }

  /* --- 6. secrets consistency ------------------------------------------ */
  add('Worker↔Apps Script secret set', !!webhookSecret_(),
    webhookSecret_() ? 'set (must match the Worker secret APPS_SCRIPT_SECRET)' : 'missing');
  add('Telegram↔Worker secret set', !!telegramWebhookSecret_(),
    telegramWebhookSecret_() ? 'set (must match the Worker secret TELEGRAM_WEBHOOK_SECRET)' : 'missing — run connect()');

  /* --- 7. admins -------------------------------------------------------- */
  add('at least one admin configured', allAdminIds_().length > 0, allAdminIds_().length + ' admin(s)');

  var passed = checks.filter(function (c) { return c.ok; }).length;
  var failed = checks.length - passed;

  var lines = ['🩺 ' + APP_NAME + ' health check', '   build ' + BUILD_VERSION + ' · ' + nowIso_(), ''];
  checks.forEach(function (c) {
    lines.push((c.ok ? '✅ ' : '❌ ') + c.name + (c.detail ? '  —  ' + c.detail : ''));
  });
  lines.push('');
  lines.push(failed === 0
    ? '🎉 ' + passed + '/' + checks.length + ' checks passed. The bot is fully operational.'
    : '⚠️ ' + failed + ' of ' + checks.length + ' checks failed — fix the ❌ lines above.');
  if (!cfg.ok) {
    lines.push('');
    lines.push('Missing configuration:');
    cfg.missing.forEach(function (m) { lines.push('  • ' + m.key + ': ' + m.help); });
  }
  var report = lines.join('\n');
  Logger.log(report);
  flushLogs_();
  return report;
}

/** Hostname of a URL, for logs/reports that must not echo query strings. */
function hostOf_(url) {
  var m = s_(url).match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1] : '(unknown)';
}

/** Live GET probe of the Worker's health endpoint. Never sends a secret. */
function probeWorker_(url) {
  try {
    var res = UrlFetchApp.fetch(s_(url), {
      method: 'get', muteHttpExceptions: true, followRedirects: true,
      validateHttpsCertificates: true
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) return { ok: false, detail: 'HTTP ' + code + ' from ' + hostOf_(url) };
    var body = parseJson_(res.getContentText(), {});
    if (body && body.service) return { ok: true, detail: body.service + ' @ ' + hostOf_(url) };
    return { ok: true, detail: 'HTTP ' + code + ' from ' + hostOf_(url) };
  } catch (err) {
    return { ok: false, detail: 'unreachable: ' + s_(err && err.message) };
  }
}

/** Drops every in-memory cache (used by setup/repair/diagnostics tools). */
function resetCaches_() {
  _ss = null;
  _shCache = {};
  _hdrCache = {};
  _table = {};
  _settingsCache = null;
  _adminIdsCache = null;
  _propsCache = null;
  invalidateSettingsCache_();
}

/**
 * STEP 1 OF THE INSTALL — run this from the Apps Script editor.
 *
 * Safe to run any number of times. It:
 *   • creates the database spreadsheet (only if SPREADSHEET_ID is empty),
 *   • creates/repairs every sheet and its headers,
 *   • seeds the default settings, sample service and sample guide,
 *   • generates both shared secrets if they do not exist yet,
 *   • prints a checklist of anything still missing.
 *
 * Existing data is never deleted or duplicated.
 */
function setup() {
  resetCaches_();
  var created = false;
  if (!spreadsheetId_()) {
    var book = SpreadsheetApp.create(APP_NAME + ' Database');
    setProp_('SPREADSHEET_ID', book.getId());
    created = true;
    var first = book.getSheets()[0];
    if (first && first.getName() === 'Sheet1' && book.getSheets().length === 1) {
      first.setName('Settings');
      first.clear();
      first.getRange(1, 1, 1, SCHEMA.Settings.length).setValues([SCHEMA.Settings]).setFontWeight('bold');
      first.setFrozenRows(1);
    }
    resetCaches_();
  }
  /* Both shared secrets are generated here so the installer can copy them
   * straight into Cloudflare — one batched property write. */
  var secretPatch = {};
  if (!webhookSecret_()) secretPatch.WEBHOOK_SECRET = randomToken_(40);
  if (!telegramWebhookSecret_()) secretPatch.TELEGRAM_WEBHOOK_SECRET = randomToken_(40);
  if (Object.keys(secretPatch).length) setProps_(secretPatch);

  SHEET_ORDER.forEach(function (name) { ensureSheet_(name); });
  resetCaches_();

  var seeded = seedDefaults_();
  setProp_('SCHEMA_VERSION', SCHEMA_VERSION);
  setSetting_('schema_version', SCHEMA_VERSION);

  var lines = [];
  lines.push('✅ ' + APP_NAME + ' database is ready.');
  lines.push('');
  lines.push('🗄  Spreadsheet : ' + ss_().getUrl());
  lines.push('📄  Sheets      : ' + SHEET_ORDER.length + ' (' + (created ? 'newly created' : 'existing data preserved') + ')');
  lines.push('⚙️  Settings    : ' + seeded.settings + ' default(s) added');
  lines.push('🛒  Sample data : service=' + (seeded.services ? 'added' : 'skipped') +
    ', guide=' + (seeded.guides ? 'added' : 'skipped'));
  lines.push('');

  /* The two values the installer must copy into Cloudflare. Printed here on
   * purpose — the Apps Script execution log is private to the project owner. */
  lines.push('🔐 COPY THESE TWO SECRETS INTO CLOUDFLARE');
  lines.push('   Run in the worker/ folder:');
  lines.push('     wrangler secret put APPS_SCRIPT_SECRET');
  lines.push('       → ' + webhookSecret_());
  lines.push('     wrangler secret put TELEGRAM_WEBHOOK_SECRET');
  lines.push('       → ' + telegramWebhookSecret_());
  lines.push('');

  var state = checkConfig();
  if (state.ok) {
    lines.push('🎉 All required configuration is present.');
    lines.push('');
    lines.push('NEXT STEP → run  connect()  to register the Telegram webhook,');
    lines.push('            then healthCheck() to verify everything end to end.');
  } else {
    lines.push('⏳ STILL TO DO — add these in Project Settings → Script Properties');
    lines.push('   (or call configure({ KEY: "value" }) from this editor):');
    state.missing.forEach(function (m) {
      lines.push('');
      lines.push('   • ' + m.key);
      lines.push('     ' + m.help);
    });
    lines.push('');
    lines.push('Then run setup() again, followed by connect() and healthCheck().');
  }
  var report = lines.join('\n');
  logInfo_('setup', '', 'setup executed', { created: created, seeded: seeded });
  Logger.log(report);
  flushLogs_();
  return report;
}

/** Backwards-compatible alias for installs that already use initialSetup(). */
function initialSetup() { return setup(); }

/** Inserts default rows only when they are missing. Never duplicates. */
function seedDefaults_() {
  var addedSettings = 0;
  var existing = settingsMap_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
    if (!existing.hasOwnProperty(key)) {
      appendRow_('Settings', { key: key, value: DEFAULT_SETTINGS[key], updated_at: nowIso_() });
      addedSettings++;
    }
  });
  _settingsCache = null;

  var servicesAdded = false;
  if (countRows_('Services') === 0 && prop_('SEED_SERVICES', '') !== 'done') {
    appendRow_('Services', {
      id: nextSeq_('Services'), name: 'سرویس یک‌ماهه ۵۰ گیگ',
      description: 'مناسب استفاده روزمره، پرسرعت و پایدار.',
      volume: '۵۰ گیگابایت', duration: '۳۰ روزه', price: 150000,
      is_active: '1', sort_order: 1, created_at: nowIso_()
    });
    appendRow_('Services', {
      id: nextSeq_('Services'), name: 'سرویس دوماهه ۱۰۰ گیگ',
      description: 'انتخاب اقتصادی برای مصرف بالا.',
      volume: '۱۰۰ گیگابایت', duration: '۶۰ روزه', price: 270000,
      is_active: '1', sort_order: 2, created_at: nowIso_()
    });
    setProp_('SEED_SERVICES', 'done');
    servicesAdded = true;
  }

  var guidesAdded = false;
  if (countRows_('Guides') === 0 && prop_('SEED_GUIDES', '') !== 'done') {
    appendRow_('Guides', {
      id: nextSeq_('Guides'), title: 'راهنمای اتصال در اندروید',
      content: '۱. اپلیکیشن مورد نظر را از گوگل‌پلی نصب کنید.\n' +
        '۲. کانفیگ دریافتی از ربات را کپی کنید.\n' +
        '۳. در اپلیکیشن روی افزودن از کلیپ‌بورد بزنید.\n' +
        '۴. اتصال را فعال کنید.\n\nدر صورت بروز مشکل با پشتیبانی در تماس باشید.',
      sort_order: 1, is_active: '1', created_at: nowIso_()
    });
    appendRow_('Guides', {
      id: nextSeq_('Guides'), title: 'راهنمای اتصال در آیفون',
      content: '۱. اپلیکیشن مورد نظر را از App Store نصب کنید.\n' +
        '۲. کانفیگ دریافتی را کپی کنید.\n' +
        '۳. در اپلیکیشن گزینه افزودن از کلیپ‌بورد را انتخاب کنید.\n' +
        '۴. اتصال را برقرار کنید.',
      sort_order: 2, is_active: '1', created_at: nowIso_()
    });
    setProp_('SEED_GUIDES', 'done');
    guidesAdded = true;
  }
  return { settings: addedSettings, services: servicesAdded, guides: guidesAdded };
}

/** Non-destructive schema repair: missing sheets, missing headers, missing defaults. */
function repairDatabase() {
  resetCaches_();
  var createdSheets = [];
  var repairedHeaders = [];
  SHEET_ORDER.forEach(function (name) {
    var before = ss_().getSheetByName(name);
    var cols = [];
    if (before) {
      var lastCol = Math.max(1, before.getLastColumn());
      cols = before.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return s_(h).trim(); });
    }
    ensureSheet_(name);
    if (!before) createdSheets.push(name);
    else {
      var missing = SCHEMA[name].filter(function (c) { return cols.indexOf(c) === -1; });
      if (missing.length) repairedHeaders.push(name + ' (' + missing.join(', ') + ')');
    }
  });
  resetCaches_();
  var seeded = seedDefaults_();
  var orphanWallets = 0;
  allRows_('Users').forEach(function (u) {
    if (!findOne_('Wallet', function (w) { return s_(w.user_id) === s_(u.user_id); })) {
      ensureWallet_(u.user_id);
      orphanWallets++;
    }
  });
  setProp_('SCHEMA_VERSION', SCHEMA_VERSION);
  setSetting_('schema_version', SCHEMA_VERSION);
  var report = '🛠 <b>تعمیر دیتابیس انجام شد</b>\n\n' +
    '🆕 شیت‌های ساخته‌شده: ' + (createdSheets.length ? createdSheets.join(', ') : 'هیچ') + '\n' +
    '🧩 ستون‌های ترمیم‌شده: ' + (repairedHeaders.length ? repairedHeaders.join(' | ') : 'هیچ') + '\n' +
    '⚙️ تنظیمات اضافه‌شده: ' + seeded.settings + '\n' +
    '👛 کیف پول‌های ساخته‌شده: ' + orphanWallets + '\n' +
    '🗄 نسخه اسکیما: ' + SCHEMA_VERSION + '\n\n' +
    '✅ هیچ داده‌ای حذف نشد.';
  logInfo_('repair_database', '', 'تعمیر دیتابیس اجرا شد', {
    created: createdSheets, headers: repairedHeaders, wallets: orphanWallets
  });
  Logger.log(report);
  flushLogs_();
  return report;
}

/**
 * Registers the Telegram webhook.
 *
 * Recommended architecture (avoids the Google Apps Script 302-redirect issue
 * that makes Telegram reject the webhook with "Wrong response ... 302 Found"):
 *
 *   Telegram → Cloudflare Worker (WORKER_URL) → this Web App (WEB_APP_URL)
 *
 * When Script Property WORKER_URL is set, the webhook is registered on the
 * Worker's public URL instead of the raw /exec URL, and Telegram is told to
 * send the secret as the "X-Telegram-Bot-Api-Secret-Token" header (validated
 * by the Worker, not by Apps Script). Apps Script keeps validating every
 * request coming from the Worker via the "?s=" query-string secret
 * (WEBHOOK_SECRET), exactly as before — no change to verifyRequest_().
 *
 * If WORKER_URL is NOT set, this falls back to the legacy direct mode
 * (webhook pointed straight at /exec). That legacy mode is known to break on
 * some Google accounts because POST /exec can return an HTTP 302 redirect to
 * script.googleusercontent.com, which Telegram refuses to follow. Prefer the
 * Worker-based setup described in the project README.
 */
function setupWebhook() {
  if (!botToken_()) return '❌ BOT_TOKEN تنظیم نشده است. ابتدا آن را در Script Properties وارد کنید.';

  var worker = workerUrl_();
  var res, me, hookTarget, usedWorker = false;

  if (worker) {
    usedWorker = true;
    if (!telegramWebhookSecret_()) setProp_('TELEGRAM_WEBHOOK_SECRET', randomToken_(40));
    var tgSecret = telegramWebhookSecret_();
    hookTarget = worker;
    res = tgSetWebhook_(hookTarget, tgSecret);
  } else {
    var url = webAppUrl_();
    if (!url) return '❌ نه WORKER_URL و نه WEB_APP_URL تنظیم نشده‌اند. آدرس Cloudflare Worker (روش پیشنهادی) یا در نبود آن آدرس /exec را در Script Properties ذخیره کنید.';
    if (url.indexOf('/exec') === -1) {
      return '❌ آدرس WEB_APP_URL باید نسخه production و به /exec ختم شود (نه /dev).';
    }
    if (!webhookSecret_()) setProp_('WEBHOOK_SECRET', randomToken_(40));
    var secret = webhookSecret_();
    hookTarget = url + (url.indexOf('?') === -1 ? '?' : '&') + 's=' + encodeURIComponent(secret);
    res = tgSetWebhook_(hookTarget, secret);
  }

  /* getMe + getWebhookInfo are independent — fetch them concurrently. */
  var post = tgAll_([{ method: 'getMe', payload: {} }, { method: 'getWebhookInfo', payload: {} }]);
  me = post[0];
  var info = post[1];
  if (me && me.ok && me.result && me.result.username) setProp_('BOT_USERNAME', me.result.username);
  var pending = (info && info.ok && info.result) ? int_(info.result.pending_update_count) : 0;
  var report;
  if (res && res.ok) {
    report = '✅ <b>وبهوک با موفقیت تنظیم شد</b>\n' +
      '🤖 ربات: @' + s_(me && me.ok ? me.result.username : '—') + '\n' +
      '🌐 مسیر: ' + (usedWorker ? 'Telegram → Cloudflare Worker → Apps Script (پیشنهادی)' : 'Telegram → Apps Script (مستقیم، حالت قدیمی)') + '\n' +
      '🔐 کلید امنیتی: فعال (مخفی)\n' +
      '📥 آپدیت‌های در انتظار: ' + pending + '\n\n' +
      (usedWorker ? '' : '⚠️ در این حالت اگر Google پاسخ 302 بدهد، Telegram خطای "Wrong response" می‌گیرد. WORKER_URL را تنظیم و دوباره اجرا کنید.\n\n') +
      'اکنون /start را در ربات بفرستید.';
  } else {
    report = '❌ تنظیم وبهوک ناموفق بود: ' + s_(res && res.description);
  }
  logInfo_('setup_webhook', '', 'تنظیم وبهوک اجرا شد', { ok: !!(res && res.ok), pending: pending, via_worker: usedWorker });
  Logger.log(report);
  flushLogs_();
  return report;
}

/** End-to-end health check. Safe to run repeatedly. */
function selfTest() {
  var lines = ['🧪 <b>تست خودکار ' + APP_NAME + '</b>', ''];
  var pass = 0, fail = 0;
  function check(label, ok, extra) {
    lines.push((ok ? '✅ ' : '❌ ') + label + (extra ? ' — ' + extra : ''));
    if (ok) pass++; else fail++;
  }
  check('BOT_TOKEN ثبت شده', !!botToken_());
  check('WEBHOOK_SECRET ثبت شده', !!webhookSecret_());
  check('ADMIN_IDS ثبت شده', rootAdminIds_().length > 0, rootAdminIds_().length + ' مدیر');
  check('WEB_APP_URL ثبت شده', !!webAppUrl_());
  check('WORKER_URL ثبت شده (معماری پیشنهادی)', !!workerUrl_());
  check('SPREADSHEET_ID ثبت شده', !!spreadsheetId_());

  var sheetsOk = true, missing = [];
  try {
    resetCaches_();
    SHEET_ORDER.forEach(function (name) {
      var sheet = ss_().getSheetByName(name);
      if (!sheet) { sheetsOk = false; missing.push(name); return; }
      var headers = hdr_(name);
      SCHEMA[name].forEach(function (col) {
        if (headers.indexOf(col) === -1) { sheetsOk = false; missing.push(name + '.' + col); }
      });
    });
  } catch (err) {
    sheetsOk = false;
    missing.push(s_(err && err.message));
  }
  check('اتصال گوگل شیت و ساختار جداول', sheetsOk, missing.length ? ('ناقص: ' + missing.join(', ')) : 'کامل');

  var writeOk = false;
  try {
    appendRow_('Logs', {
      created_at: nowIso_(), level: 'TEST', event: 'self_test',
      user_id: '', message: 'تست نوشتن و خواندن', data: ''
    });
    var sheet = sh_('Logs');
    var last = sheet.getRange(sheet.getLastRow(), 1, 1, hdr_('Logs').length).getValues()[0];
    writeOk = s_(last[2]) === 'self_test';
    if (writeOk) sheet.deleteRow(sheet.getLastRow());
  } catch (err2) { writeOk = false; }
  check('نوشتن و خواندن دیتابیس', writeOk);

  var me = tgGetMe_();
  check('اتصال به تلگرام (getMe)', !!(me && me.ok), me && me.ok ? '@' + s_(me.result.username) : s_(me && me.description));

  var info = tgGetWebhookInfo_();
  var whUrl = (info && info.ok && info.result) ? s_(info.result.url) : '';
  check('وبهوک تنظیم‌شده', !!whUrl);
  if (info && info.ok && info.result && info.result.last_error_message) {
    lines.push('⚠️ آخرین خطای تلگرام: ' + truncate_(sanitize_(info.result.last_error_message), 120));
  }
  check('تعداد سرویس فعال', activeServices_().length > 0, activeServices_().length + ' سرویس');
  check('تنظیمات پایه موجود', Object.keys(settingsMap_()).length >= 10);

  var lockOk = false;
  try {
    var lock = LockService.getScriptLock();
    lockOk = lock.tryLock(1000);
    if (lockOk) lock.releaseLock();
  } catch (err3) { lockOk = false; }
  check('سلامت سیستم قفل', lockOk);

  lines.push('');
  lines.push('📊 نتیجه: <b>' + pass + '</b> موفق | <b>' + fail + '</b> ناموفق');
  lines.push(fail === 0 ? '🎉 همه‌چیز آماده است.' : '⚠️ موارد ناموفق را برطرف کنید (initialSetup / setupWebhook).');
  var report = lines.join('\n');
  logInfo_('self_test', '', 'تست خودکار اجرا شد', { pass: pass, fail: fail });
  Logger.log(report);
  flushLogs_();
  return report;
}

/* ============================== DIAGNOSTICS ============================ */

function diagnosticsData_() {
  var data = {
    app: APP_NAME,
    app_version: APP_VERSION,
    build_version: BUILD_VERSION,
    schema_version: SCHEMA_VERSION,
    schema_saved: prop_('SCHEMA_VERSION', '—'),
    time: new Date(),
    bot_connected: false,
    bot_username: '',
    sheets_connected: false,
    db_ok: true,
    rows: {},
    missing_sheets: [],
    webhook_set: false,
    pending_updates: 0,
    secret_set: !!webhookSecret_(),
    token_set: !!botToken_(),
    worker_url_set: !!workerUrl_(),
    tg_secret_set: !!telegramWebhookSecret_(),
    admins: allAdminIds_().length,
    maintenance: getBool_('maintenance', false),
    last_update_id: prop_('LAST_UPDATE_ID', ''),
    last_update_at: prop_('LAST_UPDATE_AT', ''),
    last_tg_error: sanitize_(prop_('LAST_TG_ERROR', '')),
    lock_ok: false
  };
  var me = tgGetMe_();
  if (me && me.ok && me.result) {
    data.bot_connected = true;
    data.bot_username = s_(me.result.username);
    setProp_('BOT_USERNAME', data.bot_username);
  }
  try {
    resetCaches_();
    ss_();
    data.sheets_connected = true;
    SHEET_ORDER.forEach(function (name) {
      var sheet = ss_().getSheetByName(name);
      if (!sheet) { data.missing_sheets.push(name); data.db_ok = false; data.rows[name] = 0; return; }
      data.rows[name] = Math.max(0, sheet.getLastRow() - 1);
      var headers = hdr_(name);
      SCHEMA[name].forEach(function (col) {
        if (headers.indexOf(col) === -1) { data.db_ok = false; if (data.missing_sheets.indexOf(name) === -1) data.missing_sheets.push(name); }
      });
    });
  } catch (err) {
    data.sheets_connected = false;
    data.db_ok = false;
  }
  var info = tgGetWebhookInfo_();
  if (info && info.ok && info.result) {
    data.webhook_set = !!s_(info.result.url);
    data.pending_updates = int_(info.result.pending_update_count);
    if (info.result.last_error_message) {
      data.last_tg_error = sanitize_(s_(info.result.last_error_message));
    }
  }
  try {
    var lock = LockService.getScriptLock();
    data.lock_ok = lock.tryLock(500);
    if (data.lock_ok) lock.releaseLock();
  } catch (err2) { data.lock_ok = false; }
  return data;
}

/** Public diagnostics. Contains no secrets, only booleans and counters. */
function getDiagnostics() {
  var d = diagnosticsData_();
  var safe = {
    app: d.app,
    app_version: d.app_version,
    build_version: d.build_version,
    schema_version: d.schema_version,
    schema_saved: d.schema_saved,
    time: iso_(d.time),
    bot_connected: d.bot_connected,
    bot_username: d.bot_username,
    sheets_connected: d.sheets_connected,
    database_ok: d.db_ok,
    missing_or_incomplete_sheets: d.missing_sheets,
    rows: d.rows,
    webhook_set: d.webhook_set,
    pending_updates: d.pending_updates,
    webhook_secret_configured: d.secret_set,
    bot_token_configured: d.token_set,
    worker_url_configured: d.worker_url_set,
    telegram_webhook_secret_configured: d.tg_secret_set,
    admin_count: d.admins,
    maintenance_mode: d.maintenance,
    last_processed_update_id: d.last_update_id,
    last_processed_update_at: d.last_update_at,
    last_telegram_error: d.last_tg_error,
    lock_healthy: d.lock_ok
  };
  Logger.log(json_(safe));
  return safe;
}

/** Convenience: prints the current version triplet. */
function versionInfo() {
  var info = APP_NAME + ' ' + APP_VERSION + ' | build ' + BUILD_VERSION + ' | schema ' + SCHEMA_VERSION;
  Logger.log(info);
  return info;
}
