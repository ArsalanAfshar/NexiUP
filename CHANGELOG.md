# NexiUP Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-10-19

### Added
- **Core Architecture**:
  - Single-file Cloudflare Worker (`worker.js`) running with zero dependencies.
  - Cloudflare D1 SQL database support with automated migrations and indexing.
  - Webhook secret token verification and update deduplication.
  - In-memory caching for settings, texts, and channel memberships.
- **User Experience (100% Persian)**:
  - Interactive main menu: Service Store, My Services, Free Test Account, Guides, Referral Program, Wallet, and Support.
  - Service selection with real-time pricing, descriptions, and duration info.
  - Multiple payment methods support (Card-to-card, Crypto, Perfect Money) with manual receipt upload (photos/documents via Telegram `file_id`).
  - Split payments: pay with wallet balance + manual payment for the remainder.
  - Clean monospace config/subscription delivery with one-tap copy.
  - Renewal shortcut directly from active/expired services.
  - Manual test account flow with 24h cooldown starting only after successful delivery.
  - Referral system with unique deep links (`ref_<id>`), commission tracking, and wallet credits.
  - In-bot support ticketing system with admin quick replies.
- **Forced Channel Join (Multi-Channel)**:
  - Multi-channel support (public @username and private invite links).
  - Parallel non-blocking membership checks (`Promise.all`).
  - Cache positive memberships in memory to minimize subrequests.
  - Channel join/leave lifecycle tracking in database.
- **Comprehensive Admin Panel**:
  - Full in-bot Persian dashboard with 18 management sections.
  - System diagnostics: D1 latency, webhook health, error logs, and masked env validation.
  - Multi-period analytics dashboard (Today, 7 days, 30 days, All time) with aggregated batch queries.
  - Order review system: instant notification to all admins with inline approve/reject buttons and conflict prevention.
  - User management: search by ID/username, ban/unban, balance adjustments, and direct messaging.
  - Service, guide, payment method, coupon, and forced channel CRUD operations.
  - Wallet withdrawals review with automated refunds on rejection.
  - Safe chunked broadcast system with audience targeting (All, Buyers, Non-buyers, Active).
  - One-click JSON backup export and restore directly inside Telegram.
  - In-bot customization of texts, button labels, and general settings.
- **Smart Automations (Optional Cron Trigger)**:
  - Automated service expiry reminders (3 days, 1 day, expired) with direct renewal links.
  - Smart order timeout: auto-cancels abandoned pending orders and refunds reserved wallet balance.
  - Daily sales and user statistics report pushed to admins.
  - Automatic cleanup of old error logs and deduplication records.
