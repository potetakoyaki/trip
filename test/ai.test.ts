import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateAiPlan } from '../src/planner/ai';
import type { EventRecord, PlanRequest } from '../src/types';

function ev(partial: Partial<EventRecord>): EventRecord {
  return { id: partial.id ?? Math.random().toString(36).slice(2), source: 'test', title: 'タイトル', ...partial };
}
function fetchRes(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body } as any;
}
// Gemini の成功応答（candidates.parts.text に JSON 文字列を載せる）。
function geminiOk(jsonText: string) {
  return fetchRes(true, 200, { candidates: [{ content: { parts: [{ text: jsonText }] } }] });
}

const events: EventRecord[] = [
  ev({ id: 'a', title: '彫刻の森美術館', category: 'アート', prefecture: '神奈川県', city: '箱根町', price: 1600 }),
  ev({ id: 'b', title: '大涌谷', category: '自然', prefecture: '神奈川県', city: '箱根町', price: 1500 }),
];

afterEach(() => vi.unstubAllGlobals());

describe('generateAiPlan: Gemini単独構成のフォールバック', () => {
  // 回帰: Gemini キーのみ（Workers AI 無し）でGeminiが失敗したとき、
  // 以前は「Workers AIが無効です」で全滅していた。簡易プラン＋notice を返すべき。
  it('Workers AI 無し＋Gemini失敗でも例外を投げず簡易プラン＋noticeを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fetchRes(false, 500, { error: { message: 'temporary' } })));
    const req: PlanRequest = { area: '箱根', startDate: '2026-07-01', endDate: '2026-07-02', pace: 'normal' };
    const plan = await generateAiPlan({ GEMINI_API_KEY: 'k' } as any, events, req, {});
    expect(plan.engine).toBe('rule');
    expect(plan.notice).toBeTruthy();
    expect(plan.days).toHaveLength(2);
  });
});

describe('generateAiPlan: 「行きたい」スポットの取りこぼし防止', () => {
  // 回帰: 1日あたりの件数上限(slice)で、必ず含めるスポットが末尾にあると消えていた。
  it('上限を超える位置のmustIncludeスポットも残る', async () => {
    const planJson = JSON.stringify({
      theme: 't',
      days: [
        {
          items: [
            { title: 'A', why: 'w' },
            { title: 'B', why: 'w' },
            { title: 'C', why: 'w' },
            { title: '必ず行くスポット', why: 'w' },
          ],
        },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => geminiOk(planJson)));
    // relaxed は1日2件（cap = perDay+1 = 3）。mustInclude は4番目（cap外）。
    const req: PlanRequest = {
      area: '箱根',
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      pace: 'relaxed',
      mustInclude: ['必ず行くスポット'],
    };
    const plan = await generateAiPlan({ GEMINI_API_KEY: 'k' } as any, events, req, {});
    const titles = plan.days[0].items.map((i) => i.title);
    expect(titles).toContain('必ず行くスポット');
  });
});
