import { describe, it, expect } from 'vitest';
import { searchPlaces, prefectureOf } from '../src/data/places';

describe('prefectureOf 地名→都道府県の解決', () => {
  it('市区町村名から逆引き（出雲市→島根県）', () => {
    expect(prefectureOf('出雲市')).toBe('島根県');
    expect(prefectureOf('松江市')).toBe('島根県');
  });
  it('都道府県名を含む文字列', () => {
    expect(prefectureOf('島根県松江市')).toBe('島根県');
    expect(prefectureOf('東京都')).toBe('東京都');
  });
  it('県名の前方一致（島根→島根県）', () => {
    expect(prefectureOf('島根')).toBe('島根県');
  });
  it('解決できなければ undefined', () => {
    expect(prefectureOf('')).toBeUndefined();
  });
});

describe('searchPlaces 地名オートコンプリート', () => {
  it('漢字の市名でヒット（萩→山口県萩市）', () => {
    const r = searchPlaces('萩');
    expect(r.some((p) => p.value === '山口県萩市')).toBe(true);
  });

  it('ひらがなでヒット（はぎ→萩市）', () => {
    const r = searchPlaces('はぎ');
    expect(r.some((p) => p.value === '山口県萩市')).toBe(true);
  });

  it('カタカナでヒット（ハギ→萩市）', () => {
    const r = searchPlaces('ハギ');
    expect(r.some((p) => p.value === '山口県萩市')).toBe(true);
  });

  it('都道府県名でヒット（やまぐち→山口県）', () => {
    const r = searchPlaces('やまぐち');
    expect(r.some((p) => p.value === '山口県')).toBe(true);
  });

  it('荻(おぎ)と萩(はぎ)を混同しない（はぎ では荻を含む候補が出ない）', () => {
    const r = searchPlaces('はぎ');
    expect(r.every((p) => !p.value.includes('荻'))).toBe(true);
  });

  it('前方一致を優先（いずも→出雲市が先頭）', () => {
    const r = searchPlaces('いずも');
    expect(r[0]?.value).toBe('島根県出雲市');
  });

  it('label は「県 市」、value は「県市」（確定エリア）', () => {
    const hagi = searchPlaces('萩').find((p) => p.value === '山口県萩市');
    expect(hagi?.label).toBe('山口県 萩市');
  });

  it('空クエリ・該当なしは空配列', () => {
    expect(searchPlaces('')).toEqual([]);
    expect(searchPlaces('   ')).toEqual([]);
    expect(searchPlaces('zzzxxx')).toEqual([]);
  });

  it('limit を超えない', () => {
    expect(searchPlaces('市', 5).length).toBeLessThanOrEqual(5);
  });
});
