import { Hono } from 'hono';
import type { Env, PlanRequest } from '../types';
import { runScrape } from '../scrape/runner';
import { discoverAndScrape, roundQueries } from '../scrape/autosource';
import { processOneRound, runPlanJob } from '../scrape/collect-job';
import { rakutenHotelSearch } from '../scrape/hotels';
import { createPlan } from '../planner/create-plan';
import {
  addVisited,
  addWishlist,
  cancelCollectJob,
  cancelPlanJob,
  createPlanJob,
  createSource,
  deleteSource,
  ensureCoveredTable,
  ensureJobsTable,
  ensurePlanJobs,
  ensureVisited,
  ensureWishlist,
  findEventPrefecture,
  getCollectedAreas,
  getJob,
  getPlan,
  getPlanJob,
  getSources,
  hidePlan,
  insertDemoEvents,
  isCovered,
  listPlans,
  listVisited,
  listWishlist,
  markCovered,
  markPlanSaved,
  removeVisited,
  removeWishlist,
  reorderWishlist,
  searchEvents,
  startJob,
  updatePlanResult,
  updateSource,
} from '../db/repository';
import { extractSpotsDiag } from '../scrape/ai-extract';
import { AI_MODELS } from '../planner/ai';
import { geminiEnabled, geminiGenerate } from '../planner/gemini';
import { ALL_CATEGORIES, inferPrefecture } from '../util/normalize';

export const api = new Hono<{ Bindings: Env }>();

// APIレスポンスはキャッシュさせない（診断・進捗ポーリング等が古い結果を返さないように）。
api.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
});

// AIバインディングの疎通確認。つながっているか・どのモデルが応答するかを返す。
// 「枠の上限」表示が出るのに使用ニューロンが0のとき、ここで本当の原因を確認できる。
// （構造化出力の対応有無に左右されないよう、ここでは素のプロンプトで試す。）
api.get('/diag/ai', async (c) => {
  const env = c.env;
  const results: Array<Record<string, unknown>> = [];

  // Workers AI（バインディングがあれば各モデルを軽く叩く）。
  if (env.AI) {
    for (const model of AI_MODELS) {
      const t0 = Date.now();
      try {
        const r = (await env.AI.run(model, {
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 8,
        })) as { response?: unknown };
        const sample = typeof r?.response === 'string' ? r.response.trim().slice(0, 60) : (r?.response ?? null);
        results.push({ provider: 'workers-ai', model, ok: true, ms: Date.now() - t0, sample });
      } catch (e) {
        results.push({ provider: 'workers-ai', model, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // Gemini（APIキーがあれば疎通確認）。Cloudflareの枠とは独立。
  // 無料枠の配分はモデルごとに異なるため、候補モデルを順に試して「どれが通るか」を示す。
  if (geminiEnabled(env)) {
    const candidates = [
      (env.GEMINI_MODEL || '').trim() || 'gemini-2.5-flash',
      (env.GEMINI_EXTRACT_MODEL || '').trim() || 'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
    ];
    const seen = new Set<string>();
    for (const model of candidates) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      const t0 = Date.now();
      try {
        const out = await geminiGenerate(env, 'You are a test endpoint.', 'Reply with exactly: OK', {
          json: false,
          maxOutputTokens: 24,
          model,
          maxAttempts: 1, // 診断は素早く判定したいので再試行しない
        });
        results.push({ provider: 'gemini', model, ok: true, ms: Date.now() - t0, sample: out.trim().slice(0, 60) });
      } catch (e) {
        results.push({ provider: 'gemini', model, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (!env.AI && !geminiEnabled(env)) {
    return c.json({
      ok: false,
      bound: false,
      note: 'Workers AI も Gemini も未設定です。wrangler.toml の [ai] か、GEMINI_API_KEY を設定してください。',
    });
  }
  return c.json({
    ok: results.some((r) => r.ok),
    bound: true,
    geminiConfigured: geminiEnabled(env),
    results,
  });
});

/** リクエストURLからオリジン（https://host）を取り出す。楽天新APIのOrigin/Referer用。 */
function reqOrigin(reqUrl: string): string | undefined {
  try {
    return new URL(reqUrl).origin;
  } catch {
    return undefined;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const strArr = (v: unknown, max = 20): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 40)).filter(Boolean).slice(0, max)
    : undefined;

/** /api/plan の入力を検証・サニタイズする。 */
function validatePlanRequest(body: any): { ok: true; req: PlanRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'リクエストの形式が不正です' };

  const startDate = body.startDate;
  const endDate = body.endDate;
  if (!DATE_RE.test(startDate ?? '')) return { ok: false, error: '開始日を YYYY-MM-DD で指定してください' };
  if (!DATE_RE.test(endDate ?? '')) return { ok: false, error: '終了日を YYYY-MM-DD で指定してください' };
  const s = new Date(`${startDate}T00:00:00Z`);
  const e = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { ok: false, error: '日付が不正です' };
  if (e < s) return { ok: false, error: '終了日は開始日以降にしてください' };
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (days > 31) return { ok: false, error: '旅行期間が長すぎます（最大31日）' };

  let budget: number | undefined;
  if (body.budget != null && body.budget !== '') {
    const b = Number(body.budget);
    if (!Number.isFinite(b) || b < 0 || b > 100_000_000)
      return { ok: false, error: '予算は0〜1億円の範囲で指定してください' };
    budget = Math.round(b);
  }

  const pace = ['relaxed', 'normal', 'packed'].includes(body.pace) ? body.pace : undefined;
  const weather = ['any', 'sunny', 'rainy'].includes(body.weather) ? body.weather : undefined;

  const req: PlanRequest = {
    area: str(body.area, 80),
    startDate,
    endDate,
    interests: strArr(body.interests),
    budget,
    pace,
    weather,
    companions: str(body.companions, 40),
    vibe: str(body.vibe, 40),
    origin: str(body.origin, 80),
    transport: str(body.transport, 40),
    keyword: str(body.keyword, 80),
    hotelFeatures: strArr(body.hotelFeatures),
    autoScrape: body.autoScrape === false ? false : true,
    thorough: body.thorough === true,
    mustInclude: Array.isArray(body.mustInclude)
      ? body.mustInclude
          .filter((x: unknown) => typeof x === 'string')
          .map((x: string) => x.trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 12)
      : undefined,
    refine: str(body.refine, 200),
    engine: body.engine === 'rule' ? 'rule' : undefined,
  };
  return { ok: true, req };
}

api.get('/health', (c) =>
  c.json({ ok: true, now: new Date().toISOString(), aiAvailable: Boolean(c.env.AI) }),
);

api.get('/categories', (c) => c.json({ categories: ALL_CATEGORIES }));

// 診断用: Workers AI が動くか、抽出が成立するかを確認する。
api.get('/ai-test', async (c) => {
  if (!c.env.AI) return c.json({ ok: false, error: 'AI binding がありません' });
  const out: Record<string, unknown> = { ok: true };
  try {
    const res = (await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: '「箱根」で有名な観光スポットを1つだけ、名称のみ答えて。' }],
    })) as { response?: string };
    out.generate = res?.response ?? null;
  } catch (e) {
    out.generateError = e instanceof Error ? e.message : String(e);
  }
  // 抽出パイプラインを固定サンプルでテスト
  out.extract = await extractSpotsDiag(c.env);
  return c.json(out);
});

// 診断用: 楽天トラベルAPIが設定・動作しているか確認する（生応答も表示）。
api.get('/hotels-test', async (c) => {
  const area = c.req.query('area') || '箱根';
  const origin = reqOrigin(c.req.url);
  const r = await rakutenHotelSearch(c.env, area, origin);
  return c.json({
    hasAppId: Boolean(c.env.RAKUTEN_APP_ID),
    hasAccessKey: Boolean(c.env.RAKUTEN_ACCESS_KEY),
    origin,
    area,
    ok: r.ok,
    status: r.status,
    error: r.error,
    count: r.hotels.length,
    hotels: r.hotels,
    raw: r.raw,
  });
});

api.get('/sources', async (c) => {
  const sources = await getSources(c.env.DB);
  return c.json({ sources });
});

// ブラウザからスクレイピング元を追加（キー不要の rss / jsonld のみ）。
api.post('/sources', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body) return c.json({ error: 'JSON ボディが不正です' }, 400);

  const driver = String(body.driver ?? '');
  const url = String(body.url ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (driver !== 'rss' && driver !== 'jsonld' && driver !== 'blog') {
    return c.json({ error: 'driver は rss / jsonld / blog のいずれかを指定してください' }, 400);
  }
  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    origin = u.origin;
  } catch {
    return c.json({ error: '有効な URL（http/https）を入力してください' }, 400);
  }

  const prefecture = body.prefecture ? String(body.prefecture) : undefined;
  const ignoreRobots = body.ignoreRobots === true;
  const config =
    driver === 'rss'
      ? {
          driver: 'rss',
          feedUrl: url,
          category: body.category ? String(body.category) : undefined,
          prefecture,
          ignoreRobots,
        }
      : driver === 'jsonld'
        ? { driver: 'jsonld', pageUrls: [url], prefecture, ignoreRobots }
        : { driver: 'blog', url, prefecture, ignoreRobots };
  const id = `${driver}-${crypto.randomUUID().slice(0, 8)}`;
  const kind = driver === 'rss' ? 'rss' : 'html';

  await createSource(c.env.DB, {
    id,
    name: name || url,
    kind,
    base_url: origin,
    config,
    enabled: body.enabled !== false,
  });
  return c.json({ ok: true, id });
});

// ソースの有効/無効・設定・名前を更新。
api.patch('/sources/:id', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const patch: { enabled?: boolean; config?: object; name?: string } = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (body.config && typeof body.config === 'object') patch.config = body.config;
  if (typeof body.name === 'string') patch.name = body.name;
  const ok = await updateSource(c.env.DB, c.req.param('id'), patch);
  if (!ok) return c.json({ error: '更新対象が見つからないか、変更内容がありません' }, 404);
  return c.json({ ok: true });
});

api.delete('/sources/:id', async (c) => {
  const ok = await deleteSource(c.env.DB, c.req.param('id'));
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// スクレイピングを手動実行。?source=<id> で個別実行、?area=<エリア> で自動収集も実行。
api.post('/scrape', async (c) => {
  const sourceId = c.req.query('source') ?? undefined;
  const area = c.req.query('area')?.trim() || undefined;
  const summary = await runScrape(c.env, { sourceId });
  let discovered: { total: number; docs: { source: string; url: string }[] } | null = null;
  if (area && !sourceId) {
    try {
      discovered = await discoverAndScrape(c.env, { area });
    } catch (err) {
      discovered = { total: 0, docs: [] };
      console.error('discover failed:', err);
    }
  }
  return c.json({ ...summary, discovered });
});

// じっくり収集: 1ラウンド分だけ収集して蓄積する（無料のサブリクエスト上限内）。
// クライアントが round=1,2,... と繰り返し呼んで段階的に貯める。
api.post('/collect', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const area = str(raw?.area, 80);
  if (!area) return c.json({ error: 'エリアが必要です' }, 400);
  const round = Math.max(1, Math.min(20, Number(raw?.round) || 1));
  const keyword = str(raw?.keyword, 80);
  const interests = strArr(raw?.interests);

  const { queries, totalRounds } = roundQueries(area, round, keyword);
  let added = 0;
  let engine: string | null = null;
  let note: string | undefined;
  try {
    const r = await discoverAndScrape(c.env, { area, interests, queries, maxPages: 8 });
    added = r.total;
    engine = r.stats.engine;
    note = r.note;
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  const total = (await searchEvents(c.env.DB, { area, limit: 500 })).length;
  return c.json({ round, totalRounds, hasMore: round < totalRounds, added, total, engine, note });
});

// バックグラウンドのじっくり収集を開始する。画面を閉じても Cron が続行する。
api.post('/collect/start', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const area = str(raw?.area, 80);
  if (!area) return c.json({ error: 'エリアが必要です' }, 400);
  const keyword = str(raw?.keyword, 80);
  const interests = strArr(raw?.interests);
  const force = raw?.force === true; // 再収集ボタン: 収集済みでもフル収集し直す
  await ensureJobsTable(c.env.DB);
  await ensureCoveredTable(c.env.DB);
  const now = new Date().toISOString();
  const kw = keyword ?? '';

  const existing = await getJob(c.env.DB, area);
  const existingCount = (await searchEvents(c.env.DB, { area, limit: 60 })).length;
  if (existing && existing.status === 'pending') {
    return c.json({
      ok: false,
      reason: 'running',
      total: existingCount,
      message: `「${area}」は既に収集中です。完了までお待ちください。`,
    });
  }

  const collected = (existing && existing.status === 'done') || existingCount >= 15;
  if (collected && !force) {
    // 条件（キーワード）が増えていたら、その差分だけを追加収集する。
    if (keyword && !(await isCovered(c.env.DB, area, kw))) {
      let added = 0;
      try {
        const r = await discoverAndScrape(c.env, {
          area,
          queries: [`${area} ${keyword}`, `${area} ${keyword} おすすめ スポット`],
          maxPages: 4,
        });
        added = r.total;
      } catch {
        /* 差分収集失敗は無視 */
      }
      await markCovered(c.env.DB, area, kw, now);
      const total = (await searchEvents(c.env.DB, { area, limit: 500 })).length;
      return c.json({
        ok: true,
        delta: true,
        added,
        total,
        message: `「${keyword}」の追加分を収集しました（合計 ${total} 件）。`,
      });
    }
    // 新しい条件が無ければ再収集しない。
    return c.json({
      ok: false,
      reason: 'collected',
      total: existingCount,
      message: `「${area}」は収集済みです（合計 ${existingCount} 件）。再収集は不要で、そのままプランを作成できます。`,
    });
  }

  // 未収集 → フル収集（バックグラウンド）。
  const { totalRounds } = roundQueries(area, 1, keyword);
  await startJob(c.env.DB, { area, keyword, interests, totalRounds, now });
  await markCovered(c.env.DB, area, '', now);
  if (keyword) await markCovered(c.env.DB, area, kw, now);
  c.executionCtx.waitUntil(processOneRound(c.env, area).catch(() => {}));
  return c.json({ ok: true, area, totalRounds });
});

// じっくり収集をキャンセルする（以降のラウンドを止める）。
api.post('/collect/cancel', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const area = str(raw?.area, 80);
  if (!area) return c.json({ error: 'エリアが必要です' }, 400);
  await ensureJobsTable(c.env.DB);
  const ok = await cancelCollectJob(c.env.DB, area, new Date().toISOString());
  return c.json({ ok });
});

// 入力エリアに似た「収集済みエリア」があれば返す（過去データ再利用の確認用）。
api.get('/areas/similar', async (c) => {
  const area = (c.req.query('area') || '').trim();
  if (!area) return c.json({ match: null });
  await ensureJobsTable(c.env.DB);
  const areas = await getCollectedAreas(c.env.DB);
  let match: string | null = null;
  for (const a of areas) {
    if (!a || a === area) continue;
    if (a.includes(area) || area.includes(a)) {
      match = a;
      break;
    }
  }
  return c.json({ match });
});

// じっくり収集の進捗を取得する。
api.get('/collect/status', async (c) => {
  const area = c.req.query('area');
  if (!area) return c.json({ error: 'area が必要です' }, 400);
  await ensureJobsTable(c.env.DB);
  const job = await getJob(c.env.DB, area);
  if (!job) return c.json({ found: false });
  return c.json({
    found: true,
    area: job.area,
    round: job.round,
    totalRounds: job.total_rounds,
    status: job.status,
    collected: job.collected,
  });
});

// 動作確認用のサンプルデータ投入。
api.post('/demo', async (c) => {
  const n = await insertDemoEvents(c.env.DB, new Date().toISOString());
  return c.json({ inserted: n });
});

api.get('/events', async (c) => {
  const q = c.req.query();
  const events = await searchEvents(c.env.DB, {
    area: q.area,
    from: q.from,
    to: q.to,
    category: q.category,
    q: q.q,
    limit: q.limit ? Number(q.limit) : undefined,
  });
  return c.json({ count: events.length, events });
});

// 同期版（後方互換）。中核ロジックは createPlan に集約。
api.post('/plan', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const valid = validatePlanRequest(raw);
  if (!valid.ok) return c.json({ error: valid.error }, 400);
  try {
    const r = await createPlan(c.env, valid.req, reqOrigin(c.req.url));
    return c.json(r);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// バックグラウンドでプラン作成を開始する（画面を閉じても完成する）。
api.post('/plan/start', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const valid = validatePlanRequest(raw);
  if (!valid.ok) return c.json({ error: valid.error }, 400);
  await ensurePlanJobs(c.env.DB);
  const jobId = crypto.randomUUID();
  await createPlanJob(c.env.DB, {
    id: jobId,
    request: valid.req,
    origin: reqOrigin(c.req.url),
    now: new Date().toISOString(),
  });
  c.executionCtx.waitUntil(runPlanJob(c.env, jobId).catch(() => {}));
  return c.json({ ok: true, jobId });
});

// プラン作成（バックグラウンド）をキャンセルする。
api.post('/plan/cancel', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const jobId = str(raw?.jobId, 60);
  if (!jobId) return c.json({ error: 'jobId が必要です' }, 400);
  await ensurePlanJobs(c.env.DB);
  const ok = await cancelPlanJob(c.env.DB, jobId, new Date().toISOString());
  return c.json({ ok });
});

// プラン作成ジョブの進捗を取得する。
// 保存プランの履歴一覧。
api.get('/plans', async (c) => {
  const plans = await listPlans(c.env.DB, 20);
  return c.json({ plans });
});

// 行ったことある場所の一覧（都道府県・エリア別はフロントでグループ化）。
api.get('/visited', async (c) => {
  await ensureVisited(c.env.DB);
  const visited = await listVisited(c.env.DB);
  return c.json({ visited });
});

// 行った/未訪問の切り替え。
api.post('/visited', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  const title = str(body?.title, 120);
  if (!title) return c.json({ error: 'title が必要です' }, 400);
  await ensureVisited(c.env.DB);
  if (body?.visited === false) {
    await removeVisited(c.env.DB, title);
    return c.json({ ok: true, visited: false });
  }
  const prefecture =
    str(body?.prefecture, 20) ||
    (await findEventPrefecture(c.env.DB, title)) ||
    inferPrefecture(title) ||
    '未分類';
  await addVisited(c.env.DB, {
    title,
    prefecture,
    area: str(body?.area, 80),
    url: str(body?.url, 300),
    now: new Date().toISOString(),
  });
  return c.json({ ok: true, visited: true, prefecture });
});

// 行ってみたい場所の一覧（並び順つき）。
api.get('/wishlist', async (c) => {
  await ensureWishlist(c.env.DB);
  const wishlist = await listWishlist(c.env.DB);
  return c.json({ wishlist });
});

// 行ってみたいの追加/解除。
api.post('/wishlist', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  const title = str(body?.title, 120);
  if (!title) return c.json({ error: 'title が必要です' }, 400);
  await ensureWishlist(c.env.DB);
  if (body?.wish === false) {
    await removeWishlist(c.env.DB, title);
    return c.json({ ok: true, wish: false });
  }
  const prefecture =
    str(body?.prefecture, 20) ||
    (await findEventPrefecture(c.env.DB, title)) ||
    inferPrefecture(title) ||
    '未分類';
  await addWishlist(c.env.DB, {
    title,
    prefecture,
    area: str(body?.area, 80),
    url: str(body?.url, 300),
    now: new Date().toISOString(),
  });
  return c.json({ ok: true, wish: true, prefecture });
});

// 行ってみたいの並び替えを保存する。
api.post('/wishlist/reorder', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  const titles: string[] = Array.isArray(body?.titles)
    ? body.titles
        .filter((x: unknown) => typeof x === 'string')
        .map((x: string) => x.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 300)
    : [];
  if (!titles.length) return c.json({ error: 'titles が必要です' }, 400);
  await ensureWishlist(c.env.DB);
  await reorderWishlist(c.env.DB, titles);
  return c.json({ ok: true });
});

api.get('/plan-status', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id が必要です' }, 400);
  await ensurePlanJobs(c.env.DB);
  const job = await getPlanJob(c.env.DB, id);
  if (!job) return c.json({ found: false });
  return c.json({
    found: true,
    status: job.status,
    planId: job.plan_id,
    error: job.error,
    stage: job.stage,
    progress: job.progress,
  });
});

api.get('/plan/:id', async (c) => {
  const found = await getPlan(c.env.DB, c.req.param('id'));
  if (!found) return c.json({ error: 'not found' }, 404);
  return c.json(found);
});

// プランを「保存」する（保存ボタンを押したものだけ履歴に残す）。編集後の内容も反映する。
api.post('/plan/:id/save', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<any>().catch(() => null);
  if (body && body.result && typeof body.result === 'object') {
    await updatePlanResult(c.env.DB, id, body.result);
  }
  const ok = await markPlanSaved(c.env.DB, id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, saved: true });
});

// 保存プランをソフト削除する（一覧から隠すだけ。DBには残り、共有リンクでは閲覧可）。
api.delete('/plan/:id', async (c) => {
  const ok = await hidePlan(c.env.DB, c.req.param('id'));
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
