import { describe, it, expect } from 'vitest';
import { enumerateDates, generateRulePlan, scoreEvent } from '../src/planner/rule-based';
import type { EventRecord, PlanRequest } from '../src/types';

function ev(partial: Partial<EventRecord>): EventRecord {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    source: 'test',
    title: 'タイトル',
    ...partial,
  };
}

describe('enumerateDates', () => {
  it('両端を含む日付を列挙する', () => {
    expect(enumerateDates('2026-07-01', '2026-07-03')).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
  });

  it('単日も扱える', () => {
    expect(enumerateDates('2026-07-01', '2026-07-01')).toEqual(['2026-07-01']);
  });

  it('終了日が開始日より前ならエラー', () => {
    expect(() => enumerateDates('2026-07-03', '2026-07-01')).toThrow();
  });

  it('不正な日付はエラー', () => {
    expect(() => enumerateDates('not-a-date', '2026-07-01')).toThrow();
  });
});

describe('scoreEvent', () => {
  const base: PlanRequest = { startDate: '2026-07-01', endDate: '2026-07-02', interests: ['グルメ'] };

  it('興味カテゴリに一致するとスコアが上がる', () => {
    const match = scoreEvent(ev({ category: 'グルメ', title: '寿司' }), base);
    const noMatch = scoreEvent(ev({ category: 'アート', title: '展覧会' }), base);
    expect(match).toBeGreaterThan(noMatch);
  });

  it('予算オーバーはスコアが下がる', () => {
    const req: PlanRequest = { ...base, budget: 1000 };
    const cheap = scoreEvent(ev({ price: 500 }), req);
    const pricey = scoreEvent(ev({ price: 50000 }), req);
    expect(cheap).toBeGreaterThan(pricey);
  });
});

describe('generateRulePlan', () => {
  const req: PlanRequest = {
    area: '箱根',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    interests: ['アート', '自然'],
    pace: 'normal',
  };

  const events: EventRecord[] = [
    ev({ id: 'a', title: '彫刻の森美術館', category: 'アート', prefecture: '神奈川県', city: '箱根町', price: 1600 }),
    ev({ id: 'b', title: '大涌谷', category: '自然', prefecture: '神奈川県', city: '箱根町', price: 1500 }),
    ev({ id: 'c', title: '箱根神社', category: '歴史', prefecture: '神奈川県', city: '箱根町', price: 0 }),
    ev({ id: 'd', title: '京都の寺', category: '歴史', prefecture: '京都府', city: '京都市', price: 500 }),
    ev({ id: 'e', title: '日付固定イベント', category: 'アート', prefecture: '神奈川県', city: '箱根町', start_at: '2026-07-01T10:00:00Z' }),
  ];

  it('日数ぶんの日程を返す', () => {
    const plan = generateRulePlan(events, req);
    expect(plan.days).toHaveLength(2);
    expect(plan.days[0].date).toBe('2026-07-01');
    expect(plan.engine).toBe('rule');
  });

  it('エリア外イベントは含まれない', () => {
    const plan = generateRulePlan(events, req);
    const titles = plan.days.flatMap((d) => d.items.map((i) => i.title));
    expect(titles).not.toContain('京都の寺');
  });

  it('同じイベントは重複して使われない', () => {
    const plan = generateRulePlan(events, req);
    const titles = plan.days.flatMap((d) => d.items.map((i) => i.title));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('日付固定イベントはその日に配置される', () => {
    const plan = generateRulePlan(events, req);
    const day1Titles = plan.days[0].items.map((i) => i.title);
    expect(day1Titles).toContain('日付固定イベント');
  });

  it('候補ゼロでも壊れない', () => {
    const plan = generateRulePlan([], req);
    expect(plan.days).toHaveLength(2);
    expect(plan.totalEstimatedCost).toBe(0);
  });
});
