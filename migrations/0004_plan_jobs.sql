-- プラン作成をバックグラウンド（waitUntil＋Cron保険）で行うためのジョブ管理。
-- ※アプリ側でも CREATE TABLE IF NOT EXISTS で自動作成されるため未適用でも動作する。
CREATE TABLE IF NOT EXISTS plan_jobs (
  id         TEXT PRIMARY KEY,
  request    TEXT NOT NULL,    -- JSON（PlanRequest）
  origin     TEXT,             -- 楽天APIの Origin/Referer 用
  status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'error'
  plan_id    TEXT,             -- 完成したプランの id
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
