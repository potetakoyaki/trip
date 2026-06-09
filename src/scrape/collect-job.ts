import type { Env } from '../types';
import { discoverAndScrape, roundQueries } from './autosource';
import {
  ensureJobsTable,
  getJob,
  takeNextPendingJob,
  claimJobRound,
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
  if (!job || (job.status !== 'pending' && job.status !== 'running')) return;
  // waitUntil と毎分Cronが同じジョブを同時に処理して二重スクレイプ（無料枠の無駄）に
  // ならないよう、ここで排他取得する。取れなかった呼び出しは即終了。
  if (!(await claimJobRound(env.DB, area, new Date().toISOString()))) return;

  const { queries, totalRounds } = roundQueries(area, job.round, job.keyword ?? undefined);
  try {
    await discoverAndScrape(env, {
      area,
      interests: job.interests ? safeParse(job.interests) : undefined,
      queries,
      maxPages: 8,
      // 再収集(pass)のたびに、検索結果のより深い位置を取りに行く（同じ上位の重複を避ける）。
      resultOffset: (job.pass ?? 0) * 2,
    });
  } catch {
    /* ラウンド失敗は無視して次へ進める */
  }

  const collected = (await searchEvents(env.DB, { area, limit: 500 })).length;
  const nextRound = job.round + 1;
  // ラウンド実行中にキャンセルされていたら、保留に戻さず終了する。
  const fresh = await getJob(env.DB, area);
  if (fresh && fresh.status === 'cancelled') {
    await updateJobProgress(env.DB, area, {
      round: job.round,
      status: 'cancelled',
      collected,
      now: new Date().toISOString(),
    });
    return;
  }
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

// ---- プラン作成ジョブ ----
import { createPlan } from '../planner/create-plan';
import {
  ensurePlanJobs,
  getPlanJob,
  hidePlan,
  takePendingPlanJob,
  updatePlanJob,
  updatePlanProgress,
} from '../db/repository';

/** 1件のプラン作成ジョブを実行する。 */
export async function runPlanJob(env: Env, id: string): Promise<void> {
  await ensurePlanJobs(env.DB);
  const job = await getPlanJob(env.DB, id);
  if (!job || job.status !== 'pending') return;
  try {
    const req = JSON.parse(job.request);
    // createPlan の各段階の進捗をDBへ書き、クライアントが /plan-status で読み取る。
    const onProgress = (stage: string, progress: number) =>
      updatePlanProgress(env.DB, id, stage, progress, new Date().toISOString());
    const r = await createPlan(env, req, job.origin ?? undefined, onProgress);
    // 作成中にキャンセルされていたら、できたプランは履歴に出さず終了する。
    const fresh = await getPlanJob(env.DB, id);
    if (fresh && fresh.status === 'cancelled') {
      await hidePlan(env.DB, r.id);
      return;
    }
    await updatePlanJob(env.DB, id, { status: 'done', planId: r.id, now: new Date().toISOString() });
  } catch (e) {
    await updatePlanJob(env.DB, id, {
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      now: new Date().toISOString(),
    });
  }
}

/** Cron の保険: waitUntil が途中で切れた未完了ジョブを拾って完了させる。 */
export async function processPlanJobQueue(env: Env): Promise<void> {
  await ensurePlanJobs(env.DB);
  const before = new Date(Date.now() - 90_000).toISOString(); // 90秒以上 pending のもの
  const job = await takePendingPlanJob(env.DB, before);
  if (job) await runPlanJob(env, job.id);
}
