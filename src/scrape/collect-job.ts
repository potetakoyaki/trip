import type { Env } from '../types';
import { discoverAndScrape, roundQueries } from './autosource';
import {
  ensureJobsTable,
  getJob,
  takeNextPendingJob,
  updateJobProgress,
  searchEvents,
} from '../db/repository';

/**
 * 1ジョブの「次の1ラウンド」を実行して進捗を更新する。
 * 無料の50サブリクエスト上限を超えないよう、1回につき1ラウンド（最大8ページ）だけ。
 */
export async function processOneRound(env: Env, area: string): Promise<void> {
  await ensureJobsTable(env.DB);
  const job = await getJob(env.DB, area);
  if (!job || job.status !== 'pending') return;

  const { queries, totalRounds } = roundQueries(area, job.round, job.keyword ?? undefined);
  try {
    await discoverAndScrape(env, {
      area,
      interests: job.interests ? safeParse(job.interests) : undefined,
      queries,
      maxPages: 8,
    });
  } catch {
    /* ラウンド失敗は無視して次へ進める */
  }

  const collected = (await searchEvents(env.DB, { area, limit: 500 })).length;
  const nextRound = job.round + 1;
  const status = nextRound > totalRounds ? 'done' : 'pending';
  await updateJobProgress(env.DB, area, { round: nextRound, status, collected, now: new Date().toISOString() });
}

/** Cron から呼ぶ: 保留中のジョブを1つ取り、その次の1ラウンドを処理する。 */
export async function processCollectQueue(env: Env): Promise<void> {
  await ensureJobsTable(env.DB);
  const job = await takeNextPendingJob(env.DB);
  if (job) await processOneRound(env, job.area);
}

function safeParse(s: string): string[] | undefined {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : undefined;
  } catch {
    return undefined;
  }
}
