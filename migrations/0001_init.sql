-- スクレイピング対象ソースの設定。ドライバ方式で後から追加できる。
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'api' | 'rss' | 'html'
  base_url    TEXT,
  config      TEXT NOT NULL DEFAULT '{}', -- JSON: { driver, ...driver固有 }
  enabled     INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT
);

-- 取得・正規化したイベント / 宿泊 / スポット情報。
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,      -- "<source>:<source_event_id>"
  source          TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  url             TEXT,
  category        TEXT,                  -- 正規化カテゴリ（グルメ/自然/歴史 等）
  tags            TEXT,                  -- JSON 配列
  prefecture      TEXT,
  city            TEXT,
  location_name   TEXT,
  lat             REAL,
  lng             REAL,
  start_at        TEXT,                  -- ISO8601（不明なら NULL）
  end_at          TEXT,
  price           INTEGER,               -- 円。不明なら NULL、無料は 0
  image_url       TEXT,
  raw             TEXT,                  -- 元データ JSON
  scraped_at      TEXT NOT NULL,
  UNIQUE (source, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_prefecture ON events (prefecture);
CREATE INDEX IF NOT EXISTS idx_events_start_at   ON events (start_at);
CREATE INDEX IF NOT EXISTS idx_events_category   ON events (category);

-- 生成した旅行プランの保存。
CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  request    TEXT NOT NULL,              -- JSON（リクエスト条件）
  result     TEXT NOT NULL               -- JSON（日程プラン）
);
