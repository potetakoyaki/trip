import { robotsAllows } from './robots';

export class RobotsBlockedError extends Error {
  constructor(url: string) {
    super(`robots.txt によりアクセスが禁止されています: ${url}`);
    this.name = 'RobotsBlockedError';
  }
}

interface GetOptions {
  accept?: string;
  /** キャッシュ保持秒数（Cache API）。0で無効。 */
  cacheTtl?: number;
  /** robots.txt チェックをスキップ（robots.txt 自体の取得用）。 */
  skipRobots?: boolean;
}

/**
 * スクレイピング用の HTTP クライアント。
 * - robots.txt を尊重
 * - ホストごとにレート制限（最低間隔）
 * - Cloudflare Cache API でレスポンスをキャッシュ
 * - 連絡先入りの User-Agent を付与
 */
export class HttpClient {
  private userAgent: string;
  private minIntervalMs: number;
  private lastByHost = new Map<string, number>();
  private robotsCache = new Map<string, string | null>();

  constructor(opts: { userAgent?: string; minIntervalMs?: number } = {}) {
    this.userAgent = opts.userAgent ?? 'TripPlannerBot/0.1 (personal use)';
    this.minIntervalMs = opts.minIntervalMs ?? 1200;
  }

  async getText(url: string, opts: GetOptions = {}): Promise<string> {
    if (!opts.skipRobots) {
      const allowed = await this.isAllowed(url);
      if (!allowed) throw new RobotsBlockedError(url);
    }

    await this.throttle(url);

    const cache = (globalThis as any).caches?.default as Cache | undefined;
    const cacheKey = new Request(url, { headers: { Accept: opts.accept ?? '*/*' } });
    if (opts.cacheTtl && cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit.text();
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
    const text = await res.text();

    if (opts.cacheTtl && cache) {
      const cached = new Response(text, {
        headers: { 'Cache-Control': `max-age=${opts.cacheTtl}` },
      });
      await cache.put(cacheKey, cached);
    }
    return text;
  }

  async getJson<T = unknown>(url: string, opts: GetOptions = {}): Promise<T> {
    const text = await this.getText(url, { accept: 'application/json', ...opts });
    return JSON.parse(text) as T;
  }

  private async isAllowed(url: string): Promise<boolean> {
    try {
      const u = new URL(url);
      const robotsUrl = `${u.origin}/robots.txt`;
      let txt = this.robotsCache.get(u.origin);
      if (txt === undefined) {
        try {
          txt = await this.getText(robotsUrl, { skipRobots: true, cacheTtl: 3600 });
        } catch {
          txt = null; // robots.txt が無い/取得失敗 → 許可扱い
        }
        this.robotsCache.set(u.origin, txt);
      }
      if (!txt) return true;
      return robotsAllows(txt, u.pathname + u.search, this.userAgent);
    } catch {
      return true;
    }
  }

  private async throttle(url: string): Promise<void> {
    try {
      const host = new URL(url).host;
      const last = this.lastByHost.get(host) ?? 0;
      const wait = this.minIntervalMs - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastByHost.set(host, Date.now());
    } catch {
      /* noop */
    }
  }
}
