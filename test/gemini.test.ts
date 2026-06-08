import { describe, it, expect, vi, afterEach } from 'vitest';
import { geminiGenerate, geminiEnabled } from '../src/planner/gemini';

const env = (extra: Record<string, unknown> = {}) => ({ GEMINI_API_KEY: 'k', ...extra }) as any;
function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body } as any;
}
afterEach(() => vi.unstubAllGlobals());

describe('gemini クライアント', () => {
  it('geminiEnabled はキー有無を判定', () => {
    expect(geminiEnabled(env())).toBe(true);
    expect(geminiEnabled({} as any)).toBe(false);
    expect(geminiEnabled({ GEMINI_API_KEY: '  ' } as any)).toBe(false);
  });

  it('成功時は本文テキストを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(true, 200, { candidates: [{ content: { parts: [{ text: 'OK' }] } }] })));
    expect(await geminiGenerate(env(), 'sys', 'user', { maxAttempts: 1 })).toBe('OK');
  });

  it('429 は (maxAttempts:1) 即エラーで内容を含む', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(false, 429, { error: { message: 'quota' } })));
    await expect(geminiGenerate(env(), 's', 'u', { maxAttempts: 1 })).rejects.toThrow('429');
  });

  it('空応答(MAX_TOKENS)はエラー', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(true, 200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '' }] } }] })),
    );
    await expect(geminiGenerate(env(), 's', 'u', { maxAttempts: 1 })).rejects.toThrow('空');
  });

  it('2.5系モデルは thinkingConfig=0 を付ける', async () => {
    const f = vi.fn(async () => res(true, 200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
    vi.stubGlobal('fetch', f);
    await geminiGenerate(env(), 's', 'u', { model: 'gemini-2.5-flash', maxAttempts: 1 });
    const body = JSON.parse((f.mock.calls as any)[0][1].body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('2.0系モデルは thinkingConfig を付けない', async () => {
    const f = vi.fn(async () => res(true, 200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
    vi.stubGlobal('fetch', f);
    await geminiGenerate(env(), 's', 'u', { model: 'gemini-2.0-flash', maxAttempts: 1 });
    const body = JSON.parse((f.mock.calls as any)[0][1].body);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('キー未設定は投げる', async () => {
    await expect(geminiGenerate({} as any, 's', 'u')).rejects.toThrow('GEMINI_API_KEY');
  });
});
