import type { Env, NormalizedEvent } from '../types';
import { HttpClient } from './http';
import { extractReadableText } from './readable';
import { extractSpots } from './ai-extract';
import { upsertEvents } from '../db/repository';
import { inferCategory, inferPrefecture } from '../util/normalize';

export interface DiscoverResult {
  total: number;
  docs: { source: string; url: string }[];
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
 * Web検索（DuckDuckGo）で「<エリア> 観光 おすすめ」等を引き、上位に出る
 * 大手旅行サイト・ブログ記事を数件スクレイピングして、Workers AI で構造化する。
 * env.AI（Workers AI）が無ければ何もしない。
 */
export async function discoverAndScrape(
  env: Env,
  opts: { area: string; interests?: string[] },
): Promise<DiscoverResult> {
  const area = opts.area.trim();
  if (!area || !env.AI) return { total: 0, docs: [] };

  const http = new HttpClient({ userAgent: BROWSER_UA });

  // 1) 検索で候補URLを集める（大手サイト・ブログが上位に来る）
  const candidates: string[] = [];
  const seenUrl = new Set<string>();
  for (const q of buildQueries(area, opts.interests)) {
    const links = await searchWeb(http, q);
    for (const l of links) {
      if (!seenUrl.has(l)) {
        seenUrl.add(l);
        candidates.push(l);
      }
    }
    if (candidates.length >= 12) break;
  }

  // 2) 上位の候補を、ホスト重複を避けつつ本文取得
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
    if (isExcludedHost(host)) continue;
    if (seenHost.has(host)) continue;
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
          // エリアで確実に引っかかるよう、市区町村が無ければエリア名を入れる
          city: s.city || area,
          raw: { from: doc.source, area },
        });
      }
      total += await upsertEvents(env.DB, doc.source, events, scrapedAt);
    } catch {
      /* 1ページの抽出失敗は無視して次へ */
    }
  }

  return { total, docs: docs.map((d) => ({ source: d.source, url: d.url })) };
}

/** 検索エンジン自身や非コンテンツのホストを除外（大手旅行サイト・ブログは通す）。 */
function isExcludedHost(host: string): boolean {
  return /duckduckgo\.com|google\.|bing\.com|yahoo\.co|youtube\.com|wikipedia\.org|wikivoyage\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|amazon\.|pinterest\./i.test(
    host,
  );
}

/** DuckDuckGo（lite/html）で検索し、結果の実URL一覧を返す。 */
async function searchWeb(http: HttpClient, query: string): Promise<string[]> {
  for (const url of [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ]) {
    try {
      const html = await http.getText(url, { skipRobots: true });
      const links = extractDdgLinks(html);
      if (links.length) return links;
    } catch {
      /* 次のエンドポイントを試す */
    }
  }
  return [];
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

function buildQueries(area: string, interests?: string[]): string[] {
  const queries = [`${area} 観光 おすすめ スポット`, `${area} 旅行 ブログ おすすめ`];
  if (interests && interests.length) {
    queries.push(`${area} ${interests.slice(0, 2).join(' ')} おすすめ`);
  }
  return queries;
}
