import type { Env, HotelOption } from '../types';

export interface RakutenResult {
  ok: boolean;
  status: number;
  hotels: HotelOption[];
  error?: string;
  raw?: string;
}

export interface HotelSearchOpts {
  /** ホテルの希望条件（露天風呂・夕食付き・リゾート等）。キーワードに足す。 */
  keywords?: string[];
  /** 1泊1人の上限（円）。予算内のみ返す。 */
  maxPrice?: number;
  /** 返す件数の上限（既定12）。 */
  limit?: number;
}

// 2026年の楽天API刷新後の新エンドポイント（旧 app.rakuten.co.jp は2026/5に停止）。
const ENDPOINT = 'https://openapi.rakuten.co.jp/engine/api/Travel/KeywordHotelSearch/20170426';

/**
 * 楽天トラベル KeywordHotelSearch（新API）でエリアの実在ホテルを検索する。
 * 希望条件（露天風呂・夕食付き等）をキーワードに足し、予算内に絞って料金の安い順で返す。
 */
export async function rakutenHotelSearch(
  env: Env,
  area?: string,
  origin?: string,
  opts: HotelSearchOpts = {},
): Promise<RakutenResult> {
  if (!env.RAKUTEN_APP_ID) return { ok: false, status: 0, hotels: [], error: 'RAKUTEN_APP_ID 未設定' };
  if (!env.RAKUTEN_ACCESS_KEY)
    return { ok: false, status: 0, hotels: [], error: 'RAKUTEN_ACCESS_KEY 未設定（新APIのpk_キー）' };
  if (!area) return { ok: false, status: 0, hotels: [], error: 'エリア未指定' };

  const keyword = [area, ...(opts.keywords ?? [])].map((s) => s.trim()).filter(Boolean).join(' ');
  const limit = opts.limit ?? 24;

  const headers: Record<string, string> = {
    'User-Agent': env.USER_AGENT ?? 'TripPlannerBot/0.1 (personal use)',
    Accept: 'application/json',
  };
  if (origin) {
    headers.Origin = origin;
    headers.Referer = origin.endsWith('/') ? origin : origin + '/';
  }

  let all: HotelOption[] = [];
  let status = 0;
  const MAX_PAGES = 3; // 1ページ30件 × 最大3ページ = 最大90件まで取得

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      applicationId: env.RAKUTEN_APP_ID,
      accessKey: env.RAKUTEN_ACCESS_KEY,
      format: 'json',
      keyword,
      hits: '30',
      page: String(page),
    });
    let text = '';
    try {
      const res = await fetch(`${ENDPOINT}?${params.toString()}`, { headers });
      status = res.status;
      text = await res.text();
    } catch (e) {
      if (page === 1) return { ok: false, status: 0, hotels: [], error: e instanceof Error ? e.message : String(e) };
      break;
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      if (page === 1) return { ok: false, status, hotels: [], error: 'JSON解析に失敗', raw: text.slice(0, 300) };
      break;
    }
    if (data && data.error) {
      // 1ページ目のエラーは本物。2ページ目以降の not_found は「これ以上無い」の意味。
      if (page === 1) {
        return {
          ok: false,
          status,
          hotels: [],
          error: `${data.error}: ${data.error_description ?? ''}`.trim(),
          raw: text.slice(0, 300),
        };
      }
      break;
    }
    for (const wrap of data.hotels ?? []) {
      const info = wrap.hotel?.[0]?.hotelBasicInfo;
      if (info?.hotelName) all.push(buildHotel(info));
    }
    const pageCount = Number(data.pagingInfo?.pageCount ?? 1);
    if (page >= pageCount) break;
  }

  // 予算内に絞り、料金の安い順（料金不明は後ろ）に並べて上限件数まで
  if (opts.maxPrice != null) {
    all = all.filter((h) => h.nightlyPrice == null || h.nightlyPrice <= opts.maxPrice!);
  }
  all.sort((a, b) => (a.nightlyPrice ?? Infinity) - (b.nightlyPrice ?? Infinity));
  all = all.slice(0, limit);

  return { ok: true, status, hotels: all };
}

function buildHotel(info: any): HotelOption {
  const addr = `${info.address1 ?? ''}${info.address2 ?? ''}`.trim();
  const bookingUrl = info.hotelNo
    ? `https://travel.rakuten.co.jp/HOTEL/${info.hotelNo}/${info.hotelNo}.html`
    : info.hotelInformationUrl || undefined;
  return {
    name: String(info.hotelName),
    area: addr || undefined,
    nightlyPrice: typeof info.hotelMinCharge === 'number' ? info.hotelMinCharge : undefined,
    why: info.hotelSpecial ? String(info.hotelSpecial).slice(0, 80) : undefined,
    url: bookingUrl,
  };
}

/** プラン用: ホテル配列だけ返す（失敗時は空）。 */
export async function fetchRakutenHotels(
  env: Env,
  area?: string,
  origin?: string,
  opts: HotelSearchOpts = {},
): Promise<HotelOption[]> {
  const r = await rakutenHotelSearch(env, area, origin, opts);
  return r.hotels;
}
