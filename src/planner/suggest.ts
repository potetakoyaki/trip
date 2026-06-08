import type { Env } from '../types';
import { geminiEnabled, geminiGenerate } from './gemini';

export interface AreaSuggestion {
  area: string;
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
}

/**
 * 「おまかせモード」: 出発地・交通・予算・日数などの条件から、AIが行き先（市区町村）を
 * 3案提案する。各案に理由・見どころ・概算費用を付ける。Gemini優先→Workers AIフォールバック。
 */
export async function suggestAreas(env: Env, opts: SuggestOpts): Promise<AreaSuggestion[]> {
  const cond: string[] = [];
  if (opts.origin) cond.push(`出発地: ${opts.origin}`);
  if (opts.transport) cond.push(`移動手段: ${opts.transport}`);
  if (opts.budget) cond.push(`予算(1人の総額目安): ${opts.budget.toLocaleString()}円`);
  if (opts.days) cond.push(`日数: ${opts.days}日`);
  if (opts.adults) cond.push(`人数: ${opts.adults}人`);
  if (opts.companions) cond.push(`同行者: ${opts.companions}`);
  if (opts.vibe) cond.push(`志向: ${opts.vibe}`);
  if (opts.interests?.length) cond.push(`興味: ${opts.interests.join('、')}`);
  if (opts.keyword) cond.push(`やりたいこと: ${opts.keyword}`);

  const sys = 'あなたは日本国内旅行のプランナーです。条件に合う行き先を現実的に提案します。JSONのみ出力。';
  const user = [
    '次の条件に合う日本国内の旅行先を3つ提案してください。',
    '出発地からその交通手段・日数・予算で無理なく行ける範囲にし、毛色の違う多様な選択肢にすること。',
    '— 条件 —',
    ...(cond.length ? cond : ['（特に条件なし。定番から幅広く）']),
    '— 出力(JSON) —',
    '{"areas":[{"area":"都道府県+市区町村(例 山口県萩市)","reason":"なぜこの条件に合うか80字以内","highlights":["見どころ1","見どころ2","見どころ3"],"roughCost":1人の総額目安(円の数値)}]} を必ず3件。areaは実在する地名で、県名を必ず付ける。',
  ].join('\n');

  let text = '';
  if (geminiEnabled(env)) {
    try {
      text = await geminiGenerate(env, sys, user, { maxOutputTokens: 1200 });
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
      reason: a?.reason ? String(a.reason).slice(0, 120) : undefined,
      highlights: Array.isArray(a?.highlights) ? a.highlights.map((h: any) => String(h)).slice(0, 4) : undefined,
      roughCost: typeof a?.roughCost === 'number' && a.roughCost > 0 ? Math.round(a.roughCost) : undefined,
    }))
    .filter((a: AreaSuggestion) => a.area);
}
