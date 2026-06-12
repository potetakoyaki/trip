---
name: scrape-source
description: >
  Use when adding or debugging a web-scraping / external-API data source in this Cloudflare
  Workers trip-planner — e.g. Walker Plus events, Rakuten Travel hotels, Jina reader/search,
  Nominatim/GSI geocoding, Gemini/Workers AI extraction, or JSON-LD parsing. Covers the
  standard collect → extract → normalize → D1-save flow, the hard-won gotchas (Rakuten
  429/Referer/dailyCharge-vs-hotelMinCharge, Walker Plus ar-codes, Jina rate limits,
  Nominatim 1 req/sec, D1 batch chunking, the AI fallback chain), and a JSON-LD probe script.
allowed-tools: Bash(node *), Bash(npm run typecheck), Bash(npm test), Bash(node --check *)
---

# 収集ソースの追加・デバッグ

このアプリ（Cloudflare Workers + Hono + D1 + Workers AI/Gemini の旅行プランナー）に、
Webスクレイピング/外部APIの「データ源」を足す・直すときの標準手順とハマりどころ集。

**前提**: 本番の収集は Worker 上で自走する。このSkillは「開発作業の手順書＋知見＋テスト用
スクリプト」であって、本番ランタイムや定期実行を置き換えるものではない。

## まず読むコード（実体）

| 役割 | ファイル | 主な関数 |
|---|---|---|
| Web自動収集の中核 | `src/scrape/autosource.ts` | `discoverAndScrape` / `collectEventSites` / `resolveEventSiteUrls` / `buildEventQueries` / `walkerplusArCode` / `fetchEventHtml` / `fetchPlainHtml` |
| JSON-LD抽出 | `src/scrape/jsonld.ts` | `extractJsonLdScripts`(HTMLRewriter・Worker専用) / `parseJsonLdEvents`(純粋関数) |
| AIスポット抽出 | `src/scrape/ai-extract.ts` | `extractSpots`（gemini-2.5-flash-lite, maxAttempts:1→Workers AI） |
| 楽天ホテル | `src/scrape/hotels.ts` | `rakutenHotelSearch` / `fetchVacantPrices` / `rakutenFetch` / `buildHotel` |
| ジオコーディング | `src/scrape/geocode.ts` | `geocodeQuery` / `reversePrefecture` / `reversePlaceName` / `geocodePlanItems` |
| D1アクセス | `src/db/repository.ts` | `upsertEvents`(チャンク書き込み) / `searchEvents` / `getEventSourceUrls`/`putEventSourceUrls` |
| 定期/cronドライバ | `src/sources/*` + `src/scrape/runner.ts` | `drivers`（connpass/rss/blog/jsonld/rakuten） |
| ルート/診断 | `src/api/routes.ts` | `/diag/ai` `/diag/hotel` `/diag/events` `/reverse-geocode` |

`NormalizedEvent` 型（`src/types.ts`）に正規化して `upsertEvents(db, source, events, scrapedAt)` で保存するのが共通ゴール。

## 標準フロー：イベント情報サイトを足す（最頻ケース）

`autosource.ts` の `collectEventSites` 系に乗せるのが基本。新規ドメインなら:

1. **URLを得る（検索に頼らない）**: 可能なら「県名→直URL」を組み立てる。Walker Plusは
   `walkerplusArCode(pref)` = `ar` + 地方2桁 + JIS2桁。`resolveEventSiteUrls` の解決順は
   **seedは廃止 → cache(DB) → arcode(組立+実在確認) → index(全国索引) → search(Jina/最後)**。
   検索(Jina)は枯渇しやすいので最後の手段。発見できたURLは `putEventSourceUrls` で県ごとにキャッシュ。
2. **HTML取得**: イベント詳細/リスト（JSON-LDあり）は `fetchEventHtml`（直接→失敗時 Jina の
   `X-Return-Format: html`）。ナビ等（JSON-LD無し）は `fetchPlainHtml`（直接優先・ld+json要求しない）。
3. **抽出**: `extractJsonLdScripts`(HTMLRewriter) → `parseJsonLdEvents`。schema.org の Event 系/Place系。
   本文しか取れない時は `extractSpots`（AI・Neuron消費）で `startDate/endDate` も取る。
4. **ページ送り**: `pageUrlFor(base, p)`（末尾 `/` のリストに `N.html`）。新規が出る限り深掘りし、
   `newEvents===0` で打ち切る適応型（`gatherEventSiteEvents` 参照）。
5. **正規化→保存**: `NormalizedEvent[]` にして `upsertEvents`。過去イベントは `isPastEventDate` で除外。
6. **可視化**: `/api/diag/events?area=...&month=...` に `diagCollectEventSites` の出力を出して**本番で実証**。
7. テストは純粋関数（`isEventSiteHost`/`buildEventQueries`/`pageUrlFor`/`walkerplusArCode`/`parseJsonLdEvents`）に。

`scripts/probe-jsonld.mjs` で、足したいURLにJSON-LDのEventが本当にあるかを**先に確認**できる
（ネット接続のある環境で `node .claude/skills/scrape-source/scripts/probe-jsonld.mjs <URL>`）。

## ハマりどころ集（公式ドキュメントに無い・今日まで実際に踏んだ罠）

詳細と背景は `reference.md` に。要点だけ:

- **D1 タイムアウト**（`storage operation exceeded timeout / object reset`）: `db.batch()` に大量
  ステートメントを渡すと出る。**25件ずつチャンク**で書く（`upsertEvents` 実装済み）。`raw` も短く（≤2000字）。
- **楽天 KeywordHotelSearch**: amenityをキーワードに足すと0件→条件破棄。**温泉系のみキーワード**、
  朝食/夕食等は取得後の **featureScore で並び替え**。ゲストハウス/キャンプ場は名称で除外。
- **楽天 VacantHotelSearch**: ① **1 req/秒**（超過で429）→ `rakutenFetch` が間隔制御+再試行。
  ② 新APIは **Referer 必須**（無いと403 `REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING`）→ origin から付与。
  ③ 価格は `hotelBasicInfo.hotelMinCharge`（底値）ではなく **`roomInfo[].dailyCharge.total`**（指定日の実部屋総額）。
- **Walker Plus**: スクレイピング（公式APIではない）。販売/再配布する場合はこの依存を外すこと。
- **Jina**: キー無しは即枯渇、キー有りも**トークン残高制**（マイナスで停止）。`fetch` は `Failed to fetch`
  になりがち → クライアントは `apiRetry`（ネット失敗のみ再試行）。本番収集は arcode/cache で **Jina非依存**に寄せる。
- **Nominatim**: **1 req/秒厳守**（`geocode.ts` で sleep 済み）。逆ジオは zoom 指定（県=8 / 市区町村=14）。
  オートコンプリート用途では使わない（静的 `places.ts` / GSI を使う）。
- **AI フォールバック連鎖**: Gemini → Workers AI(8b/70b) → ルールベース。`AiQuotaError` は枠切れ
  （別モデルでも回復しない）。2.5系は `thinkingConfig.thinkingBudget=0`。収集が空でもAIの一般知識でプラン化する。
- **キャッシュ事故**: API応答は no-store。PWAの `sw.js` はネット優先（過去にキャッシュ優先で古いJS配信の事故）。

## コミット前チェック（このリポジトリの約束）

```
npm run typecheck && npm test && node --check public/app.js
```
- 開発ブランチ `claude/magical-babbage-phhPA` にコミット → ドラフトPR → マージで本番。
- コミット/PRに**モデルIDを書かない**。秘密情報（APIキー）を同梱しない。
