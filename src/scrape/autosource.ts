import type { Env, NormalizedEvent } from '../types';
import { HttpClient } from './http';
import { extractReadableText } from './readable';
import { extractJsonLdScripts, parseJsonLdEvents } from './jsonld';
import { extractSpots } from './ai-extract';
import { upsertEvents } from '../db/repository';
import { inferCategory, inferPrefecture } from '../util/normalize';

export interface DiscoverResult {
  total: number;
  docs: { source: string; url: string }[];
  stats: { candidates: number; fetched: number; engine: string | null };
  note?: string;
}

// 1エリアあたりに扱う大手サイト/ブログのページ数。1ページ＝AI抽出1回（Neuron消費）。
// 無料枠の節約のため控えめにする（じっくり収集は別途ラウンドで追加収集できる）。
const MAX_PAGES = 6;

// イベントらしいページの手がかり（JSON-LD補完の対象を絞る）。
const EVENT_HINT = /祭り|まつり|花火|フェス|イベント|開催|ライトアップ|マルシェ|展|ナイト/;

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
  opts: {
    area: string;
    interests?: string[];
    keyword?: string;
    queries?: string[];
    maxPages?: number;
    /** 本文取得が終わり、AI抽出（重い工程）を始める直前に呼ばれる。進捗表示用。 */
    onExtractStart?: () => void | Promise<void>;
    /** 検索結果の取得開始位置。再収集時に深い結果を取って新規を増やす。 */
    resultOffset?: number;
  },
): Promise<DiscoverResult> {
  const area = opts.area.trim();
  const empty: DiscoverResult = { total: 0, docs: [], stats: { candidates: 0, fetched: 0, engine: null } };
  if (!area) return { ...empty, note: 'エリアが空です' };
  if (!env.AI) return { ...empty, note: 'Workers AI(env.AI) が無効です' };

  // 同サービス（Jina/検索）への連続呼び出しを少し速める。対象サイト各ホストは
  // 1回ずつなのでレート制限の実害はほぼ無い。
  const http = new HttpClient({ userAgent: BROWSER_UA, minIntervalMs: 600 });
  const queries = opts.queries?.length ? opts.queries : buildQueries(area, opts.interests, opts.keyword);
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const offset = Math.max(0, opts.resultOffset ?? 0); // 再収集の深さ

  const docs: { source: string; url: string; text: string }[] = [];
  const jsonldEvents: NormalizedEvent[] = []; // schema.orgのEvent（正確な開催日つき）
  let engine: string | null = null;
  let candidates = 0;

  // 1) Jina 検索（検索＋本文取得を一度に。キー不要・サーバーIPで動作）
  //    クエリ（観光/グルメ/モデルコース）ごとに上位2件ずつ取り、偏りを防ぐ。
  for (const q of queries) {
    if (docs.length >= maxPages) break;
    const results = await jinaSearch(http, env, q);
    if (results.length) {
      engine = 'jina';
      candidates += results.length;
      pushDocs(docs, results.slice(offset, offset + 2), maxPages);
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
    for (let i = offset; i < offset + 6; i++) {
      for (const list of perQuery) {
        if (list[i] && !urls.includes(list[i])) urls.push(list[i]);
      }
    }
    candidates = urls.length;
    const seenHost = new Set<string>();
    for (const url of urls) {
      if (docs.length >= maxPages) break;
      const h = hostOf(url);
      if (!h || isExcludedHost(h) || seenHost.has(h)) continue;
      seenHost.add(h);
      const page = await readPage(http, env, url);
      if (page.text.length > 300) docs.push({ source: `web:${h}`, url, text: page.text });
      // city が空のイベントもこのエリアの収集なので area を既定にして、確実に検索でヒットさせる。
      for (const ev of page.events) jsonldEvents.push({ ...ev, city: ev.city || area });
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

  // 3) AI でスポット抽出 → 保存。抽出は flash-lite（高RPM）を使うので同時実行を5本まで上げ、
  // 速度を改善する（失敗分は Workers AI に即フォールバック）。
  if (opts.onExtractStart) await opts.onExtractStart();
  const scrapedAt = new Date().toISOString();
  const perDoc = await mapLimit(docs, 5, async (doc) => {
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
          hours: s.hours?.trim() || undefined,
          startAt: isoDate(s.startDate),
          endAt: isoDate(s.endDate),
          raw: { from: doc.source, area },
        });
      }
      // Jina経路は本文（整形済みテキスト）しか得られず、JSON-LD（schema.orgの
      // 正確な開催日つきEvent）が取れない。イベントらしいページに限り生HTMLを直接
      // 取得して JSON-LD を補完する（祭り・花火等の開催日を正確に拾うため。件数は
      // 控えめ・失敗は無視で、速度への影響を最小化）。
      if (engine === 'jina' && EVENT_HINT.test(doc.text)) {
        try {
          const html = await http.getText(doc.url, { skipRobots: true });
          const scripts = await extractJsonLdScripts(html);
          // city が空のイベントもこのエリアの収集なので area を既定に（title頼みの検索を避ける）。
          for (const ev of parseJsonLdEvents(scripts)) events.push({ ...ev, city: ev.city || area });
        } catch {
          /* JSON-LD補完の失敗は無視（本文抽出のイベントで代替） */
        }
      }
      return { source: doc.source, events };
    } catch {
      return { source: doc.source, events: [] as NormalizedEvent[] };
    }
  });

  let total = 0;
  for (const { source, events } of perDoc) {
    if (events.length) total += await upsertEvents(env.DB, source, events, scrapedAt);
  }
  // JSON-LD（schema.org）から拾った正確な開催日つきイベントも保存。
  if (jsonldEvents.length) {
    total += await upsertEvents(env.DB, 'jsonld', jsonldEvents, scrapedAt);
  }

  return {
    total,
    docs: docs.map((d) => ({ source: d.source, url: d.url })),
    stats: { candidates, fetched: docs.length, engine },
    note: total === 0 ? 'ページは取得できたが、AIがスポットを抽出できませんでした。' : undefined,
  };
}

/** "YYYY-MM-DD" 形式のみを ISO 日時に変換。妥当な年でなければ undefined（創作日付の混入防止）。 */
function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
}

/** 同時実行数を limit に抑えて配列を非同期マップする（順序は保持）。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
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

/**
 * ページ本文取得＋JSON-LDイベント抽出。
 * - JINA_API_KEYがあれば Jina Reader 優先（botブロック回避）。
 * - 無ければ「直接取得」を優先（無料Jinaは枠切れしやすいため）。
 * 直接取得できたときは HTML から schema.org の Event/観光スポット（正確な開催日つき）も拾う。
 */
async function readPage(http: HttpClient, env: Env, url: string): Promise<{ text: string; events: NormalizedEvent[] }> {
  const hasKey = !!env.JINA_API_KEY;
  const tryJina = async (): Promise<string> => {
    const headers: Record<string, string> = {};
    if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    const md = await http.getText(`https://r.jina.ai/${url}`, { skipRobots: true, headers });
    return md && md.length > 300 ? md : '';
  };
  const tryDirect = async (): Promise<{ text: string; events: NormalizedEvent[] }> => {
    const html = await http.getText(url, { skipRobots: true });
    let events: NormalizedEvent[] = [];
    try {
      const scripts = await extractJsonLdScripts(html);
      if (scripts.length) events = parseJsonLdEvents(scripts);
    } catch {
      /* JSON-LD抽出失敗は無視 */
    }
    return { text: extractReadableText(html), events };
  };

  if (hasKey) {
    try {
      const md = await tryJina();
      if (md) return { text: md, events: [] };
    } catch {
      /* 直接へ */
    }
    try {
      return await tryDirect();
    } catch {
      return { text: '', events: [] };
    }
  }
  // キー無し: 直接取得を優先（Jina枠切れ対策）→ ダメなら Jina Reader
  try {
    const d = await tryDirect();
    if (d.text.length > 300 || d.events.length) return d;
  } catch {
    /* Jinaへ */
  }
  try {
    const md = await tryJina();
    if (md) return { text: md, events: [] };
  } catch {
    /* 諦め */
  }
  return { text: '', events: [] };
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
  limit: number,
): void {
  for (const r of results) {
    if (docs.length >= limit) break;
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

// 「じっくり収集」用：多様な切り口の検索テンプレート。ラウンドごとに別の角度で集める。
const DEEP_TEMPLATES = [
  '観光 おすすめ スポット',
  '人気 観光地 名所 ランキング',
  'グルメ ランチ 名物 おすすめ',
  'カフェ スイーツ おしゃれ',
  'イベント 体験 アクティビティ レジャー',
  '旅行 ブログ モデルコース 巡り',
  '神社 寺 歴史 名所',
  '自然 絶景 公園 海 山',
  '穴場 隠れ家 ローカル おすすめ',
  '子供 家族 遊び場',
  'デート カップル おすすめ',
  '夜景 夕日 ビュースポット',
  'お土産 ショッピング 市場',
  '温泉 日帰り 銭湯',
  '美術館 アート 博物館',
  'インスタ 映え フォトスポット',
];
const DEEP_PER_ROUND = 3;

/** ラウンドごとの検索クエリ群と総ラウンド数を返す（じっくり収集用）。 */
export function roundQueries(
  area: string,
  round: number,
  keyword?: string,
): { queries: string[]; totalRounds: number } {
  const totalRounds = Math.ceil(DEEP_TEMPLATES.length / DEEP_PER_ROUND);
  const start = (Math.max(1, round) - 1) * DEEP_PER_ROUND;
  const slice = DEEP_TEMPLATES.slice(start, start + DEEP_PER_ROUND);
  const queries = slice.map((t) => `${area} ${t}`);
  if (round === 1 && keyword && keyword.trim()) queries.unshift(`${area} ${keyword.trim()}`);
  return { queries, totalRounds };
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
