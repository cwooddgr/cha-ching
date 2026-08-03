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
