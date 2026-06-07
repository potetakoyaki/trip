-- スポットの営業時間。AI抽出で本文に記載があれば格納する。
ALTER TABLE events ADD COLUMN hours TEXT;
