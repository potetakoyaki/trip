import { describe, it, expect } from 'vitest';
import { parseJsonLdEvents } from '../src/scrape/jsonld';

describe('parseJsonLdEvents schema.org イベント/スポット抽出', () => {
  it('Event(Festival)から開催日・都道府県を取り出す', () => {
    const s = JSON.stringify({
      '@type': 'Festival',
      name: '萩夏まつり',
      startDate: '2026-08-15',
      endDate: '2026-08-16',
      location: {
        '@type': 'Place',
        name: '萩中央公園',
        address: { '@type': 'PostalAddress', addressRegion: '山口県', addressLocality: '萩市' },
      },
    });
    const ev = parseJsonLdEvents([s]);
    expect(ev[0]?.title).toBe('萩夏まつり');
    expect(ev[0]?.startAt).toContain('2026-08-15');
    expect(ev[0]?.endAt).toContain('2026-08-16');
    expect(ev[0]?.prefecture).toBe('山口県');
  });

  it('@graph内のEventも拾う', () => {
    const s = JSON.stringify({
      '@graph': [
        { '@type': 'WebPage' },
        { '@type': 'Event', name: '秋の収穫祭', startDate: '2026-09-01' },
      ],
    });
    expect(parseJsonLdEvents([s]).some((e) => e.title === '秋の収穫祭')).toBe(true);
  });

  it('観光スポット(TouristAttraction)も拾う', () => {
    const s = JSON.stringify({ '@type': 'TouristAttraction', name: '萩城跡' });
    expect(parseJsonLdEvents([s])[0]?.title).toBe('萩城跡');
  });

  it('Event/Place以外・壊れたJSONは無視', () => {
    expect(parseJsonLdEvents(['{壊れたJSON'])).toEqual([]);
    expect(parseJsonLdEvents([JSON.stringify({ '@type': 'Organization', name: '会社' })])).toEqual([]);
  });

  it('opts.prefecture が優先される', () => {
    const s = JSON.stringify({ '@type': 'Event', name: 'X', startDate: '2026-07-01' });
    expect(parseJsonLdEvents([s], { prefecture: '広島県' })[0]?.prefecture).toBe('広島県');
  });
});
