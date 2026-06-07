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

/** ステータス更新の失敗で全体を落とさないためのラッパ。 */
async function safeUpdateStatus(env: Env, id: string, status: string, ranAt: string): Promise<void> {
  try {
    await updateSourceStatus(env.DB, id, status, ranAt);
  } catch (err) {
    console.error(`updateSourceStatus failed for ${id}:`, err);
  }
}

/**
 * 有効なソースを順番にスクレイピングし、結果を D1 に保存する。
 * どのソースが失敗しても他に波及させず、関数全体としても例外を投げない
 * （呼び出し側が常にサマリを受け取れるようにする）。
 */
export async function runScrape(env: Env, opts: { sourceId?: string } = {}): Promise<RunSummary> {
  const ranAt = new Date().toISOString();
  const results: SourceResult[] = [];
  let total = 0;

  let sources;
  try {
    sources = await getSources(env.DB, { enabledOnly: true, id: opts.sourceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ranAt,
      total: 0,
      results: [{ source: '(db)', status: 'error', count: 0, message: `ソース取得に失敗: ${message}` }],
    };
  }

  const http = new HttpClient({ userAgent: env.USER_AGENT });
  const ctx: RunContext = { env, http, now: new Date() };

  for (const source of sources) {
    try {
      const driver = resolveDriver(source);
      if (!driver) {
        results.push({ source: source.id, status: 'skipped', count: 0, message: 'ドライバ未定義' });
        await safeUpdateStatus(env, source.id, 'skipped: no driver', ranAt);
        continue;
      }
      if (!driver.isConfigured(ctx, source)) {
        results.push({ source: source.id, status: 'skipped', count: 0, message: '設定不足（APIキー/URL等）' });
        await safeUpdateStatus(env, source.id, 'skipped: not configured', ranAt);
        continue;
      }

      const events = await driver.run(ctx, source);
      const n = await upsertEvents(env.DB, source.id, events, ranAt);
      total += n;
      results.push({ source: source.id, status: 'ok', count: n });
      await safeUpdateStatus(env, source.id, `ok: ${n}件`, ranAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ source: source.id, status: 'error', count: 0, message });
      await safeUpdateStatus(env, source.id, `error: ${message}`.slice(0, 200), ranAt);
    }
  }

  return { ranAt, total, results };
}
