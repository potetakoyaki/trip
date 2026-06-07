import type { Env, HotelOption } from '../types';

/**
 * 楽天トラベル KeywordHotelSearch API で、エリアの実在ホテルを取得する。
 * RAKUTEN_APP_ID（無料）が未設定、または取得失敗時は空配列。
 */
export async function fetchRakutenHotels(env: Env, area?: string): Promise<HotelOption[]> {
  if (!env.RAKUTEN_APP_ID || !area) return [];
  const params = new URLSearchParams({
    applicationId: env.RAKUTEN_APP_ID,
    format: 'json',
    keyword: area,
    hits: '10',
    responseType: 'small',
  });
  const url = `https://app.rakuten.co.jp/services/api/Travel/KeywordHotelSearch/20170426?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': env.USER_AGENT ?? 'TripPlannerBot/0.1 (personal use)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      hotels?: { hotel?: { hotelBasicInfo?: any }[] }[];
    };

    const out: HotelOption[] = [];
    for (const wrap of data.hotels ?? []) {
      const info = wrap.hotel?.[0]?.hotelBasicInfo;
      if (!info?.hotelName) continue;
      const addr = `${info.address1 ?? ''}${info.address2 ?? ''}`.trim();
      out.push({
        name: String(info.hotelName),
        area: addr || undefined,
        nightlyPrice: typeof info.hotelMinCharge === 'number' ? info.hotelMinCharge : undefined,
        why: info.hotelSpecial ? String(info.hotelSpecial).slice(0, 80) : undefined,
        url: info.hotelInformationUrl || undefined,
      });
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}
