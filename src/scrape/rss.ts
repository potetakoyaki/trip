import type { NormalizedEvent } from '../types';
import { inferCategory, inferPrefecture } from '../util/normalize';

/** RSS/Atom 文字列をイベント配列に変換する純粋関数（テスト可能）。 */
export function parseRss(
  xml: string,
  opts: { category?: string; prefecture?: string } = {},
): NormalizedEvent[] {
  const blocks = matchAll(xml, /<(item|entry)\b[\s\S]*?<\/\1>/gi);
  const events: NormalizedEvent[] = [];

  for (const block of blocks) {
    const title = decode(firstTag(block, 'title'));
    if (!title) continue;

    const link =
      decode(firstTag(block, 'link')) ||
      attr(block, 'link', 'href') ||
      decode(firstTag(block, 'guid'));
    const description = decode(firstTag(block, 'description') || firstTag(block, 'summary') || firstTag(block, 'content'));
    const pub = firstTag(block, 'pubDate') || firstTag(block, 'updated') || firstTag(block, 'published');
    const guid = decode(firstTag(block, 'guid')) || link || title;

    const startAt = toIso(pub);

    events.push({
      sourceEventId: guid,
      title,
      description: description || undefined,
      url: link || undefined,
      category: opts.category ?? inferCategory(title, description),
      prefecture: opts.prefecture || inferPrefecture(title, description),
      startAt: startAt,
      raw: { block: block.slice(0, 2000) },
    });
  }
  return events;
}

function matchAll(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

function firstTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function attr(block: string, tag: string, name: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function decode(s: string): string {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '') // 念のため内側タグを除去
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function toIso(d: string): string | undefined {
  if (!d) return undefined;
  const t = new Date(d.trim());
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}
