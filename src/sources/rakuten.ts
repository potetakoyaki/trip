import type { NormalizedEvent, SourceRow } from '../types';
import type { Driver, RunContext } from './index';
import { inferPrefecture } from '../util/normalize';

interface RakutenHotel {
  hotelBasicInfo?: {
    hotelNo?: number;
    hotelName?: string;
    hotelInformationUrl?: string;
    hotelSpecial?: string;
    address1?: string;
    address2?: string;
    hotelMinCharge?: number;
    hotelImageUrl?: string;
    latitude?: number;
    longitude?: number;
  };
}

/**
 * 楽天トラベル KeywordHotelSearch API（公式・無料）。
 * RAKUTEN_APP_ID が無ければスキップする。
 * 参考: https://webservice.rakuten.co.jp/documentation/keyword-hotel-search
 */
export const rakutenDriver: Driver = {
  name: 'rakuten',

  isConfigured(ctx: RunContext): boolean {
    return Boolean(ctx.env.RAKUTEN_APP_ID);
  },

  async run(ctx: RunContext, source: SourceRow): Promise<NormalizedEvent[]> {
    const cfg = source.config as { keyword?: string; category?: string };
    const keyword = cfg.keyword ?? '';
    const params = new URLSearchParams({
      applicationId: ctx.env.RAKUTEN_APP_ID!,
      format: 'json',
      keyword,
      hits: '30',
    });
    const url = `https://app.rakuten.co.jp/services/api/Travel/KeywordHotelSearch/20170426?${params.toString()}`;

    const data = await ctx.http.getJson<{ hotels?: { hotel?: RakutenHotel[] }[] }>(url, {
      cacheTtl: 1800,
    });

    const out: NormalizedEvent[] = [];
    for (const wrap of data.hotels ?? []) {
      const info = wrap.hotel?.[0]?.hotelBasicInfo;
      if (!info?.hotelName) continue;
      const address = `${info.address1 ?? ''}${info.address2 ?? ''}`;
      out.push({
        sourceEventId: String(info.hotelNo ?? info.hotelName),
        title: info.hotelName,
        description: info.hotelSpecial,
        url: info.hotelInformationUrl,
        category: cfg.category ?? '宿泊',
        prefecture: inferPrefecture(address) ?? info.address1,
        city: info.address2,
        locationName: address,
        lat: info.latitude,
        lng: info.longitude,
        price: info.hotelMinCharge,
        imageUrl: info.hotelImageUrl,
        raw: info,
      });
    }
    return out;
  },
};
