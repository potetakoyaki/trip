import type { Env } from '../types';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface Spot {
  title?: string;
  category?: string;
  prefecture?: string;
  city?: string;
  description?: string;
}

/**
 * 文章（ブログ本文・百科事典記事など）から旅行スポットを抽出する。
 * Workers AI を使う。env.AI が無ければ空配列。
 */
export async function extractSpots(
  env: Env,
  text: string,
  hint: { area?: string; interests?: string[] } = {},
): Promise<Spot[]> {
  if (!env.AI || !text.trim()) return [];

  const sys =
    'あなたは旅行情報の抽出器です。与えられた文章から、旅行で実際に訪れる価値のあるスポット・店・名所・施設・イベントを抽出し、JSON配列のみで返します。文章に書かれていない情報は創作しません。地名そのもの（県名・市名）や抽象的な概念は除外し、具体的な訪問先だけを挙げます。';

  const hintLines: string[] = [];
  if (hint.area) hintLines.push(`対象エリア: ${hint.area}`);
  if (hint.interests?.length) hintLines.push(`特に次の興味に関連するものを優先: ${hint.interests.join('、')}`);

  const user = [
    '次の文章から、最大10件の訪問先を抽出してください。',
    ...hintLines,
    '各要素: {"title": 名称, "category": グルメ|自然|歴史|アート|音楽|体験|宿泊|祭り|観光 のいずれか, "prefecture": 都道府県(分かれば), "city": 市区町村(分かれば), "description": 20〜60字の説明}',
    'JSON配列だけを出力してください（前後の説明やコードブロックは不要）。',
    '',
    '文章:',
    text,
  ].join('\n');

  const res = (await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  })) as { response?: string };

  return parseSpotArray(res?.response ?? '');
}

/** AI 応答テキストから JSON 配列部分を取り出してパースする。 */
export function parseSpotArray(s: string): Spot[] {
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}
