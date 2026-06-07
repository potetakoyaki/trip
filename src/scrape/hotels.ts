import type { Env, HotelOption } from '../types';

export interface RakutenResult {
  ok: boolean;
  status: number;
  hotels: HotelOption[];
  error?: string;
  raw?: string;
}

/**
 * 楽天トラベル KeywordHotelSearch でエリアの実在ホテルを検索する。
 * 診断できるよう、ステータス・エラー・生応答の一部も返す。
 */
export async function rakutenHotelSearch(env: Env, area?: string): Promise<RakutenResult> {
  if (!env.RAKUTEN_APP_ID) return { ok: false, status: 0, hotels: [], error: 'RAKUTEN_APP_ID 未設定' };
  if (!area) return { ok: false, status: 0, hotels: [], error: 'エリア未指定' };

  const params = new URLSearchParams({
    applicationId: env.RAKUTEN_APP_ID,
    format: 'json',
    keyword: area,
    hits: '15',
  });
  const url = `https://app.rakuten.co.jp/services/api/Travel/KeywordHotelSearch/20170426?${params.toString()}`;

  let status = 0;
  let text = '';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': env.USER_AGENT ?? 'TripPlannerBot/0.1 (personal use)',
        Accept: 'application/json',
      },
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, hotels: [], error: e instanceof Error ? e.message : String(e) };
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status, hotels: [], error: 'JSON解析に失敗', raw: text.slice(0, 300) };
  }

  // 楽天はエラー時 {error, error_description} を返す
  if (data && data.error) {
    return {
      ok: false,
      status,
      hotels: [],
      error: `${data.error}: ${data.error_description ?? ''}`.trim(),
      raw: text.slice(0, 300),
    };
  }

  const hotels: HotelOption[] = [];
  for (const wrap of data.hotels ?? []) {
    const info = wrap.hotel?.[0]?.hotelBasicInfo;
    if (!info?.hotelName) continue;
    const addr = `${info.address1 ?? ''}${info.address2 ?? ''}`.trim();
    hotels.push({
      name: String(info.hotelName),
      area: addr || undefined,
      nightlyPrice: typeof info.hotelMinCharge === 'number' ? info.hotelMinCharge : undefined,
      why: info.hotelSpecial ? String(info.hotelSpecial).slice(0, 80) : undefined,
      url: info.hotelInformationUrl || undefined,
    });
    if (hotels.length >= 3) break;
  }
  return { ok: true, status, hotels };
}

/** プラン用: ホテル配列だけ返す（失敗時は空）。 */
export async function fetchRakutenHotels(env: Env, area?: string): Promise<HotelOption[]> {
  const r = await rakutenHotelSearch(env, area);
  return r.hotels;
}
