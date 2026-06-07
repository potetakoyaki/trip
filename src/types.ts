/// <reference types="@cloudflare/workers-types" />

/** Worker のバインディング / 環境変数。wrangler.toml と対応。 */
export interface Env {
  DB: D1Database;
  /** Workers AI（任意）。AIプラン生成を使う場合のみ。 */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  USER_AGENT?: string;
  RAKUTEN_APP_ID?: string;
  CONNPASS_API_KEY?: string;
}

/** スクレイパが返す正規化済みイベント（DB保存前）。 */
export interface NormalizedEvent {
  sourceEventId: string;
  title: string;
  description?: string;
  url?: string;
  category?: string;
  tags?: string[];
  prefecture?: string;
  city?: string;
  locationName?: string;
  lat?: number;
  lng?: number;
  /** ISO8601。日時不明なら省略（プランでは「自由枠」に回る）。 */
  startAt?: string;
  endAt?: string;
  /** 円。無料は 0、不明は省略。 */
  price?: number;
  imageUrl?: string;
  raw?: unknown;
}

/** DB から読み出したイベント行（プランナー入力）。 */
export interface EventRecord {
  id: string;
  source: string;
  title: string;
  description?: string | null;
  url?: string | null;
  category?: string | null;
  tags?: string[];
  prefecture?: string | null;
  city?: string | null;
  location_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  start_at?: string | null;
  end_at?: string | null;
  price?: number | null;
  image_url?: string | null;
}

/** ソース設定行。 */
export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  base_url?: string | null;
  config: Record<string, unknown>;
  enabled: number;
  last_run_at?: string | null;
  last_status?: string | null;
}

/** プラン生成リクエスト。 */
export interface PlanRequest {
  area?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  interests?: string[];
  budget?: number; // 1人あたり総額の目安（円）
  pace?: 'relaxed' | 'normal' | 'packed';
  engine?: 'rule' | 'ai';
}

export interface PlanItem {
  time?: string; // HH:MM
  title: string;
  category?: string;
  location?: string;
  url?: string;
  price?: number;
  why?: string;
}

export interface PlanDay {
  date: string; // YYYY-MM-DD
  items: PlanItem[];
}

export interface Plan {
  days: PlanDay[];
  summary: string;
  totalEstimatedCost: number;
  highlights: string[];
  engine: 'rule' | 'ai';
}
