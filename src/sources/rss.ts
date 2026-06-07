import type { NormalizedEvent, SourceRow } from '../types';
import type { Driver, RunContext } from './index';
import { parseRss } from '../scrape/rss';

/**
 * 汎用 RSS/Atom ドライバ。観光協会・自治体のニュースフィード等に。
 * config: { feedUrl | feedUrls[], category?, prefecture? }
 */
export const rssDriver: Driver = {
  name: 'rss',

  isConfigured(_ctx: RunContext, source: SourceRow): boolean {
    const cfg = source.config as { feedUrl?: string; feedUrls?: string[] };
    const urls = cfg.feedUrls ?? (cfg.feedUrl ? [cfg.feedUrl] : []);
    return urls.length > 0 && !urls.some((u) => u.includes('example.com'));
  },

  async run(ctx: RunContext, source: SourceRow): Promise<NormalizedEvent[]> {
    const cfg = source.config as {
      feedUrl?: string;
      feedUrls?: string[];
      category?: string;
      prefecture?: string;
    };
    const urls = cfg.feedUrls ?? (cfg.feedUrl ? [cfg.feedUrl] : []);
    const all: NormalizedEvent[] = [];
    for (const url of urls) {
      const xml = await ctx.http.getText(url, {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        cacheTtl: 1800,
      });
      all.push(...parseRss(xml, { category: cfg.category, prefecture: cfg.prefecture }));
    }
    return all;
  },
};
