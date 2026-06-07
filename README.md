# 🧳 旅行プランメーカー (Trip Planner)

Cloudflare 上で動く、**個人利用向け**の旅行プラン自動作成サイトです。
イベント・観光情報を集めて、条件（エリア・日付・興味・予算・ペース）から
**最適な日程プラン**を自動で組み立てます。

- **スタック**: Cloudflare Workers + [Hono](https://hono.dev/) + D1 (SQLite) + 静的フロント
- **プラン生成**: 標準は**完全無料・APIキー不要のルールベース**。任意で Workers AI（無料枠）に切替可能
- **情報収集**: 公式API（楽天トラベル / connpass）＋ schema.org JSON-LD 抽出＋ RSS。
  robots.txt 尊重・レート制限・キャッシュを内蔵

> ⚠️ **スクレイピングの注意**: じゃらん等の大手予約サイトは利用規約で
> スクレイピングを禁止していることが多いです。本プロジェクトは公式APIや
> 各サイトが公開する構造化データ（JSON-LD / RSS）を優先する設計です。
> 対象サイトの robots.txt と利用規約を必ず確認し、自己責任で利用してください。

---

## アーキテクチャ

```
ブラウザ (public/)
   │  fetch /api/*
   ▼
Cloudflare Worker (Hono)  ── /api/plan  → プランナー(ルールベース / Workers AI)
   │                       ── /api/scrape → スクレイプ・ランナー
   │                       ── /api/events, /api/sources, /api/demo ...
   ▼
D1 (SQLite): sources / events / plans
   ▲
Cron Trigger (6時間ごと) → runScrape() で各ソースを巡回
```

ソースは「ドライバ方式」。`sources` テーブルの `config.driver` で実装を選びます。

| driver    | 用途                                   | 必要な設定                         |
| --------- | -------------------------------------- | ---------------------------------- |
| `connpass`| connpass のイベント（公式API）         | `CONNPASS_API_KEY`                 |
| `rakuten` | 楽天トラベルの宿・観光（公式API）       | `RAKUTEN_APP_ID`                   |
| `rss`     | 観光協会・自治体の RSS/Atom            | `config.feedUrl`(s)                |
| `jsonld`  | ページ内 schema.org（Walkerplus/Peatix 等） | `config.pageUrls`             |

新しいサイトを追加したいときは、`src/sources/` にドライバを足して
`src/sources/index.ts` の `drivers` に登録するだけです。

---

## セットアップ

### 1. 依存をインストール
```bash
npm install
```

### 2. D1 データベースを作成
```bash
npm run db:create          # 出力された database_id を控える
```
`wrangler.toml` の `database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"` を置き換えます。

### 3. マイグレーション適用
```bash
npm run db:migrate:local   # ローカル開発用
# 本番(リモート)へは: npm run db:migrate
```

### 4. （任意）シークレット設定
公式APIを使う場合のみ。ローカルは `.dev.vars`（`.dev.vars.example` をコピー）、
本番は `wrangler secret put` で設定します。
```bash
wrangler secret put RAKUTEN_APP_ID
wrangler secret put CONNPASS_API_KEY
```

### 5. ローカル起動
```bash
npm run dev
```
ブラウザで表示されたURLを開き、
**「サンプルデータ投入」→ エリアに「箱根」→「プランを作成」** で動作確認できます。

### 6. デプロイ
```bash
npm run deploy
```

---

## 使い方

1. **サンプルで試す**: 「サンプルデータ投入」ボタン → エリア「箱根」でプラン作成。
2. **実データを集める**:
   - `sources` テーブルの対象行に設定を入れて `enabled=1` にする。
   - 例（観光協会RSS）:
     ```sql
     UPDATE sources
       SET config='{"driver":"rss","feedUrl":"https://<観光協会>/news/feed","category":"観光","prefecture":"長野県"}',
           enabled=1
       WHERE id='kanko-rss-example';
     ```
   - 「スクレイピング実行」ボタン、または Cron（6時間ごと）で収集。
3. **プラン作成**: エリア・日付・興味・予算・ペースを指定して生成。

### Workers AI でプラン生成（任意）
UI の「Workers AI でプラン生成」にチェックを入れると、Workers AI
(`@cf/meta/llama-3.1-8b-instruct`) でプランを組み立てます（無料枠あり）。
利用不可や失敗時は自動でルールベースにフォールバックします。

---

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET  | `/api/health` | 稼働確認（AI 利用可否も返す） |
| GET  | `/api/categories` | 興味カテゴリ一覧 |
| GET  | `/api/sources` | ソース一覧と状態 |
| POST | `/api/scrape?source=<id>` | スクレイピング実行（id 省略で全有効ソース） |
| POST | `/api/demo` | サンプルイベント投入 |
| GET  | `/api/events?area=&from=&to=&category=&q=&limit=` | イベント検索 |
| POST | `/api/plan` | プラン生成（body は下記） |
| GET  | `/api/plan/:id` | 保存済みプラン取得 |

`POST /api/plan` のボディ例:
```json
{
  "area": "箱根",
  "startDate": "2026-07-01",
  "endDate": "2026-07-02",
  "interests": ["アート", "自然", "グルメ"],
  "budget": 20000,
  "pace": "normal",
  "engine": "rule"
}
```

---

## 開発

```bash
npm run typecheck   # 型チェック
npm test            # ユニットテスト（プランナー / パーサ / robots）
```

純粋ロジック（`src/planner`, `src/scrape/rss.ts`, `src/scrape/jsonld.ts` の
パース部, `src/scrape/robots.ts`, `src/util`）は Worker ランタイムなしで
テストしています。

---

## ディレクトリ構成

```
├── public/              静的フロント（HTML/CSS/JS）
├── migrations/          D1 スキーマ & シード
├── src/
│   ├── index.ts         Worker エントリ（fetch / scheduled）
│   ├── api/routes.ts    Hono ルート
│   ├── db/repository.ts D1 アクセス層
│   ├── planner/         プラン生成（rule-based / ai / dispatch）
│   ├── scrape/          http(robots/rate/cache) / rss / jsonld / runner
│   ├── sources/         ドライバ（connpass / rakuten / rss / jsonld）
│   └── util/normalize.ts カテゴリ・都道府県・エリア判定
└── test/                ユニットテスト
```

## 今後の拡張アイデア
- ソース設定の UI 編集（現状は SQL / マイグレーション）
- 緯度経度を使った移動最適化（同日内の近接順ソート）
- お気に入り / 保存プラン一覧ページ
- 画像表示・地図表示（Leaflet 等）
