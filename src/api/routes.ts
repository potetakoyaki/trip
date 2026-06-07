import { Hono } from 'hono';
import type { Env, PlanRequest } from '../types';
import { runScrape } from '../scrape/runner';
import { discoverAndScrape, roundQueries } from '../scrape/autosource';
import { fetchRakutenHotels, rakutenHotelSearch } from '../scrape/hotels';
import {
  createSource,
  deleteSource,
  getPlan,
  getSources,
  insertDemoEvents,
  savePlan,
  searchEvents,
  updateSource,
} from '../db/repository';
import { generatePlan } from '../planner/planner';
import { extractSpotsDiag } from '../scrape/ai-extract';
import { ALL_CATEGORIES } from '../util/normalize';

export const api = new Hono<{ Bindings: Env }>();

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

api.post('/plan', async (c) => {
  const raw = await c.req.json<any>().catch(() => null);
  const valid = validatePlanRequest(raw);
  if (!valid.ok) return c.json({ error: valid.error }, 400);
  const body = valid.req;

  // プラン作成のたびに毎回、最新情報を取得してから組み立てる（再取得の制限なし）。
  // 相手サーバーへの配慮はレート制限（ホスト別3秒間隔）・逐次処理・robots遵守で担保する。
  // スクレイピングが失敗してもプラン作成は止めない（runScrape は例外を投げない）。
  let scrape: { ran: boolean; total?: number; results?: unknown } = { ran: false };
  if (body.autoScrape !== false) {
    const summary = await runScrape(c.env);
    scrape = { ran: true, total: summary.total, results: summary.results };
  }

  // 候補イベントを取得（日付不明のスポット/宿も含まれる）
  let events = await searchEvents(c.env.DB, {
    area: body.area,
    from: body.startDate,
    to: body.endDate,
    limit: 300,
  });

  // 設定ソースが無くても、エリア名から自動で大手サイト/ブログを集めて補完する。
  // 既に十分な候補があるエリアでは再収集しない（検索・AIの無駄打ちを避ける）。
  let discovered: { total: number; docs: { source: string; url: string }[] } | null = null;
  if (body.autoScrape !== false && body.area && events.length < 6) {
    try {
      discovered = await discoverAndScrape(c.env, {
        area: body.area,
        interests: body.interests,
        keyword: body.keyword,
      });
    } catch (err) {
      discovered = { total: 0, docs: [] };
      console.error('discover failed:', err);
    }
    if (discovered && discovered.total > 0) {
      events = await searchEvents(c.env.DB, {
        area: body.area,
        from: body.startDate,
        to: body.endDate,
        limit: 300,
      });
    }
  }

  // 楽天トラベルAPI(無料・任意)が設定されていれば、実在ホテルを取得して
  // AI概算より優先する。未設定なら空配列でAI概算のまま。
  let realHotels: Awaited<ReturnType<typeof fetchRakutenHotels>> = [];
  try {
    realHotels = await fetchRakutenHotels(c.env, body.area, reqOrigin(c.req.url), {
      keywords: body.hotelFeatures,
      maxPrice: body.budget,
      limit: 24,
    });
  } catch {
    realHotels = [];
  }

  let plan;
  try {
    plan = await generatePlan(c.env, events, body, { hotels: realHotels });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  // 収集できたスポット一覧（プランに入らなかったものも含めて全部見せる）
  const candidates = events.slice(0, 80).map((e) => ({
    title: e.title,
    category: e.category ?? undefined,
    location: e.location_name ?? e.city ?? e.prefecture ?? undefined,
    url: e.url ?? undefined,
    price: e.price ?? undefined,
  }));

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await savePlan(c.env.DB, id, createdAt, body, plan);
  return c.json({ id, createdAt, candidateCount: events.length, plan, scrape, discovered, candidates });
});

api.get('/plan/:id', async (c) => {
  const found = await getPlan(c.env.DB, c.req.param('id'));
  if (!found) return c.json({ error: 'not found' }, 404);
  return c.json(found);
});
