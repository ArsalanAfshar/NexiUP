/**
 * ============================================================================
 * PROJECT: NexiUP | نکسی آپ
 * VERSION: 1.0.0
 * LICENSE: MIT
 * REPOSITORY: https://github.com/ArsalanAfshar/NexiUP
 * DESCRIPTION:
 *   Production-ready, high-performance, single-file Telegram bot for selling
 *   and managing subscription services with manual payment verification and
 *   manual delivery. Built for Cloudflare Workers (ES Module) + Cloudflare D1.
 * ============================================================================
 *
 * TABLE OF CONTENTS:
 * ----------------------------------------------------------------------------
 * 1. CONFIG & BRANDING
 * 2. DATABASE LAYER & MIGRATIONS
 * 3. TELEGRAM API CLIENT & HELPERS
 * 4. TEXTS & LOCALIZATION (WITH D1 OVERRIDES)
 * 5. KEYBOARDS & NAVIGATION BUILDERS
 * 6. FORCED CHANNEL JOIN LOGIC
 * 7. USER FLOWS & MENUS
 * 8. WALLET & PAYMENT PROCESSING (ATOMIC TRANSACTIONS, LEDGER)
 * 9. ADMIN PANEL & SUBMENUS
 * 10. ADMIN STATISTICS DASHBOARD
 * 11. COUPONS & SALES BOOSTERS
 * 12. BROADCAST SYSTEM (QUEUE & BATCH PROCESSING)
 * 13. CRON / SCHEDULED TASKS & MAINTENANCE
 * 14. DIAGNOSTICS & SYSTEM TOOLS (BACKUP & RESTORE)
 * 15. ROUTER & REQUEST HANDLERS
 * ============================================================================
 */

// ============================================================================
// SECTION 1: CONFIG & BRANDING
// ============================================================================

export const VERSION = '1.0.0';

export const DEFAULT_BRAND = {
  name: 'NexiUP | نکسی آپ',
  short_name: 'NexiUP',
  support_id: '@NexiUP_Support',
  currency: 'تومان',
  default_referral_percent: 10,
  test_cooldown_hours: 24,
  order_timeout_minutes: 120,
  min_withdrawal: 50000,
  max_pending_orders: 3,
  first_purchase_discount_percent: 0, // 0 = disabled
  wallet_topup_bonus_percent: 0,      // 0 = disabled
  forced_join_enabled: 1,
  strict_forced_join: 0,
  maintenance_mode: 0,
  maintenance_message: '🛠 ربات در حال حاضر در حالت بروزرسانی و ارتقای فنی است.\nلطفاً دقایقی دیگر مجدداً مراجعه فرمایید.',
  pinned_announcement: '',
  daily_report_hour: 20 // 20:00 UTC (~ 23:30 Tehran time)
};

// In-memory cache per worker isolate (short TTL to keep the bot fast and inside free D1 limits)
const MEM_CACHE = {
  settings: null,
  settingsExpiresAt: 0,
  texts: null,
  textsExpiresAt: 0,
  forcedChannels: null,
  forcedChannelsExpiresAt: 0,
  userMembership: new Map(), // key: `${userId}:${channelId}` -> { joined: boolean, expireAt: number }
  statsCache: new Map(),     // key: period -> { data: any, expireAt: number }
  adminsSet: null,
  adminsSetExpiresAt: 0
};

export function invalidateCache(type = 'all') {
  const now = Date.now();
  if (type === 'all' || type === 'settings') {
    MEM_CACHE.settings = null;
    MEM_CACHE.settingsExpiresAt = 0;
  }
  if (type === 'all' || type === 'texts') {
    MEM_CACHE.texts = null;
    MEM_CACHE.textsExpiresAt = 0;
  }
  if (type === 'all' || type === 'channels') {
    MEM_CACHE.forcedChannels = null;
    MEM_CACHE.forcedChannelsExpiresAt = 0;
    MEM_CACHE.userMembership.clear();
  }
  if (type === 'all' || type === 'stats') {
    MEM_CACHE.statsCache.clear();
  }
  if (type === 'all' || type === 'admins') {
    MEM_CACHE.adminsSet = null;
    MEM_CACHE.adminsSetExpiresAt = 0;
  }
}

// ============================================================================
// SECTION 2: DATABASE LAYER & MIGRATIONS
// ============================================================================

export const SCHEMA_SQL = [
  // 1. Schema migrations tracker
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`,

  // 2. Settings table
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  // 3. Texts and customizable strings
  `CREATE TABLE IF NOT EXISTS texts (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  // 4. Users table
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    referrer_id INTEGER,
    wallet_balance INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    is_admin INTEGER DEFAULT 0,
    has_blocked_bot INTEGER DEFAULT 0,
    orders_count INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);`,
  `CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at);`,

  // 5. User conversation states (lightweight FSM)
  `CREATE TABLE IF NOT EXISTS user_states (
    user_id INTEGER PRIMARY KEY,
    step TEXT NOT NULL,
    data TEXT,
    updated_at TEXT NOT NULL
  );`,

  // 6. Subscription Services catalog
  `CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    traffic TEXT NOT NULL,
    duration_days INTEGER DEFAULT 30,
    duration_text TEXT NOT NULL,
    price INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    display_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_services_active ON services(is_active, display_order);`,

  // 7. Manual Payment Methods (Card to Card, Crypto, etc.)
  `CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    details TEXT NOT NULL,
    instructions TEXT,
    is_active INTEGER DEFAULT 1,
    display_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );`,

  // 8. Orders table
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    original_price INTEGER NOT NULL,
    discount_amount INTEGER DEFAULT 0,
    final_price INTEGER NOT NULL,
    wallet_paid INTEGER DEFAULT 0,
    manual_paid INTEGER DEFAULT 0,
    payment_method_id INTEGER,
    payment_method_name TEXT,
    coupon_code TEXT,
    receipt_file_id TEXT,
    payment_notes TEXT,
    status TEXT DEFAULT 'pending_payment',
    admin_notes TEXT,
    handler_admin_id INTEGER,
    handler_admin_name TEXT,
    renewal_of_service_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);`,

  // 9. Delivered User Services (Active & Expired subscriptions)
  `CREATE TABLE IF NOT EXISTS user_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    config_text TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reminded_3d INTEGER DEFAULT 0,
    reminded_1d INTEGER DEFAULT 0,
    reminded_expired INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_user_services_user ON user_services(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_user_services_status ON user_services(status);`,
  `CREATE INDEX IF NOT EXISTS idx_user_services_expires ON user_services(expires_at);`,

  // 10. Manual Test Account Requests
  `CREATE TABLE IF NOT EXISTS test_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    config_text TEXT,
    rejection_reason TEXT,
    handler_admin_id INTEGER,
    handler_admin_name TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_test_requests_user ON test_requests(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_test_requests_status ON test_requests(status);`,
  `CREATE INDEX IF NOT EXISTS idx_test_requests_delivered ON test_requests(delivered_at);`,

  // 11. Connection Guides
  `CREATE TABLE IF NOT EXISTS guides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );`,

  // 12. Discount Coupons
  `CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL,
    discount_value INTEGER NOT NULL,
    max_uses INTEGER DEFAULT 0,
    used_count INTEGER DEFAULT 0,
    max_uses_per_user INTEGER DEFAULT 1,
    min_order_price INTEGER DEFAULT 0,
    expires_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);`,

  // 13. Coupon Usages Tracker
  `CREATE TABLE IF NOT EXISTS coupon_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL,
    coupon_code TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    discount_amount INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_usages_coupon_user ON coupon_usages(coupon_id, user_id);`,

  // 14. Wallet Ledger (Strict Double-Entry History)
  `CREATE TABLE IF NOT EXISTS wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    type TEXT NOT NULL,
    reference_id TEXT,
    description TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_ledger_created ON wallet_ledger(created_at);`,

  // 15. Wallet Withdrawal Requests
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    dest_info TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    admin_notes TEXT,
    handler_admin_id INTEGER,
    handler_admin_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_created ON withdrawals(created_at);`,

  // 16. Multi-Channel Forced Join Channels
  `CREATE TABLE IF NOT EXISTS forced_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    invite_link TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    display_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );`,

  // 17. Channel Joins & Leavers Tracker
  `CREATE TABLE IF NOT EXISTS channel_joins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at TEXT,
    left_at TEXT,
    status TEXT DEFAULT 'joined',
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_channel_joins_user_channel ON channel_joins(user_id, channel_id);`,

  // 18. Broadcast Queue
  `CREATE TABLE IF NOT EXISTS broadcast_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    message_text TEXT NOT NULL,
    target_filter TEXT DEFAULT 'all',
    status TEXT DEFAULT 'pending',
    total_users INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    blocked_count INTEGER DEFAULT 0,
    last_processed_user_id INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  // 19. Support Tickets
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'open',
    last_message_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);`,

  // 20. Support Messages
  `CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_name TEXT,
    message_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id);`,

  // 21. Admin Activity Logs
  `CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);`,

  // 22. Telegram Updates Deduplication
  `CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_processed_updates_date ON processed_updates(processed_at);`,

  // 23. Diagnostics Error Logs
  `CREATE TABLE IF NOT EXISTS error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    error_message TEXT,
    stack TEXT,
    context TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_error_logs_date ON error_logs(created_at);`
];

export async function runMigrations(db) {
  // Check current schema version
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)').run();
  } catch (err) {
    // Already exists
  }

  const currentVersionRow = await db.prepare('SELECT MAX(version) AS max_v FROM schema_migrations').first();
  const currentVersion = currentVersionRow?.max_v || 0;

  if (currentVersion < 1) {
    const stmts = SCHEMA_SQL.map(sql => db.prepare(sql));
    await db.batch(stmts);

    // Seed initial settings
    const now = new Date().toISOString();
    const seedSettings = [
      ['brand_name', DEFAULT_BRAND.name],
      ['brand_short_name', DEFAULT_BRAND.short_name],
      ['support_id', DEFAULT_BRAND.support_id],
      ['currency', DEFAULT_BRAND.currency],
      ['default_referral_percent', String(DEFAULT_BRAND.default_referral_percent)],
      ['test_cooldown_hours', String(DEFAULT_BRAND.test_cooldown_hours)],
      ['order_timeout_minutes', String(DEFAULT_BRAND.order_timeout_minutes)],
      ['min_withdrawal', String(DEFAULT_BRAND.min_withdrawal)],
      ['max_pending_orders', String(DEFAULT_BRAND.max_pending_orders)],
      ['first_purchase_discount_percent', '0'],
      ['wallet_topup_bonus_percent', '0'],
      ['forced_join_enabled', '1'],
      ['strict_forced_join', '0'],
      ['maintenance_mode', '0'],
      ['maintenance_message', DEFAULT_BRAND.maintenance_message],
      ['pinned_announcement', ''],
      ['daily_report_hour', '20'],
      ['setup_completed', '1']
    ];

    const settingStmts = seedSettings.map(([k, v]) =>
      db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(k, v, now)
    );

    // Seed sample services if empty
    const srvCount = (await db.prepare('SELECT COUNT(*) AS c FROM services').first())?.c || 0;
    if (srvCount === 0) {
      settingStmts.push(
        db.prepare('INSERT INTO services (name, description, traffic, duration_days, duration_text, price, is_active, display_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)')
          .bind('پلن پایه یک‌ماهه', 'مناسب وب‌گردی و پیام‌رسان‌ها با سرعت عالی و بدون قطعی', '۳۰ گیگابایت', 30, 'یک ماهه (۳۰ روز)', 65000, now),
        db.prepare('INSERT INTO services (name, description, traffic, duration_days, duration_text, price, is_active, display_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?)')
          .bind('پلن استاندارد یک‌ماهه', 'مناسب تماشای ویدیو و استفاده روزمره پرسرعت', '۶۰ گیگابایت', 30, 'یک ماهه (۳۰ روز)', 110000, now),
        db.prepare('INSERT INTO services (name, description, traffic, duration_days, duration_text, price, is_active, display_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 3, ?)')
          .bind('پلن حرفه‌ای دو‌ماهه', 'حجم بالا با پینگ پایین ویژه بازی آنلاین و استریم', '۱۲۰ گیگابایت', 60, 'دو ماهه (۶۰ روز)', 200000, now)
      );
    }

    // Seed sample payment method if empty
    const pmCount = (await db.prepare('SELECT COUNT(*) AS c FROM payment_methods').first())?.c || 0;
    if (pmCount === 0) {
      settingStmts.push(
        db.prepare('INSERT INTO payment_methods (name, details, instructions, is_active, display_order, created_at) VALUES (?, ?, ?, 1, 1, ?)')
          .bind(
            'کارت به کارت (بانک سامان)',
            'شماره کارت:\n<code>6219-8610-0000-0000</code>\nبه نام: مدیریت نکسی آپ',
            'لطفاً مبلغ را به کارت بالا واریز نموده و عکس فیش را ارسال نمایید.',
            now
          ),
        db.prepare('INSERT INTO payment_methods (name, details, instructions, is_active, display_order, created_at) VALUES (?, ?, ?, 1, 2, ?)')
          .bind(
            'ارز دیجیتال تتر (USDT - TRC20)',
            'آدرس کیف پول تتر TRC20:\n<code>TLyYourCryptoWalletAddressHere</code>',
            'لطفاً مقدار معادل را واریز فرموده و شناسه تراکنش (TxID) یا اسکرین‌شات واریز را ارسال فرمایید.',
            now
          )
      );
    }

    // Seed sample guides if empty
    const guideCount = (await db.prepare('SELECT COUNT(*) AS c FROM guides').first())?.c || 0;
    if (guideCount === 0) {
      settingStmts.push(
        db.prepare('INSERT INTO guides (title, content, display_order, is_active, created_at) VALUES (?, ?, 1, 1, ?)')
          .bind(
            '📱 راهنمای اندروید (v2rayNG)',
            '۱. نرم‌افزار v2rayNG را از گوگل پلی دانلود و نصب کنید.\n۲. لینک کانفیگ ارسالی را کپی نمایید.\n۳. وارد برنامه شده، آیکون ➕ بالا را زده و گزینه Import config from clipboard را انتخاب کنید.\n۴. روی کانفیگ اضافه شده بزنید و دکمه دایره‌ای پایین را برای اتصال فعال کنید.',
            now
          ),
        db.prepare('INSERT INTO guides (title, content, display_order, is_active, created_at) VALUES (?, ?, 2, 1, ?)')
          .bind(
            '🍏 راهنمای آیفون / iOS (Streisand / V2Box)',
            '۱. نرم‌افزار Streisand یا V2Box را از اپ استور دانلود فرمایید.\n۲. متن کانفیگ خود را کپی کنید.\n۳. برنامه را باز کرده و علامت ➕ را زده و از کلیپ‌بورد وارد نمایید.\n۴. دکمه اتصال (Connect) را لمس کنید.',
            now
          ),
        db.prepare('INSERT INTO guides (title, content, display_order, is_active, created_at) VALUES (?, ?, 3, 1, ?)')
          .bind(
            '💻 راهنمای ویندوز (v2rayN)',
            '۱. برنامه v2rayN را دانلود و اجرا نمایید.\n۲. لینک کانفیگ را کپی کرده و در برنامه کلیدهای ترکیبی Ctrl + V را بزنید.\n۳. روی سرور کلیک راست نموده و Set as active server را انتخاب نمایید.\n۴. در نوار پایین روی آیکون برنامه کلیک راست کرده و System proxy را روی Set system proxy قرار دهید.',
            now
          )
      );
    }

    settingStmts.push(
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').bind(now)
    );

    await db.batch(settingStmts);
    invalidateCache('all');
  }

  return true;
}

// Database helper functions
export async function getSettings(db) {
  const now = Date.now();
  if (MEM_CACHE.settings && MEM_CACHE.settingsExpiresAt > now) {
    return MEM_CACHE.settings;
  }
  const rows = (await db.prepare('SELECT key, value FROM settings').all())?.results || [];
  const map = { ...DEFAULT_BRAND };
  for (const r of rows) {
    map[r.key] = r.value;
  }
  MEM_CACHE.settings = map;
  MEM_CACHE.settingsExpiresAt = now + 60000; // 60s cache
  return map;
}

export async function getSetting(db, key, defaultVal = '') {
  const settings = await getSettings(db);
  return settings[key] !== undefined ? settings[key] : defaultVal;
}

export async function setSetting(db, key, value) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, String(value), now).run();
  invalidateCache('settings');
  invalidateCache('stats');
}

export async function getUser(db, userId) {
  return await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
}

export async function upsertUser(db, from, referrerId = null) {
  const now = new Date().toISOString();
  const userId = from.id;
  const username = from.username || '';
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';

  const existing = await getUser(db, userId);
  if (!existing) {
    // New user signup
    const validReferrer = (referrerId && referrerId !== userId) ? referrerId : null;
    await db.prepare(`
      INSERT INTO users (id, username, first_name, last_name, referrer_id, wallet_balance, is_banned, is_admin, has_blocked_bot, orders_count, total_spent, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)
    `).bind(userId, username, firstName, lastName, validReferrer, now, now).run();
    return {
      id: userId,
      username,
      first_name: firstName,
      last_name: lastName,
      referrer_id: validReferrer,
      wallet_balance: 0,
      is_banned: 0,
      is_admin: 0,
      has_blocked_bot: 0,
      orders_count: 0,
      total_spent: 0,
      created_at: now,
      last_active_at: now,
      is_new: true
    };
  } else {
    // Update active timestamp and names
    await db.prepare(`
      UPDATE users SET username = ?, first_name = ?, last_name = ?, last_active_at = ?, has_blocked_bot = 0
      WHERE id = ?
    `).bind(username, firstName, lastName, now, userId).run();
    return { ...existing, username, first_name: firstName, last_name: lastName, last_active_at: now, is_new: false };
  }
}

export async function getUserState(db, userId) {
  const row = await db.prepare('SELECT step, data FROM user_states WHERE user_id = ?').bind(userId).first();
  if (!row) return null;
  let parsedData = null;
  try {
    parsedData = row.data ? JSON.parse(row.data) : null;
  } catch (e) {
    parsedData = null;
  }
  return { step: row.step, data: parsedData };
}

export async function setUserState(db, userId, step, data = null) {
  const now = new Date().toISOString();
  const dataJson = data ? JSON.stringify(data) : null;
  await db.prepare(`
    INSERT INTO user_states (user_id, step, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET step = excluded.step, data = excluded.data, updated_at = excluded.updated_at
  `).bind(userId, step, dataJson, now).run();
}

export async function clearUserState(db, userId) {
  await db.prepare('DELETE FROM user_states WHERE user_id = ?').bind(userId).run();
}

export async function logAdminAction(db, adminId, action, targetType = '', targetId = '', details = '') {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO admin_logs (admin_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(adminId, action, targetType, String(targetId), details, now).run();
}

export async function logError(db, error, context = '') {
  try {
    const now = new Date().toISOString();
    const errMsg = String(error?.message || error || 'Unknown error');
    const stack = String(error?.stack || '');
    await db.prepare(`
      INSERT INTO error_logs (error_message, stack, context, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(errMsg, stack, String(context).slice(0, 500), now).run();
  } catch (e) {
    // Fail-safe to avoid crash loop
  }
}

// Check admin status across env.ADMIN_IDS and DB
export async function isAdmin(userId, env, db) {
  if (!userId) return false;
  const numId = Number(userId);

  // Check cached set of admins
  const now = Date.now();
  if (MEM_CACHE.adminsSet && MEM_CACHE.adminsSetExpiresAt > now) {
    if (MEM_CACHE.adminsSet.has(numId)) return true;
  }

  // Parse env ADMIN_IDS
  const envAdminIds = (env.ADMIN_IDS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => !isNaN(n) && n > 0);

  if (envAdminIds.includes(numId)) return true;

  // Check DB is_admin flag
  try {
    const dbAdminRows = (await db.prepare('SELECT id FROM users WHERE is_admin = 1').all())?.results || [];
    const allAdmins = new Set([...envAdminIds, ...dbAdminRows.map(r => Number(r.id))]);
    MEM_CACHE.adminsSet = allAdmins;
    MEM_CACHE.adminsSetExpiresAt = now + 60000;
    return allAdmins.has(numId);
  } catch (err) {
    return envAdminIds.includes(numId);
  }
}

export async function getAllAdminIds(env, db) {
  const envAdminIds = (env.ADMIN_IDS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => !isNaN(n) && n > 0);

  try {
    const dbAdminRows = (await db.prepare('SELECT id FROM users WHERE is_admin = 1').all())?.results || [];
    const dbIds = dbAdminRows.map(r => Number(r.id));
    return Array.from(new Set([...envAdminIds, ...dbIds]));
  } catch (e) {
    return envAdminIds;
  }
}

// ============================================================================
// SECTION 3: TELEGRAM API CLIENT & HELPERS
// ============================================================================

export async function callTelegram(token, method, payload = {}, isFormData = false) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let options = {
    method: 'POST'
  };

  if (isFormData) {
    options.body = payload;
  } else {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload);
  }

  try {
    const res = await fetch(url, options);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      // Handle rate limiting
      if (res.status === 429 && data.parameters?.retry_after) {
        const waitSec = data.parameters.retry_after;
        if (waitSec <= 3) {
          await sleep(waitSec * 1000);
          return await callTelegram(token, method, payload, isFormData);
        }
      }
      return data;
    }
    return data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function sendMessage(token, chatId, text, extra = {}) {
  return await callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

export async function editMessageText(token, chatId, messageId, text, extra = {}) {
  const res = await callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
  // Ignore "message is not modified" error from Telegram
  if (!res.ok && res.description?.includes('message is not modified')) {
    return { ok: true, result: true };
  }
  return res;
}

export async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return await callTelegram(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup
  });
}

export async function answerCallbackQuery(token, callbackQueryId, text = '', showAlert = false) {
  return await callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

export async function sendPhoto(token, chatId, photo, caption = '', extra = {}) {
  return await callTelegram(token, 'sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: 'HTML',
    ...extra
  });
}

export async function sendDocument(token, chatId, document, caption = '', extra = {}) {
  return await callTelegram(token, 'sendDocument', {
    chat_id: chatId,
    document,
    caption,
    parse_mode: 'HTML',
    ...extra
  });
}

export async function getChatMember(token, chatId, userId) {
  const res = await callTelegram(token, 'getChatMember', {
    chat_id: chatId,
    user_id: userId
  });
  if (res.ok && res.result) {
    return res.result;
  }
  return null;
}

export async function setWebhook(token, webhookUrl, secretToken = '') {
  const payload = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
    drop_pending_updates: false
  };
  if (secretToken) {
    payload.secret_token = secretToken;
  }
  return await callTelegram(token, 'setWebhook', payload);
}

export async function setMyCommands(token, commands) {
  return await callTelegram(token, 'setMyCommands', { commands });
}

export async function getMe(token) {
  return await callTelegram(token, 'getMe');
}

export async function getWebhookInfo(token) {
  return await callTelegram(token, 'getWebhookInfo');
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatPrice(amount, currency = 'تومان') {
  const num = Number(amount) || 0;
  return `${num.toLocaleString('en-US')} ${currency}`;
}

export function formatDate(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${day} - ${h}:${min}`;
  } catch (e) {
    return isoStr;
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SECTION 4: TEXTS & LOCALIZATION (WITH D1 OVERRIDES)
// ============================================================================

export const DEFAULT_TEXTS = {
  welcome: `سلام {name} عزیز، به ربات {brand} خوش آمدید! 👋

جهت خرید اشتراک باکیفیت، مدیریت سرویس‌ها یا دریافت تست رایگان از گزینه‌های زیر استفاده نمایید.`,

  main_menu: `منوی اصلی {brand}:
لطفاً یکی از گزینه‌های زیر را انتخاب فرمایید:`,

  services_header: `🛒 <b>لیست پلن‌ها و سرویس‌های {brand}</b>

جهت مشاهده جزئیات، مشخصات و سفارش، پلن مد نظر خود را انتخاب نمایید:`,

  service_details: `📦 <b>{name}</b>

📊 حجم ترافیک: <b>{traffic}</b>
⏳ مدت اعتبار: <b>{duration}</b>
💰 هزینه اشتراک: <b>{price} {currency}</b>

📝 توضیحات:
{description}`,

  order_invoice: `🧾 <b>پیش‌فاکتور سفارش #{order_id}</b>

📦 سرویس: <b>{service_name}</b>
💰 قیمت اصلی: {original_price} {currency}
🎟 تخفیف اعمال شده: {discount} {currency}
💵 مبلغ نهایی قابل پرداخت: <b>{final_price} {currency}</b>

لطفاً نحوه پرداخت را مشخص کنید:`,

  payment_instructions: `💳 <b>روش پرداخت: {method_name}</b>

{details}

💵 مبلغ قابل پرداخت: <b>{price} {currency}</b>

⚠️ <i>{instructions}</i>

لطفاً پس از پرداخت، <b>تصویر فیش واریزی</b> یا شناسه واریز / توضیحات را ارسال فرمایید:`,

  order_submitted: `✅ سفارش شما با کد پیگیری <code>#{order_id}</code> با موفقیت ثبت شد.

رسید شما جهت بررسی برای مدیریت ارسال گردید. به محض تایید، کانفیگ سرویس در همین ربات برای شما فرستاده خواهد شد.`,

  order_approved: `🎉 <b>سفارش شما تایید شد!</b>

📦 سرویس: <b>{service_name}</b>
⏳ مدت اعتبار: <b>{duration}</b>
📅 تاریخ انقضا: <b>{expires_at}</b>

🔐 <b>اطلاعات اتصال / کانفیگ شما:</b>
<code>{config}</code>

⚠️ با ضربه روی کادر بالا می‌توانید کانفیگ را به راحتی کپی کنید. همچنین در بخش «سرویس‌های من» همیشه در دسترس شماست.`,

  order_rejected: `❌ <b>سفارش شما با کد #{order_id} تایید نشد.</b>

علت رد سفارش: {reason}
{refund_note}`,

  wallet_info: `💰 <b>کیف پول کاربری {brand}</b>

💳 موجودی فعلی شما: <b>{balance} {currency}</b>
👥 کل درآمد از زیرمجموعه‌گیری: <b>{referral_income} {currency}</b>

شما می‌توانید موجودی کیف پول خود را برای خرید و تمدید سرویس‌ها استفاده کنید یا در صورت تمایل درخواست تسویه حساب ثبت نمایید.`,

  test_info: `🧪 <b>دریافت اکانت تست رایگان</b>

با دریافت اکانت تست می‌توانید سرعت، پینگ و پایداری سرویس‌های {brand} را بررسی فرمایید.

⚠️ هر کاربر مجاز است با فاصله زمانی ({cooldown} ساعت) یک تست رایگان دریافت کند.`,

  referral_info: `👥 <b>سیستم کسب درآمد و معرفی دوستان</b>

با معرفی {brand} به دوستان خود، <b>{percent}٪</b> از هر خرید زیرمجموعه‌های شما به صورت آنی به کیف پولتان واریز می‌شود!

🔗 لینک دعوت اختصاصی شما:
<code>{link}</code>

📊 تعداد کاربران دعوت‌شده: <b>{count} نفر</b>
💵 مجموع درآمد کسب‌شده: <b>{income} {currency}</b>`,

  forced_join_notice: `📢 <b>عضویت در کانال‌های اطلاع‌رسانی الزامی است</b>

جهت استفاده از خدمات ربات {brand}، لطفاً در کانال‌های زیر عضو شده و سپس دکمه «✅ عضو شدم» را لمس کنید:`,

  forced_join_not_joined: `⚠️ شما هنوز در کانال‌های زیر عضو نشده‌اید:
{channels}

لطفاً ابتدا عضو شده و مجدداً دکمه بررسی را بزنید.`,

  support_text: `📞 <b>پشتیبانی و ارتباط با مدیریت</b>

برای ارسال پیام به تیم پشتیبانی، پیام خود را همینجا ارسال فرمایید.

همچنین می‌توانید مستقیماً با آیدی زیر در تماس باشید:
{support_id}`,

  maintenance_text: `🛠 ربات در حال حاضر در حال تعمیرات و ارتقای فنی است.
لطفاً صبور باشید و دقایقی دیگر مجدداً مراجعه فرمایید.`,

  rules_text: `📜 <b>قوانین و شرایط استفاده از سرویس‌های {brand}</b>

۱. استفاده غیرقانونی از سرویس‌ها اکیداً ممنوع است.
۲. حجم و زمان هر پلن دقیقاً طبق توضیحات محاسبه می‌گردد.
۳. در صورت بروز هرگونه اختلال زیرساختی، زمان به اشتراک شما اضافه خواهد شد.`
};

export async function getTexts(db) {
  const now = Date.now();
  if (MEM_CACHE.texts && MEM_CACHE.textsExpiresAt > now) {
    return MEM_CACHE.texts;
  }
  const rows = (await db.prepare('SELECT key, value FROM texts').all())?.results || [];
  const map = { ...DEFAULT_TEXTS };
  for (const r of rows) {
    map[r.key] = r.value;
  }
  MEM_CACHE.texts = map;
  MEM_CACHE.textsExpiresAt = now + 60000;
  return map;
}

export async function getText(db, key, params = {}) {
  const texts = await getTexts(db);
  const settings = await getSettings(db);
  let template = texts[key] || DEFAULT_TEXTS[key] || '';

  const allParams = {
    brand: settings.brand_name || DEFAULT_BRAND.name,
    currency: settings.currency || DEFAULT_BRAND.currency,
    support_id: settings.support_id || DEFAULT_BRAND.support_id,
    ...params
  };

  for (const [k, v] of Object.entries(allParams)) {
    template = template.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return template;
}

export async function setText(db, key, value) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO texts (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, value, now).run();
  invalidateCache('texts');
}

export async function resetText(db, key) {
  await db.prepare('DELETE FROM texts WHERE key = ?').bind(key).run();
  invalidateCache('texts');
}


// ============================================================================
// SECTION 5: KEYBOARDS & NAVIGATION BUILDERS
// ============================================================================

export function mainMenuKeyboard(isUserAdmin = false) {
  const keyboard = [
    [
      { text: '🛒 خرید سرویس', callback_data: 'menu_services' },
      { text: '📦 سرویس‌های من', callback_data: 'menu_myservices' }
    ],
    [
      { text: '🧪 دریافت اکانت تست', callback_data: 'menu_test' },
      { text: '📖 راهنمای اتصال', callback_data: 'menu_guides' }
    ],
    [
      { text: '👥 زیرمجموعه‌گیری', callback_data: 'menu_referral' },
      { text: '💰 کیف پول', callback_data: 'menu_wallet' }
    ],
    [
      { text: '📞 پشتیبانی', callback_data: 'menu_support' }
    ]
  ];

  if (isUserAdmin) {
    keyboard.push([
      { text: '👑 پنل مدیریت ربات', callback_data: 'admin_panel' }
    ]);
  }

  return { inline_keyboard: keyboard };
}

export function servicesListKeyboard(services, page = 1, totalPages = 1) {
  const keyboard = [];

  for (const s of services) {
    keyboard.push([
      { text: `📦 ${s.name} - ${formatPrice(s.price)}`, callback_data: `srv_view:${s.id}` }
    ]);
  }

  // Pagination row
  if (totalPages > 1) {
    const navRow = [];
    if (page > 1) {
      navRow.push({ text: '◀️ قبلی', callback_data: `srv_list:${page - 1}` });
    }
    navRow.push({ text: `📄 ${page} از ${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) {
      navRow.push({ text: 'بعدی ▶️', callback_data: `srv_list:${page + 1}` });
    }
    keyboard.push(navRow);
  }

  keyboard.push([
    { text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }
  ]);

  return { inline_keyboard: keyboard };
}

export function serviceViewKeyboard(serviceId) {
  return {
    inline_keyboard: [
      [{ text: '💳 ثبت سفارش و پرداخت', callback_data: `order_create:${serviceId}` }],
      [{ text: '🔙 بازگشت به لیست سرویس‌ها', callback_data: 'srv_list:1' }]
    ]
  };
}

export function orderInvoiceKeyboard(order, walletBalance) {
  const keyboard = [];
  const finalPrice = order.final_price;

  if (walletBalance >= finalPrice) {
    keyboard.push([
      { text: `💰 پرداخت کامل از کیف پول (${formatPrice(finalPrice)})`, callback_data: `order_pay_wallet:${order.id}` }
    ]);
  } else if (walletBalance > 0) {
    keyboard.push([
      { text: `⚖️ پرداخت ترکیبی (${formatPrice(walletBalance)} کیف پول + مابقی دستی)`, callback_data: `order_pay_split:${order.id}` }
    ]);
  }

  keyboard.push([
    { text: '💳 پرداخت دستی (کارت به کارت / ارز دیجیتال)', callback_data: `order_pay_manual:${order.id}` }
  ]);

  if (!order.coupon_code) {
    keyboard.push([
      { text: '🎟 اعمال کد تخفیف', callback_data: `order_apply_coupon:${order.id}` }
    ]);
  }

  keyboard.push([
    { text: '❌ انصراف از سفارش', callback_data: `order_cancel:${order.id}` }
  ]);

  return { inline_keyboard: keyboard };
}

export function paymentMethodsKeyboard(methods, orderId, isDeposit = false) {
  const keyboard = [];

  for (const m of methods) {
    const callbackData = isDeposit
      ? `wallet_topup_pm:${orderId}:${m.id}`
      : `order_pay_method:${orderId}:${m.id}`;
    keyboard.push([
      { text: `💳 ${m.name}`, callback_data: callbackData }
    ]);
  }

  const cancelData = isDeposit ? 'menu_wallet' : `srv_view:${orderId}`;
  keyboard.push([
    { text: '🔙 انصراف و بازگشت', callback_data: cancelData }
  ]);

  return { inline_keyboard: keyboard };
}

export function myServicesListKeyboard(services, page = 1, totalPages = 1) {
  const keyboard = [];

  for (const s of services) {
    const badge = s.status === 'active' ? '🟢 فعال' : '🔴 منقضی';
    keyboard.push([
      { text: `${badge} | ${s.service_name} (#${s.id})`, callback_data: `mysrv_view:${s.id}` }
    ]);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (page > 1) {
      navRow.push({ text: '◀️ قبلی', callback_data: `mysrv_list:${page - 1}` });
    }
    navRow.push({ text: `📄 ${page} از ${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) {
      navRow.push({ text: 'بعدی ▶️', callback_data: `mysrv_list:${page + 1}` });
    }
    keyboard.push(navRow);
  }

  keyboard.push([
    { text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }
  ]);

  return { inline_keyboard: keyboard };
}

export function myServiceDetailKeyboard(userSrv) {
  return {
    inline_keyboard: [
      [{ text: '🔁 تمدید این سرویس', callback_data: `mysrv_renew:${userSrv.id}` }],
      [{ text: '🔙 بازگشت به سرویس‌های من', callback_data: 'mysrv_list:1' }]
    ]
  };
}

export function walletMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '➕ افزایش موجودی / شارژ', callback_data: 'wallet_topup' },
        { text: '💸 درخواست تسویه حساب', callback_data: 'wallet_withdraw' }
      ],
      [
        { text: '📜 تاریخچه گردش حساب', callback_data: 'wallet_history:1' }
      ],
      [
        { text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }
      ]
    ]
  };
}

export function guidesListKeyboard(guides) {
  const keyboard = [];

  for (const g of guides) {
    keyboard.push([
      { text: `📖 ${g.title}`, callback_data: `guide_view:${g.id}` }
    ]);
  }

  keyboard.push([
    { text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }
  ]);

  return { inline_keyboard: keyboard };
}

export function forcedJoinKeyboard(missingChannels) {
  const keyboard = [];

  for (const ch of missingChannels) {
    keyboard.push([
      { text: `📢 عضویت در ${ch.title}`, url: ch.invite_link }
    ]);
  }

  keyboard.push([
    { text: '✅ بررسی عضویت / عضو شدم', callback_data: 'check_forced_join' }
  ]);

  return { inline_keyboard: keyboard };
}

export function cancelStateKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔙 انصراف و بازگشت به منو', callback_data: 'cancel_state' }]
    ]
  };
}

export function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🩺 سلامت سیستم', callback_data: 'adm_diagnostics' },
        { text: '📊 آمار و گزارش', callback_data: 'adm_stats:today' }
      ],
      [
        { text: '👥 کاربران', callback_data: 'adm_users:1' },
        { text: '🛒 سرویس‌ها', callback_data: 'adm_services:1' }
      ],
      [
        { text: '📦 سفارش‌ها', callback_data: 'adm_orders:pending_approval:1' },
        { text: '💳 روش‌های پرداخت', callback_data: 'adm_paymethods' }
      ],
      [
        { text: '🧪 سرویس تست', callback_data: 'adm_tests:pending:1' },
        { text: '📖 راهنماها', callback_data: 'adm_guides' }
      ],
      [
        { text: '📢 کانال اجباری', callback_data: 'adm_fchannels' },
        { text: '👥 زیرمجموعه‌ها', callback_data: 'adm_referral' }
      ],
      [
        { text: '💰 کیف پول', callback_data: 'adm_wallet' },
        { text: '💸 برداشت‌ها', callback_data: 'adm_withdraws:pending:1' }
      ],
      [
        { text: '🎟 کدهای تخفیف', callback_data: 'adm_coupons:1' },
        { text: '📣 ارسال همگانی', callback_data: 'adm_broadcast' }
      ],
      [
        { text: '⚙️ تنظیمات', callback_data: 'adm_settings' },
        { text: '📝 متن‌ها و دکمه‌ها', callback_data: 'adm_texts' }
      ],
      [
        { text: '👮 مدیران', callback_data: 'adm_admins' },
        { text: '🔧 ابزارهای سیستم', callback_data: 'adm_tools' }
      ],
      [
        { text: '🔙 بازگشت به منوی کاربری', callback_data: 'menu_main' }
      ]
    ]
  };
}

// ============================================================================
// SECTION 6: FORCED CHANNEL JOIN LOGIC
// ============================================================================

export async function getActiveForcedChannels(db) {
  const now = Date.now();
  if (MEM_CACHE.forcedChannels && MEM_CACHE.forcedChannelsExpiresAt > now) {
    return MEM_CACHE.forcedChannels;
  }
  const rows = (await db.prepare('SELECT * FROM forced_channels WHERE is_active = 1 ORDER BY display_order ASC, id ASC').all())?.results || [];
  MEM_CACHE.forcedChannels = rows;
  MEM_CACHE.forcedChannelsExpiresAt = now + 60000;
  return rows;
}

export async function checkUserForcedJoin(env, db, userId) {
  const settings = await getSettings(db);
  if (Number(settings.forced_join_enabled) !== 1) {
    return { allowed: true, missing: [] };
  }

  // Admins are exempt from forced join check
  if (await isAdmin(userId, env, db)) {
    return { allowed: true, missing: [] };
  }

  const channels = await getActiveForcedChannels(db);
  if (!channels || channels.length === 0) {
    return { allowed: true, missing: [] };
  }

  const now = Date.now();
  const missing = [];

  // Check each channel
  const checks = channels.map(async (ch) => {
    const cacheKey = `${userId}:${ch.channel_id}`;
    const cached = MEM_CACHE.userMembership.get(cacheKey);

    if (cached && cached.expireAt > now) {
      if (!cached.joined) {
        missing.push(ch);
      }
      return;
    }

    try {
      const member = await getChatMember(env.BOT_TOKEN, ch.channel_id, userId);
      if (member) {
        const isJoined = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
        // Cache positive for 90s, negative for 30s
        MEM_CACHE.userMembership.set(cacheKey, {
          joined: isJoined,
          expireAt: now + (isJoined ? 90000 : 30000)
        });

        if (isJoined) {
          // Record/update join in channel_joins table asynchronously
          await recordChannelJoin(db, userId, ch.channel_id, 'joined');
        } else {
          missing.push(ch);
        }
      } else {
        // Chat member call returned null
        if (Number(settings.strict_forced_join) === 1) {
          missing.push(ch);
        }
      }
    } catch (e) {
      // If error occurs and strict mode is on, fail closed; otherwise fail open
      if (Number(settings.strict_forced_join) === 1) {
        missing.push(ch);
      }
    }
  });

  await Promise.all(checks);

  return {
    allowed: missing.length === 0,
    missing
  };
}

export async function recordChannelJoin(db, userId, channelId, status) {
  try {
    const now = new Date().toISOString();
    const existing = await db.prepare('SELECT id, status FROM channel_joins WHERE user_id = ? AND channel_id = ?').bind(userId, String(channelId)).first();

    if (!existing) {
      await db.prepare(`
        INSERT INTO channel_joins (user_id, channel_id, joined_at, left_at, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(userId, String(channelId), status === 'joined' ? now : null, status === 'left' ? now : null, status, now).run();
    } else if (existing.status !== status) {
      await db.prepare(`
        UPDATE channel_joins SET status = ?, joined_at = CASE WHEN ? = 'joined' THEN ? ELSE joined_at END, left_at = CASE WHEN ? = 'left' THEN ? ELSE left_at END, updated_at = ?
        WHERE id = ?
      `).bind(status, status, now, status, now, now, existing.id).run();
    }
  } catch (e) {
    // Fail-safe
  }
}

export async function handleChatMemberUpdate(env, db, chatMemberUpdate) {
  try {
    const channelId = String(chatMemberUpdate.chat.id);
    const userId = chatMemberUpdate.new_chat_member.user.id;
    const oldStatus = chatMemberUpdate.old_chat_member.status;
    const newStatus = chatMemberUpdate.new_chat_member.status;

    const cacheKey = `${userId}:${channelId}`;

    if (['member', 'administrator', 'creator'].includes(newStatus)) {
      MEM_CACHE.userMembership.set(cacheKey, { joined: true, expireAt: Date.now() + 90000 });
      await recordChannelJoin(db, userId, channelId, 'joined');
    } else if (['left', 'kicked'].includes(newStatus)) {
      MEM_CACHE.userMembership.delete(cacheKey);
      await recordChannelJoin(db, userId, channelId, 'left');
    }
  } catch (err) {
    await logError(db, err, 'handleChatMemberUpdate');
  }
}


// ============================================================================
// SECTION 7: USER FLOWS & MENUS
// ============================================================================

export async function showMainMenu(env, db, chatId, user, messageId = null) {
  const isUserAdmin = await isAdmin(user.id, env, db);
  const settings = await getSettings(db);

  let text = await getText(db, 'main_menu', {
    name: escapeHtml(user.first_name || 'کاربر')
  });

  // Prepend pinned announcement if configured
  if (settings.pinned_announcement && settings.pinned_announcement.trim()) {
    text = `📌 <b>اطلاعیه مهم:</b>\n${escapeHtml(settings.pinned_announcement.trim())}\n\n${text}`;
  }

  const markup = mainMenuKeyboard(isUserAdmin);

  if (messageId) {
    return await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    return await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function handleStartCommand(env, db, message) {
  const chatId = message.chat.id;
  const from = message.from;

  // Extract deep link parameter e.g. /start ref_12345
  let referrerId = null;
  let startParam = '';
  const textParts = (message.text || '').trim().split(' ');
  if (textParts.length > 1) {
    startParam = textParts[1].trim();
    if (startParam.startsWith('ref_')) {
      const refNum = Number(startParam.replace('ref_', ''));
      if (!isNaN(refNum) && refNum !== from.id) {
        referrerId = refNum;
      }
    }
  }

  // Upsert user
  const user = await upsertUser(db, from, referrerId);

  // Check ban status
  if (Number(user.is_banned) === 1) {
    const banReason = user.ban_reason ? `\nعلت: ${user.ban_reason}` : '';
    await sendMessage(env.BOT_TOKEN, chatId, `⛔️ <b>دسترسی حساب شما به ربات مسدود شده است.</b>${banReason}\nجهت پیگیری با پشتیبانی در ارتباط باشید.`);
    return;
  }

  // Check maintenance mode
  const settings = await getSettings(db);
  const userIsAdmin = await isAdmin(from.id, env, db);
  if (Number(settings.maintenance_mode) === 1 && !userIsAdmin) {
    const maintMsg = settings.maintenance_message || DEFAULT_BRAND.maintenance_message;
    await sendMessage(env.BOT_TOKEN, chatId, maintMsg);
    return;
  }

  // Clear any existing conversation step
  await clearUserState(db, from.id);

  // Check forced channel join
  const joinCheck = await checkUserForcedJoin(env, db, from.id);
  if (!joinCheck.allowed) {
    const noticeText = await getText(db, 'forced_join_notice');
    await sendMessage(env.BOT_TOKEN, chatId, noticeText, {
      reply_markup: forcedJoinKeyboard(joinCheck.missing)
    });
    return;
  }

  // Handle deep-link to specific service
  if (startParam.startsWith('srv_')) {
    const srvId = Number(startParam.replace('srv_', ''));
    if (!isNaN(srvId)) {
      await handleServiceView(env, db, chatId, srvId);
      return;
    }
  }

  // Send welcome message and main menu
  const welcomeText = await getText(db, 'welcome', {
    name: escapeHtml(from.first_name || 'کاربر')
  });
  await sendMessage(env.BOT_TOKEN, chatId, welcomeText);
  await showMainMenu(env, db, chatId, user);
}

export async function handleServicesMenu(env, db, chatId, page = 1, messageId = null) {
  const PAGE_SIZE = 4;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM services WHERE is_active = 1').first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const services = (await db.prepare(`
    SELECT * FROM services
    WHERE is_active = 1
    ORDER BY display_order ASC, id ASC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, offset).all())?.results || [];

  if (services.length === 0) {
    const emptyText = '⚠️ در حال حاضر هیچ سرویسی برای ارائه فعال نیست. لطفاً بعداً مراجعه فرمایید.';
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, emptyText, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]] }
      });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, emptyText);
    }
    return;
  }

  const header = await getText(db, 'services_header');
  const markup = servicesListKeyboard(services, currentPage, totalPages);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, header, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, header, { reply_markup: markup });
  }
}

export async function handleServiceView(env, db, chatId, serviceId, messageId = null) {
  const service = await db.prepare('SELECT * FROM services WHERE id = ?').bind(serviceId).first();
  if (!service) {
    const notFoundText = '❌ سرویس مورد نظر یافت نشد یا غیرفعال شده است.';
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, notFoundText, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به لیست سرویس‌ها', callback_data: 'srv_list:1' }]] }
      });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, notFoundText);
    }
    return;
  }

  const settings = await getSettings(db);
  const text = await getText(db, 'service_details', {
    name: escapeHtml(service.name),
    traffic: escapeHtml(service.traffic),
    duration: escapeHtml(service.duration_text),
    price: formatPrice(service.price, settings.currency),
    description: escapeHtml(service.description || 'بدون توضیحات')
  });

  const markup = serviceViewKeyboard(service.id);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function handleMyServicesMenu(env, db, chatId, userId, page = 1, messageId = null) {
  const PAGE_SIZE = 5;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM user_services WHERE user_id = ?').bind(userId).first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const services = (await db.prepare(`
    SELECT * FROM user_services
    WHERE user_id = ?
    ORDER BY status ASC, id DESC
    LIMIT ? OFFSET ?
  `).bind(userId, PAGE_SIZE, offset).all())?.results || [];

  if (services.length === 0) {
    const emptyText = '📦 <b>شما در حال حاضر هیچ سرویس فعالی ندارید.</b>\n\nبرای تهیه اشتراک جدید می‌توانید از بخش «🛒 خرید سرویس» اقدام نمایید.';
    const markup = {
      inline_keyboard: [
        [{ text: '🛒 خرید سرویس جدید', callback_data: 'menu_services' }],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]
      ]
    };
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, emptyText, { reply_markup: markup });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, emptyText, { reply_markup: markup });
    }
    return;
  }

  const title = `📦 <b>لیست سرویس‌ها و اشتراک‌های شما</b> (تعداد کل: ${totalItems} عدد)\nجهت مشاهده اطلاعات اتصال و کانفیگ، روی سرویس مورد نظر کلیک کنید:`;
  const markup = myServicesListKeyboard(services, currentPage, totalPages);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, title, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, title, { reply_markup: markup });
  }
}

export async function handleMyServiceDetail(env, db, chatId, userId, userSrvId, messageId = null) {
  const srv = await db.prepare('SELECT * FROM user_services WHERE id = ? AND user_id = ?').bind(userSrvId, userId).first();
  if (!srv) {
    await sendMessage(env.BOT_TOKEN, chatId, '❌ اطلاعات سرویس یافت نشد.');
    return;
  }

  const isExpired = new Date(srv.expires_at) < new Date();
  const statusBadge = isExpired ? '🔴 منقضی شده' : (srv.status === 'active' ? '🟢 فعال' : '⚪️ غیرفعال');

  const text = `📦 <b>مشخصات سرویس #${srv.id}</b>

🔹 نام سرویس: <b>${escapeHtml(srv.service_name)}</b>
🔸 وضعیت: <b>${statusBadge}</b>
📅 تاریخ شروع: ${formatDate(srv.starts_at)}
⏳ تاریخ انقضا: <b>${formatDate(srv.expires_at)}</b>

🔐 <b>اطلاعات اتصال / کانفیگ:</b>
<code>${escapeHtml(srv.config_text)}</code>

⚠️ <i>جهت کپی کردن، روی کادر کانفیگ بالا ضربه بزنید.</i>`;

  const markup = myServiceDetailKeyboard(srv);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function handleTestServiceRequest(env, db, chatId, user, messageId = null) {
  const settings = await getSettings(db);
  const cooldownHours = Number(settings.test_cooldown_hours) || 24;

  // Check if user has an active delivered test within cooldown
  const lastDelivered = await db.prepare(`
    SELECT * FROM test_requests
    WHERE user_id = ? AND status = 'delivered'
    ORDER BY delivered_at DESC LIMIT 1
  `).bind(user.id).first();

  if (lastDelivered && lastDelivered.delivered_at) {
    const deliveredTime = new Date(lastDelivered.delivered_at).getTime();
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const nowMs = Date.now();
    const remainingMs = (deliveredTime + cooldownMs) - nowMs;

    if (remainingMs > 0) {
      const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
      const remainingMins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      const limitText = `⚠️ <b>محدودیت دریافت اکانت تست رایگان</b>\n\nشما قبلاً یک اکانت تست دریافت کرده‌اید.\nزمان باقی‌مانده تا امکان درخواست مجدد: <b>${remainingHours} ساعت و ${remainingMins} دقیقه</b>\n\nجهت استفاده دائمی می‌توانید از منوی اصلی اقدام به خرید اشتراک نمایید.`;
      const markup = {
        inline_keyboard: [
          [{ text: '🛒 خرید اشتراک', callback_data: 'menu_services' }],
          [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]
        ]
      };
      if (messageId) {
        await editMessageText(env.BOT_TOKEN, chatId, messageId, limitText, { reply_markup: markup });
      } else {
        await sendMessage(env.BOT_TOKEN, chatId, limitText, { reply_markup: markup });
      }
      return;
    }
  }

  // Check if user already has a pending test request
  const pendingReq = await db.prepare('SELECT id FROM test_requests WHERE user_id = ? AND status = "pending"').bind(user.id).first();
  if (pendingReq) {
    const pendingText = `⏳ <b>درخواست تست شما در صف بررسی است</b>\n\nدرخواست تست قبلی شما (کد #${pendingReq.id}) در حال بررسی توسط مدیریت است. به محض ارسال کانفیگ، در همین ربات برای شما فرستاده خواهد شد.`;
    const markup = { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]] };
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, pendingText, { reply_markup: markup });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, pendingText, { reply_markup: markup });
    }
    return;
  }

  // Create new pending test request
  const now = new Date().toISOString();
  const insertRes = await db.prepare(`
    INSERT INTO test_requests (user_id, status, created_at)
    VALUES (?, 'pending', ?)
  `).bind(user.id, now).run();

  const testId = insertRes.meta.last_row_id;

  const successText = `🧪 <b>درخواست اکانت تست ثبت شد</b>\n\nکد پیگیری درخواست: <code>#TEST-${testId}</code>\n\nدرخواست شما برای مدیریت ارسال شد و پس از بررسی، کانفیگ اختصاصی شما ارسال خواهد شد.`;
  const markup = { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]] };

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, successText, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, successText, { reply_markup: markup });
  }

  // Push instant alert to all admins
  const adminIds = await getAllAdminIds(env, db);
  const adminAlert = `🧪 <b>درخواست اکانت تست جدید</b>\n\n👤 کاربر: <b>${escapeHtml(user.first_name)}</b> (@${escapeHtml(user.username || 'ندارد')})\n🆔 شناسه عددی: <code>${user.id}</code>\nکد درخواست: <code>#TEST-${testId}</code>`;
  const adminMarkup = {
    inline_keyboard: [
      [
        { text: '✅ ارسال کانفیگ تست', callback_data: `adm_test_approve:${testId}` },
        { text: '❌ رد درخواست', callback_data: `adm_test_reject:${testId}` }
      ]
    ]
  };

  for (const aId of adminIds) {
    await sendMessage(env.BOT_TOKEN, aId, adminAlert, { reply_markup: adminMarkup });
  }
}

export async function handleGuidesMenu(env, db, chatId, messageId = null) {
  const guides = (await db.prepare('SELECT id, title FROM guides WHERE is_active = 1 ORDER BY display_order ASC, id ASC').all())?.results || [];

  if (guides.length === 0) {
    const text = '📖 راهنمای اتصالی در حال حاضر ثبت نشده است.';
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, text, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]] }
      });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, text);
    }
    return;
  }

  const title = '📖 <b>راهنماهای اتصال به سرویس‌ها</b>\nلطفاً سیستم‌عامل خود را انتخاب فرمایید:';
  const markup = guidesListKeyboard(guides);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, title, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, title, { reply_markup: markup });
  }
}

export async function handleGuideView(env, db, chatId, guideId, messageId = null) {
  const guide = await db.prepare('SELECT * FROM guides WHERE id = ?').bind(guideId).first();
  if (!guide) {
    await sendMessage(env.BOT_TOKEN, chatId, '❌ راهنمای مورد نظر یافت نشد.');
    return;
  }

  const text = `📖 <b>${escapeHtml(guide.title)}</b>\n\n${escapeHtml(guide.content)}`;
  const markup = {
    inline_keyboard: [
      [{ text: '🔙 بازگشت به لیست راهنماها', callback_data: 'menu_guides' }],
      [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]
    ]
  };

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function handleReferralMenu(env, db, chatId, user, messageId = null) {
  const settings = await getSettings(db);
  const botInfo = await getMe(env.BOT_TOKEN);
  const botUsername = botInfo?.result?.username || 'NexiUPBot';

  const refCountRow = await db.prepare('SELECT COUNT(*) AS c FROM users WHERE referrer_id = ?').bind(user.id).first();
  const invitedCount = refCountRow?.c || 0;

  const earningsRow = await db.prepare(`
    SELECT SUM(amount) AS s FROM wallet_ledger
    WHERE user_id = ? AND type = 'referral_commission'
  `).bind(user.id).first();
  const totalIncome = earningsRow?.s || 0;

  const refLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
  const percent = settings.default_referral_percent || DEFAULT_BRAND.default_referral_percent;

  const text = await getText(db, 'referral_info', {
    percent,
    link: refLink,
    count: invitedCount,
    income: formatPrice(totalIncome, settings.currency)
  });

  const markup = {
    inline_keyboard: [
      [{ text: '💰 کیف پول و برداشت سود', callback_data: 'menu_wallet' }],
      [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]
    ]
  };

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function handleSupportMenu(env, db, chatId, userId, messageId = null) {
  const settings = await getSettings(db);
  const text = await getText(db, 'support_text', {
    support_id: settings.support_id || DEFAULT_BRAND.support_id
  });

  // Set user state to write support message
  await setUserState(db, userId, 'support_ticket_message');

  const markup = {
    inline_keyboard: [
      [{ text: '🔙 انصراف و بازگشت', callback_data: 'cancel_state' }]
    ]
  };

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

// ============================================================================
// SECTION 8: WALLET & PAYMENT PROCESSING (ATOMIC TRANSACTIONS, LEDGER)
// ============================================================================

export async function creditWallet(db, userId, amount, type, refId = '', description = '') {
  const numAmount = Math.max(0, Math.floor(Number(amount)));
  if (numAmount <= 0) return { ok: false, error: 'invalid_amount' };

  const now = new Date().toISOString();

  // Fetch current user
  const user = await getUser(db, userId);
  if (!user) return { ok: false, error: 'user_not_found' };

  const newBalance = (user.wallet_balance || 0) + numAmount;

  await db.batch([
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').bind(numAmount, userId),
    db.prepare(`
      INSERT INTO wallet_ledger (user_id, amount, balance_after, type, reference_id, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(userId, numAmount, newBalance, type, String(refId), description, now)
  ]);

  return { ok: true, newBalance };
}

export async function debitWallet(db, userId, amount, type, refId = '', description = '') {
  const numAmount = Math.max(0, Math.floor(Number(amount)));
  if (numAmount <= 0) return { ok: false, error: 'invalid_amount' };

  const now = new Date().toISOString();

  const user = await getUser(db, userId);
  if (!user) return { ok: false, error: 'user_not_found' };

  if ((user.wallet_balance || 0) < numAmount) {
    return { ok: false, error: 'insufficient_balance' };
  }

  const newBalance = user.wallet_balance - numAmount;

  const result = await db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ? AND wallet_balance >= ?')
    .bind(numAmount, userId, numAmount).run();

  if (result.meta.changes === 0) {
    return { ok: false, error: 'concurrency_error' };
  }

  await db.prepare(`
    INSERT INTO wallet_ledger (user_id, amount, balance_after, type, reference_id, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, -numAmount, newBalance, type, String(refId), description, now).run();

  return { ok: true, newBalance };
}

export async function handleWalletMenu(env, db, chatId, user, messageId = null) {
  const freshUser = await getUser(db, user.id);
  const settings = await getSettings(db);

  const earningsRow = await db.prepare(`
    SELECT SUM(amount) AS s FROM wallet_ledger
    WHERE user_id = ? AND type = 'referral_commission'
  `).bind(user.id).first();
  const referralIncome = earningsRow?.s || 0;

  const text = await getText(db, 'wallet_info', {
    balance: formatPrice(freshUser.wallet_balance || 0, settings.currency),
    referral_income: formatPrice(referralIncome, settings.currency)
  });

  const markup = walletMenuKeyboard();

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function handleWalletHistory(env, db, chatId, userId, page = 1, messageId = null) {
  const PAGE_SIZE = 6;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM wallet_ledger WHERE user_id = ?').bind(userId).first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const rows = (await db.prepare(`
    SELECT * FROM wallet_ledger
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).bind(userId, PAGE_SIZE, offset).all())?.results || [];

  if (rows.length === 0) {
    const emptyText = '📜 هنوز هیچ تراکنشی در کیف پول شما ثبت نشده است.';
    const markup = { inline_keyboard: [[{ text: '🔙 بازگشت به کیف پول', callback_data: 'menu_wallet' }]] };
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, emptyText, { reply_markup: markup });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, emptyText, { reply_markup: markup });
    }
    return;
  }

  const typeLabels = {
    deposit: '➕ شارژ حساب',
    purchase: '🛒 پرداخت سفارش',
    refund: '↩️ بازگشت وجه',
    referral_commission: '👥 کمیسیون زیرمجموعه',
    withdrawal: '💸 برداشت وجه',
    bonus: '🎁 پاداش شارژ',
    admin_adjustment: '⚖️ اصلاح مدیریت'
  };

  let msg = `📜 <b>گردش حساب و تراکنش‌های کیف پول</b> (صفحه ${currentPage} از ${totalPages})\n\n`;

  for (const r of rows) {
    const sign = r.amount > 0 ? '+' : '';
    const label = typeLabels[r.type] || r.type;
    msg += `▪️ <b>${label}</b>\n`;
    msg += `   مبلغ: <b>${sign}${formatPrice(r.amount)}</b> | موجودی پس از تراکنش: ${formatPrice(r.balance_after)}\n`;
    msg += `   تاریخ: ${formatDate(r.created_at)}\n`;
    if (r.description) {
      msg += `   توضیح: ${escapeHtml(r.description)}\n`;
    }
    msg += `----------------------------------------\n`;
  }

  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ قبلی', callback_data: `wallet_history:${currentPage - 1}` });
  }
  navRow.push({ text: `📄 ${currentPage} / ${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'بعدی ▶️', callback_data: `wallet_history:${currentPage + 1}` });
  }

  const keyboard = [];
  if (totalPages > 1) keyboard.push(navRow);
  keyboard.push([{ text: '🔙 بازگشت به کیف پول', callback_data: 'menu_wallet' }]);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, msg, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, msg, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function createOrder(env, db, user, serviceId, renewalOfServiceId = null) {
  const service = await db.prepare('SELECT * FROM services WHERE id = ? AND is_active = 1').bind(serviceId).first();
  if (!service) return { ok: false, error: 'سرویس مورد نظر یافت نشد یا غیرفعال است.' };

  const settings = await getSettings(db);
  const maxPending = Number(settings.max_pending_orders) || 3;

  // Anti-abuse: limit number of simultaneous pending orders
  const pendingCountRow = await db.prepare(`
    SELECT COUNT(*) AS c FROM orders
    WHERE user_id = ? AND (status = 'pending_payment' OR status = 'pending_approval')
  `).bind(user.id).first();

  if ((pendingCountRow?.c || 0) >= maxPending) {
    return { ok: false, error: `شما در حال حاضر ${pendingCountRow.c} سفارش بررسی‌نشده دارید. لطفاً تا تعیین وضعیت آن‌ها صبور باشید.` };
  }

  let originalPrice = service.price;
  let discountAmount = 0;
  let couponCode = null;

  // Sales booster: First purchase discount
  const firstDiscountPercent = Number(settings.first_purchase_discount_percent) || 0;
  if (firstDiscountPercent > 0 && Number(user.orders_count) === 0) {
    discountAmount = Math.floor((originalPrice * firstDiscountPercent) / 100);
    couponCode = `FIRST-${firstDiscountPercent}%`;
  }

  const finalPrice = Math.max(0, originalPrice - discountAmount);
  const now = new Date().toISOString();

  const insertRes = await db.prepare(`
    INSERT INTO orders (
      user_id, service_id, service_name, original_price, discount_amount, final_price,
      wallet_paid, manual_paid, coupon_code, status, renewal_of_service_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending_payment', ?, ?, ?)
  `).bind(
    user.id, service.id, service.name, originalPrice, discountAmount, finalPrice,
    couponCode, renewalOfServiceId, now, now
  ).run();

  const orderId = insertRes.meta.last_row_id;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();

  return { ok: true, order };
}

export async function renderOrderInvoice(env, db, chatId, order, user, messageId = null) {
  const settings = await getSettings(db);
  const freshUser = await getUser(db, user.id);

  const text = await getText(db, 'order_invoice', {
    order_id: order.id,
    service_name: escapeHtml(order.service_name),
    original_price: formatPrice(order.original_price, settings.currency),
    discount: formatPrice(order.discount_amount || 0, settings.currency),
    final_price: formatPrice(order.final_price, settings.currency)
  });

  const markup = orderInvoiceKeyboard(order, freshUser.wallet_balance || 0);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

export async function processWalletFullPayment(env, db, orderId, user) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(orderId, user.id).first();
  if (!order || order.status !== 'pending_payment') {
    return { ok: false, error: 'سفارش معتبر نیست یا قبلاً بررسی شده است.' };
  }

  const amount = order.final_price;
  const debitRes = await debitWallet(db, user.id, amount, 'purchase', order.id, `پرداخت سفارش #${order.id} (${order.service_name})`);

  if (!debitRes.ok) {
    return { ok: false, error: 'موجودی کیف پول شما کافی نیست.' };
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE orders
    SET wallet_paid = ?, manual_paid = 0, status = 'pending_approval', updated_at = ?
    WHERE id = ?
  `).bind(amount, now, order.id).run();

  // Notify admins
  const adminIds = await getAllAdminIds(env, db);
  const adminAlert = `⚡️ <b>سفارش جدید پرداخت‌شده از کیف پول</b>

کد سفارش: <code>#${order.id}</code>
👤 خریدار: <b>${escapeHtml(user.first_name)}</b> (@${escapeHtml(user.username || 'ندارد')})
🆔 شناسه کاربر: <code>${user.id}</code>
📦 سرویس: <b>${escapeHtml(order.service_name)}</b>
💰 مبلغ کسرشده: <b>${formatPrice(amount)}</b> (پرداخت کامل کیف پول)

لطفاً جهت تحویل کانفیگ، روی دکمه زیر کلیک نمایید:`;

  const adminMarkup = {
    inline_keyboard: [
      [
        { text: '✅ تایید و ارسال کانفیگ', callback_data: `adm_order_approve:${order.id}` },
        { text: '❌ رد و بازگشت وجه', callback_data: `adm_order_reject:${order.id}` }
      ]
    ]
  };

  for (const aId of adminIds) {
    await sendMessage(env.BOT_TOKEN, aId, adminAlert, { reply_markup: adminMarkup });
  }

  return { ok: true };
}

export async function processWalletSplitPayment(env, db, orderId, user) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(orderId, user.id).first();
  if (!order || order.status !== 'pending_payment') {
    return { ok: false, error: 'سفارش نامعتبر است.' };
  }

  const freshUser = await getUser(db, user.id);
  const walletBalance = freshUser.wallet_balance || 0;

  if (walletBalance <= 0) {
    return { ok: false, error: 'موجودی کیف پول شما صفر است.' };
  }

  const walletPortion = Math.min(walletBalance, order.final_price);
  const remainingManual = order.final_price - walletPortion;

  // Deduct wallet portion atomically
  const debitRes = await debitWallet(db, user.id, walletPortion, 'purchase', order.id, `بخشی از پرداخت سفارش #${order.id}`);
  if (!debitRes.ok) {
    return { ok: false, error: 'خطا در کسر موجودی کیف پول.' };
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE orders
    SET wallet_paid = ?, manual_paid = ?, updated_at = ?
    WHERE id = ?
  `).bind(walletPortion, remainingManual, now, order.id).run();

  return { ok: true, walletPortion, remainingManual };
}

export async function submitOrderManualPayment(env, db, orderId, user, methodId, receiptFileId, paymentNotes = '') {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(orderId, user.id).first();
  if (!order) return { ok: false, error: 'سفارش یافت نشد.' };

  const pm = await db.prepare('SELECT * FROM payment_methods WHERE id = ?').bind(methodId).first();
  const pmName = pm ? pm.name : 'دستی';

  const now = new Date().toISOString();
  const remainingPrice = order.manual_paid > 0 ? order.manual_paid : order.final_price;

  await db.prepare(`
    UPDATE orders
    SET payment_method_id = ?, payment_method_name = ?, manual_paid = ?,
        receipt_file_id = ?, payment_notes = ?, status = 'pending_approval', updated_at = ?
    WHERE id = ?
  `).bind(methodId, pmName, remainingPrice, receiptFileId, paymentNotes, now, order.id).run();

  // Push to all admins
  const adminIds = await getAllAdminIds(env, db);
  const settings = await getSettings(db);

  const adminCaption = `💳 <b>سفارش جدید در انتظار بررسی فیش</b>

کد پیگیری سفارش: <code>#${order.id}</code>
👤 خریدار: <b>${escapeHtml(user.first_name)}</b> (@${escapeHtml(user.username || 'ندارد')})
🆔 شناسه کاربر: <code>${user.id}</code>
📦 سرویس: <b>${escapeHtml(order.service_name)}</b>
💰 کل مبلغ سفارش: ${formatPrice(order.final_price, settings.currency)}
💳 پرداخت نقدی/فیش: <b>${formatPrice(remainingPrice, settings.currency)}</b>
${order.wallet_paid > 0 ? `💰 کسر از کیف پول: ${formatPrice(order.wallet_paid, settings.currency)}\n` : ''}روش پرداخت: <b>${escapeHtml(pmName)}</b>
${paymentNotes ? `📝 توضیحات کاربر: ${escapeHtml(paymentNotes)}\n` : ''}
جهت تایید و تحویل سرویس، از دکمه‌های زیر استفاده فرمایید:`;

  const adminMarkup = {
    inline_keyboard: [
      [
        { text: '✅ تایید و ارسال کانفیگ', callback_data: `adm_order_approve:${order.id}` },
        { text: '❌ رد سفارش', callback_data: `adm_order_reject:${order.id}` }
      ]
    ]
  };

  for (const aId of adminIds) {
    if (receiptFileId) {
      // Send as photo
      await sendPhoto(env.BOT_TOKEN, aId, receiptFileId, adminCaption, { reply_markup: adminMarkup });
    } else {
      await sendMessage(env.BOT_TOKEN, aId, adminCaption, { reply_markup: adminMarkup });
    }
  }

  return { ok: true };
}


// ============================================================================
// SECTION 9: ADMIN PANEL & SUBMENUS
// ============================================================================

export async function renderAdminPanel(env, db, chatId, messageId = null) {
  const settings = await getSettings(db);
  const pendingOrdersCount = (await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = "pending_approval"').first())?.c || 0;
  const pendingTestsCount = (await db.prepare('SELECT COUNT(*) AS c FROM test_requests WHERE status = "pending"').first())?.c || 0;
  const pendingWithdrawsCount = (await db.prepare('SELECT COUNT(*) AS c FROM withdrawals WHERE status = "pending"').first())?.c || 0;

  let text = `👑 <b>پنل مدیریت ربات ${escapeHtml(settings.brand_name || DEFAULT_BRAND.name)}</b>

🔹 وضعیت ربات: ${Number(settings.maintenance_mode) === 1 ? '⚠️ حالت تعمیرات (تعلیق)' : '🟢 آنلاین و فعال'}
🔹 نسخه سورس: <code>v${VERSION}</code>

📌 <b>کارهای در انتظار بررسی:</b>
📦 سفارش‌های منتظر تایید: <b>${pendingOrdersCount} مورد</b>
🧪 اکانت‌های تست منتظر ارسال: <b>${pendingTestsCount} مورد</b>
💸 درخواست‌های تسویه حساب: <b>${pendingWithdrawsCount} مورد</b>

جهت مدیریت هر بخش از گزینه‌های زیر استفاده فرمایید:`;

  const markup = adminPanelKeyboard();

  if (messageId) {
    return await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: markup });
  } else {
    return await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: markup });
  }
}

// Admin: Users Management
export async function renderAdminUsers(env, db, chatId, page = 1, messageId = null) {
  const PAGE_SIZE = 8;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const users = (await db.prepare(`
    SELECT id, first_name, username, wallet_balance, is_banned, orders_count
    FROM users
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, offset).all())?.results || [];

  const keyboard = [];

  for (const u of users) {
    const banBadge = u.is_banned ? '🚫' : '👤';
    const name = u.first_name || u.username || 'بی‌نام';
    keyboard.push([
      { text: `${banBadge} ${name} (ID: ${u.id})`, callback_data: `adm_user_view:${u.id}` }
    ]);
  }

  // Navigation row
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ قبلی', callback_data: `adm_users:${currentPage - 1}` });
  }
  navRow.push({ text: `📄 ${currentPage} / ${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'بعدی ▶️', callback_data: `adm_users:${currentPage + 1}` });
  }
  if (navRow.length > 0) keyboard.push(navRow);

  keyboard.push([
    { text: '🔍 جستجوی کاربر (آیدی یا یوزرنیم)', callback_data: 'adm_user_search' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `👥 <b>مدیریت کاربران</b> (مجموع: ${totalItems} نفر)\nجهت مشاهده پروفایل، تغییر موجودی، مسدودسازی یا ارسال پیام، روی کاربر کلیک کنید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminUserDetail(env, db, chatId, targetUserId, messageId = null) {
  const user = await getUser(db, targetUserId);
  if (!user) {
    await sendMessage(env.BOT_TOKEN, chatId, '❌ کاربر مورد نظر یافت نشد.');
    return;
  }

  const settings = await getSettings(db);
  const ordersCountRow = await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND status = "approved"').bind(user.id).first();
  const approvedOrders = ordersCountRow?.c || 0;

  const totalSpentRow = await db.prepare('SELECT SUM(final_price) AS s FROM orders WHERE user_id = ? AND status = "approved"').bind(user.id).first();
  const totalSpent = totalSpentRow?.s || 0;

  const refCountRow = await db.prepare('SELECT COUNT(*) AS c FROM users WHERE referrer_id = ?').bind(user.id).first();
  const refCount = refCountRow?.c || 0;

  const text = `👤 <b>پروفایل کاربر</b>

🆔 شناسه کاربری: <code>${user.id}</code>
👤 نام: <b>${escapeHtml(user.first_name)} ${escapeHtml(user.last_name || '')}</b>
🔗 یوزرنیم: @${escapeHtml(user.username || 'ندارد')}
💰 موجودی کیف پول: <b>${formatPrice(user.wallet_balance || 0, settings.currency)}</b>
🛍 تعداد خریدهای موفق: <b>${approvedOrders} عدد</b>
💵 مجموع مبالغ پرداختی: <b>${formatPrice(totalSpent, settings.currency)}</b>
👥 زیرمجموعه‌های مستقیم: <b>${refCount} نفر</b>
📅 تاریخ عضویت: ${formatDate(user.created_at)}
⚡️ آخرین فعالیت: ${formatDate(user.last_active_at)}
🚫 وضعیت انسداد: <b>${user.is_banned ? `مسدود (${escapeHtml(user.ban_reason || 'بدون دلیل')})` : 'آزاد / عادی'}</b>
🤖 ربات را بلاک کرده؟ <b>${user.has_blocked_bot ? 'بله' : 'خیر'}</b>`;

  const keyboard = [
    [
      { text: user.is_banned ? '✅ رفع مسدودی (Unban)' : '🚫 مسدودسازی کاربر (Ban)', callback_data: user.is_banned ? `adm_user_unban:${user.id}` : `adm_user_ban:${user.id}` },
      { text: '💰 تغییر موجودی کیف پول', callback_data: `adm_user_balance:${user.id}` }
    ],
    [
      { text: '✉️ ارسال پیام خصوصی', callback_data: `adm_user_msg:${user.id}` }
    ],
    [
      { text: '🔙 بازگشت به لیست کاربران', callback_data: 'adm_users:1' }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: Services Management
export async function renderAdminServices(env, db, chatId, page = 1, messageId = null) {
  const PAGE_SIZE = 8;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM services').first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const services = (await db.prepare(`
    SELECT * FROM services
    ORDER BY display_order ASC, id ASC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, offset).all())?.results || [];

  const keyboard = [];

  for (const s of services) {
    const statusBadge = s.is_active ? '🟢' : '⚪️';
    keyboard.push([
      { text: `${statusBadge} ${s.name} (${formatPrice(s.price)})`, callback_data: `adm_srv_view:${s.id}` }
    ]);
  }

  // Navigation
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ قبلی', callback_data: `adm_services:${currentPage - 1}` });
  }
  navRow.push({ text: `📄 ${currentPage} / ${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'بعدی ▶️', callback_data: `adm_services:${currentPage + 1}` });
  }
  if (navRow.length > 0) keyboard.push(navRow);

  keyboard.push([
    { text: '➕ افزودن سرویس جدید', callback_data: 'adm_srv_add' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `🛒 <b>مدیریت سرویس‌ها و پلن‌ها</b>\nجهت ویرایش مشخصات، تغییر قیمت یا فعال/غیرفعال‌سازی سرویس روی آن کلیک کنید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminServiceDetail(env, db, chatId, serviceId, messageId = null) {
  const srv = await db.prepare('SELECT * FROM services WHERE id = ?').bind(serviceId).first();
  if (!srv) {
    await sendMessage(env.BOT_TOKEN, chatId, '❌ سرویس یافت نشد.');
    return;
  }

  const text = `📦 <b>مشخصات سرویس #${srv.id}</b>

🔹 نام سرویس: <b>${escapeHtml(srv.name)}</b>
🔸 وضعیت: <b>${srv.is_active ? '🟢 فعال' : '⚪️ غیرفعال'}</b>
📊 حجم ترافیک: <b>${escapeHtml(srv.traffic)}</b>
⏳ مدت اعتبار: <b>${escapeHtml(srv.duration_text)}</b> (${srv.duration_days} روز)
💰 قیمت: <b>${formatPrice(srv.price)}</b>
🔢 ترتیب نمایش: <b>${srv.display_order}</b>

📝 توضیحات:
${escapeHtml(srv.description || 'بدون توضیح')}`;

  const keyboard = [
    [
      { text: srv.is_active ? '⚪️ غیرفعال‌سازی' : '🟢 فعال‌سازی', callback_data: `adm_srv_toggle:${srv.id}` },
      { text: '🗑 حذف سرویس', callback_data: `adm_srv_del:${srv.id}` }
    ],
    [
      { text: '✏️ ویرایش نام', callback_data: `adm_srv_edit:${srv.id}:name` },
      { text: '✏️ ویرایش قیمت', callback_data: `adm_srv_edit:${srv.id}:price` }
    ],
    [
      { text: '✏️ ویرایش حجم', callback_data: `adm_srv_edit:${srv.id}:traffic` },
      { text: '✏️ ویرایش مدت', callback_data: `adm_srv_edit:${srv.id}:duration` }
    ],
    [
      { text: '🔙 بازگشت به لیست سرویس‌ها', callback_data: 'adm_services:1' }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: Orders Management
export async function renderAdminOrders(env, db, chatId, statusFilter = 'pending_approval', page = 1, messageId = null) {
  const PAGE_SIZE = 6;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ?').bind(statusFilter).first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const orders = (await db.prepare(`
    SELECT id, user_id, service_name, final_price, status, created_at
    FROM orders
    WHERE status = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).bind(statusFilter, PAGE_SIZE, offset).all())?.results || [];

  const keyboard = [];

  for (const o of orders) {
    keyboard.push([
      { text: `📦 سفارش #${o.id} | ${o.service_name} (${formatPrice(o.final_price)})`, callback_data: `adm_order_view:${o.id}` }
    ]);
  }

  // Navigation row
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ قبلی', callback_data: `adm_orders:${statusFilter}:${currentPage - 1}` });
  }
  navRow.push({ text: `📄 ${currentPage} / ${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'بعدی ▶️', callback_data: `adm_orders:${statusFilter}:${currentPage + 1}` });
  }
  if (navRow.length > 0) keyboard.push(navRow);

  // Filter selector tabs
  keyboard.push([
    { text: statusFilter === 'pending_approval' ? '• در انتظار تایید •' : 'در انتظار تایید', callback_data: 'adm_orders:pending_approval:1' },
    { text: statusFilter === 'approved' ? '• تایید شده •' : 'تایید شده', callback_data: 'adm_orders:approved:1' },
    { text: statusFilter === 'rejected' ? '• رد شده •' : 'رد شده', callback_data: 'adm_orders:rejected:1' }
  ]);

  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const filterNames = {
    pending_approval: 'در انتظار بررسی فیش',
    approved: 'تایید و تحویل شده',
    rejected: 'رد شده',
    pending_payment: 'منتظر پرداخت'
  };

  const text = `📦 <b>مدیریت سفارش‌ها</b> (${filterNames[statusFilter] || statusFilter} - مجموع: ${totalItems} عدد)\nجهت مشاهده جزئیات سفارش روی آن کلیک کنید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminOrderDetail(env, db, chatId, orderId, messageId = null) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!order) {
    await sendMessage(env.BOT_TOKEN, chatId, '❌ سفارش یافت نشد.');
    return;
  }

  const buyer = await getUser(db, order.user_id);
  const statusBadges = {
    pending_approval: '⏳ در انتظار تایید مدیریت',
    approved: '✅ تایید و تحویل شده',
    rejected: '❌ رد شده',
    pending_payment: '💳 در انتظار پرداخت',
    cancelled: '⚪️ لغو شده'
  };

  const text = `📦 <b>جزئیات سفارش #${order.id}</b>

👤 خریدار: <b>${escapeHtml(buyer?.first_name || 'کاربر')}</b> (@${escapeHtml(buyer?.username || 'ندارد')})
🆔 شناسه خریدار: <code>${order.user_id}</code>
📦 نام سرویس: <b>${escapeHtml(order.service_name)}</b>
💰 مبلغ اصلی: ${formatPrice(order.original_price)}
🎟 تخفیف: ${formatPrice(order.discount_amount || 0)} ${order.coupon_code ? `(کد: ${order.coupon_code})` : ''}
💵 مبلغ نهایی: <b>${formatPrice(order.final_price)}</b>
💳 پرداخت دستی: <b>${formatPrice(order.manual_paid)}</b> (${order.payment_method_name || '-'})
💰 پرداخت از کیف پول: <b>${formatPrice(order.wallet_paid)}</b>
🔸 وضعیت سفارش: <b>${statusBadges[order.status] || order.status}</b>
📅 تاریخ ثبت: ${formatDate(order.created_at)}
${order.admin_notes ? `📝 یادداشت مدیر: ${escapeHtml(order.admin_notes)}\n` : ''}${order.handler_admin_name ? `👮 بررسی‌کننده: ${escapeHtml(order.handler_admin_name)}\n` : ''}${order.payment_notes ? `💬 یادداشت کاربر: ${escapeHtml(order.payment_notes)}\n` : ''}`;

  const keyboard = [];

  if (order.status === 'pending_approval' || order.status === 'pending_payment') {
    keyboard.push([
      { text: '✅ تایید و ارسال کانفیگ', callback_data: `adm_order_approve:${order.id}` },
      { text: '❌ رد سفارش', callback_data: `adm_order_reject:${order.id}` }
    ]);
  }

  keyboard.push([
    { text: '🔙 بازگشت به لیست سفارش‌ها', callback_data: `adm_orders:${order.status}:1` }
  ]);

  if (order.receipt_file_id) {
    // If has photo receipt
    await sendPhoto(env.BOT_TOKEN, chatId, order.receipt_file_id, text, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    if (messageId) {
      await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    }
  }
}

// Admin: Approve Order & Deliver Config
export async function executeOrderApproval(env, db, orderId, adminUser, configText) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!order || order.status !== 'pending_approval') {
    return { ok: false, error: 'این سفارش قبلاً بررسی شده یا در انتظار تایید نیست.' };
  }

  const service = await db.prepare('SELECT * FROM services WHERE id = ?').bind(order.service_id).first();
  const durationDays = service?.duration_days || 30;

  const now = new Date();
  const startDate = now.toISOString();
  const expiresDate = new Date(now.getTime() + (durationDays * 24 * 60 * 60 * 1000)).toISOString();

  const buyer = await getUser(db, order.user_id);
  const settings = await getSettings(db);

  // D1 batch transaction for atomic approval
  const batchStmts = [
    // 1. Update order status
    db.prepare(`
      UPDATE orders
      SET status = 'approved', handler_admin_id = ?, handler_admin_name = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_approval'
    `).bind(adminUser.id, adminUser.first_name || 'مدیر', startDate, order.id),

    // 2. Insert into user_services
    db.prepare(`
      INSERT INTO user_services (user_id, order_id, service_id, service_name, config_text, status, starts_at, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).bind(order.user_id, order.id, order.service_id, order.service_name, configText.trim(), startDate, expiresDate, startDate),

    // 3. Update user metrics
    db.prepare(`
      UPDATE users
      SET orders_count = orders_count + 1, total_spent = total_spent + ?
      WHERE id = ?
    `).bind(order.final_price, order.user_id)
  ];

  await db.batch(batchStmts);

  // Log admin action
  await logAdminAction(db, adminUser.id, 'approve_order', 'order', order.id, `Approved order #${order.id} for user ${order.user_id}`);

  // Referral commission calculation
  if (buyer?.referrer_id && Number(buyer.referrer_id) > 0) {
    const referrerId = buyer.referrer_id;
    // Check if commission already paid for this order
    const alreadyPaid = await db.prepare(`
      SELECT id FROM wallet_ledger
      WHERE type = 'referral_commission' AND reference_id = ?
    `).bind(String(order.id)).first();

    if (!alreadyPaid) {
      const commissionPercent = Number(settings.default_referral_percent) || DEFAULT_BRAND.default_referral_percent;
      const commissionAmount = Math.floor((order.final_price * commissionPercent) / 100);

      if (commissionAmount > 0) {
        await creditWallet(
          db,
          referrerId,
          commissionAmount,
          'referral_commission',
          String(order.id),
          `کمیسیون معرفی برای خرید سفارش #${order.id}`
        );

        // Notify referrer
        await sendMessage(
          env.BOT_TOKEN,
          referrerId,
          `🎉 <b>تبریک! کمیسیون جدید به کیف پول شما اضافه شد</b>\n\nکاربر زیرمجموعه شما خریدی انجام داد و مبلغ <b>${formatPrice(commissionAmount)}</b> به موجودی کیف پول شما افزوده شد.`
        );
      }
    }
  }

  // Deliver config to buyer
  const deliveryText = await getText(db, 'order_approved', {
    service_name: escapeHtml(order.service_name),
    duration: escapeHtml(service?.duration_text || `${durationDays} روزه`),
    expires_at: formatDate(expiresDate),
    config: escapeHtml(configText.trim())
  });

  const buyerMarkup = {
    inline_keyboard: [
      [{ text: '📦 مشاهده در سرویس‌های من', callback_data: 'menu_myservices' }],
      [{ text: '📖 راهنمای اتصال', callback_data: 'menu_guides' }]
    ]
  };

  await sendMessage(env.BOT_TOKEN, order.user_id, deliveryText, { reply_markup: buyerMarkup });

  return { ok: true, expiresDate };
}

// Admin: Reject Order
export async function executeOrderRejection(env, db, orderId, adminUser, reasonText) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!order || (order.status !== 'pending_approval' && order.status !== 'pending_payment')) {
    return { ok: false, error: 'سفارش قبلاً تعیین تکلیف شده است.' };
  }

  const now = new Date().toISOString();

  // If order was partially or fully paid from wallet, refund that portion atomically
  let refundNote = '';
  if (order.wallet_paid > 0) {
    await creditWallet(
      db,
      order.user_id,
      order.wallet_paid,
      'refund',
      String(order.id),
      `بازگشت وجه به علت رد سفارش #${order.id}`
    );
    refundNote = `\n💰 مبلغ ${formatPrice(order.wallet_paid)} به موجودی کیف پول شما عودت داده شد.`;
  }

  await db.prepare(`
    UPDATE orders
    SET status = 'rejected', admin_notes = ?, handler_admin_id = ?, handler_admin_name = ?, updated_at = ?
    WHERE id = ?
  `).bind(reasonText, adminUser.id, adminUser.first_name || 'مدیر', now, order.id).run();

  await logAdminAction(db, adminUser.id, 'reject_order', 'order', order.id, `Reason: ${reasonText}`);

  // Notify buyer
  const rejectText = await getText(db, 'order_rejected', {
    order_id: order.id,
    reason: escapeHtml(reasonText),
    refund_note: refundNote
  });

  await sendMessage(env.BOT_TOKEN, order.user_id, rejectText);

  return { ok: true };
}

// Admin: Payment Methods Management
export async function renderAdminPaymentMethods(env, db, chatId, messageId = null) {
  const methods = (await db.prepare('SELECT * FROM payment_methods ORDER BY display_order ASC, id ASC').all())?.results || [];

  const keyboard = [];

  for (const m of methods) {
    const status = m.is_active ? '🟢' : '⚪️';
    keyboard.push([
      { text: `${status} ${m.name}`, callback_data: `adm_pm_view:${m.id}` }
    ]);
  }

  keyboard.push([
    { text: '➕ افزودن روش پرداخت جدید', callback_data: 'adm_pm_add' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `💳 <b>مدیریت روش‌های پرداخت</b>\nجهت ویرایش مشخصات کارت/آدرس ولت یا فعال/غیرفعال کردن روش، روی آن کلیک کنید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminPaymentMethodDetail(env, db, chatId, methodId, messageId = null) {
  const pm = await db.prepare('SELECT * FROM payment_methods WHERE id = ?').bind(methodId).first();
  if (!pm) {
    await sendMessage(env.BOT_TOKEN, chatId, '❌ روش پرداخت یافت نشد.');
    return;
  }

  const text = `💳 <b>مشخصات روش پرداخت #${pm.id}</b>

🔹 عنوان: <b>${escapeHtml(pm.name)}</b>
🔸 وضعیت: <b>${pm.is_active ? '🟢 فعال' : '⚪️ غیرفعال'}</b>

📝 اطلاعات حساب و شماره کارت / آدرس ولت:
${escapeHtml(pm.details)}

⚠️ راهنمای واریز به کاربر:
${escapeHtml(pm.instructions || 'ندارد')}`;

  const keyboard = [
    [
      { text: pm.is_active ? '⚪️ غیرفعال‌سازی' : '🟢 فعال‌سازی', callback_data: `adm_pm_toggle:${pm.id}` },
      { text: '🗑 حذف روش پرداخت', callback_data: `adm_pm_del:${pm.id}` }
    ],
    [
      { text: '🔙 بازگشت به لیست روش‌ها', callback_data: 'adm_paymethods' }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: Forced Channels Management
export async function renderAdminForcedChannels(env, db, chatId, messageId = null) {
  const settings = await getSettings(db);
  const channels = (await db.prepare('SELECT * FROM forced_channels ORDER BY display_order ASC, id ASC').all())?.results || [];

  const keyboard = [];

  for (const ch of channels) {
    const status = ch.is_active ? '🟢' : '⚪️';
    keyboard.push([
      { text: `${status} ${ch.title} (${ch.channel_id})`, callback_data: `adm_fc_view:${ch.id}` }
    ]);
  }

  const isGlobalOn = Number(settings.forced_join_enabled) === 1;

  keyboard.push([
    { text: isGlobalOn ? '🟢 قفل کانال اجباری: فعال' : '🔴 قفل کانال اجباری: غیرفعال', callback_data: 'adm_fc_toggle_global' }
  ]);
  keyboard.push([
    { text: '➕ افزودن کانال جدید', callback_data: 'adm_fc_add' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `📢 <b>مدیریت کانال‌های عضویت اجباری</b>

وضعیت سیستم قفل عضویت: <b>${isGlobalOn ? 'فعال (کاربران باید عضو باشند)' : 'غیرفعال (آزاد)'}</b>
تعداد کانال‌ها: ${channels.length} عدد

⚠️ توجه: ربات باید در کانال‌های اضافه شده ادمین باشد تا بتواند عضویت کاربر را بررسی کند.`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: Guides Management
export async function renderAdminGuides(env, db, chatId, messageId = null) {
  const guides = (await db.prepare('SELECT id, title, is_active FROM guides ORDER BY display_order ASC, id ASC').all())?.results || [];

  const keyboard = [];

  for (const g of guides) {
    keyboard.push([
      { text: `📖 ${g.title}`, callback_data: `adm_guide_view:${g.id}` }
    ]);
  }

  keyboard.push([
    { text: '➕ افزودن راهنمای اتصال جدید', callback_data: 'adm_guide_add' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `📖 <b>مدیریت راهنماهای اتصال</b>\nجهت مشاهده، ویرایش متن یا حذف روی راهنما کلیک نمایید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: Withdrawals Management
export async function renderAdminWithdrawals(env, db, chatId, statusFilter = 'pending', page = 1, messageId = null) {
  const PAGE_SIZE = 6;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM withdrawals WHERE status = ?').bind(statusFilter).first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const rows = (await db.prepare(`
    SELECT w.*, u.first_name, u.username
    FROM withdrawals w
    LEFT JOIN users u ON w.user_id = u.id
    WHERE w.status = ?
    ORDER BY w.id DESC
    LIMIT ? OFFSET ?
  `).bind(statusFilter, PAGE_SIZE, offset).all())?.results || [];

  const keyboard = [];

  for (const r of rows) {
    keyboard.push([
      { text: `💸 #${r.id} | ${formatPrice(r.amount)} (${r.first_name || r.user_id})`, callback_data: `adm_wd_view:${r.id}` }
    ]);
  }

  // Navigation
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ قبلی', callback_data: `adm_withdraws:${statusFilter}:${currentPage - 1}` });
  }
  navRow.push({ text: `📄 ${currentPage} / ${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'بعدی ▶️', callback_data: `adm_withdraws:${statusFilter}:${currentPage + 1}` });
  }
  if (navRow.length > 0) keyboard.push(navRow);

  keyboard.push([
    { text: statusFilter === 'pending' ? '• در انتظار •' : 'در انتظار', callback_data: 'adm_withdraws:pending:1' },
    { text: statusFilter === 'approved' ? '• تسویه شده •' : 'تسویه شده', callback_data: 'adm_withdraws:approved:1' },
    { text: statusFilter === 'rejected' ? '• رد شده •' : 'رد شده', callback_data: 'adm_withdraws:rejected:1' }
  ]);

  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `💸 <b>مدیریت درخواست‌های تسویه حساب</b> (وضعیت: ${statusFilter} - تعداد: ${totalItems})\nروی هر درخواست جهت مشاهده جزئیات کلیک کنید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: General Settings
export async function renderAdminSettings(env, db, chatId, messageId = null) {
  const settings = await getSettings(db);

  const text = `⚙️ <b>تنظیمات عمومی ربات</b>

🔹 نام برند: <b>${escapeHtml(settings.brand_name || DEFAULT_BRAND.name)}</b>
🔹 واحد پولی: <b>${escapeHtml(settings.currency || DEFAULT_BRAND.currency)}</b>
🔹 آیدی پشتیبانی: <b>${escapeHtml(settings.support_id || DEFAULT_BRAND.support_id)}</b>
🔹 درصد پیش‌فرض رفرال: <b>${settings.default_referral_percent || DEFAULT_BRAND.default_referral_percent}٪</b>
🔹 فاصله مجاز اکانت تست: <b>${settings.test_cooldown_hours || DEFAULT_BRAND.test_cooldown_hours} ساعت</b>
🔹 حداقل مبلغ برداشت: <b>${formatPrice(settings.min_withdrawal || DEFAULT_BRAND.min_withdrawal)}</b>
🔹 مهلت پرداخت سفارش: <b>${settings.order_timeout_minutes || DEFAULT_BRAND.order_timeout_minutes} دقیقه</b>
🔹 تخفیف خرید اول: <b>${settings.first_purchase_discount_percent || 0}٪</b>
🔹 بونوس شارژ کیف پول: <b>${settings.wallet_topup_bonus_percent || 0}٪</b>
🔹 حالت تعمیرات: <b>${Number(settings.maintenance_mode) === 1 ? '🔴 روشن (تعلیق)' : '🟢 خاموش (عادی)'}</b>

برای تغییر هر مورد، دکمه مربوطه را انتخاب کنید:`;

  const keyboard = [
    [
      { text: Number(settings.maintenance_mode) === 1 ? '🟢 غیرفعال کردن حالت تعمیرات' : '🔴 فعال کردن حالت تعمیرات', callback_data: 'adm_setting_toggle:maintenance_mode' }
    ],
    [
      { text: '✏️ تغییر نام برند', callback_data: 'adm_setting_edit:brand_name' },
      { text: '✏️ تغییر واحد پولی', callback_data: 'adm_setting_edit:currency' }
    ],
    [
      { text: '✏️ تغییر آیدی پشتیبانی', callback_data: 'adm_setting_edit:support_id' },
      { text: '✏️ درصد رفرال', callback_data: 'adm_setting_edit:default_referral_percent' }
    ],
    [
      { text: '✏️ فاصله مجاز تست', callback_data: 'adm_setting_edit:test_cooldown_hours' },
      { text: '✏️ حداقل مبلغ برداشت', callback_data: 'adm_setting_edit:min_withdrawal' }
    ],
    [
      { text: '✏️ تخفیف خرید اول', callback_data: 'adm_setting_edit:first_purchase_discount_percent' },
      { text: '✏️ بونوس شارژ کیف پول', callback_data: 'adm_setting_edit:wallet_topup_bonus_percent' }
    ],
    [
      { text: '📢 ثبت/ویرایش بنر اطلاعیه', callback_data: 'adm_setting_edit:pinned_announcement' }
    ],
    [
      { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// Admin: Admins List
export async function renderAdminAdmins(env, db, chatId, messageId = null) {
  const allIds = await getAllAdminIds(env, db);

  let msg = `👮 <b>مدیریت مدیران ربات</b>\n\nتعداد کل مدیران: <b>${allIds.length} نفر</b>\n\n`;

  const keyboard = [];

  for (const id of allIds) {
    const user = await getUser(db, id);
    const name = user ? `${user.first_name} (@${user.username || 'ندارد'})` : 'شناسه بدون پروفایل';
    msg += `▪️ <code>${id}</code> | ${escapeHtml(name)}\n`;
    keyboard.push([
      { text: `🗑 حذف دسترسی مدیر #${id}`, callback_data: `adm_admin_del:${id}` }
    ]);
  }

  keyboard.push([
    { text: '➕ افزودن مدیر جدید', callback_data: 'adm_admin_add' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, msg, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, msg, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// ============================================================================
// SECTION 10: ADMIN STATISTICS DASHBOARD
// ============================================================================

export async function getAggregatedStats(db, period = 'today') {
  const now = Date.now();
  const cached = MEM_CACHE.statsCache.get(period);
  if (cached && cached.expireAt > now) {
    return cached.data;
  }

  // Calculate start date string for SQL
  let periodStart = "date('now', 'start of day')";
  if (period === '7d') {
    periodStart = "datetime('now', '-7 days')";
  } else if (period === '30d') {
    periodStart = "datetime('now', '-30 days')";
  } else if (period === 'all') {
    periodStart = "'1970-01-01 00:00:00'";
  }

  // Batch query for fast execution
  const results = await db.batch([
    // 0: Users aggregation
    db.prepare(`
      SELECT
        COUNT(*) AS total_users,
        SUM(CASE WHEN created_at >= ${periodStart} THEN 1 ELSE 0 END) AS new_users,
        SUM(CASE WHEN last_active_at >= ${periodStart} THEN 1 ELSE 0 END) AS active_users,
        SUM(CASE WHEN is_banned = 1 THEN 1 ELSE 0 END) AS banned_users,
        SUM(CASE WHEN has_blocked_bot = 1 THEN 1 ELSE 0 END) AS blocked_bot,
        SUM(CASE WHEN referrer_id IS NOT NULL AND created_at >= ${periodStart} THEN 1 ELSE 0 END) AS ref_signups
      FROM users
    `),

    // 1: Orders aggregation
    db.prepare(`
      SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_orders,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_orders,
        SUM(CASE WHEN status = 'pending_approval' OR status = 'pending_payment' THEN 1 ELSE 0 END) AS pending_orders,
        SUM(CASE WHEN status = 'approved' THEN final_price ELSE 0 END) AS total_revenue,
        AVG(CASE WHEN status = 'approved' THEN final_price ELSE NULL END) AS avg_order_value,
        SUM(CASE WHEN status = 'approved' THEN wallet_paid ELSE 0 END) AS wallet_rev,
        SUM(CASE WHEN status = 'approved' THEN manual_paid ELSE 0 END) AS manual_rev,
        SUM(discount_amount) AS total_discount
      FROM orders
      WHERE created_at >= ${periodStart}
    `),

    // 2: Top Selling Services
    db.prepare(`
      SELECT service_name, COUNT(*) AS count, SUM(final_price) AS revenue
      FROM orders
      WHERE status = 'approved' AND created_at >= ${periodStart}
      GROUP BY service_name
      ORDER BY count DESC
      LIMIT 3
    `),

    // 3: Test requests aggregation
    db.prepare(`
      SELECT
        COUNT(*) AS total_tests,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_tests,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_tests
      FROM test_requests
      WHERE created_at >= ${periodStart}
    `),

    // 4: Wallet and referral stats
    db.prepare(`
      SELECT
        (SELECT SUM(wallet_balance) FROM users) AS total_wallet_balance,
        (SELECT SUM(amount) FROM wallet_ledger WHERE type = 'referral_commission' AND created_at >= ${periodStart}) AS referral_paid,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') AS pending_wd_count,
        (SELECT SUM(amount) FROM withdrawals WHERE status = 'approved' AND created_at >= ${periodStart}) AS total_wd_paid
    `),

    // 5: Forced channels join tracking
    db.prepare(`
      SELECT channel_id, COUNT(*) AS total_joined,
        SUM(CASE WHEN status = 'joined' THEN 1 ELSE 0 END) AS active_members,
        SUM(CASE WHEN status = 'left' THEN 1 ELSE 0 END) AS leavers
      FROM channel_joins
      GROUP BY channel_id
    `)
  ]);

  const data = {
    users: results[0]?.results?.[0] || {},
    orders: results[1]?.results?.[0] || {},
    topServices: results[2]?.results || [],
    tests: results[3]?.results?.[0] || {},
    wallet: results[4]?.results?.[0] || {},
    channels: results[5]?.results || []
  };

  MEM_CACHE.statsCache.set(period, { data, expireAt: now + 60000 });
  return data;
}

export async function renderAdminStats(env, db, chatId, period = 'today', messageId = null) {
  const stats = await getAggregatedStats(db, period);
  const settings = await getSettings(db);

  const periodLabels = {
    today: 'امروز',
    '7d': '۷ روز گذشته',
    '30d': '۳۰ روز گذشته',
    all: 'کل تاریخچه'
  };

  const u = stats.users;
  const o = stats.orders;
  const t = stats.tests;
  const w = stats.wallet;

  let topSrvText = '';
  if (stats.topServices && stats.topServices.length > 0) {
    topSrvText = '\n🏆 <b>پرفروش‌ترین سرویس‌ها:</b>\n';
    stats.topServices.forEach((s, idx) => {
      topSrvText += `  ${idx + 1}. ${escapeHtml(s.service_name)}: <b>${s.count} سفارش</b> (${formatPrice(s.revenue)})\n`;
    });
  }

  let channelsText = '';
  if (stats.channels && stats.channels.length > 0) {
    channelsText = '\n📢 <b>آمار عضویت کانال‌های اجباری:</b>\n';
    stats.channels.forEach((ch) => {
      channelsText += `  ▪️ ${escapeHtml(ch.channel_id)}: ${ch.active_members || 0} عضو فعال | ${ch.leavers || 0} لفت\n`;
    });
  }

  const text = `📊 <b>داشبورد آمار و گزارش جامع (${periodLabels[period] || period})</b>

👥 <b>کاربران:</b>
▫️ کل کاربران ربات: <b>${(u.total_users || 0).toLocaleString()} نفر</b>
▫️ کاربران جدید در بازه: <b>${(u.new_users || 0).toLocaleString()} نفر</b>
▫️ کاربران فعال در بازه: <b>${(u.active_users || 0).toLocaleString()} نفر</b>
▫️ ورودی‌های زیرمجموعه‌گیری: <b>${(u.ref_signups || 0).toLocaleString()} نفر</b>
▫️ مسدودشده / بلاک‌کنندگان ربات: <b>${(u.banned_users || 0).toLocaleString()} / ${(u.blocked_bot || 0).toLocaleString()}</b>

🛒 <b>فروش و درآمد:</b>
▫️ تعداد کل سفارش‌ها: <b>${(o.total_orders || 0).toLocaleString()} عدد</b>
▫️ تایید و تحویل شده: <b>${(o.approved_orders || 0).toLocaleString()} عدد</b>
▫️ رد شده / در انتظار: <b>${(o.rejected_orders || 0).toLocaleString()} / ${(o.pending_orders || 0).toLocaleString()}</b>
▫️ درآمد ناخالص فروش: <b>${formatPrice(o.total_revenue || 0, settings.currency)}</b>
▫️ میانگین ارزش هر سفارش: <b>${formatPrice(Math.round(o.avg_order_value || 0), settings.currency)}</b>
▫️ درآمد از کیف پول vs واریز فیش: <b>${formatPrice(o.wallet_rev || 0)}</b> / <b>${formatPrice(o.manual_rev || 0)}</b>
▫️ مجموع تخفیف‌های اعمال شده: <b>${formatPrice(o.total_discount || 0)}</b>
${topSrvText}
🧪 <b>اکانت تست:</b>
▫️ کل درخواست‌های تست: <b>${(t.total_tests || 0).toLocaleString()}</b> (تحویل: ${t.delivered_tests || 0} | رد: ${t.rejected_tests || 0})

💰 <b>کیف پول و کمیسیون‌ها:</b>
▫️ مجموع موجودی کیف پول همه کاربران: <b>${formatPrice(w.total_wallet_balance || 0)}</b>
▫️ کل کمیسیون رفرال پرداختی در بازه: <b>${formatPrice(w.referral_paid || 0)}</b>
▫️ تسویه‌های انجام شده / در انتظار: <b>${formatPrice(w.total_wd_paid || 0)}</b> / <b>${w.pending_wd_count || 0} مورد</b>
${channelsText}
🕒 آخرین بروزرسانی: <i>${formatDate(new Date().toISOString())}</i>`;

  const keyboard = [
    [
      { text: period === 'today' ? '• امروز •' : '📅 امروز', callback_data: 'adm_stats:today' },
      { text: period === '7d' ? '• ۷ روز •' : '📅 ۷ روز', callback_data: 'adm_stats:7d' }
    ],
    [
      { text: period === '30d' ? '• ۳۰ روز •' : '📅 ۳۰ روز', callback_data: 'adm_stats:30d' },
      { text: period === 'all' ? '• کل زمان •' : '🌐 کل زمان', callback_data: 'adm_stats:all' }
    ],
    [
      { text: '🔄 بروزرسانی آمار', callback_data: `adm_stats:${period}` },
      { text: '🔙 پنل مدیریت', callback_data: 'admin_panel' }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// ============================================================================
// SECTION 11: COUPONS & SALES BOOSTERS
// ============================================================================

export async function validateCoupon(db, code, userId, orderPrice) {
  const cleanCode = (code || '').trim().toUpperCase();
  const coupon = await db.prepare('SELECT * FROM coupons WHERE UPPER(code) = ?').bind(cleanCode).first();

  if (!coupon) return { ok: false, error: 'کد تخفیف وارد شده معتبر نمی‌باشد.' };
  if (!coupon.is_active) return { ok: false, error: 'این کد تخفیف در حال حاضر غیرفعال شده است.' };

  if (coupon.expires_at) {
    if (new Date(coupon.expires_at) < new Date()) {
      return { ok: false, error: 'مهلت استفاده از این کد تخفیف به پایان رسیده است.' };
    }
  }

  if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
    return { ok: false, error: 'ظرفیت استفاده از این کد تخفیف تکمیل شده است.' };
  }

  if (orderPrice < (coupon.min_order_price || 0)) {
    return { ok: false, error: `حداقل مبلغ سفارش برای استفاده از این کد ${formatPrice(coupon.min_order_price)} می‌باشد.` };
  }

  // Check per-user limit
  const userUsesRow = await db.prepare(`
    SELECT COUNT(*) AS c FROM coupon_usages
    WHERE coupon_id = ? AND user_id = ?
  `).bind(coupon.id, userId).first();

  if ((userUsesRow?.c || 0) >= (coupon.max_uses_per_user || 1)) {
    return { ok: false, error: 'شما قبلاً از این کد تخفیف استفاده کرده‌اید.' };
  }

  let discountAmount = 0;
  if (coupon.discount_type === 'percent') {
    discountAmount = Math.floor((orderPrice * coupon.discount_value) / 100);
  } else {
    discountAmount = Math.min(orderPrice, coupon.discount_value);
  }

  return { ok: true, coupon, discountAmount };
}

export async function renderAdminCoupons(env, db, chatId, page = 1, messageId = null) {
  const PAGE_SIZE = 8;
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM coupons').first();
  const totalItems = countRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const coupons = (await db.prepare(`
    SELECT * FROM coupons
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, offset).all())?.results || [];

  const keyboard = [];

  for (const c of coupons) {
    const status = c.is_active ? '🟢' : '⚪️';
    const valText = c.discount_type === 'percent' ? `${c.discount_value}٪` : formatPrice(c.discount_value);
    keyboard.push([
      { text: `${status} ${c.code} (${valText})`, callback_data: `adm_coupon_view:${c.id}` }
    ]);
  }

  // Navigation
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ قبلی', callback_data: `adm_coupons:${currentPage - 1}` });
  }
  navRow.push({ text: `📄 ${currentPage} / ${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'بعدی ▶️', callback_data: `adm_coupons:${currentPage + 1}` });
  }
  if (navRow.length > 0) keyboard.push(navRow);

  keyboard.push([
    { text: '➕ ساخت کد تخفیف جدید', callback_data: 'adm_coupon_add' }
  ]);
  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  const text = `🎟 <b>مدیریت کدهای تخفیف</b> (مجموع: ${totalItems} عدد)\nجهت مشاهده جزئیات، فعال/غیرفعال کردن یا حذف روی کد کلیک فرمایید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}



export async function renderAdminForcedChannelDetail(env, db, chatId, chId, messageId = null) {
  const ch = await db.prepare("SELECT * FROM forced_channels WHERE id = ?").bind(chId).first();
  if (!ch) {
    await sendMessage(env.BOT_TOKEN, chatId, "❌ کانال یافت نشد.");
    return;
  }

  const joinStats = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = "joined" THEN 1 ELSE 0 END) AS active_members,
      SUM(CASE WHEN status = "left" THEN 1 ELSE 0 END) AS leavers
    FROM channel_joins
    WHERE channel_id = ?
  `).bind(ch.channel_id).first();

  const text = `📢 <b>مشخصات کانال اجباری #${ch.id}</b>

🔹 عنوان: <b>${escapeHtml(ch.title)}</b>
🔹 شناسه / یوزرنیم: <code>${escapeHtml(ch.channel_id)}</code>
🔹 لینک عضویت: ${escapeHtml(ch.invite_link)}
🔸 وضعیت: <b>${ch.is_active ? "🟢 فعال" : "⚪️ غیرفعال"}</b>
🔢 ترتیب نمایش: <b>${ch.display_order}</b>

📊 <b>آمار اعضا از طریق ربات:</b>
▫️ اعضای فعال کنونی: <b>${joinStats?.active_members || 0} نفر</b>
▫️ افرادی که لفت داده‌اند: <b>${joinStats?.leavers || 0} نفر</b>`;

  const keyboard = [
    [
      { text: ch.is_active ? "⚪️ غیرفعال‌سازی" : "🟢 فعال‌سازی", callback_data: `adm_fc_toggle:${ch.id}` },
      { text: "🧪 تست دسترسی ربات", callback_data: `adm_fc_test:${ch.id}` }
    ],
    [
      { text: "🗑 حذف کانال", callback_data: `adm_fc_del:${ch.id}` }
    ],
    [
      { text: "🔙 بازگشت به لیست کانال‌ها", callback_data: "adm_fchannels" }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminCouponDetail(env, db, chatId, couponId, messageId = null) {
  const c = await db.prepare("SELECT * FROM coupons WHERE id = ?").bind(couponId).first();
  if (!c) {
    await sendMessage(env.BOT_TOKEN, chatId, "❌ کد تخفیف یافت نشد.");
    return;
  }

  const discountVal = c.discount_type === "percent" ? `${c.discount_value}٪` : formatPrice(c.discount_value);
  const maxUsesText = c.max_uses > 0 ? `${c.max_uses} بار` : "نامحدود";

  const text = `🎟 <b>مشخصات کد تخفیف #${c.id}</b>

🔹 کد تخفیف: <code>${escapeHtml(c.code)}</code>
🔹 نوع تخفیف: <b>${c.discount_type === "percent" ? "درصدی" : "مبلغ ثابت"}</b>
🔹 مقدار تخفیف: <b>${discountVal}</b>
🔹 سقف تعداد استفاده: <b>${maxUsesText}</b>
🔹 تعداد دفعات استفاده شده: <b>${c.used_count} بار</b>
🔹 سقف استفاده هر کاربر: <b>${c.max_uses_per_user} بار</b>
🔹 حداقل مبلغ سفارش: <b>${formatPrice(c.min_order_price || 0)}</b>
⏳ تاریخ انقضا: ${c.expires_at ? formatDate(c.expires_at) : "بدون انقضا"}
🔸 وضعیت: <b>${c.is_active ? "🟢 فعال" : "⚪️ غیرفعال"}</b>`;

  const keyboard = [
    [
      { text: c.is_active ? "⚪️ غیرفعال‌سازی" : "🟢 فعال‌سازی", callback_data: `adm_coupon_toggle:${c.id}` },
      { text: "🗑 حذف کد تخفیف", callback_data: `adm_coupon_del:${c.id}` }
    ],
    [
      { text: "🔙 بازگشت به لیست کدها", callback_data: "adm_coupons:1" }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminWithdrawalDetail(env, db, chatId, wdId, messageId = null) {
  const wd = await db.prepare(`
    SELECT w.*, u.first_name, u.username, u.wallet_balance
    FROM withdrawals w
    LEFT JOIN users u ON w.user_id = u.id
    WHERE w.id = ?
  `).bind(wdId).first();

  if (!wd) {
    await sendMessage(env.BOT_TOKEN, chatId, "❌ درخواست تسویه یافت نشد.");
    return;
  }

  const statusBadges = {
    pending: "⏳ در انتظار واریز مدیریت",
    approved: "✅ واریز و تسویه شده",
    rejected: "❌ رد شده و عودت به کیف پول"
  };

  const text = `💸 <b>جزئیات درخواست تسویه حساب #${wd.id}</b>

👤 کاربر: <b>${escapeHtml(wd.first_name || "کاربر")}</b> (@${escapeHtml(wd.username || "ندارد")})
🆔 شناسه کاربر: <code>${wd.user_id}</code>
💵 مبلغ درخواستی: <b>${formatPrice(wd.amount)}</b>
💰 موجودی فعلی کیف پول کاربر: ${formatPrice(wd.wallet_balance || 0)}
🔸 وضعیت: <b>${statusBadges[wd.status] || wd.status}</b>
📅 تاریخ ثبت درخواست: ${formatDate(wd.created_at)}
${wd.handler_admin_name ? `👮 بررسی‌کننده: ${escapeHtml(wd.handler_admin_name)}\n` : ""}${wd.admin_notes ? `📝 یادداشت: ${escapeHtml(wd.admin_notes)}\n` : ""}
💳 <b>مشخصات حساب و مقصد واریز:</b>
<code>${escapeHtml(wd.dest_info)}</code>`;

  const keyboard = [];

  if (wd.status === "pending") {
    keyboard.push([
      { text: "✅ واریز شد (تایید نهایی)", callback_data: `adm_wd_approve:${wd.id}` },
      { text: "❌ رد درخواست (عودت به کیف پول)", callback_data: `adm_wd_reject:${wd.id}` }
    ]);
  }

  keyboard.push([
    { text: "🔙 بازگشت به لیست تسویه‌ها", callback_data: `adm_withdraws:${wd.status}:1` }
  ]);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminGuideDetail(env, db, chatId, guideId, messageId = null) {
  const g = await db.prepare("SELECT * FROM guides WHERE id = ?").bind(guideId).first();
  if (!g) {
    await sendMessage(env.BOT_TOKEN, chatId, "❌ راهنما یافت نشد.");
    return;
  }

  const text = `📖 <b>مشخصات راهنما #${g.id}</b>

🔹 عنوان: <b>${escapeHtml(g.title)}</b>
🔢 ترتیب نمایش: <b>${g.display_order}</b>

📝 متن راهنما:
${escapeHtml(g.content)}`;

  const keyboard = [
    [{ text: "🗑 حذف راهنما", callback_data: `adm_guide_del:${g.id}` }],
    [{ text: "🔙 بازگشت به لیست راهنماها", callback_data: "adm_guides" }]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminTexts(env, db, chatId, messageId = null) {
  const textKeys = Object.keys(DEFAULT_TEXTS);

  const labels = {
    welcome: "پیام خوش‌آمدگویی",
    main_menu: "منوی اصلی",
    services_header: "سربرگ لیست سرویس‌ها",
    service_details: "جزئیات سرویس",
    order_invoice: "پیش‌فاکتور سفارش",
    payment_instructions: "راهنمای پرداخت و کارت",
    order_submitted: "تایید ثبت سفارش",
    order_approved: "تحویل کانفیگ و تایید",
    order_rejected: "رد سفارش",
    wallet_info: "پیام کیف پول",
    test_info: "پیام اکانت تست",
    referral_info: "پیام زیرمجموعه‌گیری",
    forced_join_notice: "پیام عضویت اجباری",
    forced_join_not_joined: "هشدار عدم عضویت",
    support_text: "پیام پشتیبانی",
    rules_text: "قوانین و شرایط"
  };

  const keyboard = [];
  for (let i = 0; i < textKeys.length; i += 2) {
    const row = [];
    const k1 = textKeys[i];
    row.push({ text: `📝 ${labels[k1] || k1}`, callback_data: `adm_text_view:${k1}` });
    if (i + 1 < textKeys.length) {
      const k2 = textKeys[i + 1];
      row.push({ text: `📝 ${labels[k2] || k2}`, callback_data: `adm_text_view:${k2}` });
    }
    keyboard.push(row);
  }

  keyboard.push([
    { text: "🔙 بازگشت به پنل مدیریت", callback_data: "admin_panel" }
  ]);

  const text = `📝 <b>مدیریت متن‌ها و پیام‌های ربات</b>\nجهت مشاهده متن فعلی، شخصی‌سازی یا بازگردانی به متن پیش‌فرض، گزینه مورد نظر را انتخاب نمایید:`;

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminTextView(env, db, chatId, key, messageId = null) {
  const texts = await getTexts(db);
  const currentText = texts[key] || DEFAULT_TEXTS[key] || "";
  const isCustomized = Boolean((await db.prepare("SELECT value FROM texts WHERE key = ?").bind(key).first())?.value);

  const text = `📝 <b>قالب پیام: <code>${escapeHtml(key)}</code></b>

وضعیت: <b>${isCustomized ? "✏️ شخصی‌سازی شده توسط مدیر" : "⚪️ متن پیش‌فرض سیستم"}</b>

📄 <b>متن فعلی:</b>
<pre>${escapeHtml(currentText)}</pre>

⚠️ متغیرهای مجاز در متن: <code>{brand}</code>, <code>{currency}</code>, <code>{support_id}</code> و متغیرهای اختصاصی`;

  const keyboard = [
    [
      { text: "✏️ ویرایش متن", callback_data: `adm_text_edit:${key}` },
      { text: "🔄 بازنشانی به پیش‌فرض", callback_data: `adm_text_reset:${key}` }
    ],
    [
      { text: "🔙 بازگشت به لیست متن‌ها", callback_data: "adm_texts" }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminTools(env, db, chatId, messageId = null) {
  const text = `🔧 <b>ابزارهای سیستمی و نگهداری</b>

جهت تهیه نسخه پشتیبان، تست ارتباطات یا بررسی سلامت سرور از گزینه‌های زیر استفاده فرمایید:`;

  const keyboard = [
    [
      { text: "🩺 دیاگنوستیک و سلامت سرور", callback_data: "adm_diagnostics" },
      { text: "💾 دریافت فایل پشتیبان (Backup)", callback_data: "adm_backup_export" }
    ],
    [
      { text: "🧹 پاکسازی لاگ خطاها", callback_data: "adm_clear_logs" }
    ],
    [
      { text: "🔙 بازگشت به پنل مدیریت", callback_data: "admin_panel" }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminReferral(env, db, chatId, messageId = null) {
  const settings = await getSettings(db);
  const currentPercent = settings.default_referral_percent || DEFAULT_BRAND.default_referral_percent;

  const totalRefEarnedRow = await db.prepare(`
    SELECT SUM(amount) AS s FROM wallet_ledger WHERE type = "referral_commission"
  `).first();
  const totalRefEarned = totalRefEarnedRow?.s || 0;

  const totalRefsCountRow = await db.prepare(`
    SELECT COUNT(*) AS c FROM users WHERE referrer_id IS NOT NULL
  `).first();
  const totalRefsCount = totalRefsCountRow?.c || 0;

  const text = `👥 <b>تنظیمات و آمار سیستم زیرمجموعه‌گیری</b>

🔹 درصد پورسانت فعلی: <b>${currentPercent}٪</b>
🔹 کل پورسانت‌های واریزشده: <b>${formatPrice(totalRefEarned)}</b>
🔹 کل کاربران عضو شده با لینک دعوت: <b>${totalRefsCount} نفر</b>

جهت تغییر درصد کمیسیون زیرمجموعه‌ها روی دکمه زیر کلیک نمایید:`;

  const keyboard = [
    [
      { text: "✏️ تغییر درصد پورسانت", callback_data: "adm_setting_edit:default_referral_percent" }
    ],
    [
      { text: "🔙 بازگشت به پنل مدیریت", callback_data: "admin_panel" }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function renderAdminWallet(env, db, chatId, messageId = null) {
  const balanceSumRow = await db.prepare("SELECT SUM(wallet_balance) AS s FROM users").first();
  const totalUserBalance = balanceSumRow?.s || 0;

  const pendingWdCountRow = await db.prepare('SELECT COUNT(*) AS c, SUM(amount) AS s FROM withdrawals WHERE status = "pending"').first();
  const pendingWdCount = pendingWdCountRow?.c || 0;
  const pendingWdSum = pendingWdCountRow?.s || 0;

  const text = `💰 <b>مدیریت کیف پول و تراکنش‌ها</b>

💳 مجموع موجودی در دست کاربران: <b>${formatPrice(totalUserBalance)}</b>
💸 تسویه‌های در انتظار پرداخت: <b>${pendingWdCount} مورد (${formatPrice(pendingWdSum)})</b>

جهت بررسی و تایید تسویه‌ها روی دکمه زیر کلیک نمایید:`;

  const keyboard = [
    [
      { text: "💸 درخواست‌های تسویه حساب", callback_data: "adm_withdraws:pending:1" }
    ],
    [
      { text: "🔙 بازگشت به پنل مدیریت", callback_data: "admin_panel" }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

// ============================================================================
// SECTION 12: BROADCAST SYSTEM (QUEUE & BATCH PROCESSING)
// ============================================================================

export async function renderAdminBroadcast(env, db, chatId, messageId = null) {
  const activeBc = await db.prepare('SELECT * FROM broadcast_queue WHERE status = "processing" OR status = "pending" ORDER BY id DESC LIMIT 1').first();

  let statusText = '';
  if (activeBc) {
    statusText = `⏳ <b>یک ارسال همگانی در حال اجراست:</b>
کد ارسال: #${activeBc.id}
جامعه هدف: ${activeBc.target_filter}
پیشرفت: ${activeBc.sent_count} ارسال شده | ${activeBc.failed_count} ناموفق | ${activeBc.blocked_count} بلاک
مجموع مخاطبان: ${activeBc.total_users}\n\n`;
  }

  const text = `📣 <b>سیستم ارسال پیام همگانی (Broadcast)</b>

${statusText}جهت شروع ارسال همگانی جدید، لطفاً مخاطبان هدف را انتخاب فرمایید:`;

  const keyboard = [
    [
      { text: '👥 همه کاربران ربات', callback_data: 'adm_bc_target:all' },
      { text: '🛍 فقط خریداران', callback_data: 'adm_bc_target:buyers' }
    ],
    [
      { text: '👤 کاربران بدون خرید', callback_data: 'adm_bc_target:non_buyers' },
      { text: '⚡️ کاربران فعال در ۳۰ روز اخیر', callback_data: 'adm_bc_target:active_30d' }
    ]
  ];

  if (activeBc) {
    keyboard.push([
      { text: '🛑 توقف و لغو ارسال جاری', callback_data: `adm_bc_cancel:${activeBc.id}` }
    ]);
  }

  keyboard.push([
    { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
  ]);

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function createBroadcast(env, db, adminId, messageText, targetFilter = 'all') {
  // Count total matching users
  let countSql = 'SELECT COUNT(*) AS c FROM users WHERE is_banned = 0';
  if (targetFilter === 'buyers') {
    countSql += ' AND orders_count > 0';
  } else if (targetFilter === 'non_buyers') {
    countSql += ' AND orders_count = 0';
  } else if (targetFilter === 'active_30d') {
    countSql += " AND last_active_at >= datetime('now', '-30 days')";
  }

  const totalUsers = (await db.prepare(countSql).first())?.c || 0;
  const now = new Date().toISOString();

  const insertRes = await db.prepare(`
    INSERT INTO broadcast_queue (
      admin_id, message_text, target_filter, status, total_users,
      sent_count, failed_count, blocked_count, last_processed_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'processing', ?, 0, 0, 0, 0, ?, ?)
  `).bind(adminId, messageText, targetFilter, totalUsers, now, now).run();

  const bcId = insertRes.meta.last_row_id;

  // Process initial batch immediately
  await processBroadcastQueue(env, db);

  return { ok: true, bcId, totalUsers };
}

export async function processBroadcastQueue(env, db) {
  const activeBc = await db.prepare('SELECT * FROM broadcast_queue WHERE status = "processing" ORDER BY id ASC LIMIT 1').first();
  if (!activeBc) return;

  const BATCH_SIZE = 25; // Safe subrequest batch size
  let query = 'SELECT id FROM users WHERE id > ? AND is_banned = 0';

  if (activeBc.target_filter === 'buyers') {
    query += ' AND orders_count > 0';
  } else if (activeBc.target_filter === 'non_buyers') {
    query += ' AND orders_count = 0';
  } else if (activeBc.target_filter === 'active_30d') {
    query += " AND last_active_at >= datetime('now', '-30 days')";
  }

  query += ' ORDER BY id ASC LIMIT ?';

  const users = (await db.prepare(query).bind(activeBc.last_processed_user_id, BATCH_SIZE).all())?.results || [];

  if (users.length === 0) {
    // Broadcast is complete
    const now = new Date().toISOString();
    await db.prepare(`
      UPDATE broadcast_queue
      SET status = 'completed', updated_at = ?
      WHERE id = ?
    `).bind(now, activeBc.id).run();

    // Report to admin
    await sendMessage(
      env.BOT_TOKEN,
      activeBc.admin_id,
      `📣 <b>ارسال همگانی #${activeBc.id} با موفقیت به پایان رسید!</b>\n\n✅ ارسال موفق: <b>${activeBc.sent_count} نفر</b>\n🚫 ربات را بلاک کرده بودند: <b>${activeBc.blocked_count} نفر</b>\n❌ خطا در ارسال: <b>${activeBc.failed_count} نفر</b>\nمجموع: <b>${activeBc.total_users} نفر</b>`
    );
    return;
  }

  let sent = 0;
  let blocked = 0;
  let failed = 0;
  let lastId = activeBc.last_processed_user_id;

  for (const u of users) {
    lastId = u.id;
    try {
      const res = await sendMessage(env.BOT_TOKEN, u.id, activeBc.message_text);
      if (res.ok) {
        sent++;
      } else {
        if (res.error_code === 403 || res.description?.includes('bot was blocked')) {
          blocked++;
          await db.prepare('UPDATE users SET has_blocked_bot = 1 WHERE id = ?').bind(u.id).run();
        } else {
          failed++;
        }
      }
    } catch (e) {
      failed++;
    }
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE broadcast_queue
    SET sent_count = sent_count + ?, blocked_count = blocked_count + ?, failed_count = failed_count + ?,
        last_processed_user_id = ?, updated_at = ?
    WHERE id = ?
  `).bind(sent, blocked, failed, lastId, now, activeBc.id).run();
}

// ============================================================================
// SECTION 13: CRON / SCHEDULED TASKS & MAINTENANCE
// ============================================================================

export async function handleScheduledTasks(event, env, ctx) {
  const db = env.DB;

  try {
    // 1. Process pending broadcast chunk
    await processBroadcastQueue(env, db);

    // 2. Auto-cancel expired pending orders
    await autoCancelExpiredOrders(env, db);

    // 3. Service expiry reminders (3 days, 1 day, expired)
    await sendServiceExpiryReminders(env, db);

    // 4. Daily admin report (if matching hour)
    await sendDailyAdminReport(env, db);

    // 5. Clean up old processed updates and old logs
    await cleanupOldData(env, db);
  } catch (err) {
    await logError(db, err, 'scheduled_tasks');
  }
}

export async function autoCancelExpiredOrders(env, db) {
  const settings = await getSettings(db);
  const timeoutMins = Number(settings.order_timeout_minutes) || 120;

  const expiredOrders = (await db.prepare(`
    SELECT * FROM orders
    WHERE status = 'pending_payment'
      AND created_at <= datetime('now', '-' || ? || ' minutes')
    LIMIT 20
  `).bind(timeoutMins).all())?.results || [];

  for (const o of expiredOrders) {
    const now = new Date().toISOString();

    // Refund wallet portion if split payment was made
    if (o.wallet_paid > 0) {
      await creditWallet(
        db,
        o.user_id,
        o.wallet_paid,
        'refund',
        String(o.id),
        `بازگشت وجه سفارش لغو شده به دلیل انقضای زمان پرداخت #${o.id}`
      );
    }

    await db.prepare(`
      UPDATE orders
      SET status = 'cancelled', admin_notes = 'لغو خودکار به دلیل عدم پرداخت در مهلت مقرر', updated_at = ?
      WHERE id = ?
    `).bind(now, o.id).run();

    // Notify user
    await sendMessage(
      env.BOT_TOKEN,
      o.user_id,
      `⚠️ <b>سفارش #${o.id} (${escapeHtml(o.service_name)}) به دلیل عدم تکمیل پرداخت در مهلت قانونی (${timeoutMins} دقیقه) لغو شد.</b>\nدر صورت کسر موجودی از کیف پول، مبلغ به حساب شما عودت داده شد.`
    );
  }
}

export async function sendServiceExpiryReminders(env, db) {
  // 1. 3-day reminder
  const threeDaysList = (await db.prepare(`
    SELECT * FROM user_services
    WHERE status = 'active'
      AND reminded_3d = 0
      AND expires_at <= datetime('now', '+3 days')
      AND expires_at > datetime('now', '+1 day')
    LIMIT 15
  `).all())?.results || [];

  for (const s of threeDaysList) {
    await db.prepare('UPDATE user_services SET reminded_3d = 1 WHERE id = ?').bind(s.id).run();
    const text = `🔔 <b>یادآوری تمدید سرویس</b>\n\nسرویس شما با نام <b>${escapeHtml(s.service_name)}</b> (کد اشتراک: #${s.id}) تا <b>۳ روز دیگر</b> منقضی خواهد شد.\n\nجهت جلوگیری از قطعی اتصال، می‌توانید نسبت به تمدید آن اقدام فرمایید:`;
    const markup = {
      inline_keyboard: [
        [{ text: '🔁 تمدید سریع این سرویس', callback_data: `mysrv_renew:${s.id}` }]
      ]
    };
    await sendMessage(env.BOT_TOKEN, s.user_id, text, { reply_markup: markup });
  }

  // 2. 1-day reminder
  const oneDayList = (await db.prepare(`
    SELECT * FROM user_services
    WHERE status = 'active'
      AND reminded_1d = 0
      AND expires_at <= datetime('now', '+1 day')
      AND expires_at > datetime('now')
    LIMIT 15
  `).all())?.results || [];

  for (const s of oneDayList) {
    await db.prepare('UPDATE user_services SET reminded_1d = 1 WHERE id = ?').bind(s.id).run();
    const text = `⚠️ <b>هشدار انقضای سرویس</b>\n\nتنها <b>کمتر از ۲۴ ساعت</b> تا پایان اعتبار سرویس <b>${escapeHtml(s.service_name)}</b> شما باقی مانده است!\n\nجهت تمدید آنی روی دکمه زیر بزنید:`;
    const markup = {
      inline_keyboard: [
        [{ text: '🔁 تمدید فوری این سرویس', callback_data: `mysrv_renew:${s.id}` }]
      ]
    };
    await sendMessage(env.BOT_TOKEN, s.user_id, text, { reply_markup: markup });
  }

  // 3. Expired services
  const expiredList = (await db.prepare(`
    SELECT * FROM user_services
    WHERE status = 'active'
      AND reminded_expired = 0
      AND expires_at <= datetime('now')
    LIMIT 15
  `).all())?.results || [];

  for (const s of expiredList) {
    await db.prepare('UPDATE user_services SET status = "expired", reminded_expired = 1 WHERE id = ?').bind(s.id).run();
    const text = `🔴 <b>سرویس شما منقضی شد</b>\n\nاعتبار سرویس <b>${escapeHtml(s.service_name)}</b> (کد #${s.id}) به پایان رسید.\nدر صورت تمایل به راه‌اندازی مجدد، می‌توانید همین سرویس را تمدید فرمایید:`;
    const markup = {
      inline_keyboard: [
        [{ text: '🔁 تمدید و فعال‌سازی مجدد', callback_data: `mysrv_renew:${s.id}` }]
      ]
    };
    await sendMessage(env.BOT_TOKEN, s.user_id, text, { reply_markup: markup });
  }
}

export async function sendDailyAdminReport(env, db) {
  const settings = await getSettings(db);
  const targetHour = Number(settings.daily_report_hour) || 20;

  const now = new Date();
  if (now.getUTCHours() !== targetHour) return;

  const todayStr = now.toISOString().slice(0, 10);
  const lastReportDate = await getSetting(db, 'last_daily_report_date', '');

  if (lastReportDate === todayStr) return; // Already sent today

  // Save report date
  await setSetting(db, 'last_daily_report_date', todayStr);

  const stats = await getAggregatedStats(db, 'today');
  const adminIds = await getAllAdminIds(env, db);

  const reportText = `📋 <b>گزارش روزانه مدیریت (${todayStr})</b>

👥 کاربران جدید امروز: <b>${stats.users.new_users || 0} نفر</b>
⚡️ کاربران فعال امروز: <b>${stats.users.active_users || 0} نفر</b>
🛍 سفارش‌های تاییدشده: <b>${stats.orders.approved_orders || 0} عدد</b>
💰 درآمد کل امروز: <b>${formatPrice(stats.orders.total_revenue || 0)}</b>
🧪 اکانت‌های تست ارسالی: <b>${stats.tests.delivered_tests || 0} عدد</b>
💸 تسویه‌های در انتظار: <b>${stats.wallet.pending_wd_count || 0} مورد</b>`;

  for (const aId of adminIds) {
    await sendMessage(env.BOT_TOKEN, aId, reportText);
  }
}

export async function cleanupOldData(env, db) {
  // Keep last 48 hours of updates deduplication
  await db.prepare("DELETE FROM processed_updates WHERE processed_at < datetime('now', '-2 days')").run();

  // Keep last 30 days of error logs
  await db.prepare("DELETE FROM error_logs WHERE created_at < datetime('now', '-30 days')").run();
}

// ============================================================================
// SECTION 14: DIAGNOSTICS & SYSTEM TOOLS (BACKUP & RESTORE)
// ============================================================================

export async function renderAdminDiagnostics(env, db, chatId, messageId = null) {
  const startTime = Date.now();

  // Test D1 read
  let d1ReadLatency = 0;
  let d1WriteLatency = 0;
  let d1Status = '🟢 متصل و آماده';

  try {
    const t0 = Date.now();
    await db.prepare('SELECT 1').first();
    d1ReadLatency = Date.now() - t0;

    const t1 = Date.now();
    await db.prepare('UPDATE settings SET updated_at = updated_at WHERE key = "brand_name"').run();
    d1WriteLatency = Date.now() - t1;
  } catch (err) {
    d1Status = `🔴 خطا: ${err.message}`;
  }

  // Telegram Webhook Info
  let webhookStatus = 'بررسی نشده';
  let pendingUpdates = 0;
  let lastErrorDate = 'ندارد';
  let lastErrorMessage = '';

  const hookInfo = await getWebhookInfo(env.BOT_TOKEN);
  if (hookInfo?.ok && hookInfo.result) {
    webhookStatus = hookInfo.result.url ? `🟢 فعال (${hookInfo.result.url})` : '⚪️ وبهوک تنظیم نشده';
    pendingUpdates = hookInfo.result.pending_update_count || 0;
    if (hookInfo.result.last_error_date) {
      lastErrorDate = formatDate(new Date(hookInfo.result.last_error_date * 1000).toISOString());
      lastErrorMessage = hookInfo.result.last_error_message || '';
    }
  } else {
    webhookStatus = '🔴 خطا در اتصال به تلگرام';
  }

  // Bot Info
  const botInfo = await getMe(env.BOT_TOKEN);
  const botUsername = botInfo?.result?.username ? `@${botInfo.result.username}` : 'نامشخص';

  // Last 3 errors from error_logs
  const errors = (await db.prepare('SELECT * FROM error_logs ORDER BY id DESC LIMIT 3').all())?.results || [];
  let errorSummary = 'هیچ خطای ثبتی وجود ندارد (عالی).';
  if (errors.length > 0) {
    errorSummary = errors.map(e => `▪️ [${formatDate(e.created_at)}] ${escapeHtml(e.error_message)} (${escapeHtml(e.context || '')})`).join('\n');
  }

  // Row counts
  const usersCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').first())?.c || 0;
  const ordersCount = (await db.prepare('SELECT COUNT(*) AS c FROM orders').first())?.c || 0;
  const srvCount = (await db.prepare('SELECT COUNT(*) AS c FROM services').first())?.c || 0;

  // Masked Token
  const token = env.BOT_TOKEN || '';
  const maskedToken = token.length > 10 ? `${token.slice(0, 6)}...${token.slice(-4)}` : 'تنظیم نشده';

  const text = `🩺 <b>بررسی سلامت سیستم و دیاگنوستیک</b>

🔹 نسخه سورس: <code>v${VERSION}</code>
🔹 ربات تلگرام: <b>${botUsername}</b> (توکن: <code>${maskedToken}</code>)
🔹 وضعیت وبهوک: ${webhookStatus}
🔹 آپدیت‌های در صف تلگرام: <b>${pendingUpdates} عدد</b>
${lastErrorMessage ? `⚠️ آخرین خطای وبهوک: ${escapeHtml(lastErrorMessage)} (${lastErrorDate})\n` : ''}
💾 <b>پایگاه داده Cloudflare D1:</b>
▫️ وضعیت اتصال: ${d1Status}
▫️ تاخیر خواندن (Read): <b>${d1ReadLatency}ms</b>
▫️ تاخیر نوشتن (Write): <b>${d1WriteLatency}ms</b>
▫️ حجم داده: ${usersCount} کاربر | ${ordersCount} سفارش | ${srvCount} سرویس

⚠️ <b>آخرین خطاهای ثبت‌شده سیستم:</b>
${errorSummary}

⏱ زمان پاسخ‌دهی سرور: <b>${Date.now() - startTime}ms</b>`;

  const keyboard = [
    [
      { text: '🔄 بروزرسانی دیاگنوستیک', callback_data: 'adm_diagnostics' },
      { text: '🧹 پاکسازی لاگ خطاها', callback_data: 'adm_clear_logs' }
    ],
    [
      { text: '💾 دریافت فایل پشتیبان (Backup)', callback_data: 'adm_backup_export' }
    ],
    [
      { text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }
    ]
  ];

  if (messageId) {
    await editMessageText(env.BOT_TOKEN, chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

export async function exportBackupJson(env, db, adminChatId) {
  // Query all key configuration tables
  const settings = (await db.prepare('SELECT * FROM settings').all())?.results || [];
  const texts = (await db.prepare('SELECT * FROM texts').all())?.results || [];
  const services = (await db.prepare('SELECT * FROM services').all())?.results || [];
  const paymentMethods = (await db.prepare('SELECT * FROM payment_methods').all())?.results || [];
  const guides = (await db.prepare('SELECT * FROM guides').all())?.results || [];
  const coupons = (await db.prepare('SELECT * FROM coupons').all())?.results || [];
  const forcedChannels = (await db.prepare('SELECT * FROM forced_channels').all())?.results || [];

  const backupData = {
    project: 'NexiUP',
    version: VERSION,
    exported_at: new Date().toISOString(),
    data: {
      settings,
      texts,
      services,
      payment_methods: paymentMethods,
      guides,
      coupons,
      forced_channels: forcedChannels
    }
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const today = new Date().toISOString().slice(0, 10);
  const fileName = `nexiup_backup_${today}.json`;

  const formData = new FormData();
  formData.append('chat_id', adminChatId);
  formData.append('document', new Blob([jsonStr], { type: 'application/json' }), fileName);
  formData.append('caption', `💾 <b>فایل پشتیبان کامل ربات نکسی آپ (NexiUP)</b>\nتاریخ استخراج: ${today}\nنسخه: v${VERSION}\n\nجهت بازگردانی، می‌توانید این فایل را با کپشن <code>#import_nexiup</code> برای ربات ارسال فرمایید.`);
  formData.append('parse_mode', 'HTML');

  await callTelegram(env.BOT_TOKEN, 'sendDocument', formData, true);
}

export async function importBackupJson(env, db, adminUser, jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    if (parsed.project !== 'NexiUP' || !parsed.data) {
      return { ok: false, error: 'فرمت فایل معتبر نیست یا متعلق به پروژه نکسی آپ نمی‌باشد.' };
    }

    const { settings, texts, services, payment_methods, guides, coupons, forced_channels } = parsed.data;
    const now = new Date().toISOString();

    const batch = [];

    if (Array.isArray(services)) {
      for (const s of services) {
        batch.push(
          db.prepare(`
            INSERT INTO services (id, name, description, traffic, duration_days, duration_text, price, is_active, display_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, traffic = excluded.traffic, duration_days = excluded.duration_days, duration_text = excluded.duration_text, price = excluded.price, is_active = excluded.is_active, display_order = excluded.display_order
          `).bind(s.id, s.name, s.description || '', s.traffic, s.duration_days || 30, s.duration_text, s.price, s.is_active ?? 1, s.display_order ?? 0, s.created_at || now)
        );
      }
    }

    if (Array.isArray(payment_methods)) {
      for (const pm of payment_methods) {
        batch.push(
          db.prepare(`
            INSERT INTO payment_methods (id, name, details, instructions, is_active, display_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, details = excluded.details, instructions = excluded.instructions, is_active = excluded.is_active, display_order = excluded.display_order
          `).bind(pm.id, pm.name, pm.details, pm.instructions || '', pm.is_active ?? 1, pm.display_order ?? 0, pm.created_at || now)
        );
      }
    }

    if (Array.isArray(guides)) {
      for (const g of guides) {
        batch.push(
          db.prepare(`
            INSERT INTO guides (id, title, content, display_order, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, display_order = excluded.display_order, is_active = excluded.is_active
          `).bind(g.id, g.title, g.content, g.display_order ?? 0, g.is_active ?? 1, g.created_at || now)
        );
      }
    }

    if (Array.isArray(coupons)) {
      for (const c of coupons) {
        batch.push(
          db.prepare(`
            INSERT INTO coupons (id, code, discount_type, discount_value, max_uses, used_count, max_uses_per_user, min_order_price, expires_at, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET code = excluded.code, discount_type = excluded.discount_type, discount_value = excluded.discount_value, max_uses = excluded.max_uses, is_active = excluded.is_active
          `).bind(c.id, c.code, c.discount_type, c.discount_value, c.max_uses ?? 0, c.used_count ?? 0, c.max_uses_per_user ?? 1, c.min_order_price ?? 0, c.expires_at || null, c.is_active ?? 1, c.created_at || now)
        );
      }
    }

    if (batch.length > 0) {
      await db.batch(batch);
    }

    invalidateCache('all');
    await logAdminAction(db, adminUser.id, 'import_backup', 'backup', '', 'Restored configuration from backup JSON');

    return { ok: true, count: batch.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


// ============================================================================
// SECTION 15: ROUTER & REQUEST HANDLERS
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route: /setup
    if (url.pathname === '/setup') {
      return await handleSetupRoute(request, env, url);
    }

    // Route: /health or /
    if (url.pathname === '/health' || (url.pathname === '/' && request.method === 'GET')) {
      return new Response(JSON.stringify({
        status: 'ok',
        project: 'NexiUP',
        version: VERSION,
        time: new Date().toISOString()
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Route: Telegram Webhook (POST /webhook or POST /)
    if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
      // Validate Webhook Secret if set
      if (env.WEBHOOK_SECRET) {
        const receivedSecret = request.headers.get('x-telegram-bot-api-secret-token');
        if (receivedSecret !== env.WEBHOOK_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      let update = null;
      try {
        update = await request.json();
      } catch (err) {
        return new Response('Invalid JSON', { status: 400 });
      }

      if (!update || !update.update_id) {
        return new Response('Bad Request', { status: 400 });
      }

      // Return 200 OK immediately to Telegram, process update in background
      ctx.waitUntil(handleTelegramUpdate(env, ctx, update));
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTasks(event, env, ctx));
  }
};

// Setup Handler
export async function handleSetupRoute(request, env, url) {
  // Check SETUP_KEY protection if configured
  if (env.SETUP_KEY) {
    const providedKey = url.searchParams.get('key');
    if (providedKey !== env.SETUP_KEY) {
      return new Response('<h1>403 Forbidden: Invalid or missing SETUP_KEY</h1>', {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
  } else {
    // If SETUP_KEY is not defined, check if setup was already completed
    try {
      const isCompleted = await getSetting(env.DB, 'setup_completed', '0');
      if (isCompleted === '1') {
        return new Response('<h1>403 Forbidden: Setup already completed. Please configure SETUP_KEY environment variable to re-run setup.</h1>', {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    } catch (e) {
      // Tables might not exist yet, allow initial run
    }
  }

  const results = {
    db: false,
    webhook: false,
    commands: false,
    botInfo: null,
    error: null
  };

  try {
    // 1. Run migrations & table creations
    await runMigrations(env.DB);
    results.db = true;

    // 2. Set Telegram Webhook
    const webhookUrl = `https://${url.host}/webhook`;
    const secretToken = env.WEBHOOK_SECRET || '';
    const hookRes = await setWebhook(env.BOT_TOKEN, webhookUrl, secretToken);
    results.webhook = hookRes.ok;

    // 3. Set Bot Commands
    const commands = [
      { command: 'start', description: 'شروع و منوی اصلی' },
      { command: 'services', description: 'لیست و خرید سرویس‌ها' },
      { command: 'myservices', description: 'سرویس‌های من و تمدید' },
      { command: 'wallet', description: 'کیف پول و موجودی' },
      { command: 'test', description: 'دریافت اکانت تست رایگان' },
      { command: 'help', description: 'راهنما و پشتیبانی' },
      { command: 'admin', description: 'پنل مدیریت ربات' }
    ];
    const cmdRes = await setMyCommands(env.BOT_TOKEN, commands);
    results.commands = cmdRes.ok;

    // 4. Get Bot Profile
    const meRes = await getMe(env.BOT_TOKEN);
    results.botInfo = meRes?.result || null;
  } catch (err) {
    results.error = err.message;
  }

  // Render Persian Setup Dashboard HTML
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>راه‌اندازی نکسی آپ | NexiUP Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 16px; border: 1px solid #334155; padding: 32px; max-width: 600px; width: 100%; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    h1 { font-size: 24px; color: #38bdf8; margin-bottom: 12px; font-weight: 700; text-align: center; }
    p.subtitle { color: #94a3b8; font-size: 14px; text-align: center; margin-bottom: 24px; }
    .item { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: #0f172a; border-radius: 10px; margin-bottom: 10px; border: 1px solid #1e293b; }
    .badge-ok { background: #059669; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: bold; }
    .badge-err { background: #dc2626; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: bold; }
    .guide-box { background: #0284c715; border-right: 4px solid #0284c7; padding: 16px; border-radius: 8px; margin-top: 24px; font-size: 14px; line-height: 1.8; color: #e2e8f0; }
    .guide-box ol { margin-right: 20px; }
    .btn { display: block; text-align: center; background: #0284c7; color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: bold; margin-top: 20px; transition: 0.2s; }
    .btn:hover { background: #0369a1; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 راه‌اندازی ربات نکسی آپ (NexiUP)</h1>
    <p class="subtitle">نسخه ${VERSION} | سورس متن‌باز فروش و مدیریت اشتراک</p>

    <div class="item">
      <span>پایگاه داده Cloudflare D1 و جداول</span>
      <span class="${results.db ? 'badge-ok' : 'badge-err'}">${results.db ? '✅ با موفقیت ایجاد شد' : '❌ خطا در ایجاد جداول'}</span>
    </div>

    <div class="item">
      <span>تنظیم وبهوک تلگرام (Telegram Webhook)</span>
      <span class="${results.webhook ? 'badge-ok' : 'badge-err'}">${results.webhook ? '✅ فعال شد' : '❌ خطا در ثبت وبهوک'}</span>
    </div>

    <div class="item">
      <span>ثبت دستورات رسمی ربات (Bot Commands)</span>
      <span class="${results.commands ? 'badge-ok' : 'badge-err'}">${results.commands ? '✅ ثبت شد' : '❌ خطا در ثبت دستورات'}</span>
    </div>

    ${results.botInfo ? `
    <div class="item">
      <span>نام کاربری ربات تلگرام</span>
      <span style="color: #38bdf8; font-weight: bold;">@${results.botInfo.username}</span>
    </div>
    ` : ''}

    ${results.error ? `
    <div style="background: #ef444422; border-right: 4px solid #ef4444; padding: 12px; border-radius: 8px; margin-top: 15px; color: #fca5a5; font-size: 13px;">
      خطا: ${results.error}
    </div>
    ` : ''}

    <div class="guide-box">
      <b>📌 گام‌های بعدی برای مدیر ربات:</b>
      <ol>
        <li>مطمئن شوید آیدی عددی تلگرام خود را در متغیر <code>ADMIN_IDS</code> در تنظیمات Worker ثبت کرده‌اید.</li>
        <li>وارد ربات تلگرام خود شوید و دستور <code>/start</code> یا <code>/admin</code> را ارسال فرمایید.</li>
        <li>از طریق پنل مدیریت ربات، شماره کارت یا آدرس ولت خود را در بخش روش‌های پرداخت وارد کنید.</li>
        <li>سرویس‌ها و قیمت‌ها را مطابق نظر خود تنظیم یا اضافه نمایید.</li>
      </ol>
    </div>

    ${results.botInfo ? `
    <a href="https://t.me/${results.botInfo.username}" target="_blank" class="btn">ورود به ربات تلگرام (@${results.botInfo.username})</a>
    ` : ''}
  </div>
</body>
</html>`;

  return new Response(html, {
    status: results.error ? 500 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// Background Telegram Update Processor
export async function handleTelegramUpdate(env, ctx, update) {
  const db = env.DB;
  const updateId = update.update_id;

  // Deduplication check
  try {
    const existing = await db.prepare('SELECT update_id FROM processed_updates WHERE update_id = ?').bind(updateId).first();
    if (existing) return; // Skip duplicate update

    const now = new Date().toISOString();
    await db.prepare('INSERT INTO processed_updates (update_id, processed_at) VALUES (?, ?)').bind(updateId, now).run();
  } catch (err) {
    // If primary key conflict, update already handled
    return;
  }

  try {
    // Route update types
    if (update.message) {
      await handleMessageUpdate(env, db, update.message);
    } else if (update.callback_query) {
      await handleCallbackQueryUpdate(env, db, update.callback_query);
    } else if (update.chat_member || update.my_chat_member) {
      await handleChatMemberUpdate(env, db, update.chat_member || update.my_chat_member);
    }
  } catch (err) {
    await logError(db, err, `update_${updateId}`);
  }
}

// Handler: Incoming Messages
export async function handleMessageUpdate(env, db, message) {
  const chatId = message.chat.id;
  const from = message.from;
  if (!from) return;

  const text = (message.text || '').trim();

  // Handle Telegram Commands
  if (text.startsWith('/start')) {
    await handleStartCommand(env, db, message);
    return;
  }

  // Upsert user
  const user = await upsertUser(db, from);

  if (Number(user.is_banned) === 1) {
    await sendMessage(env.BOT_TOKEN, chatId, '⛔️ دسترسی حساب کاربری شما مسدود است.');
    return;
  }

  const userIsAdmin = await isAdmin(from.id, env, db);
  const settings = await getSettings(db);

  if (Number(settings.maintenance_mode) === 1 && !userIsAdmin) {
    await sendMessage(env.BOT_TOKEN, chatId, settings.maintenance_message || DEFAULT_BRAND.maintenance_message);
    return;
  }

  // Handle commands
  if (text === '/admin') {
    if (!userIsAdmin) {
      await sendMessage(env.BOT_TOKEN, chatId, '⛔️ شما دسترسی به پنل مدیریت ندارید.');
      return;
    }
    await renderAdminPanel(env, db, chatId);
    return;
  }

  if (text === '/services') {
    await handleServicesMenu(env, db, chatId, 1);
    return;
  }

  if (text === '/myservices') {
    await handleMyServicesMenu(env, db, chatId, from.id, 1);
    return;
  }

  if (text === '/wallet') {
    await handleWalletMenu(env, db, chatId, user);
    return;
  }

  if (text === '/test') {
    await handleTestServiceRequest(env, db, chatId, user);
    return;
  }

  if (text === '/help') {
    await handleGuidesMenu(env, db, chatId);
    return;
  }

  // Admin Quick Reply: If admin replies to a forwarded user message
  if (userIsAdmin && message.reply_to_message) {
    const repliedMsg = message.reply_to_message;
    // Check if replied message was forwarded from a user
    const targetUserId = repliedMsg.forward_from?.id;
    if (targetUserId) {
      await sendMessage(env.BOT_TOKEN, targetUserId, `💬 <b>پاسخ پشتیبانی:</b>\n\n${escapeHtml(text)}`);
      await sendMessage(env.BOT_TOKEN, chatId, `✅ پیام شما با موفقیت برای کاربر <code>${targetUserId}</code> ارسال گردید.`);
      return;
    }
  }

  // Check if user has uploaded a JSON backup file with caption #import_nexiup
  if (userIsAdmin && message.document && (message.caption || '').includes('#import_nexiup')) {
    try {
      const fileRes = await callTelegram(env.BOT_TOKEN, 'getFile', { file_id: message.document.file_id });
      if (fileRes.ok && fileRes.result?.file_path) {
        const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileRes.result.file_path}`;
        const resp = await fetch(fileUrl);
        const jsonContent = await resp.text();
        const importRes = await importBackupJson(env, db, user, jsonContent);
        if (importRes.ok) {
          await sendMessage(env.BOT_TOKEN, chatId, `✅ <b>پشتیبان با موفقیت بازیابی شد!</b>\nتعداد ${importRes.count} رکورد با موفقیت بروزرسانی گردید.`);
        } else {
          await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در بازیابی: ${importRes.error}`);
        }
        return;
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در دانلود و پردازش فایل پشتیبان: ${e.message}`);
      return;
    }
  }

  // Check user active conversation state
  const state = await getUserState(db, from.id);
  if (!state) {
    // Normal text message without state: show main menu or handle common Persian buttons
    if (text === '🛒 خرید سرویس') {
      await handleServicesMenu(env, db, chatId, 1);
    } else if (text === '📦 سرویس‌های من') {
      await handleMyServicesMenu(env, db, chatId, from.id, 1);
    } else if (text === '🧪 دریافت اکانت تست' || text === '🧪 سرویس تست') {
      await handleTestServiceRequest(env, db, chatId, user);
    } else if (text === '📖 راهنمای اتصال') {
      await handleGuidesMenu(env, db, chatId);
    } else if (text === '👥 زیرمجموعه‌گیری') {
      await handleReferralMenu(env, db, chatId, user);
    } else if (text === '💰 کیف پول') {
      await handleWalletMenu(env, db, chatId, user);
    } else if (text === '📞 پشتیبانی') {
      await handleSupportMenu(env, db, chatId, from.id);
    } else {
      await showMainMenu(env, db, chatId, user);
    }
    return;
  }

  // Handle Conversation States
  await handleUserStateMessage(env, db, chatId, user, state, message);
}

// Router: User and Admin Conversation States
export async function handleUserStateMessage(env, db, chatId, user, state, message) {
  const text = (message.text || '').trim();
  const step = state.step;
  const data = state.data || {};

  // 1. User State: Awaiting Receipt for manual order payment
  if (step === 'awaiting_receipt') {
    const orderId = data.orderId;
    const methodId = data.methodId;

    let receiptFileId = null;
    let paymentNotes = '';

    if (message.photo && message.photo.length > 0) {
      receiptFileId = message.photo[message.photo.length - 1].file_id;
      paymentNotes = message.caption || '';
    } else if (message.document) {
      receiptFileId = message.document.file_id;
      paymentNotes = message.caption || '';
    } else if (text) {
      paymentNotes = text;
    }

    if (!receiptFileId && !paymentNotes) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ لطفاً تصویر فیش واریزی یا شماره پیگیری / متن تراکنش را ارسال نمایید:');
      return;
    }

    await clearUserState(db, user.id);
    const submitRes = await submitOrderManualPayment(env, db, orderId, user, methodId, receiptFileId, paymentNotes);

    if (submitRes.ok) {
      const confirmText = await getText(db, 'order_submitted', { order_id: orderId });
      await sendMessage(env.BOT_TOKEN, chatId, confirmText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 پیگیری در سرویس‌های من', callback_data: 'menu_myservices' }],
            [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]
          ]
        }
      });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در ثبت فیش: ${submitRes.error}`);
    }
    return;
  }

  // 2. User State: Entering Coupon Code
  if (step === 'entering_coupon') {
    const orderId = data.orderId;
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(orderId, user.id).first();

    if (!order || order.status !== 'pending_payment') {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '❌ سفارش معتبر نیست یا قبلاً نهایی شده است.');
      return;
    }

    const valRes = await validateCoupon(db, text, user.id, order.original_price);
    if (!valRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ ${valRes.error}\nلطفاً کد دیگری وارد نمایید یا انصراف دهید:`, {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    // Apply coupon to order
    const discountAmount = valRes.discountAmount;
    const finalPrice = Math.max(0, order.original_price - discountAmount);
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`
        UPDATE orders
        SET coupon_code = ?, discount_amount = ?, final_price = ?, updated_at = ?
        WHERE id = ?
      `).bind(valRes.coupon.code, discountAmount, finalPrice, now, order.id),
      db.prepare(`
        UPDATE coupons
        SET used_count = used_count + 1
        WHERE id = ?
      `).bind(valRes.coupon.id),
      db.prepare(`
        INSERT INTO coupon_usages (coupon_id, coupon_code, user_id, order_id, discount_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(valRes.coupon.id, valRes.coupon.code, user.id, order.id, discountAmount, now)
    ]);

    await clearUserState(db, user.id);
    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();

    await sendMessage(env.BOT_TOKEN, chatId, `🎉 کد تخفیف <b>${escapeHtml(valRes.coupon.code)}</b> با موفقیت اعمال شد!\nمبلغ تخفیف: <b>${formatPrice(discountAmount)}</b>`);
    await renderOrderInvoice(env, db, chatId, updatedOrder, user);
    return;
  }

  // 3. User State: Wallet Top-Up Amount
  if (step === 'wallet_topup_amount') {
    const amount = Number(text.replace(/,/g, ''));
    if (isNaN(amount) || amount < 10000) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ لطفاً مبلغ معتبری وارد فرمایید (حداقل ۱۰,۰۰۰ تومان):', {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    // List payment methods for deposit
    const methods = (await db.prepare('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY display_order ASC').all())?.results || [];
    if (methods.length === 0) {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ روش پرداختی فعال نیست. لطفاً با پشتیبانی تماس بگیرید.');
      return;
    }

    await setUserState(db, user.id, 'wallet_topup_method', { amount });

    const keyboard = methods.map(m => [
      { text: `💳 ${m.name}`, callback_data: `wallet_topup_pm:${m.id}` }
    ]);
    keyboard.push([{ text: '🔙 انصراف', callback_data: 'cancel_state' }]);

    await sendMessage(env.BOT_TOKEN, chatId, `💳 مبلغ انتخابی جهت شارژ: <b>${formatPrice(amount)}</b>\nلطفاً یکی از روش‌های پرداخت را انتخاب کنید:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // 4. User State: Wallet Top-Up Receipt
  if (step === 'wallet_topup_receipt') {
    const amount = data.amount;
    const methodId = data.methodId;

    let receiptFileId = null;
    let paymentNotes = '';

    if (message.photo && message.photo.length > 0) {
      receiptFileId = message.photo[message.photo.length - 1].file_id;
      paymentNotes = message.caption || '';
    } else if (message.document) {
      receiptFileId = message.document.file_id;
      paymentNotes = message.caption || '';
    } else if (text) {
      paymentNotes = text;
    }

    if (!receiptFileId && !paymentNotes) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ لطفاً تصویر فیش واریزی یا شماره پیگیری را ارسال فرمایید:');
      return;
    }

    await clearUserState(db, user.id);

    // Create a special order record for deposit
    const now = new Date().toISOString();
    const pm = await db.prepare('SELECT name FROM payment_methods WHERE id = ?').bind(methodId).first();

    const insertRes = await db.prepare(`
      INSERT INTO orders (
        user_id, service_id, service_name, original_price, discount_amount, final_price,
        wallet_paid, manual_paid, payment_method_id, payment_method_name,
        receipt_file_id, payment_notes, status, created_at, updated_at
      ) VALUES (?, 0, 'شارژ کیف پول', ?, 0, ?, 0, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
    `).bind(
      user.id, amount, amount, amount, methodId, pm?.name || 'کارت/ولت',
      receiptFileId, paymentNotes, now, now
    ).run();

    const depositId = insertRes.meta.last_row_id;

    await sendMessage(env.BOT_TOKEN, chatId, `✅ <b>رسید شارژ کیف پول ثبت شد!</b>\nکد پیگیری: <code>#DEP-${depositId}</code>\nپس از بررسی و تایید توسط مدیریت، موجودی حساب شما شارژ خواهد شد.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به کیف پول', callback_data: 'menu_wallet' }]] }
    });

    // Notify admins
    const adminIds = await getAllAdminIds(env, db);
    const caption = `💰 <b>درخواست شارژ کیف پول جدید</b>\n\n👤 کاربر: <b>${escapeHtml(user.first_name)}</b> (@${escapeHtml(user.username || 'ندارد')})\n🆔 شناسه عددی: <code>${user.id}</code>\n💵 مبلغ واریزی: <b>${formatPrice(amount)}</b>\n💳 روش پرداخت: ${pm?.name || '-'}\n${paymentNotes ? `📝 توضیحات: ${escapeHtml(paymentNotes)}\n` : ''}کد پیگیری: <code>#DEP-${depositId}</code>`;

    const adminMarkup = {
      inline_keyboard: [
        [
          { text: '✅ تایید و شارژ کیف پول', callback_data: `adm_dep_approve:${depositId}` },
          { text: '❌ رد فیش', callback_data: `adm_dep_reject:${depositId}` }
        ]
      ]
    };

    for (const aId of adminIds) {
      if (receiptFileId) {
        await sendPhoto(env.BOT_TOKEN, aId, receiptFileId, caption, { reply_markup: adminMarkup });
      } else {
        await sendMessage(env.BOT_TOKEN, aId, caption, { reply_markup: adminMarkup });
      }
    }
    return;
  }

  // 5. User State: Withdrawal Amount & Destination
  if (step === 'wallet_withdraw_amount') {
    const settings = await getSettings(db);
    const minWd = Number(settings.min_withdrawal) || DEFAULT_BRAND.min_withdrawal;
    const amount = Number(text.replace(/,/g, ''));

    if (isNaN(amount) || amount < minWd) {
      await sendMessage(env.BOT_TOKEN, chatId, `⚠️ حداقل مبلغ مجاز جهت تسویه حساب <b>${formatPrice(minWd)}</b> می‌باشد.\nلطفاً مبلغ معتبری وارد نمایید:`, {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    const freshUser = await getUser(db, user.id);
    if ((freshUser.wallet_balance || 0) < amount) {
      await sendMessage(env.BOT_TOKEN, chatId, `⚠️ موجودی کیف پول شما (${formatPrice(freshUser.wallet_balance || 0)}) برای این مبلغ کافی نیست.`, {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    await setUserState(db, user.id, 'wallet_withdraw_dest', { amount });
    await sendMessage(env.BOT_TOKEN, chatId, `💳 مبلغ تسویه: <b>${formatPrice(amount)}</b>\n\nلطفاً <b>شماره شبا (با IR)، شماره کارت یا آدرس کیف پول تتر</b> خود را به همراه نام صاحب حساب ارسال فرمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (step === 'wallet_withdraw_dest') {
    const amount = data.amount;
    const destInfo = text;

    if (destInfo.length < 10) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ اطلاعات مقصد نامعتبر است. لطفاً شماره شبا یا شماره کارت دقیق را ارسال کنید:');
      return;
    }

    // Debit balance atomically
    const debitRes = await debitWallet(db, user.id, amount, 'withdrawal', '', `درخواست تسویه حساب به مقصد: ${destInfo}`);
    if (!debitRes.ok) {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '❌ موجودی کیف پول شما کافی نیست.');
      return;
    }

    const now = new Date().toISOString();
    const insertRes = await db.prepare(`
      INSERT INTO withdrawals (user_id, amount, dest_info, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).bind(user.id, amount, destInfo, now, now).run();

    const wdId = insertRes.meta.last_row_id;
    await clearUserState(db, user.id);

    await sendMessage(env.BOT_TOKEN, chatId, `✅ <b>درخواست تسویه حساب با موفقیت ثبت شد</b>\n\nکد پیگیری: <code>#WD-${wdId}</code>\nمبلغ: <b>${formatPrice(amount)}</b>\nمقصد: <code>${escapeHtml(destInfo)}</code>\n\nمبلغ از کیف پول کسر شده و پس از واریز توسط مدیریت به حساب شما خواهد نشست.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به کیف پول', callback_data: 'menu_wallet' }]] }
    });

    // Notify admins
    const adminIds = await getAllAdminIds(env, db);
    const adminAlert = `💸 <b>درخواست تسویه حساب جدید</b>\n\nکد پیگیری: <code>#WD-${wdId}</code>\n👤 کاربر: <b>${escapeHtml(user.first_name)}</b> (@${escapeHtml(user.username || 'ندارد')})\n🆔 شناسه: <code>${user.id}</code>\n💵 مبلغ: <b>${formatPrice(amount)}</b>\n💳 مشخصات مقصد:\n<code>${escapeHtml(destInfo)}</code>`;

    const adminMarkup = {
      inline_keyboard: [
        [
          { text: '✅ تایید و تسویه شد', callback_data: `adm_wd_approve:${wdId}` },
          { text: '❌ رد و بازگشت وجه', callback_data: `adm_wd_reject:${wdId}` }
        ]
      ]
    };

    for (const aId of adminIds) {
      await sendMessage(env.BOT_TOKEN, aId, adminAlert, { reply_markup: adminMarkup });
    }
    return;
  }

  // 6. User State: Support Ticket Message
  if (step === 'support_ticket_message') {
    if (!text) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ لطفاً متن پیام خود را ارسال فرمایید:');
      return;
    }

    const now = new Date().toISOString();
    const insertTicket = await db.prepare(`
      INSERT INTO support_tickets (user_id, status, last_message_text, created_at, updated_at)
      VALUES (?, 'open', ?, ?, ?)
    `).bind(user.id, text.slice(0, 200), now, now).run();

    const ticketId = insertTicket.meta.last_row_id;

    await db.prepare(`
      INSERT INTO support_messages (ticket_id, sender_type, sender_id, sender_name, message_text, created_at)
      VALUES (?, 'user', ?, ?, ?, ?)
    `).bind(ticketId, user.id, user.first_name || 'کاربر', text, now).run();

    await clearUserState(db, user.id);

    await sendMessage(env.BOT_TOKEN, chatId, `✅ پیام شما با موفقیت برای تیم پشتیبانی ارسال شد (تیکت #${ticketId}). به زودی پاسخ شما از طریق همین ربات ارسال خواهد شد.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]] }
    });

    // Notify admins
    const adminIds = await getAllAdminIds(env, db);
    const alertMsg = `📩 <b>پیام پشتیبانی جدید (تیکت #${ticketId})</b>\n\n👤 فرستنده: <b>${escapeHtml(user.first_name)}</b> (@${escapeHtml(user.username || 'ندارد')})\n🆔 شناسه: <code>${user.id}</code>\n\n💬 متن پیام:\n${escapeHtml(text)}`;
    const adminMarkup = {
      inline_keyboard: [
        [{ text: '✍️ پاسخ به این پیام', callback_data: `adm_ticket_reply:${ticketId}` }]
      ]
    };

    for (const aId of adminIds) {
      await sendMessage(env.BOT_TOKEN, aId, alertMsg, { reply_markup: adminMarkup });
    }
    return;
  }

  // 7. Admin State: Deliver Config for Order
  if (step === 'admin_order_deliver_config') {
    const orderId = data.orderId;
    await clearUserState(db, user.id);

    const approveRes = await executeOrderApproval(env, db, orderId, user, text);
    if (approveRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `🎉 <b>سفارش #${orderId} با موفقیت تایید و کانفیگ به خریدار تحویل داده شد!</b>\nتاریخ انقضا: ${formatDate(approveRes.expiresDate)}`, {
        reply_markup: { inline_keyboard: [[{ text: '📦 بازگشت به سفارش‌ها', callback_data: 'adm_orders:approved:1' }]] }
      });
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در تایید سفارش: ${approveRes.error}`);
    }
    return;
  }

  // 8. Admin State: Reject Reason for Order
  if (step === 'admin_order_reject_reason') {
    const orderId = data.orderId;
    await clearUserState(db, user.id);

    const rejectRes = await executeOrderRejection(env, db, orderId, user, text);
    if (rejectRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ سفارش #${orderId} با دلیل «${escapeHtml(text)}» رد شد و به خریدار اطلاع‌رسانی گردید.`);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در رد سفارش: ${rejectRes.error}`);
    }
    return;
  }

  // 9. Admin State: Deliver Test Account Config
  if (step === 'admin_test_deliver_config') {
    const testId = data.testId;
    const testReq = await db.prepare('SELECT * FROM test_requests WHERE id = ?').bind(testId).first();

    if (!testReq || testReq.status !== 'pending') {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '❌ این درخواست تست قبلاً بررسی شده است.');
      return;
    }

    const now = new Date().toISOString();
    await db.prepare(`
      UPDATE test_requests
      SET status = 'delivered', config_text = ?, handler_admin_id = ?, handler_admin_name = ?, delivered_at = ?
      WHERE id = ?
    `).bind(text.trim(), user.id, user.first_name || 'مدیر', now, testId).run();

    await clearUserState(db, user.id);

    // Deliver config to user
    const deliveryText = `🎉 <b>اکانت تست رایگان شما آماده شد!</b>\n\n🔐 <b>کانفیگ اتصال شما:</b>\n<code>${escapeHtml(text.trim())}</code>\n\n⚠️ با لمس روی کادر بالا می‌توانید کانفیگ را کپی نمایید.\nجهت مشاهده راهنمای اتصال از بخش راهنما در منوی ربات استفاده کنید.`;
    await sendMessage(env.BOT_TOKEN, testReq.user_id, deliveryText, {
      reply_markup: { inline_keyboard: [[{ text: '📖 راهنمای اتصال', callback_data: 'menu_guides' }]] }
    });

    await sendMessage(env.BOT_TOKEN, chatId, `✅ اکانت تست #${testId} با موفقیت برای کاربر تحویل شد.`);
    return;
  }

  // 10. Admin State: Reject Test Request
  if (step === 'admin_test_reject_reason') {
    const testId = data.testId;
    const testReq = await db.prepare('SELECT * FROM test_requests WHERE id = ?').bind(testId).first();

    if (!testReq || testReq.status !== 'pending') {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '❌ این درخواست تست قبلاً بررسی شده است.');
      return;
    }

    await db.prepare(`
      UPDATE test_requests
      SET status = 'rejected', rejection_reason = ?, handler_admin_id = ?, handler_admin_name = ?
      WHERE id = ?
    `).bind(text.trim(), user.id, user.first_name || 'مدیر', testId).run();

    await clearUserState(db, user.id);

    // Notify user
    await sendMessage(env.BOT_TOKEN, testReq.user_id, `❌ درخواست اکانت تست شما توسط مدیریت رد شد.\nعلت: ${escapeHtml(text.trim())}`);
    await sendMessage(env.BOT_TOKEN, chatId, `❌ درخواست تست #${testId} رد شد.`);
    return;
  }

  // 11. Admin State: Reject Withdrawal
  if (step === 'admin_withdraw_reject_reason' || step === 'admin_wd_reject_reason') {
    const wdId = data.wdId;
    const wd = await db.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(wdId).first();

    if (!wd || wd.status !== 'pending') {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '❌ این درخواست تسویه قبلاً تعیین وضعیت شده است.');
      return;
    }

    const now = new Date().toISOString();
    // Refund amount back to user wallet atomically
    await creditWallet(db, wd.user_id, wd.amount, 'refund', String(wd.id), `عودت وجه درخواست تسویه رد شده #${wd.id}`);

    await db.prepare(`
      UPDATE withdrawals
      SET status = 'rejected', admin_notes = ?, handler_admin_id = ?, handler_admin_name = ?, updated_at = ?
      WHERE id = ?
    `).bind(text, user.id, user.first_name || 'مدیر', now, wd.id).run();

    await clearUserState(db, user.id);

    await sendMessage(env.BOT_TOKEN, wd.user_id, `❌ درخواست تسویه حساب #${wd.id} به مبلغ <b>${formatPrice(wd.amount)}</b> رد شد.\nعلت: ${escapeHtml(text)}\nمبلغ به کیف پول شما بازگردانده شد.`);
    await sendMessage(env.BOT_TOKEN, chatId, `❌ درخواست تسویه #${wd.id} رد و مبلغ به کاربر برگشت داده شد.`);
    return;
  }

  // 12. Admin State: Support Reply
  if (step === 'admin_support_reply') {
    const ticketId = data.ticketId;
    const ticket = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(ticketId).first();

    if (!ticket) {
      await clearUserState(db, user.id);
      await sendMessage(env.BOT_TOKEN, chatId, '❌ تیکت یافت نشد.');
      return;
    }

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO support_messages (ticket_id, sender_type, sender_id, sender_name, message_text, created_at)
      VALUES (?, 'admin', ?, ?, ?, ?)
    `).bind(ticketId, user.id, user.first_name || 'مدیریت', text, now).run();

    await db.prepare('UPDATE support_tickets SET status = "answered", updated_at = ? WHERE id = ?').bind(now, ticketId).run();
    await clearUserState(db, user.id);

    // Send answer to user
    await sendMessage(env.BOT_TOKEN, ticket.user_id, `💬 <b>پاسخ پشتیبانی به پیام شما (تیکت #${ticketId}):</b>\n\n${escapeHtml(text)}`);
    await sendMessage(env.BOT_TOKEN, chatId, `✅ پاسخ با موفقیت برای کاربر ارسال شد.`);
    return;
  }

  // 13. Admin State: Direct Message to User
  if (step === 'admin_user_msg') {
    const targetUserId = data.targetUserId;
    await clearUserState(db, user.id);

    const sendRes = await sendMessage(env.BOT_TOKEN, targetUserId, `📩 <b>پیام از طرف مدیریت:</b>\n\n${escapeHtml(text)}`);
    if (sendRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `✅ پیام با موفقیت به کاربر <code>${targetUserId}</code> ارسال شد.`);
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در ارسال پیام: ${sendRes.description || 'نامشخص'}`);
    }
    return;
  }

  // 14. Admin State: Adjust User Balance
  if (step === 'admin_user_balance') {
    const targetUserId = data.targetUserId;
    const delta = Number(text.replace(/,/g, ''));

    if (isNaN(delta) || delta === 0) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ لطفاً مبلغ عددی معتبر وارد فرمایید (مثبت برای افزایش، منفی برای کاهش):');
      return;
    }

    await clearUserState(db, user.id);

    if (delta > 0) {
      await creditWallet(db, targetUserId, delta, 'admin_adjustment', String(user.id), `افزایش موجودی توسط مدیریت (${user.first_name})`);
    } else {
      await debitWallet(db, targetUserId, Math.abs(delta), 'admin_adjustment', String(user.id), `کاهش موجودی توسط مدیریت (${user.first_name})`);
    }

    const freshTarget = await getUser(db, targetUserId);
    await sendMessage(env.BOT_TOKEN, chatId, `✅ موجودی کاربر با موفقیت تغییر کرد.\nموجودی جدید: <b>${formatPrice(freshTarget.wallet_balance || 0)}</b>`);
    return;
  }

  // 15. Admin State: Ban User Reason
  if (step === 'admin_user_ban_reason') {
    const targetUserId = data.targetUserId;
    await db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?').bind(text, targetUserId).run();
    await clearUserState(db, user.id);
    await logAdminAction(db, user.id, 'ban_user', 'user', targetUserId, `Reason: ${text}`);

    await sendMessage(env.BOT_TOKEN, chatId, `🚫 کاربر <code>${targetUserId}</code> با موفقیت مسدود شد.`);
    return;
  }

  // 16. Admin State: User Search
  if (step === 'admin_user_search') {
    await clearUserState(db, user.id);
    const cleanSearch = text.replace('@', '').trim();
    const numId = Number(cleanSearch);

    let foundUser = null;
    if (!isNaN(numId) && numId > 0) {
      foundUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(numId).first();
    }
    if (!foundUser) {
      foundUser = await db.prepare('SELECT * FROM users WHERE UPPER(username) = ?').bind(cleanSearch.toUpperCase()).first();
    }
    if (!foundUser) {
      foundUser = await db.prepare('SELECT * FROM users WHERE first_name LIKE ? OR last_name LIKE ?').bind(`%${cleanSearch}%`, `%${cleanSearch}%`).first();
    }

    if (!foundUser) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ کاربری با مشخصات «${escapeHtml(text)}» یافت نشد.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔍 جستجوی مجدد', callback_data: 'adm_user_search' }, { text: '🔙 بازگشت', callback_data: 'adm_users:1' }]] }
      });
      return;
    }

    await renderAdminUserDetail(env, db, chatId, foundUser.id);
    return;
  }

  // 17. Admin State: Broadcast Text
  if (step === 'admin_broadcast_text') {
    const filter = data.targetFilter || 'all';
    await clearUserState(db, user.id);

    const bcRes = await createBroadcast(env, db, user.id, text, filter);
    await sendMessage(env.BOT_TOKEN, chatId, `🚀 <b>ارسال همگانی آغاز شد!</b>\n\nکد ارسال: #${bcRes.bcId}\nجامعه هدف: ${filter}\nتعداد کل گیرندگان: <b>${bcRes.totalUsers} نفر</b>\n\nپیام‌ها در بسته‌های ایمن ارسال خواهند شد و پس از اتمام، گزارش نهایی برای شما فرستاده می‌شود.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }]] }
    });
    return;
  }

  // 18. Admin State: Edit Setting Value
  if (step === 'admin_setting_edit') {
    const key = data.key;
    await setSetting(db, key, text);
    await clearUserState(db, user.id);
    await sendMessage(env.BOT_TOKEN, chatId, `✅ تنظیم <b>${escapeHtml(key)}</b> با موفقیت به «${escapeHtml(text)}» تغییر یافت.`);
    await renderAdminSettings(env, db, chatId);
    return;
  }

  // 19. Admin State: Edit Text Template
  if (step === 'admin_text_edit') {
    const key = data.key;
    await setText(db, key, text);
    await clearUserState(db, user.id);
    await sendMessage(env.BOT_TOKEN, chatId, `✅ متن قالب <b>${escapeHtml(key)}</b> با موفقیت بروزرسانی شد.`);
    return;
  }

  // 20. Admin State: Add Admin ID
  if (step === 'admin_admin_add') {
    const newAdminId = Number(text.trim());
    if (isNaN(newAdminId) || newAdminId <= 0) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ لطفاً شناسه عددی تلگرام معتبری ارسال فرمایید:');
      return;
    }

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO users (id, first_name, is_admin, created_at, last_active_at)
      VALUES (?, 'مدیر جدید', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET is_admin = 1
    `).bind(newAdminId, now, now).run();

    invalidateCache('admins');
    await clearUserState(db, user.id);
    await logAdminAction(db, user.id, 'add_admin', 'admin', newAdminId, 'Added admin');

    await sendMessage(env.BOT_TOKEN, chatId, `✅ شناسه <code>${newAdminId}</code> با موفقیت به عنوان مدیر ثبت گردید.`);
    await renderAdminAdmins(env, db, chatId);
    return;
  }


  // 21. Admin State: Add Service
  if (step === "admin_srv_add") {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length < 4) {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ فرمت وارد شده اشتباه است. لطفاً حداقل ۴ بخش را با خط عمودی | جدا کنید:\n<code>نام پلن | حجم ترافیک | تعداد روز | قیمت به تومان | توضیحات (اختیاری)</code>", {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    const name = parts[0];
    const traffic = parts[1];
    const durationDays = Number(parts[2]) || 30;
    const price = Number(parts[3].replace(/,/g, "")) || 0;
    const desc = parts[4] || "";

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO services (name, description, traffic, duration_days, duration_text, price, is_active, display_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
    `).bind(name, desc, traffic, durationDays, `${durationDays} روزه`, price, now).run();

    invalidateCache("all");
    await clearUserState(db, user.id);
    await logAdminAction(db, user.id, "add_service", "service", "", `Added ${name}`);

    await sendMessage(env.BOT_TOKEN, chatId, `✅ سرویس <b>${escapeHtml(name)}</b> با موفقیت ایجاد گردید.`);
    await renderAdminServices(env, db, chatId, 1);
    return;
  }

  // 22. Admin State: Edit Service Field
  if (step === "admin_srv_edit") {
    const sId = data.serviceId;
    const field = data.field;
    await clearUserState(db, user.id);

    if (field === "name") {
      await db.prepare("UPDATE services SET name = ? WHERE id = ?").bind(text, sId).run();
    } else if (field === "price") {
      const price = Number(text.replace(/,/g, "")) || 0;
      await db.prepare("UPDATE services SET price = ? WHERE id = ?").bind(price, sId).run();
    } else if (field === "traffic") {
      await db.prepare("UPDATE services SET traffic = ? WHERE id = ?").bind(text, sId).run();
    } else if (field === "duration") {
      const days = Number(text) || 30;
      await db.prepare("UPDATE services SET duration_days = ?, duration_text = ? WHERE id = ?").bind(days, `${days} روزه`, sId).run();
    }

    invalidateCache("all");
    await sendMessage(env.BOT_TOKEN, chatId, "✅ تغییرات با موفقیت ذخیره شد.");
    await renderAdminServiceDetail(env, db, chatId, sId);
    return;
  }

  // 23. Admin State: Add Payment Method
  if (step === "admin_pm_add") {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length < 2) {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ فرمت نادرست است. لطفاً حداقل عنوان و مشخصات حساب را با | جدا کنید:\n<code>عنوان روش | مشخصات حساب/کارت/ولت | راهنمای کاربر (اختیاری)</code>", {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    const name = parts[0];
    const details = parts[1];
    const instructions = parts[2] || "";
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO payment_methods (name, details, instructions, is_active, display_order, created_at)
      VALUES (?, ?, ?, 1, 0, ?)
    `).bind(name, details, instructions, now).run();

    await clearUserState(db, user.id);
    await logAdminAction(db, user.id, "add_payment_method", "pm", "", `Added ${name}`);

    await sendMessage(env.BOT_TOKEN, chatId, `✅ روش پرداخت <b>${escapeHtml(name)}</b> با موفقیت اضافه شد.`);
    await renderAdminPaymentMethods(env, db, chatId);
    return;
  }

  // 24. Admin State: Add Guide
  if (step === "admin_guide_add") {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length < 2) {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ لطفاً عنوان و متن راهنما را با علامت | جدا فرمایید:\n<code>عنوان راهنما | متن کامل راهنما</code>", {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    const title = parts[0];
    const content = parts.slice(1).join("|");
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO guides (title, content, display_order, is_active, created_at)
      VALUES (?, ?, 0, 1, ?)
    `).bind(title, content, now).run();

    await clearUserState(db, user.id);
    await logAdminAction(db, user.id, "add_guide", "guide", "", `Added ${title}`);

    await sendMessage(env.BOT_TOKEN, chatId, `✅ راهنمای <b>${escapeHtml(title)}</b> با موفقیت ثبت شد.`);
    await renderAdminGuides(env, db, chatId);
    return;
  }

  // 25. Admin State: Add Forced Channel
  if (step === "admin_fc_add") {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length < 3) {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ فرمت نادرست است. لطفاً ۳ بخش را با علامت | وارد نمایید:\n<code>عنوان کانال | شناسه کانال (یا @یوزرنیم) | لینک عضویت</code>", {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    const title = parts[0];
    let channelId = parts[1];
    let link = parts[2];

    if (!channelId.startsWith("@") && !channelId.startsWith("-100") && !channelId.startsWith("-")) {
      channelId = "@" + channelId;
    }

    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO forced_channels (title, channel_id, invite_link, is_active, display_order, created_at)
      VALUES (?, ?, ?, 1, 0, ?)
    `).bind(title, channelId, link, now).run();

    invalidateCache("channels");
    await clearUserState(db, user.id);
    await logAdminAction(db, user.id, "add_forced_channel", "channel", channelId, `Added ${title}`);

    await sendMessage(env.BOT_TOKEN, chatId, `✅ کانال اجباری <b>${escapeHtml(title)}</b> با موفقیت ثبت شد.`);
    await renderAdminForcedChannels(env, db, chatId);
    return;
  }

  // 26. Admin State: Add Coupon
  if (step === "admin_coupon_add") {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length < 3) {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ فرمت نامعتبر است. لطفاً حداقل ۳ بخش اول را ارسال کنید:\n<code>کد تخفیف | نوع (percent یا fixed) | مقدار | حداکثر استفاده (اختیاری) | حداقل خرید (اختیاری)</code>", {
        reply_markup: cancelStateKeyboard()
      });
      return;
    }

    const code = parts[0].toUpperCase();
    const type = parts[1].toLowerCase() === "fixed" ? "fixed" : "percent";
    const val = Number(parts[2].replace(/,/g, "")) || 0;
    const maxUses = parts[3] ? Number(parts[3]) || 0 : 0;
    const minOrder = parts[4] ? Number(parts[4].replace(/,/g, "")) || 0 : 0;

    const now = new Date().toISOString();
    try {
      await db.prepare(`
        INSERT INTO coupons (code, discount_type, discount_value, max_uses, used_count, max_uses_per_user, min_order_price, is_active, created_at)
        VALUES (?, ?, ?, ?, 0, 1, ?, 1, ?)
      `).bind(code, type, val, maxUses, minOrder, now).run();

      await clearUserState(db, user.id);
      await logAdminAction(db, user.id, "add_coupon", "coupon", code, `Added coupon ${code}`);

      await sendMessage(env.BOT_TOKEN, chatId, `✅ کد تخفیف <code>${code}</code> با موفقیت ایجاد شد.`);
      await renderAdminCoupons(env, db, chatId, 1);
    } catch (err) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ خطا در ایجاد کد تخفیف: این کد قبلاً ثبت شده است یا خطای پایگاه داده رخ داد.`);
    }
    return;
  }

  // Fallback
  await showMainMenu(env, db, chatId, user);
}

// Router: Callback Queries
export async function handleCallbackQueryUpdate(env, db, query) {
  const queryId = query.id;
  const data = query.data;
  const message = query.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const from = query.from;

  // Immediate acknowledgement to stop client loading spinner
  await answerCallbackQuery(env.BOT_TOKEN, queryId);

  if (data === 'noop') return;

  // Upsert user
  const user = await upsertUser(db, from);

  if (Number(user.is_banned) === 1) {
    await sendMessage(env.BOT_TOKEN, chatId, '⛔️ دسترسی حساب شما به ربات مسدود شده است.');
    return;
  }

  // Check admin permission if admin callback
  const userIsAdmin = await isAdmin(from.id, env, db);
  if (data.startsWith('adm_') || data === 'admin_panel') {
    if (!userIsAdmin) {
      await sendMessage(env.BOT_TOKEN, chatId, '⛔️ شما دسترسی به پنل مدیریت ندارید.');
      return;
    }
  }

  // Handle Cancel State
  if (data === 'cancel_state') {
    await clearUserState(db, from.id);
    await showMainMenu(env, db, chatId, user, messageId);
    return;
  }

  // Handle Forced Join Verification Button
  if (data === 'check_forced_join') {
    // Clear user's membership cache to ensure fresh check
    MEM_CACHE.userMembership.clear();
    const joinCheck = await checkUserForcedJoin(env, db, from.id);

    if (joinCheck.allowed) {
      await sendMessage(env.BOT_TOKEN, chatId, '🎉 عضویت شما در تمامی کانال‌ها با موفقیت تایید شد!');
      await showMainMenu(env, db, chatId, user);
    } else {
      const channelTitles = joinCheck.missing.map(ch => `▪️ ${escapeHtml(ch.title)}`).join('\n');
      const alertMsg = await getText(db, 'forced_join_not_joined', { channels: channelTitles });
      await sendMessage(env.BOT_TOKEN, chatId, alertMsg, {
        reply_markup: forcedJoinKeyboard(joinCheck.missing)
      });
    }
    return;
  }

  // User Main Navigation
  if (data === 'menu_main') {
    await clearUserState(db, from.id);
    await showMainMenu(env, db, chatId, user, messageId);
    return;
  }

  if (data === 'menu_services') {
    await handleServicesMenu(env, db, chatId, 1, messageId);
    return;
  }

  if (data === 'menu_myservices') {
    await handleMyServicesMenu(env, db, chatId, from.id, 1, messageId);
    return;
  }

  if (data === 'menu_test') {
    await handleTestServiceRequest(env, db, chatId, user, messageId);
    return;
  }

  if (data === 'menu_guides') {
    await handleGuidesMenu(env, db, chatId, messageId);
    return;
  }

  if (data === 'menu_referral') {
    await handleReferralMenu(env, db, chatId, user, messageId);
    return;
  }

  if (data === 'menu_wallet') {
    await handleWalletMenu(env, db, chatId, user, messageId);
    return;
  }

  if (data === 'menu_support') {
    await handleSupportMenu(env, db, chatId, from.id, messageId);
    return;
  }

  // Service Viewing & Ordering
  if (data.startsWith('srv_list:')) {
    const page = Number(data.split(':')[1]) || 1;
    await handleServicesMenu(env, db, chatId, page, messageId);
    return;
  }

  if (data.startsWith('srv_view:')) {
    const srvId = Number(data.split(':')[1]);
    await handleServiceView(env, db, chatId, srvId, messageId);
    return;
  }

  if (data.startsWith('order_create:')) {
    const srvId = Number(data.split(':')[1]);
    const res = await createOrder(env, db, user, srvId);
    if (!res.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ ${res.error}`);
      return;
    }
    await renderOrderInvoice(env, db, chatId, res.order, user, messageId);
    return;
  }

  if (data.startsWith('order_apply_coupon:')) {
    const orderId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'entering_coupon', { orderId });
    await sendMessage(env.BOT_TOKEN, chatId, '🎟 لطفاً کد تخفیف خود را ارسال فرمایید:', {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('order_pay_wallet:')) {
    const orderId = Number(data.split(':')[1]);
    const payRes = await processWalletFullPayment(env, db, orderId, user);
    if (!payRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ ${payRes.error}`);
      return;
    }
    await sendMessage(env.BOT_TOKEN, chatId, '✅ مبلغ سفارش از موجودی کیف پول شما کسر گردید و سفارش جهت ارسال کانفیگ به مدیریت ارسال شد.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 مشاهده وضعیت در سرویس‌های من', callback_data: 'menu_myservices' }],
          [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'menu_main' }]
        ]
      }
    });
    return;
  }

  if (data.startsWith('order_pay_split:')) {
    const orderId = Number(data.split(':')[1]);
    const splitRes = await processWalletSplitPayment(env, db, orderId, user);
    if (!splitRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ ${splitRes.error}`);
      return;
    }

    const methods = (await db.prepare('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY display_order ASC').all())?.results || [];
    const text = `⚖️ <b>پرداخت ترکیبی</b>\n\nمبلغ <b>${formatPrice(splitRes.walletPortion)}</b> از کیف پول شما کسر گردید.\nمبلغ باقیمانده جهت واریز دستی: <b>${formatPrice(splitRes.remainingManual)}</b>\n\nلطفاً یکی از روش‌های پرداخت زیر را جهت واریز مابقی مبلغ انتخاب فرمایید:`;

    await sendMessage(env.BOT_TOKEN, chatId, text, {
      reply_markup: paymentMethodsKeyboard(methods, orderId, false)
    });
    return;
  }

  if (data.startsWith('order_pay_manual:')) {
    const orderId = Number(data.split(':')[1]);
    const methods = (await db.prepare('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY display_order ASC').all())?.results || [];

    if (methods.length === 0) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ در حال حاضر هیچ روش پرداخت فعالی وجود ندارد. لطفاً با پشتیبانی در ارتباط باشید.');
      return;
    }

    await sendMessage(env.BOT_TOKEN, chatId, '💳 لطفاً یکی از روش‌های پرداخت زیر را انتخاب فرمایید:', {
      reply_markup: paymentMethodsKeyboard(methods, orderId, false)
    });
    return;
  }

  if (data.startsWith('order_pay_method:')) {
    const parts = data.split(':');
    const orderId = Number(parts[1]);
    const methodId = Number(parts[2]);

    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(orderId, from.id).first();
    const pm = await db.prepare('SELECT * FROM payment_methods WHERE id = ?').bind(methodId).first();

    if (!order || !pm) {
      await sendMessage(env.BOT_TOKEN, chatId, '❌ سفارش یا روش پرداخت نامعتبر است.');
      return;
    }

    const payableAmount = order.manual_paid > 0 ? order.manual_paid : order.final_price;
    const settings = await getSettings(db);

    const text = await getText(db, 'payment_instructions', {
      method_name: escapeHtml(pm.name),
      details: escapeHtml(pm.details),
      price: formatPrice(payableAmount, settings.currency),
      instructions: escapeHtml(pm.instructions || 'پس از پرداخت تصویر فیش را ارسال فرمایید.')
    });

    await setUserState(db, from.id, 'awaiting_receipt', { orderId, methodId });

    await sendMessage(env.BOT_TOKEN, chatId, text, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('order_cancel:')) {
    const orderId = Number(data.split(':')[1]);
    const now = new Date().toISOString();
    await db.prepare('UPDATE orders SET status = "cancelled", updated_at = ? WHERE id = ? AND user_id = ? AND status = "pending_payment"').bind(now, orderId, from.id).run();
    await sendMessage(env.BOT_TOKEN, chatId, `❌ سفارش #${orderId} لغو شد.`);
    await showMainMenu(env, db, chatId, user);
    return;
  }

  // My Services
  if (data.startsWith('mysrv_list:')) {
    const page = Number(data.split(':')[1]) || 1;
    await handleMyServicesMenu(env, db, chatId, from.id, page, messageId);
    return;
  }

  if (data.startsWith('mysrv_view:')) {
    const id = Number(data.split(':')[1]);
    await handleMyServiceDetail(env, db, chatId, from.id, id, messageId);
    return;
  }

  if (data.startsWith('mysrv_renew:')) {
    const userSrvId = Number(data.split(':')[1]);
    const userSrv = await db.prepare('SELECT * FROM user_services WHERE id = ? AND user_id = ?').bind(userSrvId, from.id).first();
    if (!userSrv) {
      await sendMessage(env.BOT_TOKEN, chatId, '❌ سرویس یافت نشد.');
      return;
    }

    const orderRes = await createOrder(env, db, user, userSrv.service_id, userSrv.id);
    if (!orderRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ ${orderRes.error}`);
      return;
    }

    await sendMessage(env.BOT_TOKEN, chatId, `🔁 <b>تمدید اشتراک #${userSrv.id}</b>\nپیش‌فاکتور تمدید برای شما ایجاد گردید:`);
    await renderOrderInvoice(env, db, chatId, orderRes.order, user);
    return;
  }

  // Guides View
  if (data.startsWith('guide_view:')) {
    const gId = Number(data.split(':')[1]);
    await handleGuideView(env, db, chatId, gId, messageId);
    return;
  }

  // Wallet
  if (data === 'wallet_topup') {
    await setUserState(db, from.id, 'wallet_topup_amount');
    await sendMessage(env.BOT_TOKEN, chatId, '➕ <b>افزایش موجودی کیف پول</b>\n\nلطفاً مبلغ مورد نظر جهت شارژ را به تومان ارسال فرمایید (مثال: 50000):', {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('wallet_topup_pm:')) {
    const methodId = Number(data.split(':')[1]);
    const state = await getUserState(db, from.id);
    const amount = state?.data?.amount;

    if (!amount) {
      await sendMessage(env.BOT_TOKEN, chatId, '❌ درخواست نامعتبر است.');
      return;
    }

    const pm = await db.prepare('SELECT * FROM payment_methods WHERE id = ?').bind(methodId).first();
    await setUserState(db, from.id, 'wallet_topup_receipt', { amount, methodId });

    const text = `💳 <b>روش پرداخت انتخابی: ${escapeHtml(pm.name)}</b>\n\n${escapeHtml(pm.details)}\n\n💵 مبلغ قابل واریز: <b>${formatPrice(amount)}</b>\n\nلطفاً پس از واریز، <b>تصویر فیش واریزی</b> را ارسال نمایید:`;
    await sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: cancelStateKeyboard() });
    return;
  }

  if (data === 'wallet_withdraw') {
    await setUserState(db, from.id, 'wallet_withdraw_amount');
    await sendMessage(env.BOT_TOKEN, chatId, '💸 <b>درخواست تسویه حساب و برداشت وجه</b>\n\nلطفاً مبلغ مورد نظر جهت برداشت را به تومان ارسال فرمایید:', {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('wallet_history:')) {
    const page = Number(data.split(':')[1]) || 1;
    await handleWalletHistory(env, db, chatId, from.id, page, messageId);
    return;
  }

  // Admin Callbacks
  if (data === 'admin_panel') {
    await renderAdminPanel(env, db, chatId, messageId);
    return;
  }

  if (data === 'adm_diagnostics') {
    await renderAdminDiagnostics(env, db, chatId, messageId);
    return;
  }

  if (data === 'adm_clear_logs') {
    await db.prepare('DELETE FROM error_logs').run();
    await sendMessage(env.BOT_TOKEN, chatId, '🧹 لاگ خطاها با موفقیت پاکسازی شد.');
    await renderAdminDiagnostics(env, db, chatId, messageId);
    return;
  }

  if (data === 'adm_backup_export') {
    await sendMessage(env.BOT_TOKEN, chatId, '⏳ در حال تولید فایل پشتیبان...');
    await exportBackupJson(env, db, chatId);
    return;
  }

  if (data.startsWith('adm_stats:')) {
    const period = data.split(':')[1] || 'today';
    await renderAdminStats(env, db, chatId, period, messageId);
    return;
  }

  if (data.startsWith('adm_users:')) {
    const page = Number(data.split(':')[1]) || 1;
    await renderAdminUsers(env, db, chatId, page, messageId);
    return;
  }

  if (data === 'adm_user_search') {
    await setUserState(db, from.id, 'admin_user_search');
    await sendMessage(env.BOT_TOKEN, chatId, '🔍 لطفاً آیدی عددی، یوزرنیم یا نام کاربر را جهت جستجو ارسال فرمایید:', {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('adm_user_view:')) {
    const uId = Number(data.split(':')[1]);
    await renderAdminUserDetail(env, db, chatId, uId, messageId);
    return;
  }

  if (data.startsWith('adm_user_ban:')) {
    const uId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_user_ban_reason', { targetUserId: uId });
    await sendMessage(env.BOT_TOKEN, chatId, `🚫 لطفاً علت مسدودسازی کاربر <code>${uId}</code> را ارسال نمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('adm_user_unban:')) {
    const uId = Number(data.split(':')[1]);
    await db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?').bind(uId).run();
    await logAdminAction(db, from.id, 'unban_user', 'user', uId, 'Unbanned user');
    await sendMessage(env.BOT_TOKEN, chatId, `✅ کاربر <code>${uId}</code> با موفقیت رفع مسدودیت شد.`);
    await renderAdminUserDetail(env, db, chatId, uId, messageId);
    return;
  }

  if (data.startsWith('adm_user_balance:')) {
    const uId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_user_balance', { targetUserId: uId });
    await sendMessage(env.BOT_TOKEN, chatId, `💰 لطفاً مبلغ افزایش یا کاهش را به تومان وارد کنید (مثال: +50000 یا -30000):`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('adm_user_msg:')) {
    const uId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_user_msg', { targetUserId: uId });
    await sendMessage(env.BOT_TOKEN, chatId, `✉️ متن پیام خصوصی به کاربر <code>${uId}</code> را ارسال فرمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Services
  if (data.startsWith('adm_services:')) {
    const page = Number(data.split(':')[1]) || 1;
    await renderAdminServices(env, db, chatId, page, messageId);
    return;
  }

  if (data.startsWith('adm_srv_view:')) {
    const sId = Number(data.split(':')[1]);
    await renderAdminServiceDetail(env, db, chatId, sId, messageId);
    return;
  }

  if (data.startsWith('adm_srv_toggle:')) {
    const sId = Number(data.split(':')[1]);
    await db.prepare('UPDATE services SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').bind(sId).run();
    await renderAdminServiceDetail(env, db, chatId, sId, messageId);
    return;
  }

  if (data.startsWith('adm_srv_del:')) {
    const sId = Number(data.split(':')[1]);
    await db.prepare('DELETE FROM services WHERE id = ?').bind(sId).run();
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 سرویس #${sId} حذف شد.`);
    await renderAdminServices(env, db, chatId, 1, messageId);
    return;
  }

  // Admin Orders
  if (data.startsWith('adm_orders:')) {
    const parts = data.split(':');
    const filter = parts[1] || 'pending_approval';
    const page = Number(parts[2]) || 1;
    await renderAdminOrders(env, db, chatId, filter, page, messageId);
    return;
  }

  if (data.startsWith('adm_order_view:')) {
    const oId = Number(data.split(':')[1]);
    await renderAdminOrderDetail(env, db, chatId, oId, messageId);
    return;
  }

  if (data.startsWith('adm_order_approve:')) {
    const oId = Number(data.split(':')[1]);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(oId).first();
    if (!order || (order.status !== 'pending_approval' && order.status !== 'pending_payment')) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ این سفارش قبلاً بررسی شده است.');
      return;
    }

    await setUserState(db, from.id, 'admin_order_deliver_config', { orderId: oId });
    await sendMessage(env.BOT_TOKEN, chatId, `🔐 <b>تایید و تحویل سفارش #${oId} (${escapeHtml(order.service_name)})</b>\n\nلطفاً متن کانفیگ اختصاصی یا لینک اتصال این کاربر را ارسال فرمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('adm_order_reject:')) {
    const oId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_order_reject_reason', { orderId: oId });
    await sendMessage(env.BOT_TOKEN, chatId, `❌ <b>رد سفارش #${oId}</b>\nلطفاً علت رد سفارش را بنویسید تا به اطلاع خریدار برسد:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Test Service
  if (data.startsWith('adm_tests:')) {
    const parts = data.split(':');
    const filter = parts[1] || 'pending';
    const page = Number(parts[2]) || 1;
    const reqs = (await db.prepare('SELECT t.*, u.first_name, u.username FROM test_requests t LEFT JOIN users u ON t.user_id = u.id WHERE t.status = ? ORDER BY t.id DESC LIMIT 8').bind(filter).all())?.results || [];

    const keyboard = reqs.map(r => [
      { text: `🧪 #${r.id} | ${r.first_name || r.user_id}`, callback_data: `adm_test_approve:${r.id}` }
    ]);
    keyboard.push([{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_panel' }]);

    await sendMessage(env.BOT_TOKEN, chatId, `🧪 <b>درخواست‌های اکانت تست</b> (وضعیت: ${filter}):`, {
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (data.startsWith('adm_test_approve:')) {
    const tId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_test_deliver_config', { testId: tId });
    await sendMessage(env.BOT_TOKEN, chatId, `🧪 لطفاً متن کانفیگ تست برای درخواست #${tId} را ارسال کنید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('adm_test_reject:')) {
    const tId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_test_reject_reason', { testId: tId });
    await sendMessage(env.BOT_TOKEN, chatId, `❌ لطفاً دلیل رد درخواست تست #${tId} را بنویسید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Payment Methods
  if (data === 'adm_paymethods') {
    await renderAdminPaymentMethods(env, db, chatId, messageId);
    return;
  }

  if (data.startsWith('adm_pm_view:')) {
    const pmId = Number(data.split(':')[1]);
    await renderAdminPaymentMethodDetail(env, db, chatId, pmId, messageId);
    return;
  }

  if (data.startsWith('adm_pm_toggle:')) {
    const pmId = Number(data.split(':')[1]);
    await db.prepare('UPDATE payment_methods SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').bind(pmId).run();
    await renderAdminPaymentMethodDetail(env, db, chatId, pmId, messageId);
    return;
  }

  if (data.startsWith('adm_pm_del:')) {
    const pmId = Number(data.split(':')[1]);
    await db.prepare('DELETE FROM payment_methods WHERE id = ?').bind(pmId).run();
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 روش پرداخت #${pmId} حذف شد.`);
    await renderAdminPaymentMethods(env, db, chatId, messageId);
    return;
  }

  // Admin Guides
  if (data === 'adm_guides') {
    await renderAdminGuides(env, db, chatId, messageId);
    return;
  }

  // Admin Forced Channels
  if (data === 'adm_fchannels') {
    await renderAdminForcedChannels(env, db, chatId, messageId);
    return;
  }

  if (data === 'adm_fc_toggle_global') {
    const settings = await getSettings(db);
    const newVal = Number(settings.forced_join_enabled) === 1 ? '0' : '1';
    await setSetting(db, 'forced_join_enabled', newVal);
    await renderAdminForcedChannels(env, db, chatId, messageId);
    return;
  }

  // Admin Withdrawals
  if (data.startsWith('adm_withdraws:')) {
    const parts = data.split(':');
    const filter = parts[1] || 'pending';
    const page = Number(parts[2]) || 1;
    await renderAdminWithdrawals(env, db, chatId, filter, page, messageId);
    return;
  }

  if (data.startsWith('adm_wd_approve:')) {
    const wdId = Number(data.split(':')[1]);
    const now = new Date().toISOString();
    const wd = await db.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(wdId).first();

    if (!wd || wd.status !== 'pending') {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ این درخواست قبلاً بررسی شده است.');
      return;
    }

    await db.prepare('UPDATE withdrawals SET status = "approved", handler_admin_id = ?, handler_admin_name = ?, updated_at = ? WHERE id = ?')
      .bind(from.id, from.first_name || 'مدیر', now, wdId).run();

    await sendMessage(env.BOT_TOKEN, wd.user_id, `🎉 درخواست تسویه حساب #${wdId} به مبلغ <b>${formatPrice(wd.amount)}</b> توسط مدیریت واریز و تسویه گردید.`);
    await sendMessage(env.BOT_TOKEN, chatId, `✅ درخواست تسویه #${wdId} با موفقیت تایید شد.`);
    return;
  }

  if (data.startsWith('adm_wd_reject:')) {
    const wdId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_withdraw_reject_reason', { wdId });
    await sendMessage(env.BOT_TOKEN, chatId, `❌ لطفاً دلیل رد درخواست تسویه #${wdId} را ارسال کنید (مبلغ خودکار به کاربر برگشت داده می‌شود):`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Coupons
  if (data.startsWith('adm_coupons:')) {
    const page = Number(data.split(':')[1]) || 1;
    await renderAdminCoupons(env, db, chatId, page, messageId);
    return;
  }

  // Admin Broadcast
  if (data === 'adm_broadcast') {
    await renderAdminBroadcast(env, db, chatId, messageId);
    return;
  }

  if (data.startsWith('adm_bc_target:')) {
    const filter = data.split(':')[1];
    await setUserState(db, from.id, 'admin_broadcast_text', { targetFilter: filter });
    await sendMessage(env.BOT_TOKEN, chatId, `📣 لطفاً متن پیام همگانی جهت ارسال به گروه «<b>${filter}</b>» را ارسال فرمایید (پشتیبانی از HTML):`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Settings
  if (data === 'adm_settings') {
    await renderAdminSettings(env, db, chatId, messageId);
    return;
  }

  if (data.startsWith('adm_setting_toggle:')) {
    const key = data.split(':')[1];
    const settings = await getSettings(db);
    const current = Number(settings[key]) || 0;
    const next = current === 1 ? '0' : '1';
    await setSetting(db, key, next);
    await renderAdminSettings(env, db, chatId, messageId);
    return;
  }

  if (data.startsWith('adm_setting_edit:')) {
    const key = data.split(':')[1];
    await setUserState(db, from.id, 'admin_setting_edit', { key });
    await sendMessage(env.BOT_TOKEN, chatId, `✏️ لطفاً مقدار جدید را برای تنظیم <b>${escapeHtml(key)}</b> ارسال فرمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Admins
  if (data === 'adm_admins') {
    await renderAdminAdmins(env, db, chatId, messageId);
    return;
  }

  if (data === 'adm_admin_add') {
    await setUserState(db, from.id, 'admin_admin_add');
    await sendMessage(env.BOT_TOKEN, chatId, '👮 لطفاً شناسه عددی تلگرام مدیر جدید را ارسال نمایید:', {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith('adm_admin_del:')) {
    const delId = Number(data.split(':')[1]);
    await db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').bind(delId).run();
    invalidateCache('admins');
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 دسترسی مدیر برای شناسه <code>${delId}</code> لغو شد.`);
    await renderAdminAdmins(env, db, chatId, messageId);
    return;
  }

  // Admin Ticket Reply
  if (data.startsWith('adm_ticket_reply:')) {
    const tId = Number(data.split(':')[1]);
    await setUserState(db, from.id, 'admin_support_reply', { ticketId: tId });
    await sendMessage(env.BOT_TOKEN, chatId, `✍️ لطفاً متن پاسخ به تیکت #${tId} را ارسال فرمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Service Add & Edit
  if (data === "adm_srv_add") {
    await setUserState(db, from.id, "admin_srv_add");
    await sendMessage(env.BOT_TOKEN, chatId, "➕ <b>افزودن سرویس جدید</b>\n\nلطفاً مشخصات پلن را طبق فرمت زیر در یک پیام ارسال فرمایید:\n<code>نام پلن | حجم ترافیک | تعداد روز | قیمت به تومان | توضیحات</code>\n\n📌 <i>مثال:</i>\n<code>پلن طلایی | 80 گیگابایت | 30 | 140000 | سرور آلمان با پینگ پایین</code>", {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith("adm_srv_edit:")) {
    const parts = data.split(":");
    const sId = Number(parts[1]);
    const field = parts[2];
    const fieldLabels = { name: "نام جدید", price: "قیمت جدید (تومان)", traffic: "حجم ترافیک جدید", duration: "تعداد روز اعتبار" };
    await setUserState(db, from.id, "admin_srv_edit", { serviceId: sId, field });
    await sendMessage(env.BOT_TOKEN, chatId, `✏️ لطفاً مقدار <b>${fieldLabels[field] || field}</b> را ارسال فرمایید:`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Payment Methods Add
  if (data === "adm_pm_add") {
    await setUserState(db, from.id, "admin_pm_add");
    await sendMessage(env.BOT_TOKEN, chatId, "➕ <b>افزودن روش پرداخت جدید</b>\n\nلطفاً اطلاعات روش پرداخت را به این صورت ارسال نمایید:\n<code>عنوان روش | اطلاعات کارت یا آدرس ولت | توضیحات یا راهنمای واریز</code>", {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  // Admin Guides Add & View
  if (data === "adm_guide_add") {
    await setUserState(db, from.id, "admin_guide_add");
    await sendMessage(env.BOT_TOKEN, chatId, "➕ <b>افزودن راهنمای اتصال جدید</b>\n\nلطفاً عنوان و متن راهنما را به این صورت ارسال فرمایید:\n<code>عنوان راهنما | متن کامل راهنما</code>", {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith("adm_guide_view:")) {
    const gId = Number(data.split(":")[1]);
    await renderAdminGuideDetail(env, db, chatId, gId, messageId);
    return;
  }

  if (data.startsWith("adm_guide_del:")) {
    const gId = Number(data.split(":")[1]);
    await db.prepare("DELETE FROM guides WHERE id = ?").bind(gId).run();
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 راهنما #${gId} حذف شد.`);
    await renderAdminGuides(env, db, chatId, messageId);
    return;
  }

  // Admin Forced Channels Add, View, Test, Toggle, Delete
  if (data === "adm_fc_add") {
    await setUserState(db, from.id, "admin_fc_add");
    await sendMessage(env.BOT_TOKEN, chatId, "➕ <b>افزودن کانال اجباری جدید</b>\n\nلطفاً اطلاعات کانال را به صورت زیر ارسال نمایید:\n<code>عنوان کانال | شناسه کانال یا @یوزرنیم | لینک عضویت</code>\n\n⚠️ <i>توجه: مطمئن شوید قبل از ثبت، ربات را در کانال مذکور ادمین کرده باشید.</i>", {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith("adm_fc_view:")) {
    const chId = Number(data.split(":")[1]);
    await renderAdminForcedChannelDetail(env, db, chatId, chId, messageId);
    return;
  }

  if (data.startsWith("adm_fc_toggle:")) {
    const chId = Number(data.split(":")[1]);
    await db.prepare("UPDATE forced_channels SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?").bind(chId).run();
    invalidateCache("channels");
    await renderAdminForcedChannelDetail(env, db, chatId, chId, messageId);
    return;
  }

  if (data.startsWith("adm_fc_test:")) {
    const chId = Number(data.split(":")[1]);
    const ch = await db.prepare("SELECT * FROM forced_channels WHERE id = ?").bind(chId).first();
    if (!ch) {
      await sendMessage(env.BOT_TOKEN, chatId, "❌ کانال یافت نشد.");
      return;
    }

    const botInfo = await getMe(env.BOT_TOKEN);
    const botId = botInfo?.result?.id;
    let testSuccess = false;
    let detailMsg = "";

    try {
      const member = await getChatMember(env.BOT_TOKEN, ch.channel_id, botId);
      if (member && ["administrator", "creator"].includes(member.status)) {
        testSuccess = true;
        detailMsg = `✅ ربات با موفقیت کانال را شناسایی کرد و دارای دسترسی <b>${member.status}</b> می‌باشد.`;
      } else {
        detailMsg = `⚠️ ربات کانال را یافت اما وضعیت آن: <b>${member?.status || "نامشخص"}</b> است. لطفاً ربات را به عنوان ادمین کانال اضافه کنید.`;
      }
    } catch (e) {
      detailMsg = `❌ خطا در بررسی کانال: ${e.message}\nمطمئن شوید آیدی کانال درست است و ربات در آن حضور دارد.`;
    }

    await sendMessage(env.BOT_TOKEN, chatId, `🧪 <b>نتیجه تست کانال ${escapeHtml(ch.title)}:</b>\n\n${detailMsg}`);
    return;
  }

  if (data.startsWith("adm_fc_del:")) {
    const chId = Number(data.split(":")[1]);
    await db.prepare("DELETE FROM forced_channels WHERE id = ?").bind(chId).run();
    invalidateCache("channels");
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 کانال #${chId} با موفقیت حذف گردید.`);
    await renderAdminForcedChannels(env, db, chatId, messageId);
    return;
  }

  // Admin Coupons Add, View, Toggle, Delete
  if (data === "adm_coupon_add") {
    await setUserState(db, from.id, "admin_coupon_add");
    await sendMessage(env.BOT_TOKEN, chatId, "➕ <b>افزودن کد تخفیف جدید</b>\n\nلطفاً طبق الگوی زیر ارسال کنید:\n<code>کد تخفیف | نوع (percent یا fixed) | مقدار | سقف استفاده (0=نامحدود) | حداقل مبلغ خرید</code>\n\n📌 <i>مثال:</i>\n<code>DISCOUNT20 | percent | 20 | 100 | 50000</code>", {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith("adm_coupon_view:")) {
    const cId = Number(data.split(":")[1]);
    await renderAdminCouponDetail(env, db, chatId, cId, messageId);
    return;
  }

  if (data.startsWith("adm_coupon_toggle:")) {
    const cId = Number(data.split(":")[1]);
    await db.prepare("UPDATE coupons SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?").bind(cId).run();
    await renderAdminCouponDetail(env, db, chatId, cId, messageId);
    return;
  }

  if (data.startsWith("adm_coupon_del:")) {
    const cId = Number(data.split(":")[1]);
    await db.prepare("DELETE FROM coupons WHERE id = ?").bind(cId).run();
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 کد تخفیف #${cId} حذف شد.`);
    await renderAdminCoupons(env, db, chatId, 1, messageId);
    return;
  }

  // Admin Withdrawals View
  if (data.startsWith("adm_wd_view:")) {
    const wdId = Number(data.split(":")[1]);
    await renderAdminWithdrawalDetail(env, db, chatId, wdId, messageId);
    return;
  }

  // Admin Deposit Approve/Reject
  if (data.startsWith("adm_dep_approve:")) {
    const depId = Number(data.split(":")[1]);
    const depOrder = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(depId).first();

    if (!depOrder || depOrder.status !== "pending_approval") {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ این سفارش قبلاً بررسی شده است.");
      return;
    }

    const settings = await getSettings(db);
    const bonusPercent = Number(settings.wallet_topup_bonus_percent) || 0;
    let bonusAmount = 0;
    if (bonusPercent > 0) {
      bonusAmount = Math.floor((depOrder.final_price * bonusPercent) / 100);
    }
    const totalCredit = depOrder.final_price + bonusAmount;

    await creditWallet(db, depOrder.user_id, totalCredit, "deposit", String(depOrder.id), "شارژ تایید شده کیف پول توسط مدیریت");

    const now = new Date().toISOString();
    await db.prepare('UPDATE orders SET status = "approved", handler_admin_id = ?, handler_admin_name = ?, updated_at = ? WHERE id = ?')
      .bind(from.id, from.first_name || "مدیر", now, depId).run();

    await sendMessage(env.BOT_TOKEN, depOrder.user_id, `🎉 <b>کیف پول شما با موفقیت شارژ شد!</b>\n\n💵 مبلغ واریزی: <b>${formatPrice(depOrder.final_price)}</b>${bonusAmount > 0 ? `\n🎁 بونوس ویژه: <b>${formatPrice(bonusAmount)}</b>` : ""}\n💰 موجودی شارژشده: <b>${formatPrice(totalCredit)}</b>`);
    await sendMessage(env.BOT_TOKEN, chatId, `✅ فیش شارژ #DEP-${depId} تایید و کیف پول کاربر شارژ شد.`);
    return;
  }

  if (data.startsWith("adm_dep_reject:")) {
    const depId = Number(data.split(":")[1]);
    const now = new Date().toISOString();
    const depOrder = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(depId).first();

    if (!depOrder || depOrder.status !== "pending_approval") {
      await sendMessage(env.BOT_TOKEN, chatId, "⚠️ این سفارش قبلاً تعیین وضعیت شده است.");
      return;
    }

    await db.prepare('UPDATE orders SET status = "rejected", handler_admin_id = ?, handler_admin_name = ?, updated_at = ? WHERE id = ?')
      .bind(from.id, from.first_name || "مدیر", now, depId).run();

    await sendMessage(env.BOT_TOKEN, depOrder.user_id, `❌ فیش شارژ حساب شما (#DEP-${depId}) تایید نگردید.\nجهت پیگیری با پشتیبانی تماس بگیرید.`);
    await sendMessage(env.BOT_TOKEN, chatId, `❌ فیش شارژ #DEP-${depId} رد شد.`);
    return;
  }

  // Admin Referral Menu
  if (data === "adm_referral") {
    await renderAdminReferral(env, db, chatId, messageId);
    return;
  }

  // Admin Wallet Menu
  if (data === "adm_wallet") {
    await renderAdminWallet(env, db, chatId, messageId);
    return;
  }

  // Admin Texts Management
  if (data === "adm_texts") {
    await renderAdminTexts(env, db, chatId, messageId);
    return;
  }

  if (data.startsWith("adm_text_view:")) {
    const key = data.split(":")[1];
    await renderAdminTextView(env, db, chatId, key, messageId);
    return;
  }

  if (data.startsWith("adm_text_edit:")) {
    const key = data.split(":")[1];
    await setUserState(db, from.id, "admin_text_edit", { key });
    await sendMessage(env.BOT_TOKEN, chatId, `📝 لطفاً متن جدید را برای قالب <b>${escapeHtml(key)}</b> ارسال فرمایید:\n\n(می‌توانید از تگ‌های HTML مانند b, i, code استفاده کنید)`, {
      reply_markup: cancelStateKeyboard()
    });
    return;
  }

  if (data.startsWith("adm_text_reset:")) {
    const key = data.split(":")[1];
    await resetText(db, key);
    await sendMessage(env.BOT_TOKEN, chatId, `🔄 متن <b>${escapeHtml(key)}</b> به حالت پیش‌فرض بازگردانده شد.`);
    await renderAdminTextView(env, db, chatId, key, messageId);
    return;
  }

  // Admin System Tools Menu
  if (data === "adm_tools") {
    await renderAdminTools(env, db, chatId, messageId);
    return;
  }

  // Admin Broadcast Cancel
  if (data.startsWith("adm_bc_cancel:")) {
    const bcId = Number(data.split(":")[1]);
    const now = new Date().toISOString();
    await db.prepare('UPDATE broadcast_queue SET status = "cancelled", updated_at = ? WHERE id = ?').bind(now, bcId).run();
    await sendMessage(env.BOT_TOKEN, chatId, `🛑 ارسال همگانی #${bcId} متوقف و لغو گردید.`);
    await renderAdminBroadcast(env, db, chatId, messageId);
    return;
  }

}
