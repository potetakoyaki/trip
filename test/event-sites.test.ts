import { describe, it, expect } from 'vitest';
import { isEventSiteHost, buildEventQueries, isPastEventDate } from '../src/scrape/autosource';
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
  it('月ありで季節イベント・ウォーカープラス狙いのクエリを作る', () => {
    const qs = buildEventQueries('出雲市', 7);
    expect(qs).toContain('出雲市 イベント 祭り 開催 7月');
    expect(qs).toContain('出雲市 花火大会 7月');
    expect(qs.some((q) => q.includes('walkerplus'))).toBe(true);
  });

  it('月なし/範囲外は月を付けない', () => {
    expect(buildEventQueries('金沢市')).toContain('金沢市 イベント 祭り 開催');
    expect(buildEventQueries('金沢市', 13)).toContain('金沢市 花火大会');
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
