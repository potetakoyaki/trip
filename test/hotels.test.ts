import { describe, it, expect, vi, afterEach } from 'vitest';
import { rakutenHotelSearch } from '../src/scrape/hotels';

const env = (extra: Record<string, unknown> = {}) =>
  ({ RAKUTEN_APP_ID: 'app', RAKUTEN_ACCESS_KEY: 'pk_x', USER_AGENT: 'test', ...extra }) as any;

function mockRes(obj: unknown) {
  const s = JSON.stringify(obj);
  return { ok: true, status: 200, text: async () => s, json: async () => obj } as any;
}

// 楽天 KeywordHotelSearch のレスポンス（山口の宿1件＋東京の同名地ヒット1件）
const KEYWORD = {
  hotels: [
    { hotel: [{ hotelBasicInfo: { hotelName: '萩の宿', hotelNo: 1, address1: '山口県', address2: '萩市', hotelMinCharge: 8000 } }] },
    { hotel: [{ hotelBasicInfo: { hotelName: '荻窪ホテル', hotelNo: 2, address1: '東京都', address2: '杉並区上荻', hotelMinCharge: 5000 } }] },
  ],
  pagingInfo: { pageCount: 1 },
};
// VacantHotelSearch（指定日の実価格）。実際に泊まれる部屋の dailyCharge.total を使う。
// hotelMinCharge(底値3000)ではなく、部屋総額の最小24000(=1室の実価格)になるべき。
const VACANT = {
  hotels: [
    {
      hotel: [
        { hotelBasicInfo: { hotelNo: 1, hotelMinCharge: 3000 } },
        { roomInfo: [{ roomBasicInfo: { planName: 'ツイン' } }, { dailyCharge: { rakutenCharge: 12000, total: 24000 } }] },
        { roomInfo: [{ roomBasicInfo: { planName: 'デラックス' } }, { dailyCharge: { total: 30000 } }] },
      ],
    },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('VacantHotelSearch')) return mockRes(VACANT);
      if (u.includes('KeywordHotelSearch')) return mockRes(KEYWORD);
      return mockRes({});
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('rakutenHotelSearch 楽天トラベル連携', () => {
  it('キーワード検索でホテル名・hotelNo・住所・最低料金を取得', async () => {
    stubFetch();
    const r = await rakutenHotelSearch(env(), '萩', undefined, { limit: 10 });
    expect(r.ok).toBe(true);
    const names = r.hotels.map((h) => h.name);
    expect(names).toContain('萩の宿');
    const hagi = r.hotels.find((h) => h.name === '萩の宿');
    expect(hagi?.hotelNo).toBe(1);
    expect(hagi?.nightlyPrice).toBe(8000);
    expect(hagi?.area).toContain('山口県');
  });

  it('prefecture で県外（東京の同名地）を除外', async () => {
    stubFetch();
    const r = await rakutenHotelSearch(env(), '萩', undefined, { prefecture: '山口県', limit: 10 });
    expect(r.hotels.map((h) => h.name)).toEqual(['萩の宿']);
  });

  it('指定日があれば空室検索で実価格に上書き＋datedPrice=true・優先表示', async () => {
    stubFetch();
    const r = await rakutenHotelSearch(env(), '萩', undefined, {
      prefecture: '山口県',
      checkinDate: '2026-06-20',
      checkoutDate: '2026-06-21',
    });
    const hagi = r.hotels.find((h) => h.name === '萩の宿');
    expect(hagi?.nightlyPrice).toBe(24000); // 8000(最低料金) → 24000(指定日の1室実価格)
    expect(hagi?.datedPrice).toBe(true);
    expect(r.hotels[0]?.datedPrice).toBe(true); // 指定日価格が先頭
  });

  it('認証情報が無ければ ok:false', async () => {
    stubFetch();
    const r = await rakutenHotelSearch({ USER_AGENT: 't' } as any, '萩', undefined, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/RAKUTEN_APP_ID/);
  });

  it('APIがエラーを返したら ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockRes({ error: 'wrong_parameter', error_description: 'bad' })));
    const r = await rakutenHotelSearch(env(), '萩', undefined, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/wrong_parameter/);
  });

  it('予算(maxPrice)で絞り込み', async () => {
    stubFetch();
    const r = await rakutenHotelSearch(env(), '萩', undefined, { maxPrice: 6000, limit: 10 });
    // 萩の宿(8000)は除外、荻窪(5000)は残る（県絞り無しの場合）
    expect(r.hotels.every((h) => h.nightlyPrice == null || h.nightlyPrice <= 6000)).toBe(true);
  });

  it('キャンプ場は除外し、希望条件(温泉)に合う宿を上位にする', async () => {
    const KW = {
      hotels: [
        { hotel: [{ hotelBasicInfo: { hotelName: 'みろく自然公園キャンプ場', hotelNo: 10, address1: '香川県', address2: 'さぬき市', hotelMinCharge: 3000 } }] },
        { hotel: [{ hotelBasicInfo: { hotelName: 'ビジネスホテルさぬき', hotelNo: 11, address1: '香川県', address2: 'さぬき市', hotelMinCharge: 5000 } }] },
        { hotel: [{ hotelBasicInfo: { hotelName: 'さぬき温泉旅館', hotelNo: 12, address1: '香川県', address2: 'さぬき市', hotelSpecial: '露天風呂と夕食の会席が自慢', hotelMinCharge: 9000 } }] },
      ],
      pagingInfo: { pageCount: 1 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => (String(url).includes('KeywordHotelSearch') ? mockRes(KW) : mockRes({}))),
    );
    const r = await rakutenHotelSearch(env(), 'さぬき市', undefined, { keywords: ['温泉', '夕食付き'], limit: 10 });
    const names = r.hotels.map((h) => h.name);
    expect(names).not.toContain('みろく自然公園キャンプ場'); // キャンプ場は除外
    expect(r.hotels[0].name).toBe('さぬき温泉旅館'); // 温泉・夕食に合う宿が先頭
  });

  it('予算内で口コミ評価の高い順に並べる', async () => {
    const KW = {
      hotels: [
        { hotel: [{ hotelBasicInfo: { hotelName: '評価低い宿', hotelNo: 21, address1: '香川県', address2: '高松市', hotelMinCharge: 5000, reviewAverage: 3.2, reviewCount: 50 } }] },
        { hotel: [{ hotelBasicInfo: { hotelName: '評価高い宿', hotelNo: 22, address1: '香川県', address2: '高松市', hotelMinCharge: 8000, reviewAverage: 4.7, reviewCount: 120 } }] },
        { hotel: [{ hotelBasicInfo: { hotelName: '予算オーバー宿', hotelNo: 23, address1: '香川県', address2: '高松市', hotelMinCharge: 99000, reviewAverage: 5.0, reviewCount: 10 } }] },
      ],
      pagingInfo: { pageCount: 1 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => (String(url).includes('KeywordHotelSearch') ? mockRes(KW) : mockRes({}))),
    );
    const r = await rakutenHotelSearch(env(), '高松市', undefined, { maxPrice: 10000, limit: 10 });
    const names = r.hotels.map((h) => h.name);
    expect(names).not.toContain('予算オーバー宿'); // 予算外は除外
    expect(r.hotels[0].name).toBe('評価高い宿'); // 口コミ評価の高い順
    expect(r.hotels[0].reviewAverage).toBe(4.7);
  });
});
