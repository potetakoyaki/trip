-- ソースのサンプル。すべて enabled=0（無効）で投入してある。
-- 必要なものだけ config を埋めて enabled=1 にすると、スクレイピング対象になる。
--
-- 大手予約サイト（じゃらん等）は robots.txt / 利用規約でスクレイピングを
-- 禁じていることが多いため、公式API（楽天トラベル / connpass）や、各ページが
-- 埋め込む schema.org の JSON-LD、観光協会の RSS を使う方針にしている。

INSERT OR IGNORE INTO sources (id, name, kind, base_url, config, enabled) VALUES
  (
    'connpass',
    'connpass（イベント・勉強会）',
    'api',
    'https://connpass.com',
    '{"driver":"connpass","keyword":"旅行","count":50}',
    0
  ),
  (
    'rakuten-travel',
    '楽天トラベル（宿泊・観光）',
    'api',
    'https://app.rakuten.co.jp',
    '{"driver":"rakuten","keyword":"箱根","category":"宿泊"}',
    0
  ),
  (
    'kanko-rss-example',
    '観光協会RSS（例）',
    'rss',
    '',
    '{"driver":"rss","feedUrl":"https://example.com/feed.xml","category":"観光","prefecture":""}',
    0
  ),
  (
    'jsonld-example',
    'イベントページ JSON-LD（例: Walkerplus / Peatix 等）',
    'html',
    '',
    '{"driver":"jsonld","pageUrls":["https://example.com/events"],"prefecture":""}',
    0
  );
