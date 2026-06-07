-- 保存ボタンを押したプランだけを履歴に残すためのフラグ。1 で保存済み。
ALTER TABLE plans ADD COLUMN saved INTEGER NOT NULL DEFAULT 0;
