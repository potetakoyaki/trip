import type { EventRecord, NormalizedEvent, Plan, PlanRequest, SourceRow } from '../types';

/** sources を読み出す。enabledOnly で有効なものだけ。 */
export async function getSources(
  db: D1Database,
  opts: { enabledOnly?: boolean; id?: string } = {},
): Promise<SourceRow[]> {
  let sql = 'SELECT * FROM sources';
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.enabledOnly) where.push('enabled = 1');
  if (opts.id) {
    where.push('id = ?');
    binds.push(opts.id);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id';
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as any[]).map(rowToSource);
}

function rowToSource(r: any): SourceRow {
  let config: Record<string, unknown> = {};
  try {
    config = r.config ? JSON.parse(r.config) : {};
  } catch {
    config = {};
  }
  return { ...r, config };
}

export async function updateSourceStatus(
  db: D1Database,
  id: string,
  status: string,
  ranAt: string,
): Promise<void> {
  await db
    .prepare('UPDATE sources SET last_run_at = ?, last_status = ? WHERE id = ?')
    .bind(ranAt, status, id)
    .run();
}

/** ソースを新規作成。 */
export async function createSource(
  db: D1Database,
  s: { id: string; name: string; kind: string; base_url?: string | null; config: object; enabled: boolean },
): Promise<void> {
  await db
    .prepare('INSERT INTO sources (id, name, kind, base_url, config, enabled) VALUES (?,?,?,?,?,?)')
    .bind(s.id, s.name, s.kind, s.base_url ?? null, JSON.stringify(s.config), s.enabled ? 1 : 0)
    .run();
}

/** ソースの有効/無効・設定・名前を更新。変更があれば true。 */
export async function updateSource(
  db: D1Database,
  id: string,
  patch: { enabled?: boolean; config?: object; name?: string },
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    binds.push(patch.enabled ? 1 : 0);
  }
  if (patch.config !== undefined) {
    sets.push('config = ?');
    binds.push(JSON.stringify(patch.config));
  }
  if (patch.name !== undefined) {
    sets.push('name = ?');
    binds.push(patch.name);
  }
  if (!sets.length) return false;
  binds.push(id);
  const res = await db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** ソースを削除。 */
export async function deleteSource(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM sources WHERE id = ?').bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 有効なソースの最終実行時刻のうち最も新しいもの（自動取得の鮮度判定用）。 */
export async function getLastScrapeAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare('SELECT MAX(last_run_at) AS t FROM sources WHERE enabled = 1')
    .first<{ t: string | null }>();
  return row?.t ?? null;
}

/** 正規化イベントを upsert。重複は (source, source_event_id) で更新。件数を返す。 */
export async function upsertEvents(
  db: D1Database,
  source: string,
  events: NormalizedEvent[],
  scrapedAt: string,
): Promise<number> {
  if (!events.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO events
      (id, source, source_event_id, title, description, url, category, tags,
       prefecture, city, location_name, lat, lng, start_at, end_at, price, image_url, raw, scraped_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, source_event_id) DO UPDATE SET
       title=excluded.title, description=excluded.description, url=excluded.url,
       category=excluded.category, tags=excluded.tags, prefecture=excluded.prefecture,
       city=excluded.city, location_name=excluded.location_name, lat=excluded.lat,
       lng=excluded.lng, start_at=excluded.start_at, end_at=excluded.end_at,
       price=excluded.price, image_url=excluded.image_url, raw=excluded.raw,
       scraped_at=excluded.scraped_at`,
  );

  const batch = events.map((e) =>
    stmt.bind(
      `${source}:${e.sourceEventId}`,
      source,
      e.sourceEventId,
      e.title,
      e.description ?? null,
      e.url ?? null,
      e.category ?? null,
      e.tags ? JSON.stringify(e.tags) : null,
      e.prefecture ?? null,
      e.city ?? null,
      e.locationName ?? null,
      e.lat ?? null,
      e.lng ?? null,
      e.startAt ?? null,
      e.endAt ?? null,
      e.price ?? null,
      e.imageUrl ?? null,
      e.raw ? JSON.stringify(e.raw).slice(0, 8000) : null,
      scrapedAt,
    ),
  );
  await db.batch(batch);
  return events.length;
}

export interface EventQuery {
  area?: string;
  from?: string; // YYYY-MM-DD
  to?: string;
  category?: string;
  q?: string;
  limit?: number;
}

export async function searchEvents(db: D1Database, query: EventQuery): Promise<EventRecord[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (query.area) {
    where.push('(prefecture LIKE ? OR city LIKE ? OR location_name LIKE ? OR title LIKE ?)');
    const like = `%${query.area}%`;
    binds.push(like, like, like, like);
  }
  if (query.category) {
    where.push('category = ?');
    binds.push(query.category);
  }
  if (query.q) {
    where.push('(title LIKE ? OR description LIKE ?)');
    binds.push(`%${query.q}%`, `%${query.q}%`);
  }
  // 日付フィルタ: 日付不明(start_at IS NULL)は常に候補に残す
  if (query.from) {
    where.push('(start_at IS NULL OR start_at >= ?)');
    binds.push(`${query.from}T00:00:00`);
  }
  if (query.to) {
    where.push('(start_at IS NULL OR start_at <= ?)');
    binds.push(`${query.to}T23:59:59`);
  }

  let sql = 'SELECT * FROM events';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY (start_at IS NULL), start_at LIMIT ?';
  binds.push(Math.min(query.limit ?? 200, 500));

  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as any[]).map(rowToEvent);
}

function rowToEvent(r: any): EventRecord {
  let tags: string[] | undefined;
  try {
    tags = r.tags ? JSON.parse(r.tags) : undefined;
  } catch {
    tags = undefined;
  }
  return { ...r, tags };
}

export async function savePlan(
  db: D1Database,
  id: string,
  createdAt: string,
  request: PlanRequest,
  result: Plan,
): Promise<void> {
  await db
    .prepare('INSERT INTO plans (id, created_at, request, result) VALUES (?,?,?,?)')
    .bind(id, createdAt, JSON.stringify(request), JSON.stringify(result))
    .run();
}

export async function getPlan(
  db: D1Database,
  id: string,
): Promise<{ id: string; created_at: string; request: PlanRequest; result: Plan } | null> {
  const row = await db.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first<any>();
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    request: JSON.parse(row.request),
    result: JSON.parse(row.result),
  };
}

/** 動作確認用のサンプルイベントを投入する。 */
export async function insertDemoEvents(db: D1Database, scrapedAt: string): Promise<number> {
  const demo: NormalizedEvent[] = [
    { sourceEventId: 'hakone-onsen', title: '箱根湯本温泉 日帰り入浴', category: '宿泊', prefecture: '神奈川県', city: '箱根町', locationName: '箱根湯本', price: 1500, description: '名湯でゆったり。旅の疲れを癒す。' },
    { sourceEventId: 'hakone-art', title: '彫刻の森美術館', category: 'アート', prefecture: '神奈川県', city: '箱根町', locationName: '二ノ平', price: 1600, lat: 35.244, lng: 139.05, description: '屋外彫刻とピカソ館。' },
    { sourceEventId: 'hakone-shrine', title: '箱根神社 参拝', category: '歴史', prefecture: '神奈川県', city: '箱根町', locationName: '芦ノ湖畔', price: 0, description: '芦ノ湖の水中鳥居が有名。' },
    { sourceEventId: 'hakone-lunch', title: '芦ノ湖畔で名物そば', category: 'グルメ', prefecture: '神奈川県', city: '箱根町', locationName: '元箱根', price: 1200, description: '湖を眺めながらのランチ。' },
    { sourceEventId: 'hakone-ropeway', title: '大涌谷ロープウェイと黒たまご', category: '自然', prefecture: '神奈川県', city: '箱根町', locationName: '大涌谷', price: 1500, description: '噴煙地を空中散歩。名物の黒たまご。' },
    { sourceEventId: 'hakone-museum-glass', title: '箱根ガラスの森美術館', category: 'アート', prefecture: '神奈川県', city: '箱根町', locationName: '仙石原', price: 1800, description: 'ヴェネチアン・グラスの世界。' },
  ];
  return upsertEvents(db, 'demo', demo, scrapedAt);
}
