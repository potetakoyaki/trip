import type { Env, EventRecord, Plan, PlanDay, PlanItem, PlanRequest } from '../types';
import { enumerateDates, generateRulePlan } from './rule-based';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const PER_DAY: Record<NonNullable<PlanRequest['pace']>, number> = { relaxed: 2, normal: 3, packed: 4 };

const SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    advice: { type: 'array', items: { type: 'string' } },
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
 * Workers AI で「理由・楽しみ方つき」の日程プランを生成する。
 * 候補スポットの中から AI が選んで組み立て、各スポットに提案理由・楽しみ方・
 * 滞在目安・代替案を付ける。天気/同行者/テーマの条件も反映する。
 * 失敗時・AI 不在時はルールベースにフォールバック。
 */
export async function generateAiPlan(env: Env, events: EventRecord[], req: PlanRequest): Promise<Plan> {
  if (!env.AI || events.length === 0) return generateRulePlan(events, req);

  const dates = enumerateDates(req.startDate, req.endDate);
  const perDay = PER_DAY[req.pace ?? 'normal'];

  // 候補（タイトルで後から実データに突き合わせる）
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
    'あなたは経験豊富な旅行コンシェルジュです。与えられた候補スポットだけを使って、魅力的で現実的な旅行プランをJSONで作成します。候補に無い場所を創作してはいけません。各スポットには「なぜおすすめか(why)」と「楽しみ方のコツ(tips)」を、ありきたりでなく具体的に書きます。';

  const cond: string[] = [];
  if (req.area) cond.push(`エリア: ${req.area}`);
  cond.push(`日程: ${dates.length}日間（${dates[0]} 〜 ${dates[dates.length - 1]}）`);
  cond.push(`1日あたり ${perDay} 件程度`);
  if (req.interests?.length) cond.push(`興味: ${req.interests.join('、')}`);
  if (req.budget) cond.push(`予算の目安: 1人 ${req.budget.toLocaleString()}円`);
  if (req.weather === 'rainy') cond.push('天気: 雨（屋内・雨でも楽しめる場所を優先し、各スポットに雨天時の楽しみ方を)');
  if (req.weather === 'sunny') cond.push('天気: 晴れ（屋外・景色を楽しめる場所を優先）');
  if (req.companions) cond.push(`同行者: ${req.companions}（その層に合った提案・楽しみ方に）`);
  if (req.vibe) cond.push(`テーマの志向: ${req.vibe}`);

  const user = [
    '次の条件と候補から、日程ごとの旅行プランを作ってください。',
    '— 条件 —',
    ...cond,
    '— 候補スポット（この中からのみ選ぶ。titleは候補のものを完全一致で使う） —',
    JSON.stringify(candidates, null, 0),
    '— 出力要件（具体的に・自然な文章で） —',
    '- theme: このプラン全体のキャッチーなテーマ（例「芦ノ湖と温泉でめぐる箱根満喫2日間」）',
    '- advice: 旅行全体を楽しむコツを4〜5個（移動手段・服装・時間帯・予約・持ち物など実用的に）',
    '- days[].theme: その日のねらいを一言',
    '- days[].items[] 各フィールド:',
    '   title(候補と完全一致), time(目安の時刻 例"10:00"), category,',
    '   why: なぜおすすめかを80〜140字の自然な文章で。何が見どころで、どんな人・気分に向くかまで具体的に。',
    '   tips: 楽しみ方を80〜140字で具体的に。回り方・名物や食べるべき物・写真スポット・ベストな時間帯など。',
    '   access: 行き方を一言（最寄り駅/バス停・そこからの所要や手段。例「箱根登山バスで〇分」）。',
    '   duration: 滞在の目安（例"1.5時間"）。 alt: 雨天や時間が無い時の代替案。',
    '- 各日、可能ならランチまたはカフェ（グルメ/宿泊カテゴリや飲食系の候補）を1件は組み込む。',
    '同じ場所を複数日で重複させない。候補に無い場所は作らない。JSONのみ出力。',
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
    let totalCost = 0;
    const days: PlanDay[] = dates.map((date, i) => {
      const aiDay = parsed.days[i] ?? {};
      const rawItems: any[] = Array.isArray(aiDay.items) ? aiDay.items : [];
      const items: PlanItem[] = [];
      for (const it of rawItems.slice(0, perDay + 1)) {
        const title = String(it?.title ?? '').trim();
        if (!title || used.has(title)) continue;
        used.add(title);
        const rec = matchRecord(byTitle, title);
        if (rec?.price != null) totalCost += rec.price;
        items.push({
          title,
          time: cleanStr(it?.time),
          category: rec?.category ?? cleanStr(it?.category),
          location: rec?.location_name ?? rec?.city ?? rec?.prefecture ?? undefined,
          url: rec?.url ?? undefined,
          price: rec?.price ?? undefined,
          why: cleanStr(it?.why),
          tips: cleanStr(it?.tips),
          access: cleanStr(it?.access),
          duration: cleanStr(it?.duration),
          alt: cleanStr(it?.alt),
        });
      }
      items.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
      return { date, items, theme: cleanStr(aiDay.theme) };
    });

    const totalItems = days.reduce((n, d) => n + d.items.length, 0);
    if (totalItems === 0) throw new Error('AIが候補を配置できませんでした');

    const highlights = days.flatMap((d) => d.items).slice(0, 5).map((it) => it.title);
    const advice = Array.isArray(parsed.advice)
      ? parsed.advice.map((a: unknown) => String(a)).filter(Boolean).slice(0, 6)
      : [];

    return {
      theme: cleanStr(parsed.theme),
      days,
      summary: cleanStr(parsed.theme) ?? `${req.area ?? ''}の${dates.length}日間プラン`,
      totalEstimatedCost: totalCost,
      highlights,
      advice,
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
