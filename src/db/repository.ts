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

// ---- じっくり収集（バックグラウンド）のジョブ管理 ----

const ENSURE_JOBS_SQL = `CREATE TABLE IF NOT EXISTS collect_jobs (
  area TEXT PRIMARY KEY,
  keyword TEXT,
  interests TEXT,
  round INTEGER NOT NULL DEFAULT 1,
  total_rounds INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'pending',
  collected INTEGER NOT NULL DEFAULT 0,
  pass INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export interface CollectJob {
  area: string;
  keyword: string | null;
  interests: string | null;
  round: number;
  total_rounds: number;
  status: string;
  collected: number;
  pass: number;
}

/** マイグレーション無しでも動くよう、ジョブ表を都度作成（冪等）。 */
export async function ensureJobsTable(db: D1Database): Promise<void> {
  await db.prepare(ENSURE_JOBS_SQL).run();
  // 既存テーブルへ pass カラムを後付け（再収集の深さ＝何回目か）。
  try {
    await db.prepare('ALTER TABLE collect_jobs ADD COLUMN pass INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    /* 既にあれば無視 */
  }
}

export async function startJob(
  db: D1Database,
  p: { area: string; keyword?: string; interests?: string[]; totalRounds: number; pass?: number; now: string },
): Promise<void> {
  const pass = p.pass ?? 0;
  await db
    .prepare(
      `INSERT INTO collect_jobs (area, keyword, interests, round, total_rounds, status, collected, pass, created_at, updated_at)
       VALUES (?,?,?,1,?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(area) DO UPDATE SET keyword=excluded.keyword, interests=excluded.interests, round=1,
         total_rounds=excluded.total_rounds, status='pending', pass=excluded.pass, updated_at=excluded.updated_at`,
    )
    .bind(
      p.area,
      p.keyword ?? null,
      p.interests ? JSON.stringify(p.interests) : null,
      p.totalRounds,
      pass,
      p.now,
      p.now,
    )
    .run();
}

export async function getJob(db: D1Database, area: string): Promise<CollectJob | null> {
  const r = await db.prepare('SELECT * FROM collect_jobs WHERE area = ?').bind(area).first<CollectJob>();
  return r ?? null;
}

const ROUND_STALE_MS = 120000; // この時間 running のまま更新が無ければ「落ちた」とみなし再取得可。

export async function takeNextPendingJob(db: D1Database): Promise<CollectJob | null> {
  // 保留中に加え、running のまま停止した（落ちた）ジョブも再取得対象にする。
  const staleBefore = new Date(Date.now() - ROUND_STALE_MS).toISOString();
  const r = await db
    .prepare(
      "SELECT * FROM collect_jobs WHERE status='pending' OR (status='running' AND updated_at < ?) ORDER BY updated_at ASC LIMIT 1",
    )
    .bind(staleBefore)
    .first<CollectJob>();
  return r ?? null;
}

/**
 * 1ラウンド処理の排他取得。pending か「落ちた running」を running に切り替え、
 * 1件でも更新できた呼び出しだけ true（勝者）。waitUntil と Cron の二重実行を防ぐ。
 */
export async function claimJobRound(db: D1Database, area: string, now: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - ROUND_STALE_MS).toISOString();
  const res = await db
    .prepare(
      "UPDATE collect_jobs SET status='running', updated_at=? WHERE area=? AND (status='pending' OR (status='running' AND updated_at < ?))",
    )
    .bind(now, area, staleBefore)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function updateJobProgress(
  db: D1Database,
  area: string,
  p: { round: number; status: string; collected: number; now: string },
): Promise<void> {
  await db
    .prepare('UPDATE collect_jobs SET round=?, status=?, collected=?, updated_at=? WHERE area=?')
    .bind(p.round, p.status, p.collected, p.now, area)
    .run();
}

/** じっくり収集をキャンセル（保留中・実行中）。以降のラウンドは実行されない。 */
export async function cancelCollectJob(db: D1Database, area: string, now: string): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE collect_jobs SET status='cancelled', updated_at=? WHERE area=? AND (status='pending' OR status='running')",
    )
    .bind(now, area)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// 収集済みの (エリア, キーワード) 条件を記録し、差分収集の判定に使う。
const ENSURE_COVERED_SQL = `CREATE TABLE IF NOT EXISTS collect_covered (
  area TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (area, keyword)
)`;

export async function ensureCoveredTable(db: D1Database): Promise<void> {
  await db.prepare(ENSURE_COVERED_SQL).run();
}

export async function isCovered(db: D1Database, area: string, keyword: string): Promise<boolean> {
  const r = await db
    .prepare('SELECT 1 AS x FROM collect_covered WHERE area = ? AND keyword = ?')
    .bind(area, keyword)
    .first();
  return !!r;
}

export async function markCovered(db: D1Database, area: string, keyword: string, now: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO collect_covered (area, keyword, created_at) VALUES (?,?,?)')
    .bind(area, keyword, now)
    .run();
}

/** じっくり収集したエリア名の一覧（似たエリア名の判定に使う）。 */
export async function getCollectedAreas(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT area FROM collect_jobs').all();
  return (results as any[]).map((r) => String(r.area)).filter(Boolean);
}

// ---- ジオコーディング（緯度経度）のキャッシュ ----
// AIの推測座標は不正確なので、スポット名から実座標を引いて保存・再利用する。
// 見つからなかった場合も (0,0) として記録し、無駄な再問い合わせを避ける。

const ENSURE_GEOCODE_SQL = `CREATE TABLE IF NOT EXISTS geocode (
  query TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at TEXT NOT NULL
)`;

export async function ensureGeocodeTable(db: D1Database): Promise<void> {
  await db.prepare(ENSURE_GEOCODE_SQL).run();
}

export async function getGeocode(db: D1Database, query: string): Promise<{ lat: number; lng: number } | null> {
  const r = await db.prepare('SELECT lat, lng FROM geocode WHERE query = ?').bind(query).first<{ lat: number; lng: number }>();
  return r ? { lat: Number(r.lat), lng: Number(r.lng) } : null;
}

export async function putGeocode(db: D1Database, query: string, lat: number, lng: number, now: string): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO geocode (query, lat, lng, created_at) VALUES (?,?,?,?)')
    .bind(query, lat, lng, now)
    .run();
}

// ---- 行ったことある場所（visited） ----

const ENSURE_VISITED_SQL = `CREATE TABLE IF NOT EXISTS visited (
  title TEXT PRIMARY KEY,
  prefecture TEXT,
  area TEXT,
  url TEXT,
  created_at TEXT NOT NULL
)`;

export interface VisitedRow {
  title: string;
  prefecture: string | null;
  area: string | null;
  url: string | null;
}

export async function ensureVisited(db: D1Database): Promise<void> {
  await db.prepare(ENSURE_VISITED_SQL).run();
}

export async function addVisited(
  db: D1Database,
  v: { title: string; prefecture?: string; area?: string; url?: string; now: string },
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO visited (title, prefecture, area, url, created_at) VALUES (?,?,?,?,?)')
    .bind(v.title, v.prefecture ?? null, v.area ?? null, v.url ?? null, v.now)
    .run();
}

export async function removeVisited(db: D1Database, title: string): Promise<void> {
  await db.prepare('DELETE FROM visited WHERE title = ?').bind(title).run();
}

export async function listVisited(db: D1Database): Promise<VisitedRow[]> {
  const { results } = await db
    .prepare('SELECT title, prefecture, area, url FROM visited ORDER BY prefecture, area, title')
    .all();
  return results as any[];
}

/** events から同名スポットの都道府県を補完する（visited 登録時の都道府県解決用）。 */
export async function findEventPrefecture(db: D1Database, title: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT prefecture FROM events WHERE title = ? AND prefecture IS NOT NULL AND prefecture != '' LIMIT 1")
    .bind(title)
    .first<{ prefecture: string }>();
  return r?.prefecture ?? null;
}

// ---- 行ってみたい場所（wishlist。手動で並び替え可能） ----

const ENSURE_WISHLIST_SQL = `CREATE TABLE IF NOT EXISTS wishlist (
  title TEXT PRIMARY KEY,
  prefecture TEXT,
  area TEXT,
  url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`;

export interface WishlistRow {
  title: string;
  prefecture: string | null;
  area: string | null;
  url: string | null;
  sort_order: number;
}

export async function ensureWishlist(db: D1Database): Promise<void> {
  await db.prepare(ENSURE_WISHLIST_SQL).run();
}

export async function addWishlist(
  db: D1Database,
  w: { title: string; prefecture?: string; area?: string; url?: string; now: string },
): Promise<void> {
  // 末尾に追加。既存なら情報だけ更新し、並び順は維持する。
  const max = await db.prepare('SELECT MAX(sort_order) AS m FROM wishlist').first<{ m: number | null }>();
  const next = (max?.m ?? 0) + 1;
  await db
    .prepare(
      `INSERT INTO wishlist (title, prefecture, area, url, sort_order, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(title) DO UPDATE SET prefecture=excluded.prefecture, area=excluded.area, url=excluded.url`,
    )
    .bind(w.title, w.prefecture ?? null, w.area ?? null, w.url ?? null, next, w.now)
    .run();
}

export async function removeWishlist(db: D1Database, title: string): Promise<void> {
  await db.prepare('DELETE FROM wishlist WHERE title = ?').bind(title).run();
}

export async function listWishlist(db: D1Database): Promise<WishlistRow[]> {
  const { results } = await db
    .prepare('SELECT title, prefecture, area, url, sort_order FROM wishlist ORDER BY sort_order, created_at')
    .all();
  return results as any[];
}

/** 渡された順に sort_order を振り直す（並び替えの保存）。 */
export async function reorderWishlist(db: D1Database, titles: string[]): Promise<void> {
  if (!titles.length) return;
  const stmt = db.prepare('UPDATE wishlist SET sort_order = ? WHERE title = ?');
  await db.batch(titles.map((t, i) => stmt.bind(i + 1, t)));
}

// ---- プラン作成のバックグラウンドジョブ ----

const ENSURE_PLAN_JOBS_SQL = `CREATE TABLE IF NOT EXISTS plan_jobs (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  origin TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  plan_id TEXT,
  error TEXT,
  stage TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export interface PlanJob {
  id: string;
  request: string;
  origin: string | null;
  status: string;
  plan_id: string | null;
  error: string | null;
  stage: string | null;
  progress: number | null;
}

export async function ensurePlanJobs(db: D1Database): Promise<void> {
  await db.prepare(ENSURE_PLAN_JOBS_SQL).run();
  // 既存テーブルへの後付けカラム（無ければ追加。既にあればエラーは無視）。
  for (const sql of [
    'ALTER TABLE plan_jobs ADD COLUMN stage TEXT',
    'ALTER TABLE plan_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* カラムが既に存在する場合は無視 */
    }
  }
}

export async function createPlanJob(
  db: D1Database,
  p: { id: string; request: object; origin?: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plan_jobs (id, request, origin, status, created_at, updated_at)
       VALUES (?,?,?, 'pending', ?, ?)`,
    )
    .bind(p.id, JSON.stringify(p.request), p.origin ?? null, p.now, p.now)
    .run();
}

export async function getPlanJob(db: D1Database, id: string): Promise<PlanJob | null> {
  const r = await db.prepare('SELECT * FROM plan_jobs WHERE id = ?').bind(id).first<PlanJob>();
  return r ?? null;
}

export async function takePendingPlanJob(db: D1Database, before: string): Promise<PlanJob | null> {
  const r = await db
    .prepare("SELECT * FROM plan_jobs WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at ASC LIMIT 1")
    .bind(before)
    .first<PlanJob>();
  return r ?? null;
}

export async function updatePlanJob(
  db: D1Database,
  id: string,
  p: { status: string; planId?: string; error?: string; now: string },
): Promise<void> {
  await db
    .prepare('UPDATE plan_jobs SET status=?, plan_id=?, error=?, updated_at=? WHERE id=?')
    .bind(p.status, p.planId ?? null, p.error ?? null, p.now, id)
    .run();
}

/** ジョブの進捗（ステージ表示と%）だけを更新する。status は変えない。 */
export async function updatePlanProgress(
  db: D1Database,
  id: string,
  stage: string,
  progress: number,
  now: string,
): Promise<void> {
  const pct = Math.max(0, Math.min(99, Math.round(progress))); // 完了(100)は status=done 側で表現する
  await db
    .prepare('UPDATE plan_jobs SET stage=?, progress=?, updated_at=? WHERE id=?')
    .bind(stage, pct, now, id)
    .run();
}

/** プラン作成ジョブをキャンセル（保留中のみ）。 */
export async function cancelPlanJob(db: D1Database, id: string, now: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE plan_jobs SET status='cancelled', updated_at=? WHERE id=? AND status='pending'")
    .bind(now, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** events に hours 列が無ければ追加する（営業時間・冪等）。 */
export async function ensureEventsColumns(db: D1Database): Promise<void> {
  try {
    await db.prepare('ALTER TABLE events ADD COLUMN hours TEXT').run();
  } catch {
    /* 既に存在する */
  }
}

/** 正規化イベントを upsert。重複は (source, source_event_id) で更新。件数を返す。 */
/**
 * イベント情報サイト（ウォーカープラス等）の発見済みリストURLを都道府県ごとにキャッシュする。
 * 一度発見すれば次回は検索（Jina等）不要で直接取得でき、レート制限に強くなる。
 */
export async function ensureEventSourceCache(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS event_source_cache (
        pref TEXT PRIMARY KEY, urls TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
    )
    .run();
}

export async function getEventSourceUrls(db: D1Database, pref: string): Promise<string[]> {
  if (!pref) return [];
  await ensureEventSourceCache(db);
  const row = await db.prepare('SELECT urls FROM event_source_cache WHERE pref = ?').bind(pref).first<{ urls: string }>();
  if (!row?.urls) return [];
  try {
    const arr = JSON.parse(row.urls);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function putEventSourceUrls(db: D1Database, pref: string, urls: string[]): Promise<void> {
  if (!pref || !urls.length) return;
  await ensureEventSourceCache(db);
  await db
    .prepare(
      `INSERT INTO event_source_cache (pref, urls, updated_at) VALUES (?,?,?)
       ON CONFLICT(pref) DO UPDATE SET urls = excluded.urls, updated_at = excluded.updated_at`,
    )
    .bind(pref, JSON.stringify(urls.slice(0, 12)), new Date().toISOString())
    .run();
}

export async function upsertEvents(
  db: D1Database,
  source: string,
  events: NormalizedEvent[],
  scrapedAt: string,
): Promise<number> {
  if (!events.length) return 0;
  await ensureEventsColumns(db);
  const stmt = db.prepare(
    `INSERT INTO events
      (id, source, source_event_id, title, description, url, category, tags,
       prefecture, city, location_name, lat, lng, start_at, end_at, price, hours, image_url, raw, scraped_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, source_event_id) DO UPDATE SET
       title=excluded.title, description=excluded.description, url=excluded.url,
       category=excluded.category, tags=excluded.tags, prefecture=excluded.prefecture,
       city=excluded.city, location_name=excluded.location_name, lat=excluded.lat,
       lng=excluded.lng, start_at=excluded.start_at, end_at=excluded.end_at,
       price=excluded.price, hours=excluded.hours, image_url=excluded.image_url, raw=excluded.raw,
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
      e.hours ?? null,
      e.imageUrl ?? null,
      e.raw ? JSON.stringify(e.raw).slice(0, 2000) : null,
      scrapedAt,
    ),
  );
  // 一括 batch が大きすぎると D1 がタイムアウト（object reset）するので、小分けにして書き込む。
  const CHUNK = 25;
  for (let i = 0; i < batch.length; i += CHUNK) {
    await db.batch(batch.slice(i, i + CHUNK));
  }
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
  // 日付フィルタ: 開催期間[start_at, end_at]が旅行期間[from, to]と「重なる」ものを残す。
  // 終了日が無い催しは単日(end_at=start_at)とみなす。日付不明(start_at IS NULL)は常に残す。
  // これで長期開催(会期が旅行日をまたぐ展覧会・ビアガーデン等)を取りこぼさない。
  if (query.from && query.to) {
    where.push('(start_at IS NULL OR (start_at <= ? AND COALESCE(end_at, start_at) >= ?))');
    binds.push(`${query.to}T23:59:59`, `${query.from}T00:00:00`);
  } else if (query.from) {
    where.push('(start_at IS NULL OR COALESCE(end_at, start_at) >= ?)');
    binds.push(`${query.from}T00:00:00`);
  } else if (query.to) {
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

/** 直近の保存プラン一覧（履歴）。 */
export async function listPlans(
  db: D1Database,
  limit = 20,
): Promise<{ id: string; createdAt: string; area?: string; startDate?: string; endDate?: string; theme?: string }[]> {
  await ensurePlansColumns(db);
  const { results } = await db
    .prepare(
      'SELECT id, created_at, request, result FROM plans WHERE COALESCE(saved, 0) = 1 AND COALESCE(hidden, 0) = 0 ORDER BY created_at DESC LIMIT ?',
    )
    .bind(Math.min(limit, 50))
    .all();
  return (results as any[]).map((r) => {
    let req: any = {};
    let res: any = {};
    try {
      req = JSON.parse(r.request);
    } catch {
      /* ignore */
    }
    try {
      res = JSON.parse(r.result);
    } catch {
      /* ignore */
    }
    return {
      id: r.id,
      createdAt: r.created_at,
      area: req?.area,
      startDate: req?.startDate,
      endDate: req?.endDate,
      theme: res?.theme,
    };
  });
}

export async function getPlan(
  db: D1Database,
  id: string,
): Promise<{ id: string; created_at: string; request: PlanRequest; result: Plan; saved: boolean } | null> {
  const row = await db.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first<any>();
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    request: JSON.parse(row.request),
    result: JSON.parse(row.result),
    saved: !!row.saved,
  };
}

/** plans に hidden / saved 列が無ければ追加する（冪等）。 */
export async function ensurePlansColumns(db: D1Database): Promise<void> {
  try {
    await db.prepare('ALTER TABLE plans ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    /* 既に存在する */
  }
  try {
    await db.prepare('ALTER TABLE plans ADD COLUMN saved INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    /* 既に存在する */
  }
}

/** 保存プランをソフト削除（一覧から隠すだけ。DBには残り、共有リンクでは閲覧可）。 */
export async function hidePlan(db: D1Database, id: string): Promise<boolean> {
  await ensurePlansColumns(db);
  const res = await db.prepare('UPDATE plans SET hidden = 1 WHERE id = ?').bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** プランを「保存」する（保存ボタンを押したものだけ履歴に出す）。 */
export async function markPlanSaved(db: D1Database, id: string): Promise<boolean> {
  await ensurePlansColumns(db);
  const res = await db.prepare('UPDATE plans SET saved = 1, hidden = 0 WHERE id = ?').bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 編集後のプラン内容（result）を上書き保存する。 */
export async function updatePlanResult(db: D1Database, id: string, result: Plan): Promise<void> {
  await db
    .prepare('UPDATE plans SET result = ? WHERE id = ?')
    .bind(JSON.stringify(result).slice(0, 200_000), id)
    .run();
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
