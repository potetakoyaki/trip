import type { Env } from '../types';
import { geminiEnabled, geminiGenerate } from './gemini';

export interface AreaSuggestion {
  area: string;
  /** その案ならではの独自の切り口・その時期のイベント/旬を一言で。 */
  hook?: string;
  reason?: string;
  highlights?: string[];
  roughCost?: number;
}

export interface SuggestOpts {
  origin?: string;
  transport?: string;
  budget?: number;
  days?: number;
  companions?: string;
  vibe?: string;
  interests?: string[];
  adults?: number;
  keyword?: string;
  /** 片道の移動時間の上限（時間）。出発地から行ける範囲を絞る。 */
  maxHours?: number;
  /** 旅行開始日 YYYY-MM-DD（時期・季節のイベント/旬を考慮するため）。 */
  startDate?: string;
  /** 既に提案済みで、今回は避けたい行き先（「再考」で別案を出すため）。 */
  exclude?: string[];
  /** 旅のテーマ/方向性（例「温泉でとことん癒やし旅」）。これに強く合う行き先・体験にする。 */
  concept?: string;
}

/** 旅の方向性・テーマ（場所ではなく「どんな旅にするか」）。おまかせの1段目で提案する。 */
export interface PlanConcept {
  title: string;
  emoji?: string;
  description?: string;
}

const SEASON = ['冬', '冬', '春', '春', '春', '初夏', '夏', '夏', '初秋', '秋', '秋', '冬'];

/**
 * 「おまかせモード」: 条件からAIが行き先を3案提案する。
 * ありきたりな教科書的提案を避け、各案に独自の切り口（穴場/その時期の旬・イベント/テーマ体験）を持たせる。
 */
export async function suggestAreas(env: Env, opts: SuggestOpts): Promise<AreaSuggestion[]> {
  const cond: string[] = [];
  if (opts.origin) cond.push(`出発地: ${opts.origin}`);
  if (opts.transport) cond.push(`移動手段: ${opts.transport}`);
  if (opts.maxHours && opts.origin) {
    cond.push(`移動の上限: 出発地から${opts.transport || '公共交通'}で片道${opts.maxHours}時間以内で行ける範囲だけ`);
  }
  if (opts.budget) cond.push(`予算(1人の総額目安): ${opts.budget.toLocaleString()}円`);
  if (opts.days) cond.push(`日数: ${opts.days}日`);
  if (opts.startDate) {
    const m = Number(opts.startDate.slice(5, 7));
    if (m >= 1 && m <= 12) cond.push(`旅行時期: ${m}月（${SEASON[m - 1]}）。この時期の祭り・花火・紅葉・旬の味覚など“今だけ”の要素を重視`);
  }
  if (opts.adults) cond.push(`人数: ${opts.adults}人`);
  if (opts.companions) cond.push(`同行者: ${opts.companions}`);
  if (opts.vibe) cond.push(`志向: ${opts.vibe}`);
  if (opts.interests?.length) cond.push(`興味: ${opts.interests.join('、')}`);
  if (opts.keyword) cond.push(`やりたいこと: ${opts.keyword}`);
  if (opts.concept) cond.push(`旅のテーマ: 「${opts.concept}」。この雰囲気・過ごし方に強く合う行き先・体験にする（最重要）`);
  const excluded = (opts.exclude || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  if (excluded.length) {
    cond.push(`既出につき除外（別の行き先・別エリアにする）: ${excluded.join('、')}`);
  }

  const sys =
    'あなたは旅のプロのコンシェルジュです。誰でも思いつく教科書的な提案を嫌い、各案に明確な「独自の切り口」を持たせます。JSONのみ出力。';
  const user = [
    '次の条件に合う日本国内の旅行先を3案、提案してください。',
    '【最重要】3案は毛色を大きく変えること。例: ①王道を一捻りした穴場 ②“その時期ならでは”の祭り/花火/紅葉/旬の味覚が楽しめる所 ③テーマ特化の体験型（工房/離島/レトロ温泉街/ローカル線 等）。',
    '京都市・奈良市・神戸市のような「誰もが真っ先に挙げる超定番ど真ん中」は避ける（どうしても出すなら、定番とは違う独自の切り口を必ず添える）。',
    '各案に hook（「なぜ“今ここ”なのか」の独自の魅力＝その時期のイベント・旬・体験を一言で）を必ず付ける。実在する地名のみ。',
    '— 条件 —',
    ...(cond.length ? cond : ['（特に条件なし。ただし無難すぎない、ひねりのある提案にする）']),
    '— 出力(JSON) —',
    '{"areas":[{"area":"都道府県+市区町村(例 富山県氷見市)","hook":"独自の切り口・その時期のイベント/旬を一言","reason":"条件に合う理由80字以内","highlights":["見どころ1","見どころ2","見どころ3"],"roughCost":1人の総額目安(円の数値)}]} を必ず3件。areaは県名を必ず付ける。',
  ].join('\n');

  let text = '';
  // 「再考」（除外あり）のときは温度を上げて、前回と毛色の違う案が出やすくする。
  const temperature = excluded.length ? 1.0 : 0.7;
  if (geminiEnabled(env)) {
    try {
      text = await geminiGenerate(env, sys, user, { maxOutputTokens: 1200, temperature });
    } catch {
      /* Workers AI へ */
    }
  }
  if (!text && env.AI) {
    try {
      const r = (await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        max_tokens: 1200,
      })) as { response?: unknown };
      text = typeof r?.response === 'string' ? r.response : JSON.stringify(r?.response ?? '');
    } catch {
      /* 失敗 */
    }
  }
  if (!text.trim()) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        parsed = JSON.parse(text.slice(s, e + 1));
      } catch {
        /* 解釈不能 */
      }
    }
  }
  const arr = Array.isArray(parsed?.areas) ? parsed.areas : Array.isArray(parsed) ? parsed : [];
  return arr
    .slice(0, 3)
    .map((a: any) => ({
      area: String(a?.area ?? '').trim(),
      hook: a?.hook ? String(a.hook).slice(0, 100) : undefined,
      reason: a?.reason ? String(a.reason).slice(0, 120) : undefined,
      highlights: Array.isArray(a?.highlights) ? a.highlights.map((h: any) => String(h)).slice(0, 4) : undefined,
      roughCost: typeof a?.roughCost === 'number' && a.roughCost > 0 ? Math.round(a.roughCost) : undefined,
    }))
    .filter((a: AreaSuggestion) => a.area);
}

/** AIにテキストを生成させる（Gemini優先→Workers AI）。失敗時は空文字。 */
async function runSuggestModel(env: Env, sys: string, user: string, temperature: number): Promise<string> {
  let text = '';
  if (geminiEnabled(env)) {
    try {
      text = await geminiGenerate(env, sys, user, { maxOutputTokens: 1000, temperature });
    } catch {
      /* Workers AI へ */
    }
  }
  if (!text && env.AI) {
    try {
      const r = (await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        max_tokens: 1000,
      })) as { response?: unknown };
      text = typeof r?.response === 'string' ? r.response : JSON.stringify(r?.response ?? '');
    } catch {
      /* 失敗 */
    }
  }
  return text;
}

function parseJsonLoose(text: string): any {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        /* 解釈不能 */
      }
    }
  }
  return null;
}

/**
 * 「おまかせ」1段目: 条件から「旅の方向性（テーマ・過ごし方）」を4案提案する。
 * 具体的な地名は挙げず、どんな雰囲気でどう過ごすか（癒やし/アクティブ/グルメ/文化体験 等）を提案する。
 * ユーザーが選んだテーマを suggestAreas の concept に渡すと、それに合う行き先を出せる。
 */
export async function suggestConcepts(env: Env, opts: SuggestOpts): Promise<PlanConcept[]> {
  const cond: string[] = [];
  if (opts.origin) cond.push(`出発地: ${opts.origin}`);
  if (opts.days) cond.push(`日数: ${opts.days}日`);
  if (opts.startDate) {
    const m = Number(opts.startDate.slice(5, 7));
    if (m >= 1 && m <= 12) cond.push(`旅行時期: ${m}月（${SEASON[m - 1]}）。この時期ならではの過ごし方も意識`);
  }
  if (opts.adults) cond.push(`人数: ${opts.adults}人`);
  if (opts.companions) cond.push(`同行者: ${opts.companions}`);
  if (opts.vibe) cond.push(`気分: ${opts.vibe}`);
  if (opts.interests?.length) cond.push(`興味: ${opts.interests.join('、')}`);
  if (opts.keyword) cond.push(`やりたいこと: ${opts.keyword}`);
  if (opts.budget) cond.push(`予算(1人の総額目安): ${opts.budget.toLocaleString()}円`);
  const excluded = (opts.exclude || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  if (excluded.length) cond.push(`既出につき除外（別の毛色のテーマにする）: ${excluded.join('、')}`);

  const sys =
    'あなたは旅のコンシェルジュです。具体的な地名・施設名は一切挙げず、「どんな旅にするか」の方向性・テーマ・過ごし方だけを、ワクワクする言葉で提案します。JSONのみ出力。';
  const user = [
    '次の条件に合う「旅の方向性（テーマ・過ごし方）」を4案、提案してください。',
    '【最重要】具体的な地名・施設名は絶対に出さない。あくまで“どんな雰囲気で、どう過ごすか”のテーマ。',
    '4案は毛色を大きく変える（例: のんびり癒やし系 / 体を動かすアクティブ系 / 食べ歩きグルメ系 / 歴史文化・体験系）。',
    '各案に、ひと目で伝わる短いタイトル(15字以内)・絵文字1つ・一言の説明(40字以内)を付ける。',
    '— 条件 —',
    ...(cond.length ? cond : ['（特に条件なし。幅広い気分に応えるバラエティ豊かな4案を）']),
    '— 出力(JSON) —',
    '{"concepts":[{"emoji":"♨️","title":"温泉でとことん癒やし旅","description":"名湯にゆっくり浸かり、何もしない贅沢を味わう"}]} を必ず4件。',
  ].join('\n');

  const text = await runSuggestModel(env, sys, user, excluded.length ? 1.0 : 0.8);
  const parsed = parseJsonLoose(text);
  const arr = Array.isArray(parsed?.concepts) ? parsed.concepts : Array.isArray(parsed) ? parsed : [];
  return arr
    .slice(0, 4)
    .map((c: any) => ({
      title: String(c?.title ?? '').trim().slice(0, 40),
      emoji: c?.emoji ? String(c.emoji).slice(0, 4) : undefined,
      description: c?.description ? String(c.description).slice(0, 80) : undefined,
    }))
    .filter((c: PlanConcept) => c.title);
}
