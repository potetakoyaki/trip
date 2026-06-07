import type { NormalizedEvent } from '../types';
import { inferCategory, inferPrefecture } from '../util/normalize';

/**
 * HTML から <script type="application/ld+json"> の中身を抽出する。
 * Cloudflare の HTMLRewriter を使うので Worker 実行時専用。
 */
export async function extractJsonLdScripts(html: string): Promise<string[]> {
  const scripts: string[] = [];
  let current = '';
  const rewriter = new HTMLRewriter().on('script[type="application/ld+json"]', {
    element(el) {
      current = '';
      el.onEndTag(() => {
        if (current.trim()) scripts.push(current.trim());
        current = '';
      });
    },
    text(t) {
      current += t.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  return scripts;
}

const EVENT_TYPES = new Set([
  'Event', 'Festival', 'MusicEvent', 'TheaterEvent', 'ExhibitionEvent',
  'FoodEvent', 'SportsEvent', 'SocialEvent', 'BusinessEvent', 'EducationEvent',
  'ScreeningEvent', 'ComedyEvent', 'DanceEvent', 'VisualArtsEvent',
]);
const PLACE_TYPES = new Set([
  'TouristAttraction', 'LandmarksOrHistoricalBuildings', 'Museum', 'Park',
  'LodgingBusiness', 'Hotel', 'Resort', 'Campground', 'Restaurant',
]);

/**
 * 抽出済み JSON-LD 文字列群を NormalizedEvent に変換する純粋関数（テスト可能）。
 * schema.org の Event 系 / 観光スポット・宿泊系を拾う。
 */
export function parseJsonLdEvents(
  scripts: string[],
  opts: { prefecture?: string } = {},
): NormalizedEvent[] {
  const nodes: any[] = [];
  for (const s of scripts) {
    let data: any;
    try {
      data = JSON.parse(s);
    } catch {
      continue;
    }
    collectNodes(data, nodes);
  }

  const events: NormalizedEvent[] = [];
  for (const node of nodes) {
    const types = toArray(node['@type']).map(String);
    const isEvent = types.some((t) => EVENT_TYPES.has(t));
    const isPlace = types.some((t) => PLACE_TYPES.has(t));
    if (!isEvent && !isPlace) continue;

    const name = asString(node.name);
    if (!name) continue;
    const url = asString(node.url);
    const description = asString(node.description);
    const image = firstImage(node.image);
    const startAt = toIso(node.startDate);
    const endAt = toIso(node.endDate);
    // 観光スポット/宿の場合、住所・座標はノード自身に付くことが多い。
    const locSource = node.location ?? (isPlace ? node : undefined);
    const { locationName, prefecture, city, lat, lng } = readLocation(locSource);
    const price = readPrice(node.offers);

    events.push({
      sourceEventId: url || name,
      title: name,
      description: description || undefined,
      url: url || undefined,
      category: isPlace ? inferCategory(name, description) ?? '観光' : inferCategory(name, description) ?? 'イベント',
      prefecture: opts.prefecture || prefecture || inferPrefecture(locationName, description),
      city,
      locationName,
      lat,
      lng,
      startAt,
      endAt,
      price,
      imageUrl: image,
      raw: node,
    });
  }
  return events;
}

function collectNodes(data: any, out: any[]): void {
  if (Array.isArray(data)) {
    for (const d of data) collectNodes(d, out);
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data['@graph'])) collectNodes(data['@graph'], out);
    if (data['@type']) out.push(data);
  }
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: any): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object' && typeof v['@value'] === 'string') return v['@value'].trim() || undefined;
  return undefined;
}

function firstImage(v: any): string | undefined {
  const first = toArray(v)[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') return asString(first.url ?? first.contentUrl);
  return undefined;
}

function toIso(v: any): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function readLocation(loc: any): {
  locationName?: string;
  prefecture?: string;
  city?: string;
  lat?: number;
  lng?: number;
} {
  const node = toArray(loc)[0];
  if (!node || typeof node !== 'object') {
    const name = asString(loc);
    return { locationName: name };
  }
  const locationName = asString(node.name);
  const address = node.address;
  let prefecture: string | undefined;
  let city: string | undefined;
  if (typeof address === 'string') {
    prefecture = inferPrefecture(address);
  } else if (address && typeof address === 'object') {
    prefecture = asString(address.addressRegion);
    city = asString(address.addressLocality);
  }
  const geo = node.geo;
  let lat: number | undefined;
  let lng: number | undefined;
  if (geo && typeof geo === 'object') {
    lat = toNum(geo.latitude);
    lng = toNum(geo.longitude);
  }
  return { locationName, prefecture, city, lat, lng };
}

function readPrice(offers: any): number | undefined {
  const node = toArray(offers)[0];
  if (!node || typeof node !== 'object') return undefined;
  const p = toNum(node.price ?? node.lowPrice);
  return p;
}

function toNum(v: any): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
