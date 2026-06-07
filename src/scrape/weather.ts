import type { DayForecast } from '../types';

/**
 * Open-Meteo（無料・APIキー不要）で旅行日の天気予報を取得する。
 * エリア名をジオコーディング → 日次予報。予報範囲外（先すぎる日付）は空。
 */
export async function fetchForecast(
  area: string,
  startDate: string,
  endDate: string,
): Promise<DayForecast[]> {
  if (!area || !startDate || !endDate) return [];
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      area,
    )}&count=1&language=ja&format=json`;
    const g = await fetch(geoUrl, { headers: { Accept: 'application/json' } });
    if (!g.ok) return [];
    const gd = (await g.json()) as any;
    const loc = gd?.results?.[0];
    if (!loc || typeof loc.latitude !== 'number') return [];

    const fUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=Asia%2FTokyo&start_date=${startDate}&end_date=${endDate}`;
    const f = await fetch(fUrl, { headers: { Accept: 'application/json' } });
    if (!f.ok) return [];
    const fd = (await f.json()) as any;
    const d = fd?.daily;
    if (!d || !Array.isArray(d.time)) return [];

    const out: DayForecast[] = [];
    for (let i = 0; i < d.time.length; i++) {
      const code = Number(d.weather_code?.[i] ?? 0);
      const w = weatherLabel(code);
      out.push({
        date: String(d.time[i]),
        code,
        tmax: round(d.temperature_2m_max?.[i]),
        tmin: round(d.temperature_2m_min?.[i]),
        pop: numOrUndef(d.precipitation_probability_max?.[i]),
        label: w.label,
        emoji: w.emoji,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function round(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** WMO weather code → 絵文字・ラベル（ざっくり）。 */
function weatherLabel(code: number): { label: string; emoji: string } {
  if (code === 0) return { label: '快晴', emoji: '☀️' };
  if (code <= 2) return { label: '晴れ時々曇り', emoji: '🌤️' };
  if (code === 3) return { label: '曇り', emoji: '☁️' };
  if (code <= 48) return { label: '霧', emoji: '🌫️' };
  if (code <= 57) return { label: '霧雨', emoji: '🌦️' };
  if (code <= 67) return { label: '雨', emoji: '🌧️' };
  if (code <= 77) return { label: '雪', emoji: '🌨️' };
  if (code <= 82) return { label: 'にわか雨', emoji: '🌦️' };
  if (code <= 86) return { label: '雪', emoji: '🌨️' };
  if (code <= 99) return { label: '雷雨', emoji: '⛈️' };
  return { label: '—', emoji: '🌡️' };
}
