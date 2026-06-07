-- 収集済みの (エリア, キーワード) 条件を記録し、差分収集の判定に使う。
-- ※アプリ側でも CREATE TABLE IF NOT EXISTS で自動作成されるため未適用でも動作する。
CREATE TABLE IF NOT EXISTS collect_covered (
  area       TEXT NOT NULL,
  keyword    TEXT NOT NULL,   -- '' は一般（キーワード無し）収集
  created_at TEXT NOT NULL,
  PRIMARY KEY (area, keyword)
);
