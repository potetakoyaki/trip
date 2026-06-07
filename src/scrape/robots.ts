/**
 * robots.txt の最小実装。User-agent グループごとに Allow/Disallow を集め、
 * 最長一致のルールで判定する。完全準拠ではないが個人利用には十分。
 */
export function robotsAllows(robotsTxt: string, path: string, userAgent: string): boolean {
  const uaToken = userAgent.toLowerCase().split('/')[0]; // "TripPlannerBot/0.1" -> "tripplannerbot"
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());

  // エージェントごとにルールをまとめる
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let expectingAgent = false;

  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !expectingAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      expectingAgent = false;
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }

  // 自分の UA に一致するグループ、なければ '*' グループ
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = specific.length ? specific : wildcard;
  if (!applicable.length) return true;

  const rules = applicable.flatMap((g) => g.rules);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (r.path === '') {
      // "Disallow:" 空 = 全許可。Allow: 空は無視。
      if (!r.allow) continue;
    }
    if (path.startsWith(r.path) || r.path === '/') {
      const len = r.path.length;
      if (!best || len > best.len) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}
