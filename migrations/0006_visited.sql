-- 行ったことある場所（visited）。都道府県＞エリア別に表示する。
CREATE TABLE IF NOT EXISTS visited (
  title TEXT PRIMARY KEY,
  prefecture TEXT,
  area TEXT,
  url TEXT,
  created_at TEXT NOT NULL
);
