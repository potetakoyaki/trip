import { Hono } from 'hono';
import type { Env, PlanRequest } from '../types';
import { runScrape } from '../scrape/runner';
import { discoverAndScrape } from '../scrape/autosource';
import { fetchRakutenHotels } from '../scrape/hotels';
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

// 診断用: 楽天トラベルAPIが設定・動作しているか確認する。
api.get('/hotels-test', async (c) => {
  const area = c.req.query('area') || '箱根';
  const configured = Boolean(c.env.RAKUTEN_APP_ID);
  const hotels = await fetchRakutenHotels(c.env, area);
  return c.json({ configured, area, count: hotels.length, hotels });
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
  let body: PlanRequest;
  try {
    body = await c.req.json<PlanRequest>();
  } catch {
    return c.json({ error: 'JSON ボディが不正です' }, 400);
  }
  if (!body.startDate || !body.endDate) {
    return c.json({ error: 'startDate と endDate は必須です' }, 400);
  }

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
      discovered = await discoverAndScrape(c.env, { area: body.area, interests: body.interests });
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
    realHotels = await fetchRakutenHotels(c.env, body.area);
  } catch {
    realHotels = [];
  }

  let plan;
  try {
    plan = await generatePlan(c.env, events, body, { hotels: realHotels });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await savePlan(c.env.DB, id, createdAt, body, plan);
  return c.json({ id, createdAt, candidateCount: events.length, plan, scrape, discovered });
});

api.get('/plan/:id', async (c) => {
  const found = await getPlan(c.env.DB, c.req.param('id'));
  if (!found) return c.json({ error: 'not found' }, 404);
  return c.json(found);
});
