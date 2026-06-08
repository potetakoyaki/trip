import type { Env, Plan, PlanRequest } from '../types';
import { runScrape } from '../scrape/runner';
import { discoverAndScrape } from '../scrape/autosource';
import { geocodePlanItems, geocodeQuery, haversineKm } from '../scrape/geocode';
import { fetchRakutenHotels } from '../scrape/hotels';
import { searchEvents, savePlan, ensureCoveredTable, isCovered, markCovered } from '../db/repository';
import { fetchForecast } from '../scrape/weather';
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
export async function createPlan(
  env: Env,
  body: PlanRequest,
  origin?: string,
  onProgress?: (stage: string, progress: number) => void | Promise<void>,
): Promise<CreatePlanResult> {
  // 進捗報告のヘルパー（失敗してもプラン作成は止めない）。
  const report = async (stage: string, progress: number) => {
    if (!onProgress) return;
    try {
      await onProgress(stage, progress);
    } catch {
      /* 進捗の更新失敗は致命的でない */
    }
  };

  await report('情報を準備しています…', 8);
  let scrape: { ran: boolean; total?: number; results?: unknown } = { ran: false };
  if (body.autoScrape !== false) {
    await report('最新情報を確認中…', 15);
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
    await ensureCoveredTable(env.DB);
    // 既に抽出済みのエリアは、AIによる再抽出（＝Neuron消費）を行わない。
    // 収集済みスポットが少なくても、既存データだけでプラン化を試みる。
    const alreadyCovered = await isCovered(env.DB, body.area, '');
    if (!alreadyCovered) {
      await report('スポット情報を集めています…', 30);
      try {
        discovered = await discoverAndScrape(env, {
          area: body.area,
          interests: body.interests,
          keyword: body.keyword,
          onExtractStart: () => report('スポット情報を抽出中…', 50),
        });
      } catch {
        discovered = { total: 0, docs: [] };
      }
      if (discovered && discovered.total > 0) {
        // 新規スポットを取得できたエリアだけ「カバー済み」にして、次回以降の再抽出を防ぐ。
        await markCovered(env.DB, body.area, '', new Date().toISOString());
        events = await searchEvents(env.DB, {
          area: body.area,
          from: body.startDate,
          to: body.endDate,
          limit: 300,
        });
      }
    }
  }

  await report('情報を整理して宿泊先を検索中…', 68);
  let realHotels: Awaited<ReturnType<typeof fetchRakutenHotels>> = [];
  try {
    realHotels = await fetchRakutenHotels(env, body.area, origin, {
      keywords: body.hotelFeatures,
      maxPrice: body.budget,
      limit: 24,
      checkinDate: body.startDate,
      checkoutDate: body.endDate,
    });
  } catch {
    realHotels = [];
  }

  await report('AIがプランを組み立て中…', 82);
  const plan = await generatePlan(env, events, body, { hotels: realHotels });

  // スポットが1件も組み込めなかった場合は、情報取得に失敗している可能性が高い。
  // 空のプランを「成功」として返さず、明確なエラーにする。
  const itemCount = plan.days.reduce((n, d) => n + d.items.length, 0);
  if (itemCount === 0) {
    throw new Error(
      'スポット情報を取得できませんでした（情報元のAPIエラー、またはこのエリアの情報が少ない可能性があります）。エリア名をもう少し具体的にするか、時間をおいて再度お試しください。',
    );
  }

  // 地図用に各スポットの実座標を取得（AIの推測座標を上書き。ベストエフォート）。
  await report('地図の座標を取得中…', 90);
  try {
    await geocodePlanItems(env, plan.days.flatMap((d) => d.items), body.area);
  } catch {
    /* 座標取得の失敗はプラン全体を止めない */
  }

  // 出発地が指定されていれば、実座標から交通の距離・所要・概算費用を計算して上書きする
  // （AIの幻覚で「茨木市→下関 80km」のような誤りを防ぐ）。AIがtravelを省いていても作る。
  if (body.origin) {
    try {
      const origin = await geocodeQuery(env, body.origin);
      const items = plan.days.flatMap((d) => d.items);
      const destItem = items.find((it) => it.lat != null && it.lng != null);
      const dest =
        destItem && destItem.lat != null && destItem.lng != null
          ? { lat: destItem.lat, lng: destItem.lng }
          : await geocodeQuery(env, body.area ?? '');
      if (origin && dest) {
        const straight = haversineKm(origin, dest);
        const mode = plan.travel?.mode || body.transport || '';
        const isWalk = /徒歩|歩/.test(mode);
        const isCar = /車|ドライブ|自動車|car/i.test(mode);
        const roadKm = Math.max(1, Math.round(straight * (isWalk ? 1.15 : 1.3)));
        const speed = isWalk ? 4.5 : isCar ? 65 : 85; // km/h（車=一般+高速の平均、鉄道=乗換込みでざっくり）
        const minutes = Math.max(1, Math.round((roadKm / speed) * 60));
        const fmtDur = (m: number) =>
          m < 60 ? `約${m}分` : m % 60 === 0 ? `約${m / 60}時間` : `約${Math.floor(m / 60)}時間${m % 60}分`;
        const cost = isWalk ? 0 : isCar ? Math.round(roadKm * 2 * 22) : Math.round(straight * 2 * 28);
        plan.travel = {
          from: body.origin,
          to: body.area,
          mode: plan.travel?.mode || body.transport,
          distance: `約${roadKm}km`,
          duration: fmtDur(minutes),
          costRoundTrip: cost,
          note: plan.travel?.note,
        };
        if (plan.costBreakdown) {
          plan.costBreakdown.transport = cost;
          plan.costBreakdown.grandTotal = plan.costBreakdown.stayTotal + cost;
        }
      }
    } catch {
      /* 交通の再計算に失敗してもAIの値のまま進める */
    }
  }

  await report('天気を取得して仕上げ中…', 95);
  // 旅行日の天気予報（無料・キー不要）。取得できたら付与。
  try {
    const forecast = await fetchForecast(body.area ?? '', body.startDate, body.endDate);
    if (forecast.length) plan.forecast = forecast;
  } catch {
    /* 天気は任意 */
  }

  const candidates = events.slice(0, 80).map((e) => ({
    title: e.title,
    category: e.category ?? undefined,
    location: e.location_name ?? e.city ?? e.prefecture ?? undefined,
    prefecture: e.prefecture ?? undefined,
    url: e.url ?? undefined,
    price: e.price ?? undefined,
    description: e.description ?? undefined,
    hours: e.hours ?? undefined,
    lat: e.lat ?? undefined,
    lng: e.lng ?? undefined,
  }));

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await savePlan(env.DB, id, createdAt, body, plan);
  return { id, createdAt, candidateCount: events.length, plan, scrape, discovered, candidates };
}
