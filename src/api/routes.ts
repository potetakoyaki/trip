import { Hono } from 'hono';
import type { Env, PlanRequest } from '../types';
import { runScrape } from '../scrape/runner';
import {
  getPlan,
  getSources,
  insertDemoEvents,
  savePlan,
  searchEvents,
} from '../db/repository';
import { generatePlan } from '../planner/planner';
import { ALL_CATEGORIES } from '../util/normalize';

export const api = new Hono<{ Bindings: Env }>();

api.get('/health', (c) =>
  c.json({ ok: true, now: new Date().toISOString(), aiAvailable: Boolean(c.env.AI) }),
);

api.get('/categories', (c) => c.json({ categories: ALL_CATEGORIES }));

api.get('/sources', async (c) => {
  const sources = await getSources(c.env.DB);
  return c.json({ sources });
});

// スクレイピングを手動実行。?source=<id> で個別実行。
api.post('/scrape', async (c) => {
  const sourceId = c.req.query('source') ?? undefined;
  const summary = await runScrape(c.env, { sourceId });
  return c.json(summary);
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

  // 候補イベントを取得（日付不明のスポット/宿も含まれる）
  const events = await searchEvents(c.env.DB, {
    area: body.area,
    from: body.startDate,
    to: body.endDate,
    limit: 300,
  });

  let plan;
  try {
    plan = await generatePlan(c.env, events, body);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await savePlan(c.env.DB, id, createdAt, body, plan);
  return c.json({ id, createdAt, candidateCount: events.length, plan });
});

api.get('/plan/:id', async (c) => {
  const found = await getPlan(c.env.DB, c.req.param('id'));
  if (!found) return c.json({ error: 'not found' }, 404);
  return c.json(found);
});
