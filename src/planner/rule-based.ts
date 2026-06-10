import type { EventRecord, Plan, PlanDay, PlanItem, PlanRequest } from '../types';
import { areaMatches } from '../util/normalize';

const ITEMS_PER_DAY: Record<NonNullable<PlanRequest['pace']>, number> = {
  relaxed: 2,
  normal: 3,
  packed: 4,
};

/** YYYY-MM-DD の連続日付を列挙（両端含む）。 */
export function enumerateDates(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('日付の形式が正しくありません (YYYY-MM-DD)');
  }
  if (end < start) throw new Error('endDate は startDate 以降にしてください');
  const dates: string[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  if (dates.length > 31) throw new Error('期間が長すぎます（最大31日）');
  return dates;
}

function eventDate(e: EventRecord): string | null {
  if (!e.start_at) return null;
  return e.start_at.slice(0, 10);
}

function eventTime(e: EventRecord): string | undefined {
  if (!e.start_at || e.start_at.length < 16) return undefined;
  // ISO の時刻部分 HH:MM を取り出す
  const m = e.start_at.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : undefined;
}

/** 条件に対するイベントのスコア（高いほど優先）。 */
export function scoreEvent(e: EventRecord, req: PlanRequest): number {
  let score = 1;
  const interests = (req.interests ?? []).map((i) => i.toLowerCase());
  const hay = [e.category, ...(e.tags ?? []), e.title, e.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const interest of interests) {
    if (interest && hay.includes(interest)) score += 3;
  }

  if (req.budget != null && e.price != null) {
    if (e.price <= req.budget) score += 1;
    else score -= 2;
  }
  if (e.price === 0) score += 0.5; // 無料は気軽に組み込める

  // 位置情報や説明が充実しているものを少し優遇
  if (e.lat != null && e.lng != null) score += 0.3;
  if (e.description) score += 0.2;

  return score;
}

interface Scored {
  e: EventRecord;
  score: number;
}

/**
 * ルールベースで日程プランを生成する純粋関数。
 * 日付が確定しているイベントはその日に、未確定（宿泊/スポット等）は
 * 自由枠として空きスロットに割り当てる。
 */
export function generateRulePlan(events: EventRecord[], req: PlanRequest): Plan {
  const dates = enumerateDates(req.startDate, req.endDate);
  const perDay = ITEMS_PER_DAY[req.pace ?? 'normal'];

  // エリア＆予算で大まかに絞り込み、スコア付け。宿泊施設は行程に入れない（宿泊先は別カード）。
  const candidates: Scored[] = events
    .filter((e) => areaMatches(e, req.area))
    .filter((e) => e.category !== '宿泊' && !/ホテル|旅館|ホステル|ゲストハウス|ペンション/.test(e.title ?? ''))
    .map((e) => ({ e, score: scoreEvent(e, req) }))
    .sort((a, b) => b.score - a.score);

  // 日付確定 / 未確定に振り分け
  const fixedByDate = new Map<string, Scored[]>();
  const flexible: Scored[] = [];
  const dateSet = new Set(dates);
  for (const c of candidates) {
    const d = eventDate(c.e);
    if (d && dateSet.has(d)) {
      const arr = fixedByDate.get(d) ?? [];
      arr.push(c);
      fixedByDate.set(d, arr);
    } else if (!d) {
      flexible.push(c);
    }
    // 期間外の日付確定イベントは除外
  }

  const used = new Set<string>();
  const days: PlanDay[] = [];
  let totalCost = 0;
  const highlights: string[] = [];

  for (const date of dates) {
    const items: PlanItem[] = [];
    const fixed = (fixedByDate.get(date) ?? []).filter((c) => !used.has(c.e.id));

    const pickInto = (pool: Scored[]) => {
      for (const c of pool) {
        if (items.length >= perDay) break;
        if (used.has(c.e.id)) continue;
        used.add(c.e.id);
        items.push(toItem(c.e));
        if (c.e.price) totalCost += c.e.price;
        if (highlights.length < 5 && c.score >= 4) highlights.push(c.e.title);
      }
    };

    pickInto(fixed); // まず日付確定を優先
    if (items.length < perDay) pickInto(flexible); // 残り枠は自由枠で埋める

    // 時刻があるものを先に、未定は後ろに
    items.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
    days.push({ date, items });
  }

  const totalItems = days.reduce((n, d) => n + d.items.length, 0);
  const summary =
    totalItems === 0
      ? `条件に合うイベントが見つかりませんでした。スクレイピングを実行するか、エリア/興味の条件をゆるめてみてください。`
      : `${req.area ? req.area + 'の' : ''}${dates.length}日間プラン。${totalItems}件の候補を${dates.length}日に配置しました。`;

  return {
    days,
    summary,
    totalEstimatedCost: totalCost,
    highlights,
    engine: 'rule',
  };
}

function toItem(e: EventRecord): PlanItem {
  return {
    time: eventTime(e),
    title: e.title,
    category: e.category ?? undefined,
    location: e.location_name ?? e.city ?? e.prefecture ?? undefined,
    url: e.url ?? undefined,
    price: e.price ?? undefined,
    why: e.category ? `${e.category}カテゴリ` : undefined,
  };
}
