import { Hono } from 'hono';
import type { Env } from './types';
import { api } from './api/routes';
import { runScrape } from './scrape/runner';
import { processCollectQueue, processPlanJobQueue } from './scrape/collect-job';

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

  // Cron Trigger。毎分のトリガーは「じっくり収集キュー」を1ラウンド進め、
  // 6時間ごとのトリガーは設定ソースの定期スクレイピングを行う。
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '* * * * *') {
      ctx.waitUntil(processCollectQueue(env).catch((e) => console.error('collect queue failed:', e)));
      ctx.waitUntil(processPlanJobQueue(env).catch((e) => console.error('plan queue failed:', e)));
    } else {
      ctx.waitUntil(
        runScrape(env)
          .then((s) => console.log('scheduled scrape:', JSON.stringify(s)))
          .catch((e) => console.error('scheduled scrape failed:', e)),
      );
    }
  },
};
