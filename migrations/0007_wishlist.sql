-- 行ってみたい場所（wishlist）。手動で並び替え可能（sort_order）。
CREATE TABLE IF NOT EXISTS wishlist (
  title TEXT PRIMARY KEY,
  prefecture TEXT,
  area TEXT,
  url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
