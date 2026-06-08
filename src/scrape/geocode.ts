import type { Env, PlanItem } from '../types';
import { ensureGeocodeTable, getGeocode, putGeocode } from '../db/repository';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * プランの各スポットに、名称から引いた実際の緯度経度を付与する（地図用）。
 * AIの推測座標は不正確なので上書きする。DBキャッシュ優先で、未取得分だけ
 * Nominatim(OSM) に問い合わせる（利用ポリシーに従い 1req/秒・User-Agent必須）。
 * ベストエフォート：取得できないスポットはAI座標のまま残す。
 */
export async function geocodePlanItems(env: Env, items: PlanItem[], areaHint?: string): Promise<void> {
  if (!items.length) return;
  await ensureGeocodeTable(env.DB);
  const ua = env.USER_AGENT || 'TripPlannerBot/0.1 (personal use)';
  const now = () => new Date().toISOString();

  for (const item of items) {
    const name = (item.title || '').trim();
    if (!name) continue;
    const hint = (item.location || areaHint || '').trim();
    const query = [name, hint, '日本'].filter(Boolean).join(' ');

    // 1) キャッシュ
    const cached = await getGeocode(env.DB, query);
    if (cached) {
      if (!(cached.lat === 0 && cached.lng === 0)) {
        item.lat = cached.lat;
        item.lng = cached.lng;
      }
      continue;
    }

    // 2) Nominatim（キャッシュミスのみ。1req/秒を守る）
    let lat = 0;
    let lng = 0;
    try {
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
      /* 失敗時は (0,0) として記録し、AI座標を温存 */
    }

    await putGeocode(env.DB, query, lat, lng, now());
    if (lat !== 0 || lng !== 0) {
      item.lat = lat;
      item.lng = lng;
    }
    await sleep(1100); // Nominatim 利用ポリシー: 最大 1req/秒
  }
}
