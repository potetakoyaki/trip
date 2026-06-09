import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateAiPlan } from '../src/planner/ai';
import type { PlanRequest } from '../src/types';

afterEach(() => vi.unstubAllGlobals());

// Gemini が plan JSON を返すモック（fetch を差し替え）。
function stubGemini(planJson: unknown) {
  const body = { candidates: [{ content: { parts: [{ text: JSON.stringify(planJson) }] } }] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as any),
  );
}

const req: PlanRequest = { area: '出雲市', startDate: '2026-07-01', endDate: '2026-07-01' };

describe('generateAiPlan: 収集スポットが空でもAIの一般知識で作る', () => {
  it('events が空でも Gemini が返した名所でプランを作る（ルールベース空に落ちない）', async () => {
    stubGemini({
      theme: '出雲のご縁旅',
      enjoyment: '朝の澄んだ空気で参拝を。',
      advice: ['朝早く動く', '出雲そばを食べる'],
      days: [
        {
          theme: '縁結びめぐり',
          items: [
            { title: '出雲大社', time: '10:00', category: '歴史', why: '縁結びの名社', tips: '朝が空く', hours: '6:00-20:00', estCost: 0, lat: 35.4, lng: 132.68 },
            { title: '出雲そば 八雲', time: '12:30', category: 'グルメ', why: '名物の割子そば', tips: '混む前に', estCost: 1200, lat: 35.4, lng: 132.69 },
          ],
        },
      ],
    });

    const env = { GEMINI_API_KEY: 'k' } as any;
    const plan = await generateAiPlan(env, [], req);
    const items = plan.days.flatMap((d) => d.items);
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.title)).toContain('出雲大社');
    expect(plan.engine).toBe('ai');
  });
});
