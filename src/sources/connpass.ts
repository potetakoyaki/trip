import type { NormalizedEvent, SourceRow } from '../types';
import type { Driver, RunContext } from './index';
import { inferCategory, inferPrefecture } from '../util/normalize';

interface ConnpassEvent {
  event_id?: number;
  id?: number;
  title?: string;
  catch?: string;
  description?: string;
  event_url?: string;
  url?: string;
  started_at?: string;
  ended_at?: string;
  place?: string;
  address?: string;
  lat?: string | number;
  lon?: string | number;
}

/**
 * connpass 公式API。2024年以降の仕様変更で API キーが必須のため、
 * CONNPASS_API_KEY が無ければスキップする。
 * 参考: https://connpass.com/about/api/
 */
export const connpassDriver: Driver = {
  name: 'connpass',

  isConfigured(ctx: RunContext): boolean {
    return Boolean(ctx.env.CONNPASS_API_KEY);
  },

  async run(ctx: RunContext, source: SourceRow): Promise<NormalizedEvent[]> {
    const cfg = source.config as { keyword?: string; count?: number; endpoint?: string };
    const endpoint = cfg.endpoint ?? 'https://connpass.com/api/v2/events/';
    const params = new URLSearchParams();
    if (cfg.keyword) params.set('keyword', cfg.keyword);
    params.set('count', String(Math.min(cfg.count ?? 50, 100)));
    const url = `${endpoint}?${params.toString()}`;

    const res = await fetch(url, {
      headers: {
        'X-API-Key': ctx.env.CONNPASS_API_KEY!,
        'User-Agent': ctx.env.USER_AGENT ?? 'TripPlannerBot/0.1 (personal use)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`connpass API HTTP ${res.status}`);
    const data = (await res.json()) as { events?: ConnpassEvent[] };

    return (data.events ?? []).map((e): NormalizedEvent => {
      const title = e.title ?? '(無題)';
      const desc = e.catch || e.description;
      return {
        sourceEventId: String(e.event_id ?? e.id ?? e.event_url ?? title),
        title,
        description: desc,
        url: e.event_url ?? e.url,
        category: inferCategory(title, desc) ?? 'テック',
        prefecture: inferPrefecture(e.address, e.place),
        locationName: e.place,
        lat: toNum(e.lat),
        lng: toNum(e.lon),
        startAt: toIso(e.started_at),
        endAt: toIso(e.ended_at),
        price: undefined,
        raw: e,
      };
    });
  },
};

function toNum(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function toIso(v?: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
