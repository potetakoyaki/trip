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
  /** 宿泊チェックイン日（YYYY-MM-DD）。指定すると空室検索で実価格を取得する。 */
  checkinDate?: string;
  /** 宿泊チェックアウト日（YYYY-MM-DD）。 */
  checkoutDate?: string;
  /** 大人の人数（既定1）。 */
  adults?: number;
}

// 2026年の楽天API刷新後の新エンドポイント（旧 app.rakuten.co.jp は2026/5に停止）。
const ENDPOINT = 'https://openapi.rakuten.co.jp/engine/api/Travel/KeywordHotelSearch/20170426';
// 空室検索（指定日の実価格・空室を取得）。hotelNo はカンマ区切りで複数指定可。
const VACANT_ENDPOINT = 'https://openapi.rakuten.co.jp/engine/api/Travel/VacantHotelSearch/20170426';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  // 指定日があれば、空室検索でその日の実価格を取得して上書きする。
  if (opts.checkinDate && opts.checkoutDate) {
    const nos = Array.from(
      new Set(all.map((h) => h.hotelNo).filter((n): n is number => typeof n === 'number')),
    );
    const prices = await fetchVacantPrices(env, nos, opts.checkinDate, opts.checkoutDate, opts.adults ?? 1, origin);
    for (const h of all) {
      if (h.hotelNo != null && prices.has(h.hotelNo)) {
        h.nightlyPrice = prices.get(h.hotelNo);
        h.datedPrice = true; // この料金は指定日の空室実価格
      }
    }
  }

  // 予算内に絞り、指定日の実価格があるホテルを優先しつつ料金の安い順（料金不明は後ろ）に
  if (opts.maxPrice != null) {
    all = all.filter((h) => h.nightlyPrice == null || h.nightlyPrice <= opts.maxPrice!);
  }
  all.sort((a, b) => {
    if (!!a.datedPrice !== !!b.datedPrice) return a.datedPrice ? -1 : 1;
    return (a.nightlyPrice ?? Infinity) - (b.nightlyPrice ?? Infinity);
  });
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
    hotelNo: typeof info.hotelNo === 'number' ? info.hotelNo : Number(info.hotelNo) || undefined,
  };
}

/**
 * 空室検索（VacantHotelSearch）で、指定日の実価格を hotelNo 単位で取得する。
 * hotelNo はカンマ区切りで複数指定できるのでバッチで問い合わせる。
 * 返り値: hotelNo → その日の最低料金（円）。空室が無い/取得失敗のhotelNoは含まれない。
 */
async function fetchVacantPrices(
  env: Env,
  hotelNos: number[],
  checkinDate: string,
  checkoutDate: string,
  adults: number,
  origin?: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!hotelNos.length || !env.RAKUTEN_APP_ID || !env.RAKUTEN_ACCESS_KEY) return out;
  if (!DATE_RE.test(checkinDate) || !DATE_RE.test(checkoutDate)) return out;

  const headers: Record<string, string> = {
    'User-Agent': env.USER_AGENT ?? 'TripPlannerBot/0.1 (personal use)',
    Accept: 'application/json',
  };
  if (origin) {
    headers.Origin = origin;
    headers.Referer = origin.endsWith('/') ? origin : origin + '/';
  }

  const BATCH = 15; // hotelNo の多重指定は念のため15件ずつ
  for (let i = 0; i < hotelNos.length; i += BATCH) {
    const batch = hotelNos.slice(i, i + BATCH);
    const params = new URLSearchParams({
      applicationId: env.RAKUTEN_APP_ID,
      accessKey: env.RAKUTEN_ACCESS_KEY,
      format: 'json',
      checkinDate,
      checkoutDate,
      adultNum: String(Math.max(1, adults)),
      hotelNo: batch.join(','),
    });
    try {
      const res = await fetch(`${VACANT_ENDPOINT}?${params.toString()}`, { headers });
      const data: any = await res.json();
      if (data?.error) continue; // バッチ全体が満室/該当なし等
      for (const wrap of data.hotels ?? []) {
        const info = wrap.hotel?.[0]?.hotelBasicInfo;
        const no = Number(info?.hotelNo);
        const charge = info?.hotelMinCharge;
        if (Number.isFinite(no) && typeof charge === 'number' && charge > 0) out.set(no, charge);
      }
    } catch {
      /* このバッチは諦めて次へ */
    }
  }
  return out;
}

/** プラン用: ホテル配列だけ返す（失敗時は空）。 */
export async function fetchRakutenHotels(
  env: Env,
  area?: string,
  origin?: string,
  opts: HotelSearchOpts = {},
): Promise<HotelOption[]> {
  let r = await rakutenHotelSearch(env, area, origin, opts);
  // 条件（露天風呂等）で0件になったら、条件を外してエリアだけで再検索し、実ホテルを優先する。
  if (r.hotels.length === 0 && opts.keywords && opts.keywords.length) {
    r = await rakutenHotelSearch(env, area, origin, { ...opts, keywords: [] });
  }
  return r.hotels;
}
