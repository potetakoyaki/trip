/// <reference types="@cloudflare/workers-types" />

/** Worker のバインディング / 環境変数。wrangler.toml と対応。 */
export interface Env {
  DB: D1Database;
  /** Workers AI（任意）。AIプラン生成を使う場合のみ。 */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  USER_AGENT?: string;
  RAKUTEN_APP_ID?: string;
  /** 楽天 新API の Access Key（pk_ で始まる・新APIで必須）。 */
  RAKUTEN_ACCESS_KEY?: string;
  CONNPASS_API_KEY?: string;
  /** Brave Search API キー（任意）。自動収集の検索を安定化する。 */
  BRAVE_API_KEY?: string;
  /** Jina API キー（任意・カード不要の無料キーで上限アップ）。 */
  JINA_API_KEY?: string;
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
  /** 営業時間（本文に記載があれば。例 "9:00-17:00"）。 */
  hours?: string;
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
  hours?: string | null;
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
  /** プラン作成時に最新情報を自動取得するか（既定 true）。 */
  autoScrape?: boolean;
  /** 条件分岐: 天気 / 同行者 / テーマの志向。 */
  weather?: 'any' | 'sunny' | 'rainy';
  companions?: string; // ひとり / カップル / 家族 / 友人 など
  vibe?: string; // 定番 / 穴場 / グルメ重視 / のんびり など
  /** 出発地点（例: 新宿 / 東京駅 / 名古屋）。 */
  origin?: string;
  /** 移動手段（電車 / 新幹線 / 車 / 飛行機 / バス）。 */
  transport?: string;
  /** やりたいこと等のフリーワード（例: 花火 / 紅葉 / 美術館）。 */
  keyword?: string;
  /** ホテルの希望条件（例: 温泉 / 露天風呂 / 夕食付き / リゾート）。 */
  hotelFeatures?: string[];
  /** 省エネモード（軽量AIモデルでNeuron消費を抑える）。 */
  eco?: boolean;
}

export interface PlanItem {
  time?: string; // HH:MM
  title: string;
  category?: string;
  location?: string;
  url?: string;
  price?: number;
  /** なぜおすすめか（提案理由）。 */
  why?: string;
  /** 楽しみ方・回り方のコツ。 */
  tips?: string;
  /** 行き方・アクセス。 */
  access?: string;
  /** 目安の滞在時間。 */
  duration?: string;
  /** 雨天や時間が無いときの代替案。 */
  alt?: string;
  /** その場所の目安費用（入場料・飲食代など、円）。 */
  estCost?: number;
  /** 営業時間（例 "9:00-17:00"）。 */
  hours?: string;
  /** おおよその緯度（地図・スポット間の移動時間の概算用）。 */
  lat?: number;
  /** おおよその経度。 */
  lng?: number;
}

export interface PlanDay {
  date: string; // YYYY-MM-DD
  items: PlanItem[];
  /** その日のテーマ/ねらい。 */
  theme?: string;
}

/** 出発地点から旅行先までの移動（目安）。 */
export interface TravelLeg {
  from?: string;
  to?: string;
  mode?: string;
  distance?: string;
  duration?: string;
  /** 往復の目安費用（円）。 */
  costRoundTrip?: number;
  /** 具体的な経路・乗り換え・道路など。 */
  note?: string;
}

export interface HotelOption {
  name: string;
  area?: string;
  /** 1泊1人あたりの目安（円）。 */
  nightlyPrice?: number;
  why?: string;
  url?: string;
}

/** 費用の内訳（円・1人あたり）。 */
export interface CostBreakdown {
  nights: number;
  hotel: number;
  food: number;
  activities: number;
  /** 旅行先での滞在費合計（ホテル＋食事＋観光）。予算と比較する対象。 */
  stayTotal: number;
  /** 出発地からの往復交通費。 */
  transport: number;
  /** 総額（滞在費＋交通）。 */
  grandTotal: number;
  budget?: number;
  withinBudget?: boolean;
}

export interface DayForecast {
  date: string;
  code: number;
  tmax?: number;
  tmin?: number;
  pop?: number; // 降水確率(%)
  label: string;
  emoji: string;
}

export interface Plan {
  /** プラン全体のテーマ/タイトル。 */
  theme?: string;
  /** なぜこのスポットの組み合わせ・プランにしたかの選定理由。 */
  rationale?: string;
  /** プラン全体を通した楽しみ方の提案。 */
  enjoyment?: string;
  /** 旅行日の天気予報（Open-Meteo・取得できた場合）。 */
  forecast?: DayForecast[];
  days: PlanDay[];
  summary: string;
  totalEstimatedCost: number;
  highlights: string[];
  /** 旅行全体の楽しみ方アドバイス。 */
  advice?: string[];
  /** 出発地からの移動（目安）。 */
  travel?: TravelLeg;
  /** ホテル候補。 */
  hotels?: HotelOption[];
  /** 費用内訳。 */
  costBreakdown?: CostBreakdown;
  engine: 'rule' | 'ai';
}
