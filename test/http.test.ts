import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, RobotsBlockedError } from '../src/scrape/http';

/**
 * 相手サーバーに負担をかけない仕組み（レート制限・キャッシュ・robots遵守）を
 * 実際に検証するテスト。fetch / caches をモックして挙動を確認する。
 */
describe('HttpClient（相手サーバーへの配慮）', () => {
  let calls: { url: string; t: number }[];
  let origFetch: typeof globalThis.fetch;
  let origCaches: unknown;

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
    origCaches = (globalThis as any).caches;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    (globalThis as any).caches = origCaches;
  });

  it('同一ホストへの連続アクセスは最低 minIntervalMs の間隔を空ける（レート制限）', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      calls.push({ url: String(input), t: Date.now() });
      return new Response('ok', { status: 200 });
    }) as any;
    (globalThis as any).caches = undefined;

    const http = new HttpClient({ minIntervalMs: 150 });
    await http.getText('https://example.test/a', { skipRobots: true });
    await http.getText('https://example.test/b', { skipRobots: true });
    await http.getText('https://example.test/c', { skipRobots: true });

    expect(calls).toHaveLength(3);
    // 3回のアクセスは少なくとも 2*150ms 以上に分散している
    expect(calls[1].t - calls[0].t).toBeGreaterThanOrEqual(140);
    expect(calls[2].t - calls[1].t).toBeGreaterThanOrEqual(140);
  });

  it('キャッシュにヒットすればオリジンへ再アクセスしない（負荷の重複防止）', async () => {
    const store = new Map<string, Response>();
    (globalThis as any).caches = {
      default: {
        async match(req: Request) {
          const r = store.get(req.url);
          return r ? r.clone() : undefined;
        },
        async put(req: Request, res: Response) {
          store.set(req.url, res.clone());
        },
      },
    };
    const fetchMock = vi.fn(async (input: any) => {
      calls.push({ url: String(input), t: Date.now() });
      return new Response('body-v1', { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    const http = new HttpClient({ minIntervalMs: 10 });
    const a = await http.getText('https://cache.test/x', { skipRobots: true, cacheTtl: 60 });
    const b = await http.getText('https://cache.test/x', { skipRobots: true, cacheTtl: 60 });

    expect(a).toBe('body-v1');
    expect(b).toBe('body-v1');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 2回目はキャッシュから返る
  });

  it('robots.txt が Disallow なら実ページをフェッチせず例外を投げる（robots遵守）', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /', { status: 200 });
      }
      calls.push({ url, t: Date.now() }); // 実ページへのアクセスはここに記録
      return new Response('should-not-be-fetched', { status: 200 });
    });
    globalThis.fetch = fetchMock as any;
    (globalThis as any).caches = undefined;

    const http = new HttpClient({ minIntervalMs: 10 });
    await expect(http.getText('https://blocked.test/page')).rejects.toBeInstanceOf(RobotsBlockedError);
    // robots で禁止されたページは一度もフェッチされていない
    expect(calls.find((c) => c.url.includes('/page'))).toBeUndefined();
  });

  it('robots.txt が許可なら通常どおり取得できる', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /private', { status: 200 });
      }
      return new Response('page-body', { status: 200 });
    });
    globalThis.fetch = fetchMock as any;
    (globalThis as any).caches = undefined;

    const http = new HttpClient({ minIntervalMs: 10 });
    const body = await http.getText('https://ok.test/public/page');
    expect(body).toBe('page-body');
  });
});
