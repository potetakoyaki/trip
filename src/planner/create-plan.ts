import type { Env, Plan, PlanRequest } from '../types';
import { runScrape } from '../scrape/runner';
import { discoverAndScrape } from '../scrape/autosource';
import { fetchRakutenHotels } from '../scrape/hotels';
import { searchEvents, savePlan } from '../db/repository';
import { generatePlan } from './planner';

export interface CreatePlanResult {
  id: string;
  createdAt: string;
  candidateCount: number;
  plan: Plan;
  scrape: { ran: boolean; total?: number; results?: unknown };
  discovered: { total: number; docs: { source: string; url: string }[] } | null;
  candidates: unknown[];
}

/**
 * プラン作成の中核。/api/plan（同期）とバックグラウンドジョブの両方から使う。
 * 自動収集 → 候補取得 → 楽天ホテル → AI提案 → 保存 までを行う。
 */
export async function createPlan(env: Env, body: PlanRequest, origin?: string): Promise<CreatePlanResult> {
  let scrape: { ran: boolean; total?: number; results?: unknown } = { ran: false };
  if (body.autoScrape !== false) {
    const summary = await runScrape(env);
    scrape = { ran: true, total: summary.total, results: summary.results };
  }

  let events = await searchEvents(env.DB, {
    area: body.area,
    from: body.startDate,
    to: body.endDate,
    limit: 300,
  });

  let discovered: { total: number; docs: { source: string; url: string }[] } | null = null;
  if (body.autoScrape !== false && body.area && events.length < 6) {
    try {
      discovered = await discoverAndScrape(env, {
        area: body.area,
        interests: body.interests,
        keyword: body.keyword,
      });
    } catch {
      discovered = { total: 0, docs: [] };
    }
    if (discovered && discovered.total > 0) {
      events = await searchEvents(env.DB, {
        area: body.area,
        from: body.startDate,
        to: body.endDate,
        limit: 300,
      });
    }
  }

  let realHotels: Awaited<ReturnType<typeof fetchRakutenHotels>> = [];
  try {
    realHotels = await fetchRakutenHotels(env, body.area, origin, {
      keywords: body.hotelFeatures,
      maxPrice: body.budget,
      limit: 24,
    });
  } catch {
    realHotels = [];
  }

  const plan = await generatePlan(env, events, body, { hotels: realHotels });

  const candidates = events.slice(0, 80).map((e) => ({
    title: e.title,
    category: e.category ?? undefined,
    location: e.location_name ?? e.city ?? e.prefecture ?? undefined,
    url: e.url ?? undefined,
    price: e.price ?? undefined,
    description: e.description ?? undefined,
  }));

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await savePlan(env.DB, id, createdAt, body, plan);
  return { id, createdAt, candidateCount: events.length, plan, scrape, discovered, candidates };
}
