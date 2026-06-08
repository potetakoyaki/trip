import type { Env } from '../types';

// 既定モデル。GEMINI_MODEL で上書き可能。gemini-2.0-flash は無料枠があり高速・高品質。
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

/** GEMINI_API_KEY が設定されていれば true（＝外部Geminiを使う）。 */
export function geminiEnabled(env: Env): boolean {
  return typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
}

/**
 * Google Gemini（Generative Language API v1beta）でテキストを生成する。
 * 既定でJSON出力を強制（responseMimeType）。Cloudflare Workers AI のニューロン枠とは
 * 無関係なので、4006（枠切れ）の影響を受けない。失敗時は例外を投げ、呼び出し側で
 * Workers AI へフォールバックする。
 */
export async function geminiGenerate(
  env: Env,
  systemText: string,
  userText: string,
  opts: { json?: boolean; maxOutputTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = (env.GEMINI_API_KEY ?? '').trim();
  if (!key) throw new Error('GEMINI_API_KEY が未設定です');
  const model = (env.GEMINI_MODEL ?? '').trim() || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(key)}`;

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.7,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  };
  if (opts.json !== false) generationConfig.responseMimeType = 'application/json';

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig,
  };

  // 429（レート/クォータ超過）・503（一時的）はバックオフして再試行する。
  // 無料枠はRPM（毎分リクエスト数）が低く、抽出の並列呼び出しで一時的に超えやすいため。
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const maxAttempts = 3;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const parts = data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
      if (!text.trim()) {
        const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'empty';
        throw new Error(`Gemini応答が空でした (${reason})`);
      }
      return text;
    }
    const t = await res.text().catch(() => '');
    lastErr = `Gemini APIエラー (${res.status}): ${t.slice(0, 300)}`;
    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
      await sleep(900 * attempt); // 0.9s, 1.8s
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr || 'Gemini 生成に失敗しました');
}
