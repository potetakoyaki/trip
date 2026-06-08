import type { Env, EventRecord, Plan, PlanDay, PlanItem, PlanRequest } from '../types';
import { enumerateDates, generateRulePlan } from './rule-based';

// じっくりモード用の高性能モデル。
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// 通常（デフォルト）の軽量モデル（Neuron消費が小さい）。
const ECO_MODEL = '@cf/meta/llama-3.1-8b-instruct';
/** 診断（/api/diag/ai）で疎通確認するモデル一覧（軽量→高性能の順）。 */
export const AI_MODELS = [ECO_MODEL, MODEL];
const PER_DAY: Record<NonNullable<PlanRequest['pace']>, number> = { relaxed: 2, normal: 3, packed: 4 };

/** AIの無料枠（トークン/ニューロン）切れ・利用上限を表すエラー。これはフォールバックせず上位へ伝える。 */
export class AiQuotaError extends Error {
  constructor() {
    super(
      'AIが利用できませんでした（本日の無料利用枠の上限に達したか、混雑の可能性があります）。日付が変わると枠は回復します。時間をおいて再度お試しください。じっくりモードをオフにすると消費を抑えられます。',
    );
    this.name = 'AiQuotaError';
  }
}

function aiErrText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '');
}

/**
 * AI呼び出しのエラー種別を見分ける。
 * - 'quota': 本当の無料枠切れ・クレジット切れ・1日の上限（別モデルでも回復しない）。
 * - 'busy' : 一時的な混雑・容量超過・レート制限・ルーティング/5xx（再試行で回復しうる。アカウント枠とは無関係）。
 * - 'other': その他（パラメータ非対応など。別モデルでの再試行に価値あり）。
 *
 * ※以前は 'capacity'（容量超過）や 3040（モデル不達）まで枠切れ扱いにしていたため、
 *   使用ニューロンが0でも「枠の上限に達した」と誤表示していた。ここで明確に分離する。
 */
function classifyAiError(e: unknown): 'quota' | 'busy' | 'other' {
  const msg = aiErrText(e).toLowerCase();
  if (/neuron|quota|out of credit|insufficient|daily limit|limit reached|allocation/.test(msg)) {
    return 'quota';
  }
  if (/capacity|overload|temporar|unavailable|no route|too many requests|\b429\b|rate.?limit|\b50[0234]\b|\b3040\b|try again/.test(msg)) {
    return 'busy';
  }
  return 'other';
}

const SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    rationale: { type: 'string' },
    enjoyment: { type: 'string' },
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
                hours: { type: 'string' },
                lat: { type: 'number' },
                lng: { type: 'number' },
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
  const baseCands = events.slice(0, 36).map((e) => ({
    title: e.title,
    category: e.category ?? undefined,
    area: e.city ?? e.prefecture ?? undefined,
    price: e.price ?? undefined,
    desc: e.description ? String(e.description).slice(0, 120) : undefined,
  }));
  // 「行きたい」スポット（必ず含める）を候補に足す。
  const mustInclude = (req.mustInclude ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  const have = new Set(baseCands.map((c) => c.title));
  const mustCands = mustInclude
    .filter((t) => !have.has(t))
    .map((title) => ({ title, category: undefined, area: req.area, price: undefined, desc: '行きたいスポット（必ず含める）' }));
  const candidates = [...mustCands, ...baseCands];

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
  if (mustInclude.length)
    cond.push(`必ず含める「行きたい」スポット: ${mustInclude.join('、')}（各日のどこかに必ず全て組み込む）`);
  if (req.refine) cond.push(`ユーザーからの追加リクエスト（最優先で反映する）: 「${req.refine}」`);

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
    '- rationale: なぜこのスポットの組み合わせ・この順番にしたのかという「選定理由」を150〜250字で。何を軸に選び、どんな体験の流れを意図したかを語る。',
    '- enjoyment: このプラン全体をどう楽しむか「楽しみ方の提案」を150〜250字で。五感・季節・時間帯・組み合わせの妙など具体的に。',
    '- advice: 旅行を楽しむコツ・上手く回るコツを4〜5個',
    travelReq,
    `- hotels: 「${req.area ?? '旅行先'}」の宿泊先を2〜3件（候補に宿泊系があれば優先、無ければ定番を一般知識で）。各 name, area, nightlyPrice(1泊1人の目安・円の数値), why(おすすめ理由)。`,
    '- days[].theme: その日のねらい',
    '- days[].items[]: title(候補と一致), time(例"10:00"), category,',
    '   why(おすすめ理由を80〜140字), tips(楽しみ方を80〜140字。名物/回り方/ベスト時間帯),',
    '   access(行き方を一言), duration(滞在目安), alt(代替案), estCost(その場所の目安費用・円の数値。入場料や飲食代。無料は0),',
    '   hours(営業時間。一般知識でおおよそで良いので必ず入れる。例 "9:00-17:00"。24時間営業は "24時間"、店舗で不明確なら "11:00-22:00頃"),',
    '   lat,lng(その場所のおおよその緯度・経度の数値。地図表示とスポット間の移動時間の概算に使うので必ず入れる)。',
    '- 各日に必ず昼食(ランチ)を1件入れる。夜まで滞在する日は夕食も。食事のitemは category="グルメ" とし、tips に名物料理・おすすめメニュー・予算感を具体的に書く（estCostに目安）。',
    '  候補に飲食店が少なければ、そのエリアで評判の料理ジャンルや店を一般知識で提案してよい。',
    '- 観光スポットは候補から選び、同じ場所を重複させない。',
    '- 各日の項目は移動効率が良い順（地理的に近い場所が連続するよう）に並べ、time もその順で矛盾なく付ける。JSONのみ出力。',
  ].join('\n');

  // じっくりモードでは高性能モデルを使う。通常は軽量モデルでNeuron消費を抑える。
  const primary = req.thorough ? MODEL : ECO_MODEL;
  const fallback = primary === MODEL ? ECO_MODEL : MODEL;

  const ai = env.AI; // 上の guard で defined。nested closure 内でも参照できるよう束ねる。
  const runModel = async (m: string): Promise<{ response?: unknown }> =>
    (await ai.run(m, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      max_tokens: 3000,
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    })) as { response?: unknown };

  let res: { response?: unknown };
  try {
    res = await runModel(primary);
  } catch (e) {
    const kind = classifyAiError(e);
    // 本当の枠切れ・上限は別モデルでも回復しないので、弱いルールベースに退避せず即エラー。
    if (kind === 'quota') throw new AiQuotaError();
    // 混雑・モデル固有のエラーは、もう一方のモデルで一度だけ再試行する
    // （例: 軽量モデルが応答できない/構造化出力に未対応でも高性能モデルなら通る）。
    try {
      res = await runModel(fallback);
    } catch (e2) {
      const kind2 = classifyAiError(e2);
      if (kind2 === 'quota') throw new AiQuotaError();
      if (kind2 === 'busy') {
        throw new Error(
          'AIが混雑しているようです（一時的な容量超過の可能性で、無料枠の消費とは別です）。少し待ってから再度お試しください。詳細: ' +
            aiErrText(e2),
        );
      }
      // 原因を隠さず、本当のエラー内容を添えて上位（ジョブ）へ返す。
      throw new Error(
        'AIでのプラン生成に失敗しました（時間をおいて再度お試しください）。詳細: ' + aiErrText(e2),
      );
    }
  }

  try {
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
          hours: rec?.hours ?? cleanStr(it?.hours),
          lat: rec?.lat ?? cleanCoord(it?.lat),
          lng: rec?.lng ?? cleanCoord(it?.lng),
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
      rationale: cleanStr(parsed.rationale),
      enjoyment: cleanStr(parsed.enjoyment),
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

/** 緯度経度（小数・負値あり）。移動時間の概算に使うのでそのまま保持する。 */
function cleanCoord(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) return n;
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
