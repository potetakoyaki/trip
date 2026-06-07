import type { Env, NormalizedEvent, SourceRow } from '../types';
import type { HttpClient } from '../scrape/http';
import { connpassDriver } from './connpass';
import { rakutenDriver } from './rakuten';
import { rssDriver } from './rss';
import { jsonldDriver } from './jsonld';
import { blogDriver } from './blog';

export interface RunContext {
  env: Env;
  http: HttpClient;
  now: Date;
}

export interface Driver {
  name: string;
  /** 実行に必要な設定（APIキー等）が揃っているか。 */
  isConfigured(ctx: RunContext, source: SourceRow): boolean;
  run(ctx: RunContext, source: SourceRow): Promise<NormalizedEvent[]>;
}

/** config.driver の値 → ドライバ実装。 */
export const drivers: Record<string, Driver> = {
  connpass: connpassDriver,
  rakuten: rakutenDriver,
  rss: rssDriver,
  jsonld: jsonldDriver,
  blog: blogDriver,
};

export function resolveDriver(source: SourceRow): Driver | undefined {
  const key = String(source.config?.driver ?? '');
  return drivers[key];
}
