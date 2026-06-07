import type { Env, EventRecord, Plan, PlanDay, PlanItem, PlanRequest } from '../types';
import { enumerateDates, generateRulePlan } from './rule-based';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const PER_DAY: Record<NonNullable<PlanRequest['pace']>, number> = { relaxed: 2, normal: 3, packed: 4 };

const SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    advice: { type: 'array', items: { type: 'string' } },
    travel: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        distance: { type: 'string' },
        duration: { type: 'string' },
        costRoundTrip: { type: 'number' },
        note: { type: 'string' },
      },
    },
    hotels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          area: { type: 'string' },
          nightlyPrice: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['name'],
      },
    },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                time: { type: 'string' },
                category: { type: 'string' },
                why: { type: 'string' },
                tips: { type: 'string' },
                access: { type: 'string' },
                duration: { type: 'string' },
                alt: { type: 'string' },
                estCost: { type: 'number' },
              },
              required: ['title', 'why', 'tips'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  required: ['theme', 'days'],
};

/**
 * Workers AI で「理由・楽しみ方・行き方・費用つき」の旅行プランを生成する。
 * 候補スポットから AI が選んで組み立て、出発地からの移動（目安）・ホテル候補・
 * 各スポットの目安費用を出し、予算（滞在費＋ホテル）と比較する内訳も作る。
 */
export async function generateAiPlan(
  env: Env,
  events: EventRecord[],
  req: PlanRequest,
  opts: { hotels?: import('../types').HotelOption[] } = {},
): Promise<Plan> {
  if (!env.AI || events.length === 0) return generateRulePlan(events, req);

  const dates = enumerateDates(req.startDate, req.endDate);
  const nights = Math.max(0, dates.length - 1);
  const perDay = PER_DAY[req.pace ?? 'normal'];

  const byTitle = new Map<string, EventRecord>();
  for (const e of events) if (!byTitle.has(e.title)) byTitle.set(e.title, e);
  const candidates = events.slice(0, 36).map((e) => ({
    title: e.title,
    category: e.category ?? undefined,
    area: e.city ?? e.prefecture ?? undefined,
    price: e.price ?? undefined,
    desc: e.description ? String(e.description).slice(0, 120) : undefined,
  }));

  const sys =
    'あなたは経験豊富な旅行コンシェルジュです。観光スポットは与えられた候補から選びます。ただし飲食店・カフェ、ホテル、移動・費用の目安は一般知識で補ってよいです。魅力的で現実的な旅行プランをJSONで作成し、各項目は具体的で実用的に書きます。費用はすべて1人あたりの円の目安です。';

  const cond: string[] = [];
  if (req.area) cond.push(`旅行先エリア: ${req.area}`);
  if (req.origin) cond.push(`出発地点: ${req.origin}`);
  if (req.transport) cond.push(`移動手段: ${req.transport}`);
  cond.push(`日程: ${dates.length}日間 / ${nights}泊（${dates[0]} 〜 ${dates[dates.length - 1]}）`);
  cond.push(`1日あたり ${perDay} 件程度`);
  if (req.interests?.length) cond.push(`興味: ${req.interests.join('、')}`);
  if (req.budget) cond.push(`予算(滞在費＋ホテル)の目安: 1人 ${req.budget.toLocaleString()}円`);
  if (req.weather === 'rainy') cond.push('天気: 雨（屋内・雨でも楽しめる場所を優先）');
  if (req.weather === 'sunny') cond.push('天気: 晴れ（屋外・景色を優先）');
  if (req.companions) cond.push(`同行者: ${req.companions}`);
  if (req.vibe) cond.push(`テーマの志向: ${req.vibe}`);
  if (req.keyword) cond.push(`重視キーワード: 「${req.keyword}」に関するスポット/イベントがあれば必ず入れて中心に据える`);

  const travelReq = req.origin
    ? `- travel: 「${req.origin}」から「${req.area ?? '旅行先'}」へ${req.transport ?? '公共交通機関'}で行く場合の目安。mode(手段), distance(距離の目安 例"80km"), duration(片道の所要 例"約90分"), costRoundTrip(往復の目安・円の数値), note(具体的な経路・乗換・路線/高速道路名など)。`
    : '- travel: 出発地が未指定なので省略可。';

  const user = [
    '次の条件と候補から、費用と移動つきの旅行プランを作ってください。',
    '— 条件 —',
    ...cond,
    '— 候補スポット（観光/グルメ等。titleは候補と完全一致で使う） —',
    JSON.stringify(candidates, null, 0),
    '— 出力要件（1人あたり・円。自然な文章で具体的に） —',
    '- theme: 全体のキャッチーなテーマ',
    '- advice: 旅行を楽しむコツを4〜5個',
    travelReq,
    `- hotels: 「${req.area ?? '旅行先'}」の宿泊先を2〜3件（候補に宿泊系があれば優先、無ければ定番を一般知識で）。各 name, area, nightlyPrice(1泊1人の目安・円の数値), why(おすすめ理由)。`,
    '- days[].theme: その日のねらい',
    '- days[].items[]: title(候補と一致), time(例"10:00"), category,',
    '   why(おすすめ理由を80〜140字), tips(楽しみ方を80〜140字。名物/回り方/ベスト時間帯),',
    '   access(行き方を一言), duration(滞在目安), alt(代替案), estCost(その場所の目安費用・円の数値。入場料や飲食代。無料は0)。',
    '- 各日に必ず昼食(ランチ)を1件入れる。夜まで滞在する日は夕食も。食事のitemは category="グルメ" とし、tips に名物料理・おすすめメニュー・予算感を具体的に書く（estCostに目安）。',
    '  候補に飲食店が少なければ、そのエリアで評判の料理ジャンルや店を一般知識で提案してよい。',
    '- 観光スポットは候補から選び、同じ場所を重複させない。JSONのみ出力。',
  ].join('\n');

  try {
    const res = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    })) as { response?: unknown };

    const parsed = coerce(res?.response);
    if (!parsed || !Array.isArray(parsed.days)) throw new Error('AI応答を解釈できませんでした');

    const used = new Set<string>();
    let food = 0;
    let activities = 0;
    const days: PlanDay[] = dates.map((date, i) => {
      const aiDay = parsed.days[i] ?? {};
      const rawItems: any[] = Array.isArray(aiDay.items) ? aiDay.items : [];
      const items: PlanItem[] = [];
      for (const it of rawItems.slice(0, perDay + 1)) {
        const title = String(it?.title ?? '').trim();
        if (!title || used.has(title)) continue;
        used.add(title);
        const rec = matchRecord(byTitle, title);
        const category = rec?.category ?? cleanStr(it?.category);
        const cost = rec?.price ?? cleanNum(it?.estCost) ?? 0;
        if (category === 'グルメ') food += cost;
        else activities += cost;
        items.push({
          title,
          time: cleanStr(it?.time),
          category,
          location: rec?.location_name ?? rec?.city ?? rec?.prefecture ?? undefined,
          url: rec?.url ?? undefined,
          price: rec?.price ?? undefined,
          why: cleanStr(it?.why),
          tips: cleanStr(it?.tips),
          access: cleanStr(it?.access),
          duration: cleanStr(it?.duration),
          alt: cleanStr(it?.alt),
          estCost: cleanNum(it?.estCost),
        });
      }
      items.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
      return { date, items, theme: cleanStr(aiDay.theme) };
    });

    const totalItems = days.reduce((n, d) => n + d.items.length, 0);
    if (totalItems === 0) throw new Error('AIが候補を配置できませんでした');

    // ホテル: 実在データ（楽天等）があれば優先、無ければ AI 概算
    const aiHotels = Array.isArray(parsed.hotels)
      ? parsed.hotels
          .filter((h: any) => h && typeof h.name === 'string')
          .slice(0, 3)
          .map((h: any) => ({
            name: String(h.name),
            area: cleanStr(h.area),
            nightlyPrice: cleanNum(h.nightlyPrice),
            why: cleanStr(h.why),
          }))
      : [];
    const hotels = opts.hotels && opts.hotels.length ? opts.hotels : aiHotels;

    // 移動
    let travel = undefined;
    if (req.origin && parsed.travel && typeof parsed.travel === 'object') {
      travel = {
        from: req.origin,
        to: req.area,
        mode: cleanStr(parsed.travel.mode) ?? req.transport,
        distance: cleanStr(parsed.travel.distance),
        duration: cleanStr(parsed.travel.duration),
        costRoundTrip: cleanNum(parsed.travel.costRoundTrip),
        note: cleanStr(parsed.travel.note),
      };
    }

    // 費用内訳（1人あたり）
    const hotelNightly = hotels[0]?.nightlyPrice ?? 0;
    const hotelTotal = hotelNightly * nights;
    const stayTotal = hotelTotal + food + activities;
    const transport = travel?.costRoundTrip ?? 0;
    const grandTotal = stayTotal + transport;
    const costBreakdown = {
      nights,
      hotel: hotelTotal,
      food,
      activities,
      stayTotal,
      transport,
      grandTotal,
      budget: req.budget,
      withinBudget: req.budget != null ? stayTotal <= req.budget : undefined,
    };

    const highlights = days.flatMap((d) => d.items).slice(0, 5).map((it) => it.title);
    const advice = Array.isArray(parsed.advice)
      ? parsed.advice.map((a: unknown) => String(a)).filter(Boolean).slice(0, 6)
      : [];

    return {
      theme: cleanStr(parsed.theme),
      days,
      summary: cleanStr(parsed.theme) ?? `${req.area ?? ''}の${dates.length}日間プラン`,
      totalEstimatedCost: grandTotal,
      highlights,
      advice,
      travel,
      hotels,
      costBreakdown,
      engine: 'ai',
    };
  } catch {
    return generateRulePlan(events, req);
  }
}

function matchRecord(byTitle: Map<string, EventRecord>, title: string): EventRecord | undefined {
  if (byTitle.has(title)) return byTitle.get(title);
  for (const [t, rec] of byTitle) {
    if (t.includes(title) || title.includes(t)) return rec;
  }
  return undefined;
}

function cleanStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function cleanNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }
  return undefined;
}

/** JSONモードはオブジェクトを返すが、文字列で返る場合にも対応。 */
function coerce(r: unknown): any {
  if (r && typeof r === 'object') return r;
  if (typeof r === 'string') {
    const start = r.indexOf('{');
    const end = r.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(r.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
