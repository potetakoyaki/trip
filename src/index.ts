import { Hono } from 'hono';
import type { Env } from './types';
import { api } from './api/routes';
import { runScrape } from './scrape/runner';

const app = new Hono<{ Bindings: Env }>();

app.route('/api', api);

// 想定外の例外も「HTTP 500」で潰さず、原因メッセージをJSONで返す。
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

// /api 以外で Worker に届いたパス（静的アセットに無いもの）への 404。
app.notFound((c) => c.json({ error: 'not found' }, 404));

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),

  // Cron Trigger: 定期スクレイピング。
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScrape(env)
        .then((s) => console.log('scheduled scrape:', JSON.stringify(s)))
        .catch((e) => console.error('scheduled scrape failed:', e)),
    );
  },
};
