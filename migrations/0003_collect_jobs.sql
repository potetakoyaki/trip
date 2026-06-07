-- 「じっくり収集」をバックグラウンド（Cron）で進めるためのジョブ管理。
-- ※アプリ起動時にも CREATE TABLE IF NOT EXISTS で自動作成されるため、
--   このマイグレーションが未適用でも動作する。
CREATE TABLE IF NOT EXISTS collect_jobs (
  area         TEXT PRIMARY KEY,
  keyword      TEXT,
  interests    TEXT,            -- JSON 配列
  round        INTEGER NOT NULL DEFAULT 1,
  total_rounds INTEGER NOT NULL DEFAULT 6,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done'
  collected    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
