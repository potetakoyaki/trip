import type { Env, PlanItem } from '../types';
import { ensureGeocodeTable, getGeocode, putGeocode } from '../db/repository';

export interface LatLng {
  lat: number;
  lng: number;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 1件のクエリ（地名/施設名＋エリアヒント）を緯度経度に変換する。
 * DBキャッシュ優先、未取得なら Nominatim(1req/秒)。見つからなければ null。
 */
export async function geocodeQuery(env: Env, name: string, areaHint?: string): Promise<LatLng | null> {
  const n = (name || '').trim();
  if (!n) return null;
  await ensureGeocodeTable(env.DB);
  const query = [n, (areaHint || '').trim(), '日本'].filter(Boolean).join(' ');

  const cached = await getGeocode(env.DB, query);
  if (cached) return cached.lat === 0 && cached.lng === 0 ? null : cached;

  let lat = 0;
  let lng = 0;
  try {
    const ua = env.USER_AGENT || 'TripPlannerBot/0.1 (personal use)';
    const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=ja&countrycodes=jp`;
    const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
    if (res.ok) {
      const arr = (await res.json()) as Array<{ lat?: string; lon?: string }>;
      const hit = Array.isArray(arr) ? arr[0] : undefined;
      if (hit?.lat && hit?.lon) {
        const la = Number(hit.lat);
        const lo = Number(hit.lon);
        if (Number.isFinite(la) && Number.isFinite(lo)) {
          lat = la;
          lng = lo;
        }
      }
    }
  } catch {
    /* 失敗時は (0,0) として記録 */
  }
  await putGeocode(env.DB, query, lat, lng, new Date().toISOString());
  await sleep(1100); // Nominatim 利用ポリシー: 最大 1req/秒
  return lat !== 0 || lng !== 0 ? { lat, lng } : null;
}

/**
 * プランの各スポットに、名称から引いた実際の緯度経度を付与する（地図用）。
 * AIの推測座標は不正確なので上書きする。DBキャッシュ優先で、未取得分だけ
 * Nominatim(OSM) に問い合わせる（利用ポリシーに従い 1req/秒・User-Agent必須）。
 * ベストエフォート：取得できないスポットはAI座標のまま残す。
 */
export async function geocodePlanItems(
  env: Env,
  items: PlanItem[],
  areaHint?: string,
  opts: { center?: LatLng | null; maxKm?: number } = {},
): Promise<void> {
  const center = opts.center ?? null;
  const maxKm = opts.maxKm ?? 150;
  for (const item of items) {
    // 各スポットの実座標を名称から引き直す（AIの座標は海上等にズレることがあるため信頼しない）。
    // DBキャッシュがあれば即返るので、同じスポットの2回目以降は速い。
    const ll = await geocodeQuery(env, item.title || '', item.location || areaHint);
    // エリア中心から離れすぎ（＝別地方の同名地に誤マッチ）や取得失敗は地図に出さない。
    if (ll && (!center || haversineKm(center, ll) <= maxKm)) {
      item.lat = ll.lat;
      item.lng = ll.lng;
    } else {
      item.lat = undefined;
      item.lng = undefined;
    }
  }
}

const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';

/** 緯度経度から都道府県名（例 "山口県"）を逆ジオコーディングで得る。失敗時 undefined。 */
export async function reversePrefecture(env: Env, lat: number, lng: number): Promise<string | undefined> {
  try {
    const ua = env.USER_AGENT || 'TripPlannerBot/0.1 (personal use)';
    const url = `${NOMINATIM_REVERSE}?lat=${lat}&lon=${lng}&format=json&accept-language=ja&zoom=8&addressdetails=1`;
    const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
    await sleep(1100);
    if (!res.ok) return undefined;
    const data = (await res.json()) as any;
    const a = data?.address ?? {};
    const pref = a.province || a.state || a.region;
    return typeof pref === 'string' && pref.trim() ? pref.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 2地点の直線距離(km)。ハバーサイン。 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
