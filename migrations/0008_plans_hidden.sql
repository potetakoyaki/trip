-- 保存プランのソフト削除用フラグ。1 で一覧から非表示（DBには残す）。
ALTER TABLE plans ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
