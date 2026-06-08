import { describe, it, expect } from 'vitest';
import { haversineKm } from '../src/scrape/geocode';

describe('haversineKm 距離計算', () => {
  it('同一点は0km', () => {
    expect(haversineKm({ lat: 35, lng: 135 }, { lat: 35, lng: 135 })).toBeCloseTo(0, 5);
  });

  it('東京-大阪は約400km前後（地図近傍判定の基礎）', () => {
    const d = haversineKm({ lat: 35.68, lng: 139.77 }, { lat: 34.69, lng: 135.5 });
    expect(d).toBeGreaterThan(380);
    expect(d).toBeLessThan(420);
  });

  it('東京-札幌は約800km超（誤ピン除外150kmを十分上回る）', () => {
    const d = haversineKm({ lat: 35.68, lng: 139.77 }, { lat: 43.06, lng: 141.35 });
    expect(d).toBeGreaterThan(150);
    expect(d).toBeGreaterThan(800);
  });
});
