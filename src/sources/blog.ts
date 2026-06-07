import type { Env, NormalizedEvent, SourceRow } from '../types';
import type { Driver, RunContext } from './index';
import { parseRss } from '../scrape/rss';
import { extractReadableText } from '../scrape/readable';
import { inferCategory, inferPrefecture } from '../util/normalize';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

interface Spot {
  title?: string;
  category?: string;
  prefecture?: string;
  city?: string;
  description?: string;
}

/**
 * 一般のブログ記事から旅行スポットを抽出するドライバ。
 * 構造化データが無い散文を Workers AI に読ませて、訪問候補を取り出す。
 * - URL が RSS/Atom なら新着記事を数件たどって本文を集める
 * - 単一記事ページならその本文を使う
 * config: { driver:'blog', url, prefecture?, ignoreRobots?, maxPosts? }
 */
export const blogDriver: Driver = {
  name: 'blog',

  isConfigured(ctx: RunContext, source: SourceRow): boolean {
    const cfg = source.config as { url?: string };
    return Boolean(cfg.url) && !String(cfg.url).includes('example.com') && Boolean(ctx.env.AI);
  },

  async run(ctx: RunContext, source: SourceRow): Promise<NormalizedEvent[]> {
    const cfg = source.config as {
      url?: string;
      prefecture?: string;
      ignoreRobots?: boolean;
      maxPosts?: number;
    };
    if (!cfg.url) return [];
    if (!ctx.env.AI) throw new Error('blogドライバには Workers AI(env.AI) が必要です');
    const skipRobots = cfg.ignoreRobots === true;

    const body = await ctx.http.getText(cfg.url, { skipRobots });
    const isFeed = /<\?xml|<rss[\s>]|<feed[\s>]/i.test(body.slice(0, 300));

    const posts: { url: string; text: string }[] = [];
    if (isFeed) {
      const items = parseRss(body);
      const max = Math.min(cfg.maxPosts ?? 3, 5);
      for (const it of items.slice(0, max)) {
        if (!it.url) continue;
        try {
          const html = await ctx.http.getText(it.url, { skipRobots });
          posts.push({ url: it.url, text: `${it.title ?? ''}\n${extractReadableText(html)}` });
        } catch {
          /* 個別記事の取得失敗はスキップ */
        }
      }
    } else {
      posts.push({ url: cfg.url, text: extractReadableText(body) });
    }

    const events: NormalizedEvent[] = [];
    for (const post of posts) {
      const spots = await extractSpots(ctx.env, post.text.slice(0, 6000));
      for (const s of spots) {
        const title = (s.title ?? '').trim();
        if (!title) continue;
        events.push({
          sourceEventId: `${post.url}#${title}`,
          title,
          description: s.description?.trim() || undefined,
          url: post.url,
          category: s.category || inferCategory(title, s.description) || '観光',
          prefecture: cfg.prefecture || s.prefecture || inferPrefecture(title, s.description, s.city),
          city: s.city,
          raw: { from: 'blog', post: post.url },
        });
      }
    }
    return events;
  },
};

/** Workers AI でブログ本文から旅行スポットを抽出する。 */
async function extractSpots(env: Env, text: string): Promise<Spot[]> {
  if (!env.AI || !text.trim()) return [];
  const sys =
    'あなたは旅行情報の抽出器です。与えられたブログ本文から、旅行で訪れる価値のあるスポット・店・名所・イベントを抽出し、JSON配列のみで返します。本文に書かれていない情報は創作しません。';
  const user = [
    '次の本文から最大8件抽出してください。',
    '各要素: {"title": 名称, "category": グルメ|自然|歴史|アート|音楽|体験|宿泊|祭り|観光 のいずれか, "prefecture": 都道府県(分かれば), "city": 市区町村(分かれば), "description": 20〜60字の説明}',
    'JSON配列だけを出力してください（前後の説明やコードブロックは不要）。',
    '',
    '本文:',
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
