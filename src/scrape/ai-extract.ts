import type { Env } from '../types';

// 抽出は無料枠を節約するため軽量モデルを使う。JSONモード(schema強制)により
// 8bでも構造化出力は安定する。失敗時も同モデルの素のJSON出力で再試行。
const EXTRACT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const FALLBACK_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface Spot {
  title?: string;
  category?: string;
  prefecture?: string;
  city?: string;
  description?: string;
}

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    spots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string' },
          prefecture: { type: 'string' },
          city: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  required: ['spots'],
};

function buildMessages(text: string, hint: { area?: string; interests?: string[] }) {
  const sys =
    'あなたは旅行情報の抽出器です。与えられた文章から、旅行で実際に訪れる価値のあるスポット・店・名所・施設・イベントを抽出します。文章に書かれていない情報は創作しません。地名そのもの（県名・市名）や抽象概念は除外し、具体的な訪問先だけを挙げます。';
  const hintLines: string[] = [];
  if (hint.area) hintLines.push(`対象エリア: ${hint.area}`);
  if (hint.interests?.length) hintLines.push(`特に次の興味に関連するものを優先: ${hint.interests.join('、')}`);
  const user = [
    '次の文章から訪問先を最大12件抽出し、JSONで返してください。',
    ...hintLines,
    '観光名所だけでなく、カフェ・レストラン・名物グルメの店、体験・アクティビティ・レジャー施設・イベントも積極的に拾ってください。',
    '各要素のフィールド: title(名称・必須), category(グルメ/自然/歴史/アート/音楽/体験/宿泊/祭り/観光 のいずれか), prefecture, city, description(その場所の魅力や名物を40〜80字で具体的に)。',
    '',
    '文章:',
    text,
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/**
 * 文章から旅行スポットを抽出する。
 * まず JSON モード（schema強制）で賢いモデルに依頼し、ダメなら軽量モデルで素のJSONを試す。
 */
export async function extractSpots(
  env: Env,
  text: string,
  hint: { area?: string; interests?: string[] } = {},
): Promise<Spot[]> {
  if (!env.AI || !text.trim()) return [];
  const messages = buildMessages(text, hint);

  // 1) JSONモード（schema強制）。max_tokens を確保し出力の途中切れを防ぐ。
  try {
    const res = await env.AI.run(EXTRACT_MODEL, {
      messages,
      max_tokens: 1500,
      response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
    });
    const spots = readSpots(res);
    if (spots.length) return spots;
  } catch {
    /* フォールバックへ */
  }

  // 2) 軽量モデルで素のJSON出力 → テキストから配列抽出
  try {
    const res = await env.AI.run(FALLBACK_MODEL, { messages, max_tokens: 1500 });
    return readSpots(res);
  } catch {
    return [];
  }
}

/** AI 応答（オブジェクト / 文字列いずれの形でも）から Spot 配列を取り出す。 */
export function readSpots(res: any): Spot[] {
  const r = res?.response ?? res;
  if (r && typeof r === 'object') {
    if (Array.isArray(r)) return cleanSpots(r);
    if (Array.isArray(r.spots)) return cleanSpots(r.spots);
    return [];
  }
  if (typeof r === 'string') {
    const trimmed = r.trim();
    try {
      const o = JSON.parse(trimmed);
      if (Array.isArray(o)) return cleanSpots(o);
      if (o && Array.isArray(o.spots)) return cleanSpots(o.spots);
    } catch {
      /* テキスト中の配列を拾う */
    }
    return parseSpotArray(r);
  }
  return [];
}

function cleanSpots(arr: any[]): Spot[] {
  return arr.filter((x) => x && typeof x === 'object' && typeof x.title === 'string' && x.title.trim());
}

/** テキストから JSON 配列部分を取り出してパースする。 */
export function parseSpotArray(s: string): Spot[] {
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? cleanSpots(arr) : [];
  } catch {
    return [];
  }
}

/** 診断用: 固定サンプルで抽出を試し、生応答と結果を返す。 */
export async function extractSpotsDiag(
  env: Env,
): Promise<{ model: string; raw: string; count: number; spots: Spot[]; error?: string }> {
  const sample =
    '箱根は神奈川県の人気観光地。大涌谷では黒たまごが名物。芦ノ湖では海賊船クルーズが楽しめる。彫刻の森美術館や箱根神社の水中鳥居も有名。強羅温泉では日帰り入浴ができる。';
  const messages = buildMessages(sample, { area: '箱根' });
  if (!env.AI) return { model: EXTRACT_MODEL, raw: '', count: 0, spots: [], error: 'AI binding なし' };
  try {
    const res = (await env.AI.run(EXTRACT_MODEL, {
      messages,
      max_tokens: 1500,
      response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
    })) as any;
    const raw = typeof res?.response === 'string' ? res.response : JSON.stringify(res?.response ?? res);
    const spots = readSpots(res);
    return { model: EXTRACT_MODEL, raw: raw.slice(0, 500), count: spots.length, spots };
  } catch (e) {
    return { model: EXTRACT_MODEL, raw: '', count: 0, spots: [], error: e instanceof Error ? e.message : String(e) };
  }
}
