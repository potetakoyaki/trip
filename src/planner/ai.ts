import type { Env, EventRecord, Plan, PlanRequest } from '../types';
import { enumerateDates, generateRulePlan } from './rule-based';

// Workers AI の無料枠で使える軽量モデル。
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

/**
 * Workers AI で日程プランを生成する。失敗時はルールベースにフォールバック。
 * env.AI バインディングが無ければ最初からルールベースを返す。
 */
export async function generateAiPlan(
  env: Env,
  events: EventRecord[],
  req: PlanRequest,
): Promise<Plan> {
  if (!env.AI) return generateRulePlan(events, req);

  const dates = enumerateDates(req.startDate, req.endDate);
  // プロンプトに渡す候補は数を絞る（トークン節約）
  const shortlist = events.slice(0, 40).map((e) => ({
    title: e.title,
    category: e.category,
    date: e.start_at?.slice(0, 10) ?? null,
    location: e.location_name ?? e.city ?? e.prefecture ?? null,
    price: e.price ?? null,
    url: e.url ?? null,
  }));

  const sys =
    'あなたは旅行プランナーです。与えられた候補イベントのみを使い、日程ごとの現実的な旅行プランをJSONで作成します。候補に無い場所を創作してはいけません。';
  const user = JSON.stringify({
    指示: '次の条件と候補から、各日2〜4件で日程プランを作成してください。',
    条件: {
      エリア: req.area ?? null,
      日付: dates,
      興味: req.interests ?? [],
      予算: req.budget ?? null,
      ペース: req.pace ?? 'normal',
    },
    候補: shortlist,
    出力形式: {
      summary: 'string',
      highlights: ['string'],
      days: [{ date: 'YYYY-MM-DD', items: [{ time: 'HH:MM?', title: 'string', category: 'string?', location: 'string?', url: 'string?', price: 0, why: 'string?' }] }],
    },
  });

  try {
    const res = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    })) as { response?: string };

    const text = res?.response ?? '';
    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.days)) throw new Error('AI 応答を解析できませんでした');

    const total = (parsed.days as Array<{ items?: Array<{ price?: number }> }>)
      .flatMap((d) => d.items ?? [])
      .reduce((sum, it) => sum + (typeof it.price === 'number' ? it.price : 0), 0);

    return {
      days: parsed.days,
      summary: parsed.summary ?? 'AI が作成したプランです。',
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      totalEstimatedCost: total,
      engine: 'ai',
    };
  } catch {
    // どんな失敗でも体験を止めないよう、ルールベースに退避
    return generateRulePlan(events, req);
  }
}

function extractJson(text: string): any | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
