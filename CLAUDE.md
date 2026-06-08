# CLAUDE.md — 引継書 / プロジェクトガイド

旅行プラン作成アプリ（個人用）。**Cloudflare Workers + Hono + D1 + Workers AI / Gemini**。
このファイルは Claude Code がセッション開始時に自動で読みます。新セッションはまずここを読んでください。

## 何のアプリか
エリア（行き先）と日程を入れると、Web から情報を自動収集し、AI が「観光＋グルメ＋ホテル＋費用＋交通＋地図」つきの旅程を作る。登録不要。

- 本番URL（固定）: `https://trip.potetakoyaki.workers.dev/`
- AI疎通診断: `GET /api/diag/ai`（Workers AI と Gemini の各モデルを叩いて ok/エラーを返す。困ったら最初にこれ）

## スタック / デプロイ
- ランタイム: Cloudflare Workers（`src/index.ts` がエントリ。Hono ルータ）
- DB: D1（`wrangler.toml` の `[[d1_databases]] binding="DB"`）。スキーマは各 `ensure*Table()` が `CREATE TABLE IF NOT EXISTS` で都度作成（マイグレーション無しでも動く）。
- 静的フロント: `public/`（`index.html` / `app.js` / `styles.css`）。`/api/*` 以外は assets から配信。
- AI: Workers AI バインディング `AI`、または **Gemini API**（`GEMINI_API_KEY` があれば優先）。
- デプロイ: GitHub 連携の Cloudflare Workers Builds。**main にマージすると自動で本番デプロイ**。PRごとにビルドが走る。
- 開発: `npm run dev` / 型: `npm run typecheck` / テスト: `npm test`（vitest）。コミット前に typecheck・test・`node --check public/app.js` を通すこと。

### 重要な運用ルール（このリポジトリ）
- 開発ブランチ: `claude/magical-babbage-phhPA`。ここにコミット＆プッシュ → ドラフトPRを作る → マージで本番反映。
- API応答は `no-store`（`routes.ts` の `api.use('*', ...)`）。診断や進捗ポーリングが古いキャッシュを返さないため。**ブラウザ側のキャッシュで古い結果が出る事故が実際にあった**ので注意。

## AI 構成（重要・ハマりどころ多数）
- **抽出（スポット抽出 `ai-extract.ts`）= `gemini-2.5-flash-lite`**（無料枠RPMが高い15/分。失敗時 maxAttempts=1 で即 Workers AI へフォールバック）。`GEMINI_EXTRACT_MODEL` で変更可。
- **プラン生成（`ai.ts`）= `gemini-2.5-flash`**（品質重視。無料枠5/分だが1プラン1回なので足りる）。`GEMINI_MODEL` で変更可。
- Gemini が無い/失敗 → **Workers AI（llama-3.1-8b / じっくりモードは 3.3-70b）にフォールバック**。それも枠切れ(4006)なら **ルールベースの簡易プラン**（`planner.ts` で `AiQuotaError` を捕捉、`plan.notice` に表示）。
- `gemini.ts`: 2.5系は `thinkingConfig.thinkingBudget=0` で思考を無効化（JSON途中切れ/空応答 MAX_TOKENS 対策）。429/503 はバックオフ再試行。
- **Cloudflare Workers AI 無料枠は 10,000 Neuron/日**。`4006` が出たら枠切れ。**「ダッシュボードは0/10kなのに4006」になる既知バグ**があり（リセット未反映）、これは Cloudflare 側。回避は Gemini 利用 or Workers Paid。
- このユーザーの Gemini キー実測: `gemini-2.0-flash`/`-lite` は free_tier `limit:0`（不可）、`2.5-flash`=5RPM、`2.5-flash-lite`=15RPM。**2.0系は使わない**。

## 主要ディレクトリ / ファイル
- `src/index.ts` — Worker エントリ。Cron（毎分=収集キュー / 6h=定期スクレイプ）。
- `src/api/routes.ts` — 全APIルート（`/plan/start` `/plan-status` `/collect/start` `/places` `/diag/ai` `/areas/similar` 等）。
- `src/planner/create-plan.ts` — プラン作成の中核（収集→候補→ホテル→AI生成→ジオコーディング→交通→保存）。**進捗 `onProgress` を各段階で呼ぶ**。
- `src/planner/ai.ts` / `planner.ts` / `rule-based.ts` — AIプラン生成・フォールバック・ルールベース。
- `src/planner/gemini.ts` — Gemini クライアント。
- `src/scrape/autosource.ts` — Web自動収集（Jina検索→本文→AI抽出）。`resultOffset` で再収集の深さをずらす。
- `src/scrape/ai-extract.ts` — 本文からスポット/イベント抽出（日付 startDate/endDate も対応）。
- `src/scrape/collect-job.ts` — じっくり収集/プラン作成のバックグラウンドジョブ。
- `src/scrape/hotels.ts` — 楽天トラベル。KeywordHotelSearch で候補→ VacantHotelSearch で**指定日の実価格**。`prefecture` で県絞り込み。
- `src/scrape/geocode.ts` — Nominatim(OSM) ジオコーディング（DBキャッシュ・1req/秒）。`reversePrefecture` で都道府県、`geocodePlanItems` はエリア中心から `maxKm` 外を除外。
- `src/data/places.ts` — 都道府県＋主要市区町村の静的リスト（入力オートコンプリート）。
- `src/db/repository.ts` — D1 アクセス全般。

## 実装済みの主な機能
- AIプラン作成（バックグラウンドジョブ＋進捗バーは**実ステージ進捗**。`plan_jobs.stage/progress`）。
- じっくり収集（バックグラウンド・複数ラウンド）。**再収集ボタンは「収集済み」表示時のみ**表示し、`force`＋`pass` で深い検索結果を取る。
- ホテル：楽天で**入力宿泊日の実価格**、選択式（4件展開・残りは「もっと見る」）で**滞在費が連動**。
- 地図：Leaflet。座標は実ジオコーディング＋**エリア近傍(150km)のみ**表示（全国に散る誤ピン対策）。
- 交通：出発地→エリア中心の実距離・所要・概算費用（AIの幻覚距離を上書き）。
- イベント：開催日を抽出し、旅行日に一致するものを優先配置。
- 地名オートコンプリート（漢字/ひらがな。「はぎ」→山口県萩市）。**荻(東京・荻窪) と 萩(山口) の取り違え対策**。
- 確認ダイアログは自前モーダル `uiConfirm()`（標準 confirm は不使用）。
- 「じっくりモード」チェック=ON で高性能モデル、OFFで軽量（既定）。

## 既知の注意点 / ハマりどころ
- **地名の曖昧さ**：楽天 KeywordHotelSearch は名称マッチで全国ヒットする。必ず `prefecture` を付けて絞る。地図も `center+maxKm` で絞る。オートコンプリートで「県＋市」を確定させるのが根本対策。
- **キャッシュ**：API は no-store 済みだが、ブラウザ実機での確認は `?t=乱数` でキャッシュ回避が確実。
- **Nominatim**：1req/秒厳守（geocode.ts で sleep 済み）。オートコンプリート用途では使わない（静的 places.ts を使う）。
- 進捗ジョブは `ctx.waitUntil` ＋ Cron フォールバック。更新してもクライアントは保存 jobId で再アタッチするだけ（再作成しない）。

## 未対応 / 保留（TODO）
- **デザイン刷新**：ユーザーは lazyweb 系のおしゃれUIを希望。暖色化は不評で**クリーン配色に戻し済み**。方向性未確定（要：具体指摘 or 参考スクショ or lazyweb 連携）。
- **Lazyweb MCP/Skill**：このリモートWebセッションでは設定不可（セッション開始時ロード＋要トークン）。ユーザーのローカル Claude Code で `aboul3ata/lazyweb-skill` 追加＋MCP設定が必要。
- 地名リスト（`src/data/places.ts`）は主要市のみ。要望次第で追加。

## コミット/PR の約束
- 開発ブランチにコミット→`git push -u origin claude/magical-babbage-phhPA`→**ドラフトPRを作成**（無ければ）。
- PRがマージされるまで CI/レビューを監視。デプロイは Cloudflare bot がPRにコメント。
