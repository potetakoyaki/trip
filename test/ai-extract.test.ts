import { describe, it, expect } from 'vitest';
import { readSpots } from '../src/scrape/ai-extract';

describe('readSpots 抽出パース', () => {
  it('{response:{spots:[...]}} 形式（title空/title無しは除外）', () => {
    const r = readSpots({ response: { spots: [{ title: 'A' }, { title: '' }, { foo: 1 }] } });
    expect(r.map((s) => s.title)).toEqual(['A']);
  });

  it('文字列のJSON配列を解釈し、開催日も保持', () => {
    const r = readSpots('[{"title":"花火大会","startDate":"2026-08-15","category":"祭り"}]');
    expect(r[0].title).toBe('花火大会');
    expect(r[0].startDate).toBe('2026-08-15');
    expect(r[0].category).toBe('祭り');
  });

  it('{spots:[...]} オブジェクト直も可', () => {
    expect(readSpots({ spots: [{ title: 'C' }] })[0].title).toBe('C');
  });

  it('配列直も可', () => {
    expect(readSpots([{ title: 'D' }])[0].title).toBe('D');
  });

  it('壊れた/空の入力は空配列', () => {
    expect(readSpots(null)).toEqual([]);
    expect(readSpots({})).toEqual([]);
    expect(readSpots('ただのテキストで配列なし')).toEqual([]);
  });
});
