import { describe, it, expect } from 'vitest';
import { isEventSiteHost, buildEventQueries, isPastEventDate, eventListPageUrls } from '../src/scrape/autosource';
import { parseJsonLdEvents } from '../src/scrape/jsonld';

describe('isEventSiteHost: イベント情報サイトの判定', () => {
  it('ウォーカープラス（サブドメイン含む）を認識する', () => {
    expect(isEventSiteHost('www.walkerplus.com')).toBe(true);
    expect(isEventSiteHost('hanabi.walkerplus.com')).toBe(true);
    expect(isEventSiteHost('walkerplus.com')).toBe(true);
  });

  it('他のイベントサイトも認識する', () => {
    expect(isEventSiteHost('www.iko-yo.net')).toBe(true);
    expect(isEventSiteHost('www.jorudan.co.jp')).toBe(true);
  });

  it('無関係なドメインや紛らわしい名前は弾く', () => {
    expect(isEventSiteHost('example.com')).toBe(false);
    expect(isEventSiteHost('notwalkerplus.com')).toBe(false);
  });
});

describe('buildEventQueries: イベント検索クエリ', () => {
  it('ウォーカープラスを最優先に当て、季節イベントも含む', () => {
    const qs = buildEventQueries('出雲市', 8);
    expect(qs[0]).toContain('walkerplus'); // 最優先
    expect(qs.filter((q) => q.includes('walkerplus')).length).toBeGreaterThanOrEqual(2);
    // 8月は夏祭り/花火の季節キーワードが入る
    expect(qs.some((q) => q.includes('夏祭り') || q.includes('花火'))).toBe(true);
  });

  it('クエリ数は絞る（検索の利用制限対策）', () => {
    expect(buildEventQueries('松江市', 8).length).toBeLessThanOrEqual(4);
  });

  it('月なし/範囲外でもwalkerplus狙い＋保険クエリを返す', () => {
    expect(buildEventQueries('金沢市').some((q) => q.includes('walkerplus'))).toBe(true);
    expect(buildEventQueries('金沢市')).toContain('金沢市 イベント 開催');
    expect(buildEventQueries('金沢市', 13).some((q) => q.includes('walkerplus'))).toBe(true);
  });
});

describe('eventListPageUrls: ページ送りURL生成', () => {
  it('末尾スラッシュのリストURLに N.html を付ける', () => {
    const urls = eventListPageUrls('https://www.walkerplus.com/event_list/ar0832/', 4);
    expect(urls).toEqual([
      'https://www.walkerplus.com/event_list/ar0832/',
      'https://www.walkerplus.com/event_list/ar0832/2.html',
      'https://www.walkerplus.com/event_list/ar0832/3.html',
      'https://www.walkerplus.com/event_list/ar0832/4.html',
    ]);
  });

  it('クエリ付き/末尾が非スラッシュのURLはそのまま（誤生成しない）', () => {
    expect(eventListPageUrls('https://x.com/a?b=1', 3)).toEqual(['https://x.com/a?b=1']);
    expect(eventListPageUrls('https://x.com/detail/e001', 3)).toEqual(['https://x.com/detail/e001']);
  });
});

describe('isPastEventDate: 過去イベントの判定', () => {
  const today = '2026-06-09';
  it('終了日が今日より前なら過去', () => {
    expect(isPastEventDate({ startAt: '2025-08-09T00:00:00.000Z', endAt: '2025-08-09T00:00:00.000Z' }, today)).toBe(true);
  });
  it('終了日が今日以降なら過去でない', () => {
    expect(isPastEventDate({ startAt: '2026-08-01T00:00:00.000Z', endAt: '2026-08-02T00:00:00.000Z' }, today)).toBe(false);
  });
  it('開催中（開始は過去・終了は未来）は残す', () => {
    expect(isPastEventDate({ startAt: '2026-05-23T00:00:00.000Z', endAt: '2026-09-26T00:00:00.000Z' }, today)).toBe(false);
  });
  it('日付不明は過去扱いしない', () => {
    expect(isPastEventDate({}, today)).toBe(false);
  });
});

describe('parseJsonLdEvents: ウォーカープラス風のEvent JSON-LD', () => {
  it('開催日・場所つきイベントを取り出す', () => {
    const script = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: '出雲大社 神在祭',
      startDate: '2026-11-20',
      endDate: '2026-11-27',
      url: 'https://www.walkerplus.com/event/ar0832e000001/',
      location: {
        '@type': 'Place',
        name: '出雲大社',
        address: { '@type': 'PostalAddress', addressRegion: '島根県', addressLocality: '出雲市' },
      },
    });
    const events = parseJsonLdEvents([script]);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.title).toBe('出雲大社 神在祭');
    expect(ev.startAt?.slice(0, 10)).toBe('2026-11-20');
    expect(ev.prefecture).toBe('島根県');
    expect(ev.city).toBe('出雲市');
  });
});
