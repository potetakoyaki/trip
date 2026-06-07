import type { EventRecord } from '../types';

/**
 * キーワード → 正規化カテゴリのマッピング。
 * タイトル/説明/タグから推定する。当たらなければ undefined。
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  グルメ: ['グルメ', '食', 'レストラン', 'カフェ', '居酒屋', 'ランチ', 'ディナー', 'food', 'gourmet', '酒', 'ワイン', 'ビール'],
  自然: ['自然', '山', '海', '公園', '滝', '森', '湖', '花', '紅葉', '桜', 'nature', 'park', 'ハイキング', '登山'],
  歴史: ['歴史', '神社', '寺', '城', '史跡', '遺跡', '博物館', 'history', 'temple', 'shrine', 'castle'],
  アート: ['アート', '美術', '展覧会', 'ギャラリー', '芸術', 'art', 'museum', 'exhibition', '個展'],
  音楽: ['音楽', 'ライブ', 'コンサート', 'フェス', 'music', 'live', 'concert', 'festival'],
  体験: ['体験', 'ワークショップ', '工房', '教室', '陶芸', '手作り', 'workshop', 'experience'],
  宿泊: ['宿泊', 'ホテル', '旅館', '温泉', '民宿', 'hotel', 'ryokan', 'onsen', 'spa'],
  祭り: ['祭', 'まつり', '花火', 'マルシェ', 'イベント', 'matsuri', 'fireworks'],
  テック: ['勉強会', 'meetup', 'ハッカソン', 'tech', 'エンジニア', 'プログラ', 'it', 'ai', '開発'],
};

export function inferCategory(...texts: (string | undefined | null)[]): string | undefined {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => hay.includes(k.toLowerCase()))) return cat;
  }
  return undefined;
}

export const ALL_CATEGORIES = Object.keys(CATEGORY_KEYWORDS);

/** 都道府県名を住所文字列から抽出（簡易）。 */
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

export function inferPrefecture(...texts: (string | undefined | null)[]): string | undefined {
  const hay = texts.filter(Boolean).join(' ');
  return PREFECTURES.find((p) => hay.includes(p));
}

/** エリア指定（フリーワード）がイベントに合致するか。 */
export function areaMatches(e: EventRecord, area?: string): boolean {
  if (!area) return true;
  const q = area.trim().toLowerCase();
  if (!q) return true;
  const hay = [e.prefecture, e.city, e.location_name, e.title, e.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}
