import type { Env, NormalizedEvent } from '../types';
import { HttpClient } from './http';
import { extractReadableText } from './readable';
import { extractJsonLdScripts, parseJsonLdEvents } from './jsonld';
import { extractSpots } from './ai-extract';
import { upsertEvents, getEventSourceUrls, putEventSourceUrls } from '../db/repository';
import { inferCategory, inferPrefecture } from '../util/normalize';
import { prefectureOf } from '../data/places';

/**
 * 検証済みのウォーカープラス リストURL（都道府県→直URL）。検索(Jina)に頼らず直接取得できる。
 * ※ /api/diag/events の実データで確認できたものだけを載せる（憶測のコードは入れない）。
 *   ar0832 = 島根県（実データで確認済み）。他県は発見時にDBへ自動キャッシュされる。
 */
const KNOWN_WALKERPLUS: Record<string, string[]> = {
  島根県: ['https://www.walkerplus.com/event_list/ar0832/', 'https://hanabi.walkerplus.com/list/ar0832/'],
};

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

// イベント情報に強い大手サイト（schema.org の Event 構造化データを持つことが多い＝
// 正確な開催日が取れる）。ウォーカープラス等を直接ねらってイベントを補完する。
const EVENT_SITE_DOMAINS = [
  'walkerplus.com', // ウォーカープラス（全国の祭り・花火・イベント）
  'enjoytokyo.jp', // エンジョイ東京
  'jorudan.co.jp', // ジョルダン（イベント・花火）
  'iko-yo.net', // いこーよ（おでかけ・イベント）
  'omatsurijapan.com', // オマツリジャパン
];

/** イベント情報サイト（ウォーカープラス等）のホストか。サブドメイン(hanabi.walkerplus.com 等)も含む。 */
export function isEventSiteHost(host: string): boolean {
  const h = host.toLowerCase();
  return EVENT_SITE_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/** 旅行月に応じた季節イベントのキーワード（別ジャンルのリストを増やして件数を稼ぐ）。 */
function seasonalEventKeyword(month?: number): string {
  if (!month || month < 1 || month > 12) return '';
  if (month >= 3 && month <= 4) return '桜 花見';
  if (month >= 5 && month <= 6) return '新緑 バラ あじさい';
  if (month >= 7 && month <= 8) return '夏祭り 花火';
  if (month === 9) return '秋祭り コスモス';
  if (month >= 10 && month <= 11) return '紅葉 ライトアップ';
  return 'イルミネーション 初詣'; // 12〜2月
}

/**
 * イベント収集用の検索クエリ。検索（キー無しJina等）は数回で制限がかかるため、
 * クエリ数は絞り、ウォーカープラスを"最優先"に当てて確実にリストURLを得る。件数は
 * リストのページ送り(N.html)で稼ぐ方針（検索を増やすより堅牢で速い）。
 */
export function buildEventQueries(area: string, month?: number): string[] {
  const m = month && month >= 1 && month <= 12 ? `${month}月` : '';
  const season = seasonalEventKeyword(month);
  const raw = [
    `${area} イベント walkerplus`, // ← 最優先（event_list を当てる）
    `${area} 祭り 花火 walkerplus`, // ← hanabi 等の別ジャンルリスト
    season ? `${area} ${season} walkerplus` : '', // ← 季節もの(koyo等)
    `${area} イベント 開催 ${m}`, // 保険: 他イベントサイト/一般結果も拾う
  ];
  return raw.map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * ページ送りURL。p<=1 はベースURLそのまま、p>=2 は末尾スラッシュURLに N.html を付ける。
 * クエリ付き/末尾が非スラッシュのURLは段送り不可として null（誤URL生成を避ける）。
 * 例: event_list/ar0832/ + p2 → event_list/ar0832/2.html
 */
export function pageUrlFor(base: string, p: number): string | null {
  if (p <= 1) return base;
  const m = base.match(/^(https?:\/\/[^?#]*\/)$/);
  return m ? `${m[1]}${p}.html` : null;
}

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
    /** 旅行開始日 YYYY-MM-DD（季節イベントの月をイベント検索に反映）。 */
    startDate?: string;
    /** イベントサイトのページ送り取得上限。プランは控えめ・じっくり収集は深く。 */
    eventPages?: number;
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
  let jsonldEvents: NormalizedEvent[] = []; // schema.orgのEvent（正確な開催日つき）
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

  // 3.5) イベント情報サイト（ウォーカープラス等）を直接ねらい、開催日つきイベントを補完。
  //      schema.org の Event(JSON-LD) を読むだけなので AI(Neuron) を消費しない。best-effort。
  //      本文収集が空でもイベントだけは拾えるよう、docs有無の判定より前に実行する。
  try {
    const month = opts.startDate ? Number(opts.startDate.slice(5, 7)) : undefined;
    const eventSiteEvents = await collectEventSites(http, env, area, month, opts.eventPages ?? 24);
    for (const ev of eventSiteEvents) jsonldEvents.push({ ...ev, city: ev.city || area });
  } catch {
    /* イベントサイト収集は付加機能。失敗してもプラン作成は続ける */
  }

  // 終了済み（過去）のイベントは保存しない（2025年など古い催しの混入・DB汚染を防ぐ）。
  // 開催日不明のスポット/イベントは残す。
  const today = new Date().toISOString().slice(0, 10);
  jsonldEvents = jsonldEvents.filter((e) => !isPastEventDate(e, today));

  if (!docs.length) {
    // 本文は取れなくても、イベントサイトから開催日つきイベントが取れていれば保存して返す。
    let saved = 0;
    if (jsonldEvents.length) {
      saved = await upsertEvents(env.DB, 'jsonld', jsonldEvents, new Date().toISOString());
    }
    return {
      ...empty,
      total: saved,
      stats: { candidates, fetched: 0, engine },
      note: saved
        ? `本文は取得できませんでしたが、イベント情報を${saved}件取得しました。`
        : candidates
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

/** 都道府県名から接尾辞を外した照合用の名前（島根県→島根 / 東京都→東京 / 北海道→北海道）。 */
function prefBareName(prefecture: string): string {
  return prefecture.replace(/[都府県]$/, '');
}

/**
 * Walker Plus の全国イベントインデックスHTMLから、指定都道府県の ar コードを探す。
 * 例: <a href="/event_list/ar0832/">島根</a> → "ar0832"。県名は接尾辞あり/なし両対応。
 * 純粋関数（テスト可能）。検索(Jina)に頼らずコードを得る要。
 */
export function findWalkerplusArCode(html: string, prefecture: string): string | null {
  const bare = prefBareName(prefecture);
  if (!bare) return null;
  const re = /\/event_list\/(ar\d{3,4})\/"[^>]*>\s*([^<]{1,24})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const code = m[1];
    const label = m[2].trim();
    if (label && (label.includes(bare) || bare.includes(label))) return code;
  }
  return null;
}

/** Walker Plus の ar コードから、収集に使うリストURL（一般＋花火）を組み立てる。 */
function walkerplusUrlsForCode(code: string): string[] {
  return [`https://www.walkerplus.com/event_list/${code}/`, `https://hanabi.walkerplus.com/list/${code}/`];
}

/**
 * 生HTMLを取得する（JSON-LDの有無を問わない）。Walker Plusのインデックス等、ナビだけの
 * ページ用。直接取得を最優先（walkerplusはサーバー直取得が通る）。空/失敗時のみ Jina(html)。
 * ※ fetchEventHtml は ld+json を含むページだけを「直接成功」とみなすため、ld+jsonを持たない
 *   インデックスでは使えない（Jina枯渇に巻き込まれる）。ここは専用の素直な直接取得にする。
 */
async function fetchPlainHtml(http: HttpClient, env: Env, url: string): Promise<string> {
  try {
    const html = await http.getText(url, { skipRobots: true });
    if (html) return html;
  } catch {
    /* 直接取得失敗 → Jina へ */
  }
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'html' };
    if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    return (await http.getText(`https://r.jina.ai/${url}`, { skipRobots: true, headers })) || '';
  } catch {
    return '';
  }
}

/**
 * Walker Plus 全国インデックスを「生HTMLで」直接取得し、その県の ar コードからリストURLを得る。
 * インデックスは JSON-LD を持たないので fetchPlainHtml で取る（＝Jina非依存・枯渇に巻き込まれない）。
 */
async function discoverWalkerplusFromIndex(http: HttpClient, env: Env, prefecture: string): Promise<string[]> {
  const html = await fetchPlainHtml(http, env, 'https://www.walkerplus.com/event_list/');
  if (!html) return [];
  const code = findWalkerplusArCode(html, prefecture);
  return code ? walkerplusUrlsForCode(code) : [];
}

/**
 * イベントサイトのリストURLを決める（Jina非依存を最優先）。
 * 1) 既知（検証済み・内蔵）→ 2) DBキャッシュ → 3) Walker Plus 全国インデックスから直接発見
 * → 4) 検索で発見（Jina等・最後の手段）。1〜3 は検索不要でレート制限に強い。発見したら県毎にキャッシュ。
 */
async function resolveEventSiteUrls(
  http: HttpClient,
  env: Env,
  area: string,
  month?: number,
): Promise<{ urls: string[]; prefecture?: string; source: 'seed' | 'cache' | 'index' | 'search' }> {
  const pref = prefectureOf(area);
  if (pref && KNOWN_WALKERPLUS[pref]) return { urls: KNOWN_WALKERPLUS[pref], prefecture: pref, source: 'seed' };
  if (pref) {
    const cached = await getEventSourceUrls(env.DB, pref).catch(() => [] as string[]);
    if (cached.length) return { urls: cached, prefecture: pref, source: 'cache' };
  }
  if (pref) {
    const idx = await discoverWalkerplusFromIndex(http, env, pref).catch(() => [] as string[]);
    if (idx.length) {
      await putEventSourceUrls(env.DB, pref, idx).catch(() => {});
      return { urls: idx, prefecture: pref, source: 'index' };
    }
  }
  const found = await searchEventSiteUrls(http, env, area, month);
  if (found.length && pref) await putEventSourceUrls(env.DB, pref, found).catch(() => {});
  return { urls: found, prefecture: pref, source: 'search' };
}

/** イベントサイトのURLを検索で集める（ウォーカープラス等のホストだけ残す）。 */
async function searchEventSiteUrls(http: HttpClient, env: Env, area: string, month?: number): Promise<string[]> {
  const queries = buildEventQueries(area, month);
  const urls: string[] = [];
  for (const q of queries) {
    if (urls.length >= 16) break;
    let found: string[] = [];
    try {
      found = (await jinaSearch(http, env, q)).map((r) => r.url);
    } catch {
      /* jina 不調 */
    }
    if (!found.length) {
      try {
        found = (await searchWeb(http, env, q)).urls;
      } catch {
        found = [];
      }
    }
    for (const u of found) {
      const h = hostOf(u);
      if (h && isEventSiteHost(h) && !urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

/**
 * イベントページの生HTML（JSON-LD入り）を取得する。
 * 1) 直接取得（速い・JSON-LDそのまま）。2) ボットブロックで弾かれたら Jina Reader を
 * html返却モード（X-Return-Format: html）で。サーバーIP＋bot回避でld+jsonを保持できる。
 * 返り値の via で、どの経路で取れたか（または失敗か）が分かる。
 */
async function fetchEventHtml(
  http: HttpClient,
  env: Env,
  url: string,
): Promise<{ html: string; via: 'direct' | 'jina' | 'fail' }> {
  try {
    const html = await http.getText(url, { skipRobots: true });
    if (html && html.includes('application/ld+json')) return { html, via: 'direct' };
  } catch {
    /* 直接取得が弾かれた → Jina へ */
  }
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'html' };
    if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    const html = await http.getText(`https://r.jina.ai/${url}`, { skipRobots: true, headers });
    if (html) return { html, via: 'jina' };
  } catch {
    /* Jina も失敗 */
  }
  return { html: '', via: 'fail' };
}

interface EventPageLog {
  url: string;
  via: 'direct' | 'jina' | 'fail';
  jsonldBlocks: number;
  newEvents: number;
}

/**
 * 各リストURLを「新規イベントが出る限り」ページ送りで深掘りする適応型収集。
 * あるページが新規0件（尽きた/重複/失敗）になったら、そのリストは打ち切って次のリストへ。
 * これで生きているリスト(www event_list等)を深く掘り、死にページ(hanabiの2頁目以降等)に
 * 取得枠を浪費しない。schema.orgのEventを読むだけでAI(Neuron)は消費しない。
 */
async function gatherEventSiteEvents(
  http: HttpClient,
  env: Env,
  baseUrls: string[],
  maxPages: number,
  perBaseMax = 25,
): Promise<{ events: NormalizedEvent[]; pages: EventPageLog[] }> {
  const seen = new Set<string>();
  const events: NormalizedEvent[] = [];
  const pages: EventPageLog[] = [];
  let fetched = 0;
  for (const base of baseUrls) {
    for (let p = 1; p <= perBaseMax && fetched < maxPages; p++) {
      const url = pageUrlFor(base, p);
      if (!url) break;
      const { html, via } = await fetchEventHtml(http, env, url);
      fetched++;
      let jsonldBlocks = 0;
      let parsed: NormalizedEvent[] = [];
      if (html) {
        try {
          const scripts = await extractJsonLdScripts(html);
          jsonldBlocks = scripts.length;
          parsed = parseJsonLdEvents(scripts);
        } catch {
          /* 解析失敗 */
        }
      }
      let newCount = 0;
      for (const ev of parsed) {
        const key = ev.sourceEventId || ev.url || ev.title;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        events.push(ev);
        newCount++;
      }
      pages.push({ url, via, jsonldBlocks, newEvents: newCount });
      if (newCount === 0) break; // このリストは尽きた → 次のリストへ
    }
  }
  return { events, pages };
}

/**
 * イベント情報サイト（ウォーカープラス等）からイベントを収集する。
 * リストURL（内蔵/キャッシュ/検索で解決）を適応型ページ送りで深掘りする。
 */
async function collectEventSites(
  http: HttpClient,
  env: Env,
  area: string,
  month?: number,
  maxPages = 24,
): Promise<NormalizedEvent[]> {
  const { urls } = await resolveEventSiteUrls(http, env, area, month);
  const { events } = await gatherEventSiteEvents(http, env, urls, maxPages);
  return events;
}

/**
 * 診断用: イベントサイト収集の各段階を可視化する（/api/diag/events）。
 * どのリストURLを使い、何ページ取得し、重複除去/過去除外後に何件になるかを返す。
 * 「本当にウォーカープラス等から十分な件数が取れているか」を本番で実証するため。
 */
export async function diagCollectEventSites(env: Env, area: string, month?: number, maxPages = 24) {
  const http = new HttpClient({ userAgent: BROWSER_UA, minIntervalMs: 600 });
  const queries = buildEventQueries(area, month);
  const { urls: base, prefecture, source } = await resolveEventSiteUrls(http, env, area, month);
  const { events: distinct, pages } = await gatherEventSiteEvents(http, env, base, maxPages);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = distinct.filter((e) => !isPastEventDate(e, today));
  return {
    area,
    prefecture,
    source, // seed(内蔵) / cache(DB) / search(検索)。Jina非依存かどうかが分かる。
    hasJinaKey: !!env.JINA_API_KEY, // アプリ(Worker)がJinaキーを認識しているか
    month,
    queries,
    eventSiteUrls: base,
    fetchedPages: pages.length,
    distinctEvents: distinct.length,
    upcomingEvents: upcoming.length, // 実際に保存される件数（過去除外後）
    perPage: pages, // url/via/jsonldBlocks/newEvents
    sample: upcoming.slice(0, 20).map((e) => ({ title: e.title, startAt: e.startAt, endAt: e.endAt, url: e.url })),
  };
}

/**
 * 終了日（無ければ開催日）が「今日」より前なら過去イベントと判定する。
 * 開催日が分からないもの（通常の観光スポット等）は過去扱いしない（false）。
 * todayStr は "YYYY-MM-DD"。日付文字列の先頭10桁を辞書順比較するのでタイムゾーン非依存。
 */
export function isPastEventDate(ev: { startAt?: string; endAt?: string }, todayStr: string): boolean {
  const d = (ev.endAt || ev.startAt || '').slice(0, 10);
  if (!d) return false;
  return d < todayStr;
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
