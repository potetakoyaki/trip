import type { Env } from '../types';
import { geminiEnabled, geminiGenerate } from './gemini';

export interface PackingGroup {
  title: string;
  items: string[];
}

export interface PackingOpts {
  area?: string;
  days?: number;
  month?: number;
  weather?: string;
  companions?: string;
  adults?: number;
  activities?: string[];
}

const SEASON = ['冬', '冬', '春', '春', '春', '初夏', '夏', '夏', '初秋', '秋', '秋', '冬'];

/** 旅行条件（行き先・季節・日数・天気・アクティビティ）から持ち物リストをAIが生成する。 */
export async function generatePacking(env: Env, opts: PackingOpts): Promise<PackingGroup[]> {
  const cond: string[] = [];
  if (opts.area) cond.push(`行き先: ${opts.area}`);
  if (opts.days) cond.push(`日数: ${opts.days}日`);
  if (opts.month && opts.month >= 1 && opts.month <= 12) cond.push(`時期: ${opts.month}月（${SEASON[opts.month - 1]}）`);
  if (opts.weather) cond.push(`天気傾向: ${opts.weather}`);
  if (opts.companions) cond.push(`同行者: ${opts.companions}`);
  if (opts.adults) cond.push(`人数: ${opts.adults}人`);
  if (opts.activities?.length) cond.push(`予定の内容: ${opts.activities.slice(0, 12).join('、')}`);

  const sys = '旅行の持ち物リストを作るアシスタントです。季節・天気・日数・予定に合わせ、過不足のない実用的なリストをJSONで返します。';
  const user = [
    '次の旅行の持ち物リストを、カテゴリ別に作ってください。季節・天気・日数・予定の内容に合わせ、抜け漏れなく現実的に。',
    '— 条件 —',
    ...(cond.length ? cond : ['（一般的な国内1〜2泊旅行）']),
    '— 出力(JSON) —',
    '{"groups":[{"title":"カテゴリ名(例: 必需品 / 服装 / 季節・天気対策 / 予定に合わせて / あると便利)","items":["持ち物1","持ち物2"]}]} を5カテゴリ前後。各itemsは3〜8個。簡潔な名詞で。',
  ].join('\n');

  let text = '';
  if (geminiEnabled(env)) {
    try {
      text = await geminiGenerate(env, sys, user, { maxOutputTokens: 1100 });
    } catch {
      /* Workers AI へ */
    }
  }
  if (!text && env.AI) {
    try {
      const r = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        max_tokens: 1100,
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
  const arr = Array.isArray(parsed?.groups) ? parsed.groups : [];
  return arr
    .slice(0, 7)
    .map((g: any) => ({
      title: String(g?.title ?? '').slice(0, 30),
      items: Array.isArray(g?.items)
        ? g.items.map((i: any) => String(i).trim().slice(0, 40)).filter(Boolean).slice(0, 10)
        : [],
    }))
    .filter((g: PackingGroup) => g.title && g.items.length);
}
