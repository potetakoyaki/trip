import type { NormalizedEvent, SourceRow } from '../types';
import type { Driver, RunContext } from './index';
import { parseRss } from '../scrape/rss';
import { extractReadableText } from '../scrape/readable';
import { extractSpots } from '../scrape/ai-extract';
import { inferCategory, inferPrefecture } from '../util/normalize';

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
      const spots = await extractSpots(ctx.env, post.text.slice(0, 6000), {
        area: cfg.prefecture,
      });
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
