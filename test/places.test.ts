import { describe, it, expect } from 'vitest';
import { searchPlaces } from '../src/data/places';

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
