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

const MAX_PAGES = 4; // 1エリアあたりに読む大手サイト/ブログのページ数

// 自動収集は一般サイト/検索を相手にするため、通常のブラウザとして振る舞う
// （bot 用UAだと空ページやブロックを返されやすいため）。レート制限は維持。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * ユーザーがソースを登録しなくても、エリア名から自動で情報源を集めて
 * AI で旅行スポットを抽出・保存する（「サイトはアプリが自動で決める」動作）。
 *
 * Web検索で「<エリア> 観光 おすすめ」等を引き、上位の大手旅行サイト・ブログ記事を
 * 数件スクレイピングして Workers AI で構造化する。
 * 検索は Brave API（キーがあれば最優先・確実）→ Bing → DuckDuckGo の順で試す。
 */
export async function discoverAndScrape(
  env: Env,
  opts: { area: string; interests?: string[] },
): Promise<DiscoverResult> {
  const area = opts.area.trim();
  const empty: DiscoverResult = { total: 0, docs: [], stats: { candidates: 0, fetched: 0, engine: null } };
  if (!area) return { ...empty, note: 'エリアが空です' };
  if (!env.AI) return { ...empty, note: 'Workers AI(env.AI) が無効です' };

  const http = new HttpClient({ userAgent: BROWSER_UA });

  // 1) 検索で候補URLを集める
  let candidates: string[] = [];
  let engine: string | null = null;
  for (const q of buildQueries(area, opts.interests)) {
    const r = await searchWeb(http, env, q);
    if (r.urls.length) {
      engine = r.engine;
      for (const u of r.urls) if (!candidates.includes(u)) candidates.push(u);
    }
    if (candidates.length >= 12) break;
  }

  if (!candidates.length) {
    return {
      ...empty,
      note: '検索結果を取得できませんでした（検索エンジンがサーバーからのアクセスをブロックしている可能性）。Brave Search API キーの設定を推奨します。',
    };
  }

  // 2) 上位候補を、ホスト重複を避けつつ本文取得
  const docs: { source: string; url: string; text: string }[] = [];
  const seenHost = new Set<string>();
  for (const link of candidates) {
    if (docs.length >= MAX_PAGES) break;
    let host: string;
    try {
      host = new URL(link).host;
    } catch {
      continue;
    }
    if (isExcludedHost(host) || seenHost.has(host)) continue;
    seenHost.add(host);
    try {
      const html = await http.getText(link, { skipRobots: true });
      const text = extractReadableText(html);
      if (text.length > 300) docs.push({ source: `web:${host}`, url: link, text });
    } catch {
      /* この記事はスキップ */
    }
  }

  // 3) AI で旅行スポットを抽出して保存
  const scrapedAt = new Date().toISOString();
  let total = 0;
  for (const doc of docs) {
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
          city: s.city || area, // エリアで確実に引っかかるように
          raw: { from: doc.source, area },
        });
      }
      total += await upsertEvents(env.DB, doc.source, events, scrapedAt);
    } catch {
      /* 1ページの抽出失敗は無視して次へ */
    }
  }

  const stats = { candidates: candidates.length, fetched: docs.length, engine };
  let note: string | undefined;
  if (docs.length === 0) note = '検索はできたが、ページ本文を取得できませんでした（各サイトがブロックしている可能性）。';
  else if (total === 0) note = 'ページは取得できたが、AIがスポットを抽出できませんでした。';

  return { total, docs: docs.map((d) => ({ source: d.source, url: d.url })), stats, note };
}

/** 検索: Brave API（キーがあれば）→ Bing → DuckDuckGo の順に試す。 */
async function searchWeb(
  http: HttpClient,
  env: Env,
  query: string,
): Promise<{ urls: string[]; engine: string | null }> {
  // Brave Search API（キーがあれば最優先・最も確実）
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

  // Bing（サーバーIPに比較的寛容）
  try {
    const html = await http.getText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja`, {
      skipRobots: true,
    });
    const urls = extractBingLinks(html);
    if (urls.length) return { urls, engine: 'bing' };
  } catch {
    /* フォールバック */
  }

  // DuckDuckGo（html / lite）
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

function isExcludedHost(host: string): boolean {
  return /duckduckgo\.com|google\.|bing\.com|yahoo\.co|youtube\.com|wikipedia\.org|wikivoyage\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|amazon\.|pinterest\./i.test(
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

function buildQueries(area: string, interests?: string[]): string[] {
  const queries = [`${area} 観光 おすすめ スポット`, `${area} 旅行 ブログ おすすめ`];
  if (interests && interests.length) {
    queries.push(`${area} ${interests.slice(0, 2).join(' ')} おすすめ`);
  }
  return queries;
}
