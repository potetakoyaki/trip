#!/usr/bin/env node
// 収集ソース候補のURLに schema.org の Event / Place(JSON-LD) があるか手早く確認するツール。
// 使い方:  node .claude/skills/scrape-source/scripts/probe-jsonld.mjs <URL> [--html-via-jina]
//
// - 直接取得を試し、ld+json が無ければ Jina Reader(html返却) でも試す（--html-via-jina or 自動）。
// - 本番Worker は HTMLRewriter で抽出するが、これは開発確認用に正規表現で <script type=ld+json> を拾う簡易版。
// - 要ネット接続。サンドボックス等の許可リスト環境では弾かれることがある（その場合はローカルで実行）。
//
// 出力: 見つかった Event/Place の name / startDate / endDate / url を一覧表示。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EVENT_TYPES = new Set([
  'Event', 'Festival', 'MusicEvent', 'TheaterEvent', 'ExhibitionEvent', 'FoodEvent',
  'SportsEvent', 'SocialEvent', 'BusinessEvent', 'EducationEvent', 'ScreeningEvent',
  'ComedyEvent', 'DanceEvent', 'VisualArtsEvent',
]);
const PLACE_TYPES = new Set([
  'TouristAttraction', 'LandmarksOrHistoricalBuildings', 'Museum', 'Park',
  'LodgingBusiness', 'Hotel', 'Resort', 'Campground', 'Restaurant',
]);

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const asStr = (v) =>
  typeof v === 'string' ? v.trim() : v && typeof v === 'object' && typeof v['@value'] === 'string' ? v['@value'].trim() : undefined;

function collectNodes(data, out) {
  if (Array.isArray(data)) for (const d of data) collectNodes(d, out);
  else if (data && typeof data === 'object') {
    if (Array.isArray(data['@graph'])) collectNodes(data['@graph'], out);
    if (data['@type']) out.push(data);
  }
}

function extractLdJson(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1].trim());
  return out;
}

async function fetchDirect(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  return { ok: res.ok, status: res.status, html: await res.text() };
}
async function fetchViaJina(url) {
  const headers = { 'X-Return-Format': 'html' };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  return { ok: res.ok, status: res.status, html: await res.text() };
}

async function main() {
  const url = process.argv[2];
  const forceJina = process.argv.includes('--html-via-jina');
  if (!url) {
    console.error('usage: node probe-jsonld.mjs <URL> [--html-via-jina]');
    process.exit(1);
  }

  let via = 'direct';
  let r;
  try {
    r = forceJina ? await fetchViaJina(url) : await fetchDirect(url);
    if (forceJina) via = 'jina';
  } catch (e) {
    console.error('direct fetch failed:', e.message);
    r = { ok: false, html: '' };
  }
  if (!forceJina && (!r.ok || !r.html.includes('application/ld+json'))) {
    try {
      const j = await fetchViaJina(url);
      if (j.html) {
        r = j;
        via = 'jina';
      }
    } catch (e) {
      /* keep direct */
    }
  }

  console.log(`fetched via: ${via}  status: ${r.status ?? '?'}  htmlLen: ${r.html.length}`);
  const scripts = extractLdJson(r.html);
  console.log(`ld+json blocks: ${scripts.length}`);

  const nodes = [];
  for (const s of scripts) {
    try {
      collectNodes(JSON.parse(s), nodes);
    } catch {
      /* skip invalid json */
    }
  }

  const hits = [];
  for (const n of nodes) {
    const types = arr(n['@type']).map(String);
    const isEvent = types.some((t) => EVENT_TYPES.has(t));
    const isPlace = types.some((t) => PLACE_TYPES.has(t));
    if (!isEvent && !isPlace) continue;
    const name = asStr(n.name);
    if (!name) continue;
    hits.push({
      type: isEvent ? 'Event' : 'Place',
      name,
      startDate: asStr(n.startDate),
      endDate: asStr(n.endDate),
      url: asStr(n.url),
    });
  }

  console.log(`Event/Place found: ${hits.length}`);
  for (const h of hits.slice(0, 40)) {
    const d = [h.startDate, h.endDate].filter(Boolean).join(' 〜 ');
    console.log(`- [${h.type}] ${h.name}${d ? `  (${d})` : ''}${h.url ? `  ${h.url}` : ''}`);
  }
  if (!hits.length) {
    console.log('→ JSON-LD の Event/Place は見つからず。本文をAI抽出(extractSpots)に回すか、別URL/別ソースを検討。');
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
