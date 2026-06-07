import type { Env, HotelOption } from '../types';

export interface RakutenResult {
  ok: boolean;
  status: number;
  hotels: HotelOption[];
  error?: string;
  raw?: string;
}

// 2026年の楽天API刷新後の新エンドポイント（旧 app.rakuten.co.jp は2026/5に停止）。
const ENDPOINT = 'https://openapi.rakuten.co.jp/engine/api/Travel/KeywordHotelSearch/20170426';

/**
 * 楽天トラベル KeywordHotelSearch（新API）でエリアの実在ホテルを検索する。
 * 新APIは applicationId(UUID) と accessKey(pk_) の両方が必須で、Origin/Referer
 * ヘッダー（登録した許可ドメイン）も要求される。
 */
export async function rakutenHotelSearch(
  env: Env,
  area?: string,
  origin?: string,
): Promise<RakutenResult> {
  if (!env.RAKUTEN_APP_ID) return { ok: false, status: 0, hotels: [], error: 'RAKUTEN_APP_ID 未設定' };
  if (!env.RAKUTEN_ACCESS_KEY)
    return { ok: false, status: 0, hotels: [], error: 'RAKUTEN_ACCESS_KEY 未設定（新APIのpk_キー）' };
  if (!area) return { ok: false, status: 0, hotels: [], error: 'エリア未指定' };

  const params = new URLSearchParams({
    applicationId: env.RAKUTEN_APP_ID,
    accessKey: env.RAKUTEN_ACCESS_KEY,
    format: 'json',
    keyword: area,
    hits: '15',
  });
  const url = `${ENDPOINT}?${params.toString()}`;

  const headers: Record<string, string> = {
    'User-Agent': env.USER_AGENT ?? 'TripPlannerBot/0.1 (personal use)',
    Accept: 'application/json',
  };
  // 新APIはブラウザ前提の設計で Origin/Referer を確認する。許可ドメインと一致させる。
  if (origin) {
    headers.Origin = origin;
    headers.Referer = origin.endsWith('/') ? origin : origin + '/';
  }

  let status = 0;
  let text = '';
  try {
    const res = await fetch(url, { headers });
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
    // ホテル番号から正規の予約ページURLを組み立てる（hotelInformationUrlは画像系のことがある）。
    const bookingUrl = info.hotelNo
      ? `https://travel.rakuten.co.jp/HOTEL/${info.hotelNo}/${info.hotelNo}.html`
      : info.hotelInformationUrl || undefined;
    hotels.push({
      name: String(info.hotelName),
      area: addr || undefined,
      nightlyPrice: typeof info.hotelMinCharge === 'number' ? info.hotelMinCharge : undefined,
      why: info.hotelSpecial ? String(info.hotelSpecial).slice(0, 80) : undefined,
      url: bookingUrl,
    });
    if (hotels.length >= 3) break;
  }
  return { ok: true, status, hotels };
}

/** プラン用: ホテル配列だけ返す（失敗時は空）。 */
export async function fetchRakutenHotels(env: Env, area?: string, origin?: string): Promise<HotelOption[]> {
  const r = await rakutenHotelSearch(env, area, origin);
  return r.hotels;
}
