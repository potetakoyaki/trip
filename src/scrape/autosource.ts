import type { Env, NormalizedEvent } from '../types';
import { HttpClient } from './http';
import { extractReadableText } from './readable';
import { extractSpots } from './ai-extract';
import { upsertEvents } from '../db/repository';
import { inferCategory, inferPrefecture } from '../util/normalize';

export interface DiscoverResult {
  total: number;
  docs: { source: string; url: string }[];
  stats: { candidates: number; fetched: number; engine: string | null };
  note?: string;
}

const MAX_PAGES = 12; // 1エリアあたりに扱う大手サイト/ブログのページ数

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * エリア名から自動で情報源を集め、AI で旅行スポットを抽出・保存する。
 *
 * 主軸は Jina（s.jina.ai 検索 / r.jina.ai 本文取得）。エージェント向けサービスで
 * サーバーIPからでも動作し、サイト側のbotブロックを回避しやすい。キー不要（任意の
 * 無料キーで上限アップ・カード不要）。失敗時は Brave/Bing/DuckDuckGo にフォールバック。
 */
export async function discoverAndScrape(
  env: Env,
  opts: { area: string; interests?: string[]; keyword?: string },
): Promise<DiscoverResult> {
  const area = opts.area.trim();
  const empty: DiscoverResult = { total: 0, docs: [], stats: { candidates: 0, fetched: 0, engine: null } };
  if (!area) return { ...empty, note: 'エリアが空です' };
  if (!env.AI) return { ...empty, note: 'Workers AI(env.AI) が無効です' };

  // 同サービス（Jina/検索）への連続呼び出しを少し速める。対象サイト各ホストは
  // 1回ずつなのでレート制限の実害はほぼ無い。
  const http = new HttpClient({ userAgent: BROWSER_UA, minIntervalMs: 1200 });
  const queries = buildQueries(area, opts.interests, opts.keyword);

  const docs: { source: string; url: string; text: string }[] = [];
  let engine: string | null = null;
  let candidates = 0;

  // 1) Jina 検索（検索＋本文取得を一度に。キー不要・サーバーIPで動作）
  //    クエリ（観光/グルメ/モデルコース）ごとに上位2件ずつ取り、偏りを防ぐ。
  for (const q of queries) {
    if (docs.length >= MAX_PAGES) break;
    const results = await jinaSearch(http, env, q);
    if (results.length) {
      engine = 'jina';
      candidates += results.length;
      pushDocs(docs, results.slice(0, 2));
    }
  }

  // 2) フォールバック: 他検索でURLを発見 → Jina Reader/直接で本文取得
  if (!docs.length) {
    // クエリごとの結果を交互に並べ、グルメ系クエリの結果も確実に拾う
    const perQuery: string[][] = [];
    for (const q of queries) {
      const s = await searchWeb(http, env, q);
      if (s.urls.length) {
        engine = s.engine;
        perQuery.push(s.urls);
      }
    }
    const urls: string[] = [];
    for (let i = 0; i < 6; i++) {
      for (const list of perQuery) {
        if (list[i] && !urls.includes(list[i])) urls.push(list[i]);
      }
    }
    candidates = urls.length;
    const seenHost = new Set<string>();
    for (const url of urls) {
      if (docs.length >= MAX_PAGES) break;
      const h = hostOf(url);
      if (!h || isExcludedHost(h) || seenHost.has(h)) continue;
      seenHost.add(h);
      const text = await readPage(http, env, url);
      if (text.length > 300) docs.push({ source: `web:${h}`, url, text });
    }
  }

  if (!docs.length) {
    return {
      ...empty,
      stats: { candidates, fetched: 0, engine },
      note: candidates
        ? '検索はできたが、ページ本文を取得できませんでした。'
        : '検索結果を取得できませんでした（検索サービスに到達できていない可能性）。',
    };
  }

  // 3) AI でスポット抽出（ページごとに並列実行して時間短縮）→ 保存
  const scrapedAt = new Date().toISOString();
  const perDoc = await Promise.all(
    docs.map(async (doc) => {
      try {
        const spots = await extractSpots(env, doc.text.slice(0, 6000), { area, interests: opts.interests });
        const events: NormalizedEvent[] = [];
        for (const s of spots) {
          const title = (s.title ?? '').trim();
          if (!title) continue;
          events.push({
            sourceEventId: `${doc.url}#${title}`,
            title,
            description: s.description?.trim() || undefined,
            url: doc.url,
            category: s.category || inferCategory(title, s.description) || '観光',
            prefecture: s.prefecture || inferPrefecture(title, s.description, s.city),
            city: s.city || area,
            raw: { from: doc.source, area },
          });
        }
        return { source: doc.source, events };
      } catch {
        return { source: doc.source, events: [] as NormalizedEvent[] };
      }
    }),
  );

  let total = 0;
  for (const { source, events } of perDoc) {
    if (events.length) total += await upsertEvents(env.DB, source, events, scrapedAt);
  }

  return {
    total,
    docs: docs.map((d) => ({ source: d.source, url: d.url })),
    stats: { candidates, fetched: docs.length, engine },
    note: total === 0 ? 'ページは取得できたが、AIがスポットを抽出できませんでした。' : undefined,
  };
}

/** Jina 検索（s.jina.ai）。検索結果に本文content付きで返る。 */
async function jinaSearch(
  http: HttpClient,
  env: Env,
  query: string,
): Promise<{ url: string; text: string }[]> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Retain-Images': 'none' };
    if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    const json = await http.getJson<any>(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      skipRobots: true,
      headers,
    });
    const data = Array.isArray(json?.data) ? json.data : [];
    const out: { url: string; text: string }[] = [];
    for (const r of data) {
      const url = r?.url;
      const text = r?.content || r?.description;
      if (typeof url === 'string' && typeof text === 'string' && text.length > 200) {
        out.push({ url, text });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** ページ本文取得: Jina Reader(r.jina.ai)優先（botブロック回避）→ 直接取得。 */
async function readPage(http: HttpClient, env: Env, url: string): Promise<string> {
  try {
    const headers: Record<string, string> = {};
    if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    const md = await http.getText(`https://r.jina.ai/${url}`, { skipRobots: true, headers });
    if (md && md.length > 300) return md;
  } catch {
    /* 直接取得にフォールバック */
  }
  try {
    const html = await http.getText(url, { skipRobots: true });
    return extractReadableText(html);
  } catch {
    return '';
  }
}

/** Brave API（キーがあれば）→ Bing → DuckDuckGo の順でURL候補を得る。 */
async function searchWeb(
  http: HttpClient,
  env: Env,
  query: string,
): Promise<{ urls: string[]; engine: string | null }> {
  if (env.BRAVE_API_KEY) {
    try {
      const json = await http.getJson<any>(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=jp&search_lang=jp&count=10`,
        { skipRobots: true, headers: { 'X-Subscription-Token': env.BRAVE_API_KEY, Accept: 'application/json' } },
      );
      const urls = (json?.web?.results ?? []).map((r: any) => r?.url).filter((u: any) => typeof u === 'string');
      if (urls.length) return { urls, engine: 'brave' };
    } catch {
      /* フォールバック */
    }
  }
  try {
    const html = await http.getText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja`, {
      skipRobots: true,
    });
    const urls = extractBingLinks(html);
    if (urls.length) return { urls, engine: 'bing' };
  } catch {
    /* フォールバック */
  }
  for (const [url, eng] of [
    [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 'ddg-html'],
    [`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, 'ddg-lite'],
  ] as const) {
    try {
      const html = await http.getText(url, { skipRobots: true });
      const urls = extractDdgLinks(html);
      if (urls.length) return { urls, engine: eng };
    } catch {
      /* 次へ */
    }
  }
  return { urls: [], engine: null };
}

function pushDocs(
  docs: { source: string; url: string; text: string }[],
  results: { url: string; text: string }[],
): void {
  for (const r of results) {
    if (docs.length >= MAX_PAGES) break;
    const h = hostOf(r.url);
    if (!h || isExcludedHost(h)) continue;
    if (docs.some((d) => hostOf(d.url) === h)) continue; // 同一ホストは1件まで
    docs.push({ source: `web:${h}`, url: r.url, text: r.text });
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isExcludedHost(host: string): boolean {
  return /duckduckgo\.com|google\.|bing\.com|yahoo\.co|youtube\.com|wikipedia\.org|wikivoyage\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|amazon\.|pinterest\.|jina\.ai/i.test(
    host,
  );
}

/** DuckDuckGo HTML 結果から実URLを取り出す（uddg リダイレクトを復元）。純粋関数。 */
export function extractDdgLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /uddg=([^"&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    try {
      const u = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(u) && !seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Bing 検索結果HTMLから結果URLを取り出す。純粋関数。 */
export function extractBingLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<h2>\s*<a[^>]+href="(https?:\/\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    const u = m[1].replace(/&amp;/g, '&');
    if (/bing\.com|microsoft\.com|msn\.com|go\.microsoft/i.test(u)) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function buildQueries(area: string, interests?: string[], keyword?: string): string[] {
  const queries: string[] = [];
  // キーワード（花火 等）があれば最優先で検索
  if (keyword && keyword.trim()) queries.push(`${area} ${keyword.trim()}`);
  queries.push(
    `${area} 観光 おすすめ スポット`,
    `${area} 人気 観光地 名所 ランキング`,
    `${area} グルメ ランチ 名物 おすすめ`,
    `${area} カフェ スイーツ おしゃれ`,
    `${area} イベント 体験 アクティビティ レジャー`,
    `${area} 旅行 ブログ モデルコース 巡り`,
  );
  if (interests && interests.length) {
    queries.push(`${area} ${interests.slice(0, 2).join(' ')} おすすめ`);
  }
  return queries;
}
