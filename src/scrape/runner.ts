import type { Env } from '../types';
import { HttpClient } from './http';
import { getSources, updateSourceStatus, upsertEvents } from '../db/repository';
import { resolveDriver, type RunContext } from '../sources/index';

export interface SourceResult {
  source: string;
  status: 'ok' | 'skipped' | 'error';
  count: number;
  message?: string;
}

export interface RunSummary {
  ranAt: string;
  total: number;
  results: SourceResult[];
}

/**
 * 有効なソースを順番にスクレイピングし、結果を D1 に保存する。
 * 1ソースのエラーは他に波及させない。
 */
export async function runScrape(env: Env, opts: { sourceId?: string } = {}): Promise<RunSummary> {
  const ranAt = new Date().toISOString();
  const sources = await getSources(env.DB, { enabledOnly: true, id: opts.sourceId });
  const http = new HttpClient({ userAgent: env.USER_AGENT });
  const ctx: RunContext = { env, http, now: new Date() };

  const results: SourceResult[] = [];
  let total = 0;

  for (const source of sources) {
    const driver = resolveDriver(source);
    if (!driver) {
      results.push({ source: source.id, status: 'skipped', count: 0, message: 'ドライバ未定義' });
      await updateSourceStatus(env.DB, source.id, 'skipped: no driver', ranAt);
      continue;
    }
    if (!driver.isConfigured(ctx, source)) {
      results.push({ source: source.id, status: 'skipped', count: 0, message: '設定不足（APIキー/URL等）' });
      await updateSourceStatus(env.DB, source.id, 'skipped: not configured', ranAt);
      continue;
    }

    try {
      const events = await driver.run(ctx, source);
      const n = await upsertEvents(env.DB, source.id, events, ranAt);
      total += n;
      results.push({ source: source.id, status: 'ok', count: n });
      await updateSourceStatus(env.DB, source.id, `ok: ${n}件`, ranAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ source: source.id, status: 'error', count: 0, message });
      await updateSourceStatus(env.DB, source.id, `error: ${message}`.slice(0, 200), ranAt);
    }
  }

  return { ranAt, total, results };
}
