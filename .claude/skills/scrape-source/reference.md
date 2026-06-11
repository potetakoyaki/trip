# 収集ソース：詳細リファレンス（ハマりどころの背景）

SKILL.md の要点の根拠・背景。深掘りが要るときだけ読む。

## 楽天トラベル（`src/scrape/hotels.ts`）

新エンドポイント（旧 app.rakuten.co.jp は 2026/5 停止）:
- KeywordHotelSearch: `https://openapi.rakuten.co.jp/engine/api/Travel/KeywordHotelSearch/20170426`
- VacantHotelSearch:  `https://openapi.rakuten.co.jp/engine/api/Travel/VacantHotelSearch/20170426`
- 認証は `applicationId` + `accessKey`（pk_キー）。

### 罠と対処
1. **429 Rate limit**（`{"statusCode":429,"message":"Rate limit is exceeded. Try again in 1 seconds."}`）
   - 楽天は **1 req/秒**。Keyword複数ページ→Vacant を間隔なしで連射すると出る。
   - 対処: `rakutenFetch()` がモジュール内で直近呼び出しから 1.1s 空け、429なら待って再試行。
2. **403 Referer 欠落**（`{"errors":{"errorCode":403,"errorMessage":"REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING"}}`）
   - 新APIは `Origin`/`Referer` 必須。`createPlan(env, body, origin)` の origin（`reqOrigin`）を
     `fetchRakutenHotels`→`rakutenHotelSearch`→`fetchVacantPrices` まで渡し、ヘッダに付ける。
   - `/api/diag/hotel` の生Vacant fetchにも付けること（付け忘れると診断だけ403になり誤診する）。
3. **価格の取り違え**: `hotelBasicInfo.hotelMinCharge` は「全プランの底値（相部屋の人数割り等）」で、
   指定日の実価格ではない。**`wrap.hotel[].roomInfo[].dailyCharge.total` の最小**を使う（1室1泊総額）。
   UIは「1室いくら」表示（人数で割らない）。
4. **絞り込み**: amenity語をキーワードに入れると名称マッチで0件→fallbackで条件破棄。
   キーワードには **温泉/露天風呂/大浴場のみ**。他（朝食/夕食/Wi-Fi/駅近/送迎）は取得後 `featureScore` で並び替え。
5. **宿の種別除外**: 名称・紹介文に ゲストハウス/ホステル/ドミトリー/カプセル/キャンプ/グランピング 等が
   あれば除外（`EXCLUDE_LODGING`）。0件になるなら絞らない。
6. **並び順**: featureScore（希望条件）→ 口コミ評価(`reviewAverage`、`reviewCount`>0のみ)→ datedPrice → 安い順。

## Walker Plus（`src/scrape/autosource.ts`）

- 公式APIではなくスクレイピング。**商用配布時はこの依存を外す**（規約リスク）。
- エリアコード `arRRPP` = `ar` + 地方番号(2) + JISコード(2)。実データ確認: 東京 ar0313 / 神奈川 ar0314 /
  島根 ar0832 / 香川 ar0937 / 石川 ar0517（中部の地方番号も石川=北陸05で確認済み）。`walkerplusArCode()` 参照。
- `event_list/ar{code}/` が県の総合リスト。`hanabi.walkerplus.com/list/ar{code}/` 等はジャンル別。
- ページ送りは末尾 `/` のリストに `N.html`（`pageUrlFor`）。`event_list` は機能、`hanabi` の2頁目以降は失敗しがち。
- **JSON-LDは Event を持つ**。詳細ページ＝確実、リストページ＝ItemListで10件前後。
- 直接取得が本番Worker（Cloudflare網）では `via:direct` で通る。サンドボックス等の許可リスト環境では弾かれる。

## Jina（`s.jina.ai` 検索 / `r.jina.ai` 本文）

- キー無しは即レート制限。キー有りも**トークン残高制**（使い切るとマイナス→停止）。
- `r.jina.ai/<url>` は既定でMarkdown。`X-Return-Format: html` ヘッダで**生HTML（ld+json保持）**が取れる。
- 本番収集は arcode 直URL + DBキャッシュで **Jina非依存**に寄せる（枯渇に強い）。
- クライアントの `Failed to fetch`（ネット失敗）は `apiRetry` で自動再試行（最大3回・指数バックオフ）。

## Nominatim / GSI（`src/scrape/geocode.ts`）

- Nominatim は **1 req/秒厳守**（sleep 1.1s 済み）。`User-Agent` 必須。
- 逆ジオ: 県名は zoom=8（`reversePrefecture`）、市区町村は zoom=14（`reversePlaceName`、「現在地を使う」用）。
- AIの座標は海上等にズレる→ `geocodePlanItems` は名称から引き直し、エリア中心 `maxKm=150` 外を除外。
  座標はDBキャッシュ（`geocode` 表）されるので2回目以降は速い。
- オートコンプリートに Nominatim は使わない（静的 `places.ts` / 国土地理院GSI `msearch.gsi.go.jp`）。

## D1（`src/db/repository.ts`）

- `db.batch()` に大量ステートメント（150〜300）を渡すと
  `D1_ERROR: storage operation exceeded timeout which caused object to be reset`。
  → **25件ずつチャンク**で `db.batch(slice)`。`raw` は ≤2000字。
- スキーマは `ensure*Table()`/`ensure*Columns()` が `CREATE TABLE IF NOT EXISTS` / `ALTER` で都度作成。
- `searchEvents` は LIKE スキャン（先頭ワイルドカード=インデックス効かない）。表が肥大すると重くなるので、
  過去イベントは保存時に `isPastEventDate` で除外して肥大を抑える。

## AI（`src/planner/ai.ts` / `gemini.ts` / `ai-extract.ts`）

- 抽出 = `gemini-2.5-flash-lite`（15RPM, maxAttempts:1 で即フォールバック）、生成 = `gemini-2.5-flash`（5RPM）。
- 2.5系は `thinkingConfig.thinkingBudget=0`（空応答/MAX_TOKENS対策）。429/503 はバックオフ再試行。
- フォールバック: Gemini → Workers AI(llama 8b/70b) → ルールベース。`AiQuotaError` は枠切れ（別モデルでも回復せず）。
- 収集が空でも **AIの一般知識でプラン化**（「○○市立△△」等の架空名は禁止＝地図ズレ防止）。
- Cloudflare Workers AI 無料枠は 10,000 Neuron/日。`4006` は枠切れ（ダッシュボード0でも出る既知バグあり）。

## 診断エンドポイント（本番で実証する習慣）

- `/api/diag/ai` … Workers AI / Gemini 各モデルの疎通
- `/api/diag/hotel?area=&checkin=&checkout=` … keyword/vacant の生結果・`dated`（底値 vs 実部屋総額）
- `/api/diag/events?area=&month=&pages=` … 解決source/取得経路/件数/ページ毎
- 「実装した→診断で本番の生データを見る→直す」を徹底。サンドボックスからは外部到達できないことが多い。
