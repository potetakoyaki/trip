import type { NormalizedEvent, SourceRow } from '../types';
import type { Driver, RunContext } from './index';
import { extractJsonLdScripts, parseJsonLdEvents } from '../scrape/jsonld';

/**
 * 汎用 JSON-LD ドライバ。ページ内の schema.org Event / 観光スポット情報を抽出。
 * Walkerplus / Peatix / 観光協会の多くは JSON-LD を埋め込んでいるため、
 * CSS セレクタに依存する壊れやすいスクレイピングを避けられる。
 * config: { pageUrls[], prefecture? }
 */
export const jsonldDriver: Driver = {
  name: 'jsonld',

  isConfigured(_ctx: RunContext, source: SourceRow): boolean {
    const cfg = source.config as { pageUrls?: string[] };
    const urls = cfg.pageUrls ?? [];
    return urls.length > 0 && !urls.some((u) => u.includes('example.com'));
  },

  async run(ctx: RunContext, source: SourceRow): Promise<NormalizedEvent[]> {
    const cfg = source.config as { pageUrls?: string[]; prefecture?: string };
    const all: NormalizedEvent[] = [];
    for (const url of cfg.pageUrls ?? []) {
      const html = await ctx.http.getText(url, { cacheTtl: 1800 });
      const scripts = await extractJsonLdScripts(html);
      all.push(...parseJsonLdEvents(scripts, { prefecture: cfg.prefecture }));
    }
    return all;
  },
};
