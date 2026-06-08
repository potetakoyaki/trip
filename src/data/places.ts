// 入力補完・地名の曖昧さ解消用の地名リスト（アプリに静的同梱・外部通信なし）。
// name=表示名, kana=ひらがな検索用, pref=都道府県（都道府県自体は pref を空に）。
// 選択時は pref+name を確定エリアにするので、ジオコーディング/ホテル検索が正確になる。
export interface Place {
  name: string;
  kana: string;
  pref: string;
}

// 47都道府県
const PREFS: Place[] = [
  { name: '北海道', kana: 'ほっかいどう', pref: '' },
  { name: '青森県', kana: 'あおもり', pref: '' },
  { name: '岩手県', kana: 'いわて', pref: '' },
  { name: '宮城県', kana: 'みやぎ', pref: '' },
  { name: '秋田県', kana: 'あきた', pref: '' },
  { name: '山形県', kana: 'やまがた', pref: '' },
  { name: '福島県', kana: 'ふくしま', pref: '' },
  { name: '茨城県', kana: 'いばらき', pref: '' },
  { name: '栃木県', kana: 'とちぎ', pref: '' },
  { name: '群馬県', kana: 'ぐんま', pref: '' },
  { name: '埼玉県', kana: 'さいたま', pref: '' },
  { name: '千葉県', kana: 'ちば', pref: '' },
  { name: '東京都', kana: 'とうきょう', pref: '' },
  { name: '神奈川県', kana: 'かながわ', pref: '' },
  { name: '新潟県', kana: 'にいがた', pref: '' },
  { name: '富山県', kana: 'とやま', pref: '' },
  { name: '石川県', kana: 'いしかわ', pref: '' },
  { name: '福井県', kana: 'ふくい', pref: '' },
  { name: '山梨県', kana: 'やまなし', pref: '' },
  { name: '長野県', kana: 'ながの', pref: '' },
  { name: '岐阜県', kana: 'ぎふ', pref: '' },
  { name: '静岡県', kana: 'しずおか', pref: '' },
  { name: '愛知県', kana: 'あいち', pref: '' },
  { name: '三重県', kana: 'みえ', pref: '' },
  { name: '滋賀県', kana: 'しが', pref: '' },
  { name: '京都府', kana: 'きょうと', pref: '' },
  { name: '大阪府', kana: 'おおさか', pref: '' },
  { name: '兵庫県', kana: 'ひょうご', pref: '' },
  { name: '奈良県', kana: 'なら', pref: '' },
  { name: '和歌山県', kana: 'わかやま', pref: '' },
  { name: '鳥取県', kana: 'とっとり', pref: '' },
  { name: '島根県', kana: 'しまね', pref: '' },
  { name: '岡山県', kana: 'おかやま', pref: '' },
  { name: '広島県', kana: 'ひろしま', pref: '' },
  { name: '山口県', kana: 'やまぐち', pref: '' },
  { name: '徳島県', kana: 'とくしま', pref: '' },
  { name: '香川県', kana: 'かがわ', pref: '' },
  { name: '愛媛県', kana: 'えひめ', pref: '' },
  { name: '高知県', kana: 'こうち', pref: '' },
  { name: '福岡県', kana: 'ふくおか', pref: '' },
  { name: '佐賀県', kana: 'さが', pref: '' },
  { name: '長崎県', kana: 'ながさき', pref: '' },
  { name: '熊本県', kana: 'くまもと', pref: '' },
  { name: '大分県', kana: 'おおいた', pref: '' },
  { name: '宮崎県', kana: 'みやざき', pref: '' },
  { name: '鹿児島県', kana: 'かごしま', pref: '' },
  { name: '沖縄県', kana: 'おきなわ', pref: '' },
];

// 主要観光都市・エリア（県＋名で確定させる）。曖昧になりやすい地名を中心に網羅。
const CITIES: Place[] = [
  { name: '札幌市', kana: 'さっぽろ', pref: '北海道' },
  { name: '函館市', kana: 'はこだて', pref: '北海道' },
  { name: '小樽市', kana: 'おたる', pref: '北海道' },
  { name: '富良野市', kana: 'ふらの', pref: '北海道' },
  { name: '旭川市', kana: 'あさひかわ', pref: '北海道' },
  { name: '釧路市', kana: 'くしろ', pref: '北海道' },
  { name: '青森市', kana: 'あおもり', pref: '青森県' },
  { name: '弘前市', kana: 'ひろさき', pref: '青森県' },
  { name: '盛岡市', kana: 'もりおか', pref: '岩手県' },
  { name: '平泉町', kana: 'ひらいずみ', pref: '岩手県' },
  { name: '仙台市', kana: 'せんだい', pref: '宮城県' },
  { name: '松島町', kana: 'まつしま', pref: '宮城県' },
  { name: '秋田市', kana: 'あきた', pref: '秋田県' },
  { name: '角館', kana: 'かくのだて', pref: '秋田県' },
  { name: '山形市', kana: 'やまがた', pref: '山形県' },
  { name: '会津若松市', kana: 'あいづわかまつ', pref: '福島県' },
  { name: '水戸市', kana: 'みと', pref: '茨城県' },
  { name: '日光市', kana: 'にっこう', pref: '栃木県' },
  { name: '草津町', kana: 'くさつ', pref: '群馬県' },
  { name: '川越市', kana: 'かわごえ', pref: '埼玉県' },
  { name: '成田市', kana: 'なりた', pref: '千葉県' },
  { name: '浦安市', kana: 'うらやす', pref: '千葉県' },
  { name: '新宿区', kana: 'しんじゅく', pref: '東京都' },
  { name: '渋谷区', kana: 'しぶや', pref: '東京都' },
  { name: '浅草', kana: 'あさくさ', pref: '東京都' },
  { name: '横浜市', kana: 'よこはま', pref: '神奈川県' },
  { name: '鎌倉市', kana: 'かまくら', pref: '神奈川県' },
  { name: '箱根町', kana: 'はこね', pref: '神奈川県' },
  { name: '新潟市', kana: 'にいがた', pref: '新潟県' },
  { name: '富山市', kana: 'とやま', pref: '富山県' },
  { name: '金沢市', kana: 'かなざわ', pref: '石川県' },
  { name: '福井市', kana: 'ふくい', pref: '福井県' },
  { name: '甲府市', kana: 'こうふ', pref: '山梨県' },
  { name: '長野市', kana: 'ながの', pref: '長野県' },
  { name: '松本市', kana: 'まつもと', pref: '長野県' },
  { name: '軽井沢町', kana: 'かるいざわ', pref: '長野県' },
  { name: '岐阜市', kana: 'ぎふ', pref: '岐阜県' },
  { name: '高山市', kana: 'たかやま', pref: '岐阜県' },
  { name: '白川村', kana: 'しらかわ', pref: '岐阜県' },
  { name: '静岡市', kana: 'しずおか', pref: '静岡県' },
  { name: '熱海市', kana: 'あたみ', pref: '静岡県' },
  { name: '名古屋市', kana: 'なごや', pref: '愛知県' },
  { name: '伊勢市', kana: 'いせ', pref: '三重県' },
  { name: '大津市', kana: 'おおつ', pref: '滋賀県' },
  { name: '京都市', kana: 'きょうと', pref: '京都府' },
  { name: '大阪市', kana: 'おおさか', pref: '大阪府' },
  { name: '茨木市', kana: 'いばらき', pref: '大阪府' },
  { name: '神戸市', kana: 'こうべ', pref: '兵庫県' },
  { name: '姫路市', kana: 'ひめじ', pref: '兵庫県' },
  { name: '奈良市', kana: 'なら', pref: '奈良県' },
  { name: '和歌山市', kana: 'わかやま', pref: '和歌山県' },
  { name: '高野町', kana: 'こうや', pref: '和歌山県' },
  { name: '鳥取市', kana: 'とっとり', pref: '鳥取県' },
  { name: '松江市', kana: 'まつえ', pref: '島根県' },
  { name: '出雲市', kana: 'いずも', pref: '島根県' },
  { name: '岡山市', kana: 'おかやま', pref: '岡山県' },
  { name: '倉敷市', kana: 'くらしき', pref: '岡山県' },
  { name: '広島市', kana: 'ひろしま', pref: '広島県' },
  { name: '尾道市', kana: 'おのみち', pref: '広島県' },
  { name: '廿日市市', kana: 'はつかいち', pref: '広島県' },
  { name: '山口市', kana: 'やまぐち', pref: '山口県' },
  { name: '萩市', kana: 'はぎ', pref: '山口県' },
  { name: '下関市', kana: 'しものせき', pref: '山口県' },
  { name: '徳島市', kana: 'とくしま', pref: '徳島県' },
  { name: '高松市', kana: 'たかまつ', pref: '香川県' },
  { name: '松山市', kana: 'まつやま', pref: '愛媛県' },
  { name: '高知市', kana: 'こうち', pref: '高知県' },
  { name: '福岡市', kana: 'ふくおか', pref: '福岡県' },
  { name: '北九州市', kana: 'きたきゅうしゅう', pref: '福岡県' },
  { name: '佐賀市', kana: 'さが', pref: '佐賀県' },
  { name: '長崎市', kana: 'ながさき', pref: '長崎県' },
  { name: '佐世保市', kana: 'させぼ', pref: '長崎県' },
  { name: '熊本市', kana: 'くまもと', pref: '熊本県' },
  { name: '阿蘇市', kana: 'あそ', pref: '熊本県' },
  { name: '大分市', kana: 'おおいた', pref: '大分県' },
  { name: '別府市', kana: 'べっぷ', pref: '大分県' },
  { name: '由布市', kana: 'ゆふ', pref: '大分県' },
  { name: '宮崎市', kana: 'みやざき', pref: '宮崎県' },
  { name: '鹿児島市', kana: 'かごしま', pref: '鹿児島県' },
  { name: '那覇市', kana: 'なは', pref: '沖縄県' },
  { name: '石垣市', kana: 'いしがき', pref: '沖縄県' },
];

export const PLACES: Place[] = [...PREFS, ...CITIES];

/** クエリ（漢字/ひらがな）で前方一致・部分一致の候補を返す（最大 limit 件）。 */
export function searchPlaces(q: string, limit = 8): { label: string; value: string }[] {
  const s = q.trim();
  if (!s) return [];
  const scored: { p: Place; score: number }[] = [];
  for (const p of PLACES) {
    const hay = p.name + ' ' + p.kana;
    let score = -1;
    if (p.name.startsWith(s) || p.kana.startsWith(s)) score = 0; // 前方一致を優先
    else if (hay.includes(s)) score = 1;
    if (score >= 0) scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || a.p.name.length - b.p.name.length);
  return scored.slice(0, limit).map(({ p }) => ({
    label: p.pref ? `${p.pref} ${p.name}` : p.name,
    value: p.pref ? `${p.pref}${p.name}` : p.name, // 確定エリア（県＋市）
  }));
}
