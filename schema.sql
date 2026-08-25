-- cha-ching D1 schema
-- Apply with: npx wrangler d1 execute cha-ching --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS notifications (
  notification_uuid TEXT PRIMARY KEY,
  signed_date INTEGER NOT NULL,            -- ms since epoch, from responseBodyV2 signedDate
  notification_type TEXT NOT NULL,
  subtype TEXT,
  bundle_id TEXT,
  environment TEXT,                        -- Production | Sandbox
  product_id TEXT,
  transaction_id TEXT,
  original_transaction_id TEXT,
  price INTEGER,                           -- milliunits of local currency (Apple's price field)
  currency TEXT,
  storefront TEXT,                         -- alpha-3 country code
  offer_type INTEGER,
  offer_identifier TEXT,
  offer_discount_type TEXT,                -- FREE_TRIAL | PAY_AS_YOU_GO | PAY_UP_FRONT
  in_app_ownership_type TEXT,              -- PURCHASED | FAMILY_SHARED
  purchase_date INTEGER,                   -- ms since epoch
  expires_date INTEGER,                    -- ms since epoch
  auto_renew_status INTEGER,               -- from renewal info, when present
  raw TEXT NOT NULL                        -- full decoded notification JSON (transaction + renewal info inlined)
);

CREATE INDEX IF NOT EXISTS idx_notifications_signed_date ON notifications (signed_date);
CREATE INDEX IF NOT EXISTS idx_notifications_bundle_type ON notifications (bundle_id, notification_type, signed_date);
CREATE INDEX IF NOT EXISTS idx_notifications_original_txn ON notifications (original_transaction_id);

-- ---------------------------------------------------------------------------
-- Apple Summary Sales reports (App Store Connect API, /v1/salesReports)
-- ---------------------------------------------------------------------------
-- One row per line of a DAILY Summary Sales report. Imported by
-- scripts/sales-import.mjs; see CLAUDE.md for the counting rules.
--
-- Why this exists alongside `notifications`: App Store Server Notification
-- history only reaches back 180 days, which truncates CD Wally's lifetime and
-- misses Countdowns entirely. Sales reports reach back a year and carry
-- Apple's ACTUAL developer proceeds rather than our fx_rates estimate, so they
-- are authoritative for units and revenue. They are aggregates with no
-- transaction ids, so subscriber state, MRR and trial conversion still come
-- from `notifications`.
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,       -- 'YYYY-MM-DD', Apple's PACIFIC-TIME day, not UTC
  bundle_id TEXT,                  -- mapped from sku by the importer; NULL if unrecognised
  sku TEXT,                        -- Apple's SKU: the app's, or the IAP's own
  title TEXT,
  product_type TEXT,               -- Product Type Identifier; 'IA%' are the IAP/subscription rows
  units INTEGER,                   -- NEGATIVE on a refund
  proceeds_per_unit REAL,          -- Apple's "Developer Proceeds" — PER UNIT, post-commission
  proceeds_currency TEXT,          -- currency of proceeds_per_unit; join fx_rates on this
  customer_price REAL,             -- per unit, gross, in customer_currency
  customer_currency TEXT,
  country_code TEXT,               -- alpha-2 here (notifications.storefront is alpha-3)
  apple_identifier TEXT,
  parent_identifier TEXT,          -- parent app SKU on IAP rows
  promo_code TEXT,                 -- 'FREE' on a free trial, else a promo code
  order_type TEXT,                 -- 'Free Trial Intro Offer', an offer-code name, or NULL
  subscription TEXT,               -- 'New' | 'Renewal'
  period TEXT,                     -- '7 Days' | '1 Month' | '1 Year'
  device TEXT,
  version TEXT,
  begin_date TEXT,
  end_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_report_date ON sales (report_date);
CREATE INDEX IF NOT EXISTS idx_sales_bundle_date ON sales (bundle_id, report_date);
CREATE INDEX IF NOT EXISTS idx_sales_sku ON sales (sku, report_date);

-- Which report days have been fetched, so incremental runs skip them. Days
-- Apple answered 404 ("no sales") are recorded with row_count 0 — that is a
-- real answer, not a gap, and must not be refetched forever.
CREATE TABLE IF NOT EXISTS sales_import_log (
  report_date TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL,    -- ms since epoch
  row_count INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Apple App Sessions analytics (App Store Connect API, Analytics Reports)
-- ---------------------------------------------------------------------------
-- One row per line of an "App Sessions Standard" report instance. Imported by
-- scripts/analytics-import.mjs; the Worker's /api/analytics-import creates
-- these tables itself on first use (wrangler d1 execute --remote 403s from
-- the laptop), so this block is the record, not the mechanism.
--
-- `unique_devices` is Apple's distinct-device count FOR THAT ROW's slice of
-- dimensions within the row's period (a day, a Monday–Sunday week, or a
-- calendar month). Summing rows within one (granularity, bundle_id, date)
-- gives that period's active devices; summing ACROSS dates does not give
-- anything — a device active on ten days is ten rows. See CLAUDE.md.
CREATE TABLE IF NOT EXISTS app_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  granularity TEXT NOT NULL,       -- 'DAILY' | 'WEEKLY' | 'MONTHLY'
  date TEXT NOT NULL,              -- the day, or the FIRST day of the week/month
  processing_date TEXT NOT NULL,   -- instance that supplied the row; latest wins
  bundle_id TEXT,
  app_apple_id TEXT,
  app_version TEXT,
  device TEXT,                     -- 'iPhone' | 'iPad' | 'Apple TV' | 'Desktop' …
  platform_version TEXT,           -- 'iOS 26.5', 'tvOS 26.3' …
  source_type TEXT,                -- how the app was discovered
  page_type TEXT,
  download_date TEXT,              -- only if downloaded in the previous 30 days
  territory TEXT,                  -- alpha-2
  sessions INTEGER,
  session_duration INTEGER,        -- seconds, total across the row's sessions
  unique_devices INTEGER
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_lookup ON app_sessions (granularity, bundle_id, date);

-- Which report instances have been imported, so runs skip them.
CREATE TABLE IF NOT EXISTS analytics_import_log (
  instance_id TEXT PRIMARY KEY,
  bundle_id TEXT,
  granularity TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  imported_at INTEGER NOT NULL,    -- ms since epoch
  row_count INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Active users from first-party telemetry (Overflight → Analytics Engine)
-- ---------------------------------------------------------------------------
-- One row per app per UTC day, written by the Worker's daily cron
-- (snapshotActiveUsers): the distinct installs that posted a session_start in
-- the 1 / 7 / 30 days ENDING on `date`. Exact and over every install — the
-- opposite of app_sessions' opt-in sample. Created by the Worker on first use.
CREATE TABLE IF NOT EXISTS active_users (
  bundle_id TEXT NOT NULL,
  date TEXT NOT NULL,              -- UTC day the windows end on (inclusive)
  dau INTEGER NOT NULL,
  wau INTEGER NOT NULL,
  mau INTEGER NOT NULL,
  sessions INTEGER NOT NULL,       -- session_starts on that day
  computed_at INTEGER NOT NULL,    -- ms since epoch
  PRIMARY KEY (bundle_id, date)
);

-- Static currency -> USD conversion rates for revenue estimates.
-- Rates are approximate (mid-2026); revenue figures are estimates, not accounting truth.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  usd_rate REAL NOT NULL                   -- 1 unit of currency = usd_rate USD
);

INSERT OR REPLACE INTO fx_rates (currency, usd_rate) VALUES
  ('USD', 1.0),
  ('EUR', 1.09),
  ('GBP', 1.28),
  ('CAD', 0.73),
  ('AUD', 0.66),
  ('NZD', 0.60),
  ('JPY', 0.0064),
  ('KRW', 0.00073),
  ('CNY', 0.14),
  ('TWD', 0.031),
  ('HKD', 0.128),
  ('SGD', 0.75),
  ('INR', 0.0117),
  ('BRL', 0.18),
  ('MXN', 0.054),
  ('CLP', 0.0011),
  ('COP', 0.00024),
  ('PEN', 0.27),
  ('ARS', 0.0008),
  ('CHF', 1.12),
  ('SEK', 0.095),
  ('NOK', 0.094),
  ('DKK', 0.146),
  ('PLN', 0.255),
  ('CZK', 0.043),
  ('HUF', 0.0027),
  ('RON', 0.22),
  ('BGN', 0.56),
  ('TRY', 0.029),
  ('ILS', 0.27),
  ('SAR', 0.267),
  ('AED', 0.272),
  ('QAR', 0.275),
  ('KWD', 3.25),
  ('EGP', 0.020),
  ('ZAR', 0.055),
  ('NGN', 0.00062),
  ('KES', 0.0077),
  ('THB', 0.028),
  ('IDR', 0.000061),
  ('MYR', 0.22),
  ('PHP', 0.0172),
  ('VND', 0.000039),
  ('PKR', 0.0036),
  ('RUB', 0.011),
  ('UAH', 0.024);
