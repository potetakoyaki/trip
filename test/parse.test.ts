import { describe, it, expect } from 'vitest';
import { parseRss } from '../src/scrape/rss';
import { parseJsonLdEvents } from '../src/scrape/jsonld';
import { robotsAllows } from '../src/scrape/robots';
import { extractReadableText } from '../src/scrape/readable';
import { parseSpotArray } from '../src/sources/blog';

describe('parseRss', () => {
  it('RSS の item を抽出する', () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>夏祭り花火大会</title>
          <link>https://example.org/event/1</link>
          <description><![CDATA[湖畔の花火イベント]]></description>
          <pubDate>Wed, 01 Jul 2026 09:00:00 +0900</pubDate>
          <guid>evt-1</guid>
        </item>
        <item>
          <title>朝市マルシェ</title>
          <link>https://example.org/event/2</link>
        </item>
      </channel></rss>`;
    const events = parseRss(xml, { category: '祭り', prefecture: '長野県' });
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('夏祭り花火大会');
    expect(events[0].sourceEventId).toBe('evt-1');
    expect(events[0].category).toBe('祭り');
    expect(events[0].prefecture).toBe('長野県');
    expect(events[0].startAt).toBeTruthy();
  });

  it('Atom の entry も扱える', () => {
    const xml = `<feed>
      <entry>
        <title>アートワークショップ</title>
        <link href="https://example.org/a"/>
        <summary>陶芸体験</summary>
        <updated>2026-08-01T10:00:00Z</updated>
        <id>atom-1</id>
      </entry>
    </feed>`;
    const events = parseRss(xml);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('アートワークショップ');
    expect(events[0].url).toBe('https://example.org/a');
  });
});

describe('parseJsonLdEvents', () => {
  it('schema.org Event を抽出する', () => {
    const json = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: '音楽フェス2026',
      url: 'https://example.org/fes',
      startDate: '2026-07-20T15:00:00+09:00',
      endDate: '2026-07-20T21:00:00+09:00',
      location: {
        '@type': 'Place',
        name: '海浜公園',
        address: { '@type': 'PostalAddress', addressRegion: '千葉県', addressLocality: '千葉市' },
        geo: { '@type': 'GeoCoordinates', latitude: 35.6, longitude: 140.1 },
      },
      offers: { '@type': 'Offer', price: '3000', priceCurrency: 'JPY' },
    });
    const events = parseJsonLdEvents([json]);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe('音楽フェス2026');
    expect(e.prefecture).toBe('千葉県');
    expect(e.city).toBe('千葉市');
    expect(e.lat).toBe(35.6);
    expect(e.price).toBe(3000);
    expect(e.startAt).toBeTruthy();
  });

  it('@graph 配下や配列も処理する', () => {
    const json = JSON.stringify({
      '@graph': [
        { '@type': 'WebPage', name: '無関係' },
        { '@type': 'TouristAttraction', name: '展望台', address: '東京都港区' },
      ],
    });
    const events = parseJsonLdEvents([json]);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('展望台');
    expect(events[0].prefecture).toBe('東京都');
  });

  it('不正な JSON は無視する', () => {
    expect(parseJsonLdEvents(['{ broken'])).toEqual([]);
  });
});

describe('robotsAllows', () => {
  const ua = 'TripPlannerBot/0.1';

  it('Disallow されたパスを拒否する', () => {
    const txt = 'User-agent: *\nDisallow: /private';
    expect(robotsAllows(txt, '/private/page', ua)).toBe(false);
    expect(robotsAllows(txt, '/public/page', ua)).toBe(true);
  });

  it('空の Disallow は全許可', () => {
    const txt = 'User-agent: *\nDisallow:';
    expect(robotsAllows(txt, '/anything', ua)).toBe(true);
  });

  it('Allow が Disallow より長い一致なら許可', () => {
    const txt = 'User-agent: *\nDisallow: /a\nAllow: /a/ok';
    expect(robotsAllows(txt, '/a/ok/page', ua)).toBe(true);
    expect(robotsAllows(txt, '/a/no', ua)).toBe(false);
  });

  it('自分の UA 向けルールを優先する', () => {
    const txt = 'User-agent: tripplannerbot\nDisallow: /\n\nUser-agent: *\nDisallow:';
    expect(robotsAllows(txt, '/x', ua)).toBe(false);
  });
});

describe('extractReadableText（ブログ本文抽出）', () => {
  it('script/style/タグを除去して本文を取り出す', () => {
    const html = `
      <html><head><style>.a{color:red}</style><script>var x=1;</script></head>
      <body>
        <h1>箱根温泉の旅</h1>
        <p>大涌谷で黒たまごを食べました。</p>
        <p>芦ノ湖の遊覧船もおすすめ。</p>
      </body></html>`;
    const text = extractReadableText(html);
    expect(text).toContain('箱根温泉の旅');
    expect(text).toContain('黒たまご');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('<p>');
  });

  it('maxLen で切り詰める', () => {
    const html = '<p>' + 'あ'.repeat(100) + '</p>';
    expect(extractReadableText(html, 20).length).toBeLessThanOrEqual(20);
  });
});

describe('parseSpotArray（AI応答からJSON配列を抽出）', () => {
  it('前後に説明文があってもJSON配列を取り出す', () => {
    const res = 'はい、以下が抽出結果です:\n[{"title":"大涌谷","category":"自然"},{"title":"芦ノ湖","category":"自然"}] 以上です。';
    const spots = parseSpotArray(res);
    expect(spots).toHaveLength(2);
    expect(spots[0].title).toBe('大涌谷');
  });

  it('配列が無ければ空配列', () => {
    expect(parseSpotArray('抽出できませんでした')).toEqual([]);
  });

  it('壊れたJSONは空配列', () => {
    expect(parseSpotArray('[{"title": broken')).toEqual([]);
  });
});
