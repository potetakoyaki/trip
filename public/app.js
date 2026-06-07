'use strict';

const $ = (id) => document.getElementById(id);
const selectedInterests = new Set();
const visitedSet = new Set();
const wishlistSet = new Set();
let wishlistRows = [];
let currentPlanId = null;
let currentArea = '';
let currentTransport = '';
let currentPlan = null;

const CAT_EMOJI = {
  グルメ: '🍜',
  自然: '🌿',
  歴史: '⛩️',
  アート: '🎨',
  音楽: '🎵',
  体験: '🎫',
  宿泊: '♨️',
  祭り: '🎆',
  テック: '💻',
  観光: '📷',
  イベント: '🎉',
};
const catEmoji = (c) => CAT_EMOJI[c] || '📍';

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function api(path, options) {
  const res = await fetch('/api' + path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- 行ったことある場所（visited） ---
async function loadVisited() {
  try {
    const { visited } = await api('/visited');
    visitedSet.clear();
    (visited || []).forEach((v) => visitedSet.add(v.title));
    const cnt = $('visited-count');
    if (cnt) cnt.textContent = visited && visited.length ? ` (${visited.length})` : '';
    renderVisitedTree(visited || []);
    syncSpotChecks();
  } catch {
    /* 任意機能 */
  }
}

function renderVisitedTree(rows) {
  const el = $('visited-tree');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML =
      '<p class="visited-empty">まだありません。プランやスポット一覧の「行った」にチェックすると、ここに<strong>都道府県＞エリア別</strong>でたまります。</p>';
    return;
  }
  // 都道府県 → エリア → スポット の階層に
  const byPref = {};
  rows.forEach((r) => {
    const pref = r.prefecture || '未分類';
    const area = r.area || 'その他';
    byPref[pref] = byPref[pref] || {};
    byPref[pref][area] = byPref[pref][area] || [];
    byPref[pref][area].push(r);
  });
  el.innerHTML = Object.keys(byPref)
    .sort()
    .map((pref) => {
      const areas = byPref[pref];
      const count = Object.values(areas).reduce((n, a) => n + a.length, 0);
      const areaHtml = Object.keys(areas)
        .sort()
        .map((area) => {
          const spots = areas[area]
            .map((s) => {
              const name = s.url
                ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
                : esc(s.title);
              return `<div class="vt-spot"><span>${name}</span><button type="button" class="vt-remove" data-title="${esc(s.title)}">削除</button></div>`;
            })
            .join('');
          return `<div class="vt-area"><div class="vt-area-name">${esc(area)}</div>${spots}</div>`;
        })
        .join('');
      return `<details class="vt-pref" open><summary>${esc(pref)}<span class="vt-pref-count">${count}件</span></summary>${areaHtml}</details>`;
    })
    .join('');
}

async function toggleVisited(title, on, opts = {}) {
  if (on) visitedSet.add(title);
  else visitedSet.delete(title);
  try {
    await api('/visited', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, visited: on, area: opts.area, prefecture: opts.prefecture, url: opts.url }),
    });
  } catch {
    /* ignore */
  }
  loadVisited();
}

function visitedCheckbox(title, prefecture, url) {
  const checked = visitedSet.has(title) ? 'checked' : '';
  return `<label class="visited-check"><input type="checkbox" class="visited-cb" data-title="${esc(title)}" data-pref="${esc(prefecture || '')}" data-url="${esc(url || '')}" ${checked}> 行った</label>`;
}

function openDrawer() {
  $('drawer').classList.remove('hidden');
  $('drawer-overlay').classList.remove('hidden');
  loadHistory();
  loadWishlist();
  loadVisited();
}
function closeDrawer() {
  $('drawer').classList.add('hidden');
  $('drawer-overlay').classList.add('hidden');
}

// --- 行ってみたい場所（wishlist・並び替え可能） ---
async function loadWishlist() {
  try {
    const { wishlist } = await api('/wishlist');
    wishlistRows = wishlist || [];
    wishlistSet.clear();
    wishlistRows.forEach((w) => wishlistSet.add(w.title));
    renderWishlist();
    syncSpotChecks();
  } catch {
    /* 任意機能 */
  }
}

function renderWishlist() {
  const el = $('wishlist-list');
  if (!el) return;
  const cnt = $('wish-count');
  if (cnt) cnt.textContent = wishlistRows.length ? ` (${wishlistRows.length})` : '';
  if (!wishlistRows.length) {
    el.innerHTML =
      '<p class="visited-empty">スポットの「⭐行きたい」にチェックすると、ここに行きたい順で並びます。</p>';
    return;
  }
  el.innerHTML = wishlistRows
    .map((w, i) => {
      const name = w.url
        ? `<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a>`
        : esc(w.title);
      const pref = w.prefecture ? `<span class="wl-pref">${esc(w.prefecture)}</span>` : '';
      return `<div class="wl-item">
        <div class="wl-ord">
          <button type="button" class="wl-up" data-title="${esc(w.title)}" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="wl-down" data-title="${esc(w.title)}" aria-label="下へ" ${i === wishlistRows.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <div class="wl-main"><span class="wl-name">${name}</span>${pref}</div>
        <button type="button" class="wl-remove" data-title="${esc(w.title)}" aria-label="削除">🗑</button>
      </div>`;
    })
    .join('');
}

async function toggleWishlist(title, on, opts = {}) {
  if (on) wishlistSet.add(title);
  else wishlistSet.delete(title);
  syncSpotChecks();
  try {
    await api('/wishlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, wish: on, area: opts.area, prefecture: opts.prefecture, url: opts.url }),
    });
  } catch {
    /* ignore */
  }
  loadWishlist();
}

// ↑↓ で並び替え。画面はその場で更新し、順序をサーバーに保存する。
async function moveWishlist(title, dir) {
  const i = wishlistRows.findIndex((r) => r.title === title);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= wishlistRows.length) return;
  [wishlistRows[i], wishlistRows[j]] = [wishlistRows[j], wishlistRows[i]];
  renderWishlist();
  try {
    await api('/wishlist/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles: wishlistRows.map((r) => r.title) }),
    });
  } catch {
    /* ignore */
  }
}

// 画面上の各スポットの「行った/行きたい」チェック状態を、最新の集合に合わせる。
function syncSpotChecks() {
  document.querySelectorAll('.visited-cb').forEach((cb) => {
    cb.checked = visitedSet.has(cb.dataset.title);
  });
  document.querySelectorAll('.wish-cb').forEach((cb) => {
    cb.checked = wishlistSet.has(cb.dataset.title);
  });
}

function wishCheckbox(title, prefecture, url) {
  const checked = wishlistSet.has(title) ? 'checked' : '';
  return `<label class="wish-check"><input type="checkbox" class="wish-cb" data-title="${esc(title)}" data-pref="${esc(prefecture || '')}" data-url="${esc(url || '')}" ${checked}> ⭐行きたい</label>`;
}

function spotChecks(title, prefecture, url) {
  return `<div class="spot-checks">${wishCheckbox(title, prefecture, url)}${visitedCheckbox(title, prefecture, url)}</div>`;
}

// --- スポット間の移動時間の概算（緯度経度から・並び替えで即再計算） ---
const MODE_SPEED = { 電車: 30, 新幹線: 45, 車: 30, 飛行機: 40, 高速バス: 28, '': 26 };
const MODE_ICON = { 電車: '🚃', 新幹線: '🚄', 車: '🚗', 飛行機: '✈️', 高速バス: '🚌' };

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function travelLeg(a, b, mode) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const km = haversineKm(a, b);
  if (km < 0.05) return null;
  if (km < 0.8) {
    const m = Math.max(2, Math.round((km / 4.5) * 60));
    return { minutes: m, km: Math.round(km * 10) / 10, label: `徒歩 約${m}分`, icon: '🚶' };
  }
  const sp = MODE_SPEED[mode] ?? 26;
  const m = Math.max(5, Math.round((km / sp) * 60) + 4);
  return { minutes: m, km: Math.round(km * 10) / 10, label: `${mode || '公共交通'} 約${m}分`, icon: MODE_ICON[mode] || '🧭' };
}

function parseClock(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function fmtClock(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function parseDurationMin(s) {
  if (!s) return 60;
  const str = String(s);
  let total = 0;
  let ok = false;
  const h = str.match(/(\d+(?:\.\d+)?)\s*時間/);
  if (h) {
    total += parseFloat(h[1]) * 60;
    ok = true;
  }
  const m = str.match(/(\d+)\s*分/);
  if (m) {
    total += parseInt(m[1], 10);
    ok = true;
  }
  if (!ok) {
    const n = str.match(/(\d+)/);
    if (n) {
      total = parseInt(n[1], 10);
      ok = true;
    }
  }
  return ok && total > 0 ? total : 60;
}

// 各スポットの開始時刻と、次までの移動を計算する（移動手段は選択値）。
function computeSchedule(items, mode) {
  const times = [];
  const legs = [];
  let cur = parseClock(items[0] && items[0].time);
  if (cur == null) cur = 600; // 10:00 既定
  for (let i = 0; i < items.length; i++) {
    times[i] = fmtClock(cur);
    const stay = parseDurationMin(items[i].duration);
    const leg = i < items.length - 1 ? travelLeg(items[i], items[i + 1], mode) : null;
    legs[i] = leg;
    cur += stay + (leg ? leg.minutes : 0);
  }
  return { times, legs };
}

function renderConnector(leg) {
  if (!leg) return '<div class="move-seg move-unknown">↓</div>';
  const km = leg.km != null ? `<span class="move-km">約${leg.km}km</span>` : '';
  return `<div class="move-seg">${leg.icon} 次まで <b>${esc(leg.label)}</b>${km}</div>`;
}

// --- dates ---
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function initDates() {
  const start = addDays(new Date().toISOString().slice(0, 10), 7);
  $('startDate').value = start;
  $('endDate').value = addDays(start, 1);
}

async function loadCategories(preselect) {
  try {
    const { categories } = await api('/categories');
    const box = $('interests');
    box.innerHTML = '';
    categories.forEach((cat) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.cat = cat;
      chip.textContent = `${catEmoji(cat)} ${cat}`;
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        if (selectedInterests.has(cat)) selectedInterests.delete(cat);
        else selectedInterests.add(cat);
      });
      if (preselect && preselect.includes(cat)) {
        chip.classList.add('active');
        selectedInterests.add(cat);
      }
      box.appendChild(chip);
    });
  } catch (e) {
    console.error(e);
  }
}

function getHotelFeatures() {
  const vals = Array.from(document.querySelectorAll('.hotel-feat:checked')).map((c) => c.value);
  return vals.length ? vals : undefined;
}

function fillForm(req) {
  if (!req) return;
  const set = (id, v) => {
    if (v != null && v !== '') $(id).value = v;
  };
  set('area', req.area);
  set('origin', req.origin);
  set('transport', req.transport);
  set('startDate', req.startDate);
  set('endDate', req.endDate);
  set('budget', req.budget);
  set('pace', req.pace);
  set('weather', req.weather);
  set('companions', req.companions);
  set('vibe', req.vibe);
  set('keyword', req.keyword);
  const feats = new Set(req.hotelFeatures || []);
  document.querySelectorAll('.hotel-feat').forEach((c) => {
    c.checked = feats.has(c.value);
  });
  $('eco').checked = !!req.eco;
}

async function sharePlan() {
  if (!currentPlanId) return;
  const url = `${location.origin}/?plan=${currentPlanId}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus('プランのリンクをコピーしました 🔗 ' + url, 'ok');
  } catch {
    setStatus('共有リンク: ' + url, 'ok');
  }
}

async function loadSharedPlan(id) {
  setStatus('保存されたプランを読み込み中…');
  try {
    const d = await api('/plan/' + encodeURIComponent(id));
    selectedInterests.clear();
    await loadCategories(d.request && d.request.interests);
    fillForm(d.request);
    currentPlanId = d.id;
    currentArea = (d.request && d.request.area) || '';
    currentTransport = (d.request && d.request.transport) || '';
    renderPlan({ plan: d.result });
    $('share-btn').classList.remove('hidden');
    setStatus('保存されたプランを表示中。条件を変えて作り直せます。', 'ok');
  } catch (e) {
    await loadCategories();
    setStatus('共有プランが見つかりませんでした: ' + e.message, 'err');
  }
}

// --- plan ---
function validateForm() {
  const area = $('area').value.trim();
  if (!area) {
    setStatus('エリア・行き先を入力してください。', 'err');
    $('area').focus();
    return false;
  }
  const s = $('startDate').value;
  const e = $('endDate').value;
  if (!s || !e) {
    setStatus('開始日と終了日を入力してください。', 'err');
    return false;
  }
  if (e < s) {
    setStatus('終了日は開始日以降にしてください。', 'err');
    $('endDate').focus();
    return false;
  }
  const days = Math.round((new Date(e + 'T00:00:00Z') - new Date(s + 'T00:00:00Z')) / 86400000) + 1;
  if (days > 31) {
    setStatus('旅行期間が長すぎます（最大31日）。', 'err');
    return false;
  }
  const b = $('budget').value;
  if (b !== '' && Number(b) < 0) {
    setStatus('予算は0以上で入力してください。', 'err');
    $('budget').focus();
    return false;
  }
  return true;
}

let pollTimer = null;

function showProgress(doneRounds, totalRounds, collected, done) {
  const wrap = $('collect-progress');
  wrap.classList.remove('hidden');
  wrap.classList.toggle('done', !!done);
  $('cp-fill').classList.remove('indet');
  const pct = totalRounds ? Math.round((doneRounds / totalRounds) * 100) : done ? 100 : 0;
  $('cp-fill').style.width = (done ? 100 : pct) + '%';
  $('cp-label').innerHTML = done
    ? '✅ 収集完了'
    : `<span class="cp-spin"></span>じっくり収集中… ${doneRounds}/${totalRounds} ラウンド`;
  $('cp-count').textContent = `合計 ${collected} 件`;
}

// 入力エリアに似た収集済みエリアがあれば「同じ？」と確認し、同じなら過去データを使う。
async function resolveArea(area) {
  if (!area) return area;
  try {
    const r = await api('/areas/similar?area=' + encodeURIComponent(area));
    if (r.match && r.match !== area) {
      const same = confirm(
        `「${r.match}」と同じ場所ですか？\n\n同じなら、過去に収集したデータを使います（収集の手間とAI消費を節約できます）。`,
      );
      if (same) {
        $('area').value = r.match;
        return r.match;
      }
    }
  } catch {
    /* ignore */
  }
  return area;
}

async function deepCollect() {
  let area = $('area').value.trim();
  if (!area) {
    setStatus('エリア・行き先を入力してください。', 'err');
    $('area').focus();
    return;
  }
  setBusy(true);
  area = await resolveArea(area);
  const keyword = $('keyword').value.trim() || undefined;
  const interests = [...selectedInterests];
  showIndet('収集できるか確認中…');
  try {
    const r = await api('/collect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ area, keyword, interests }),
    });
    // 既に収集中／収集済みなら、再収集せずメッセージを出す（AI消費の無駄を防ぐ）。
    if (r.ok === false) {
      hideProgressBar();
      setBusy(false);
      setStatus(r.message || 'このエリアは既に収集済みです。', r.reason === 'running' ? '' : 'ok');
      return;
    }
    // 条件（キーワード）が増えた分の差分だけ収集した場合。
    if (r.delta) {
      showProgress(1, 1, r.total, true);
      setBusy(false);
      clearBusy();
      setStatus(r.message || `追加分を収集しました（合計 ${r.total} 件）。`, 'ok');
      return;
    }
    saveBusy({ type: 'collect', area });
    setStatus(
      `バックグラウンドで収集を開始しました（最大${r.totalRounds}ラウンド・数分）。画面を閉じても・更新してもOK、サーバーが続行します。`,
      'ok',
    );
    showProgress(0, r.totalRounds, 0, false);
    pollCollect(area);
  } catch (e) {
    hideProgressBar();
    setBusy(false);
    clearBusy();
    setStatus('開始に失敗: ' + e.message, 'err');
  }
}

// 開いている間だけ進捗をポーリング（閉じてもサーバー側は継続。リロードでも再開）。
function pollCollect(area) {
  if (pollTimer) clearTimeout(pollTimer);
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const s = await api('/collect/status?area=' + encodeURIComponent(area));
      if (s.found) {
        const doneRounds = Math.max(0, s.round - 1);
        if (s.status === 'done') {
          showProgress(s.totalRounds, s.totalRounds, s.collected, true);
          setStatus(`収集完了（${esc(area)}・合計 ${s.collected} 件）。「プランを作成する」で使えます。`, 'ok');
          setBusy(false);
          clearBusy();
          return;
        }
        showProgress(doneRounds, s.totalRounds, s.collected, false);
        setStatus('じっくり収集中… 画面を閉じても・更新してもサーバーが続行します。', '');
      }
    } catch {
      /* 一時失敗は無視 */
    }
    if (tries < 80) {
      pollTimer = setTimeout(tick, 8000);
    } else {
      setBusy(false);
      clearBusy();
    }
  };
  pollTimer = setTimeout(tick, 6000);
}

function buildPlanBody() {
  return {
    area: $('area').value.trim() || undefined,
    startDate: $('startDate').value,
    endDate: $('endDate').value,
    interests: [...selectedInterests],
    budget: $('budget').value ? Number($('budget').value) : undefined,
    pace: $('pace').value,
    weather: $('weather').value,
    companions: $('companions').value || undefined,
    vibe: $('vibe').value || undefined,
    origin: $('origin').value.trim() || undefined,
    transport: $('transport').value || undefined,
    keyword: $('keyword').value.trim() || undefined,
    hotelFeatures: getHotelFeatures(),
    autoScrape: $('autoScrape').checked,
    eco: $('eco').checked,
  };
}

// 進行中は「プラン作成」「じっくり収集」両方のボタンを無効化する。
function setBusy(busy) {
  const main = $('submit-btn');
  main.disabled = busy;
  main.classList.toggle('loading', busy);
  $('collect-btn').disabled = busy;
}

// 進行中の操作を localStorage に記録し、リロード時に再開できるようにする。
function saveBusy(o) {
  try {
    localStorage.setItem('tp_busy', JSON.stringify({ ...o, ts: Date.now() }));
  } catch {
    /* ignore */
  }
}
function clearBusy() {
  try {
    localStorage.removeItem('tp_busy');
  } catch {
    /* ignore */
  }
}
function readBusy() {
  try {
    const v = JSON.parse(localStorage.getItem('tp_busy') || 'null');
    if (v && Date.now() - (v.ts || 0) < 20 * 60 * 1000) return v;
  } catch {
    /* ignore */
  }
  clearBusy();
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// プラン作成は「ジョブ化してバックグラウンド実行」。画面を閉じても Cron が完成させる。
async function submitPlan(ev) {
  ev.preventDefault();
  if (!validateForm()) return;
  setBusy(true);
  try {
    await resolveArea($('area').value.trim());
    const body = buildPlanBody();
    const r = await api('/plan/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    saveBusy({ type: 'plan', jobId: r.jobId });
    setStatus('プランを作成中…（画面を閉じても作成は続きます。あとで開き直すと結果が出ます）', '');
    startPlanProgress();
    pollPlanJob(r.jobId);
  } catch (e) {
    stopPlanProgress();
    hideProgressBar();
    setBusy(false);
    setStatus('エラー: ' + e.message, 'err');
  }
}

const PLAN_STAGES = [
  '情報を集めています…（大手サイト・ブログ）',
  'AIがスポットを抽出中…',
  '日程・ホテル・費用を計算中…',
  '仕上げています…',
];
let planStageTimer = null;

function startPlanProgress() {
  let i = 0;
  showIndet(PLAN_STAGES[0]);
  if (planStageTimer) clearInterval(planStageTimer);
  planStageTimer = setInterval(() => {
    i = (i + 1) % PLAN_STAGES.length;
    setIndetLabel(PLAN_STAGES[i]);
  }, 4500);
}
function stopPlanProgress() {
  if (planStageTimer) {
    clearInterval(planStageTimer);
    planStageTimer = null;
  }
}
function showIndet(label) {
  const wrap = $('collect-progress');
  wrap.classList.remove('hidden', 'done');
  const fill = $('cp-fill');
  fill.classList.add('indet');
  fill.style.width = '35%';
  setIndetLabel(label);
  $('cp-count').textContent = '';
}
function setIndetLabel(label) {
  $('cp-label').innerHTML = `<span class="cp-spin"></span>${esc(label)}`;
}
function hideProgressBar() {
  const wrap = $('collect-progress');
  wrap.classList.add('hidden');
  const fill = $('cp-fill');
  fill.classList.remove('indet');
  fill.style.width = '0%';
}

async function pollPlanJob(jobId) {
  for (let i = 0; i < 160; i++) {
    let s;
    try {
      s = await api('/plan-status?id=' + encodeURIComponent(jobId));
    } catch {
      await sleep(3000);
      continue;
    }
    if (s.found && s.status === 'done' && s.planId) {
      stopPlanProgress();
      hideProgressBar();
      clearBusy();
      setBusy(false);
      await loadAndRenderSavedPlan(s.planId);
      setStatus('プランが完成しました 🎉', 'ok');
      loadHistory();
      return;
    }
    if (s.found && s.status === 'error') {
      stopPlanProgress();
      hideProgressBar();
      clearBusy();
      setBusy(false);
      setStatus('作成に失敗: ' + (s.error || '不明なエラー'), 'err');
      return;
    }
    await sleep(3000);
  }
  stopPlanProgress();
  hideProgressBar();
  setBusy(false);
  setStatus('時間がかかっています。少し待ってから再読み込みしてください。', '');
}

async function loadAndRenderSavedPlan(planId) {
  const d = await api('/plan/' + encodeURIComponent(planId));
  currentPlanId = d.id;
  fillForm(d.request);
  currentArea = (d.request && d.request.area) || '';
  currentTransport = (d.request && d.request.transport) || '';
  renderPlan({ plan: d.result });
  $('share-btn').classList.remove('hidden');
  const area = d.request && d.request.area;
  if (area) {
    try {
      const qs =
        '/events?area=' +
        encodeURIComponent(area) +
        '&from=' +
        encodeURIComponent(d.request.startDate || '') +
        '&to=' +
        encodeURIComponent(d.request.endDate || '') +
        '&limit=80';
      const ev = await api(qs);
      renderCandidates(
        (ev.events || []).map((e) => ({
          title: e.title,
          category: e.category,
          location: e.city || e.prefecture || e.location_name,
          prefecture: e.prefecture,
          url: e.url,
          price: e.price,
          description: e.description,
        })),
      );
    } catch {
      /* 候補一覧は任意 */
    }
  }
}

function renderPlan(data) {
  const plan = data.plan;
  currentPlan = plan;
  $('result').classList.remove('hidden');

  const theme = plan.theme ? `<div class="plan-theme">${esc(plan.theme)}</div>` : '';
  const summaryText =
    plan.summary && plan.summary !== plan.theme ? `<div class="summary-text">${esc(plan.summary)}</div>` : '';
  const highlights = (plan.highlights || []).length
    ? `<div class="highlights">${plan.highlights.map((h) => `<span class="tag">★ ${esc(h)}</span>`).join('')}</div>`
    : '';
  const advice = (plan.advice || []).length
    ? `<div class="advice"><div class="advice-h">🧭 楽しみ方のヒント</div><ul>${plan.advice
        .map((a) => `<li>${esc(a)}</li>`)
        .join('')}</ul></div>`
    : '';

  let html = `<div class="summary-box">${theme}${summaryText}${highlights}</div>`;
  if (plan.forecast && plan.forecast.length) html += renderForecast(plan.forecast);
  if (plan.travel) html += renderTravel(plan.travel);
  if (plan.costBreakdown) html += renderCost(plan.costBreakdown);
  if (plan.hotels && plan.hotels.length) html += renderHotels(plan.hotels);
  html += advice;
  $('plan-summary').innerHTML = html;

  const daysEl = $('plan-days');
  daysEl.innerHTML = plan.days
    .map((day, i) => `<div class="day" data-day="${i}">${renderDayInner(day, i)}</div>`)
    .join('');

  renderCandidates(data.candidates);

  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 1日分の中身（見出し＋ルート＋スポット＋移動）を生成。並び替え時の再描画にも使う。
function renderDayInner(day, i) {
  const d = new Date(day.date + 'T00:00:00');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const dayTheme = day.theme ? `<div class="day-theme">${esc(day.theme)}</div>` : '';
  const route = dayRouteLink(day.items);
  let body;
  if (day.items.length) {
    const sched = computeSchedule(day.items, currentTransport);
    body = day.items
      .map((it, idx) => {
        const item = renderItem(it, i, idx, day.items.length, sched.times[idx]);
        const connector = idx < day.items.length - 1 ? renderConnector(sched.legs[idx]) : '';
        return item + connector;
      })
      .join('');
  } else {
    body = '<div class="empty-day">この日の候補は見つかりませんでした。条件をゆるめてみてください。</div>';
  }
  return `
    <div class="day-head">
      <div class="day-num"><small>DAY</small>${i + 1}</div>
      <div>
        <div class="day-date">${d.getMonth() + 1}/${d.getDate()}<span>(${wd})</span></div>
        ${dayTheme}
      </div>
    </div>
    ${route ? `<div class="day-route-wrap">${route}</div>` : ''}
    <div class="items">${body}</div>`;
}

// プラン内のスポットを上下に並び替え、その日だけ画面更新なしで再計算する。
function movePlanItem(dayIndex, idx, dir) {
  const day = currentPlan && currentPlan.days && currentPlan.days[dayIndex];
  if (!day) return;
  const j = idx + dir;
  if (j < 0 || j >= day.items.length) return;
  [day.items[idx], day.items[j]] = [day.items[j], day.items[idx]];
  const el = document.querySelector(`.day[data-day="${dayIndex}"]`);
  if (el) el.innerHTML = renderDayInner(day, dayIndex);
}

const CAT_ORDER = ['グルメ', '自然', '歴史', 'アート', '音楽', '体験', '宿泊', '祭り', 'テック', '観光', 'イベント'];

function candCard(c) {
  const q = encodeURIComponent(`${c.title} ${c.location || ''}`.trim());
  const cat = c.category ? `<span class="badge">${catEmoji(c.category)} ${esc(c.category)}</span>` : '';
  const price = c.price != null ? `<span class="item-price">${c.price === 0 ? '無料' : '目安 ' + yen(c.price)}</span>` : '';
  const loc = c.location ? `<span class="cand-loc">📍 ${esc(c.location)}</span>` : '';
  const desc = c.description
    ? `<p class="cand-desc">${esc(c.description)}</p>`
    : `<p class="cand-desc cand-desc-empty">概要はまだありません。下のリンクで確認できます。</p>`;
  const links =
    `<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">📍 地図</a>` +
    ` <a href="https://www.google.com/search?q=${encodeURIComponent(c.title + ' 公式')}" target="_blank" rel="noopener">🔎 公式</a>` +
    (c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">📰 情報元</a>` : '');
  return `<details class="cand">
    <summary><span class="cand-name">${esc(c.title)}</span>${cat}${price}</summary>
    <div class="cand-body">${loc}${desc}<div class="cand-links">${links}</div>
      <div class="item-foot">${spotChecks(c.title, c.prefecture, c.url)}</div></div>
  </details>`;
}

// 見つかったスポットをカテゴリーの大きな括りで表示し、タップで一覧を展開する。
function renderCandidates(candidates) {
  const el = $('plan-extra');
  if (!el) return;
  if (!candidates || !candidates.length) {
    el.innerHTML = '';
    return;
  }
  const groups = {};
  candidates.forEach((c) => {
    const k = c.category || 'その他';
    (groups[k] = groups[k] || []).push(c);
  });
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a);
    const ib = CAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ja');
  });
  const groupHtml = keys
    .map((k) => {
      const cards = groups[k].map(candCard).join('');
      return `<details class="cat-group">
        <summary><span class="cat-name">${catEmoji(k)} ${esc(k)}</span><span class="cat-count">${groups[k].length}</span></summary>
        <div class="cand-list">${cards}</div>
      </details>`;
    })
    .join('');
  el.innerHTML = `<div class="cand-head">🔎 見つかったスポット（${candidates.length}件・カテゴリーをタップで展開）</div><div class="cat-groups">${groupHtml}</div>`;
}

const yen = (n) => '¥' + Number(n || 0).toLocaleString();

function renderTravel(t) {
  const bits = [];
  if (t.distance) bits.push(`距離 ${esc(t.distance)}`);
  if (t.duration) bits.push(`片道 ${esc(t.duration)}`);
  if (t.costRoundTrip) bits.push(`往復 ${yen(t.costRoundTrip)}`);
  const mode = t.mode ? `（${esc(t.mode)}）` : '';
  return `<div class="info-card">
    <div class="info-h">🚆 ${esc(t.from || '出発地')} → ${esc(t.to || '目的地')}${mode}</div>
    ${bits.length ? `<div class="pills">${bits.map((b) => `<span class="pill">${b}</span>`).join('')}</div>` : ''}
    ${t.note ? `<p class="info-note">${esc(t.note)}</p>` : ''}
  </div>`;
}

function renderCost(c) {
  const rows = [
    [`ホテル${c.nights ? `（${c.nights}泊）` : ''}`, c.hotel],
    ['食事', c.food],
    ['観光・体験', c.activities],
  ]
    .map(([l, v]) => `<div class="cost-row"><span>${l}</span><span>${yen(v)}</span></div>`)
    .join('');
  const stay = `<div class="cost-row total"><span>滞在費合計</span><b>${yen(c.stayTotal)}</b></div>`;
  const transport = c.transport
    ? `<div class="cost-row"><span>交通（往復）</span><span>${yen(c.transport)}</span></div>`
    : '';
  const grand = `<div class="cost-row grand"><span>総額（滞在費＋交通）</span><b>${yen(c.grandTotal)}</b></div>`;
  let budget = '';
  if (c.budget != null) {
    const diff = Math.abs(c.stayTotal - c.budget);
    budget = c.withinBudget
      ? `<div class="budget ok">✓ 予算内（滞在費 ${yen(c.stayTotal)} / 予算 ${yen(c.budget)}）</div>`
      : `<div class="budget over">⚠ 予算オーバー +${yen(diff)}（滞在費 ${yen(c.stayTotal)} / 予算 ${yen(c.budget)}）</div>`;
  }
  return `<div class="info-card">
    <div class="info-h">💰 費用の目安（1人）</div>
    ${rows}${stay}${transport}${grand}${budget}
    <p class="info-note">※AIによる概算です。実際の料金は各予約サイト等でご確認ください。</p>
  </div>`;
}

function renderHotels(hotels) {
  const list = hotels
    .map((h) => {
      const name = h.url
        ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.name)}</a>`
        : esc(h.name);
      const link = h.url
        ? `<a class="hotel-link" href="${esc(h.url)}" target="_blank" rel="noopener">楽天トラベルで見る →</a>`
        : `<a class="hotel-link" href="https://www.google.com/search?q=${encodeURIComponent(h.name + ' 宿泊 予約')}" target="_blank" rel="noopener">空室・料金を探す →</a>`;
      return `<div class="hotel">
      <div class="hotel-top"><span class="hotel-name">${name}</span>${
        h.nightlyPrice ? `<span class="hotel-price">${yen(h.nightlyPrice)} / 泊・人〜</span>` : ''
      }</div>
      ${h.area ? `<div class="hotel-area">📍 ${esc(h.area)}</div>` : ''}
      ${h.why ? `<div class="hotel-why">${esc(h.why)}</div>` : ''}
      <div class="hotel-actions">${link}</div>
    </div>`;
    })
    .join('');
  return `<div class="info-card">
    <div class="info-h">🏨 宿泊の候補（${hotels.length}件・予算内/安い順）</div>
    ${list}
    <p class="info-note">※価格は目安です。空室・料金・プランは予約ページでご確認ください。</p>
  </div>`;
}

function dayRouteLink(items) {
  const pts = (items || []).map((it) => `${it.title} ${it.location || ''}`.trim()).filter(Boolean);
  if (pts.length < 2) return '';
  const enc = pts.slice(0, 10).map(encodeURIComponent);
  const origin = enc[0];
  const destination = enc[enc.length - 1];
  const wp = enc.slice(1, -1).join('%7C');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`;
  if (wp) url += `&waypoints=${wp}`;
  return `<a class="day-route" href="${url}" target="_blank" rel="noopener">🗺 この日のルートを地図で見る</a>`;
}

function renderForecast(fc) {
  const days = fc
    .map((day) => {
      const dd = new Date(day.date + 'T00:00:00');
      const md = `${dd.getMonth() + 1}/${dd.getDate()}`;
      const temp = (day.tmax != null ? `${day.tmax}°` : '') + (day.tmin != null ? `/${day.tmin}°` : '');
      const pop = day.pop != null ? `☔${day.pop}%` : '';
      return `<div class="fc-day">
        <div class="fc-date">${md}</div>
        <div class="fc-emoji">${day.emoji}</div>
        <div class="fc-label">${esc(day.label)}</div>
        <div class="fc-temp">${temp}</div>
        <div class="fc-pop">${pop}</div>
      </div>`;
    })
    .join('');
  return `<div class="info-card">
    <div class="info-h">🌤️ 旅行日の天気予報</div>
    <div class="fc-row">${days}</div>
    <p class="info-note">出典: Open-Meteo（無料）。日が近づくと精度が上がります。</p>
  </div>`;
}

async function loadHistory() {
  const list = $('history-list');
  if (!list) return;
  try {
    const { plans } = await api('/plans');
    const cnt = $('history-count');
    if (cnt) cnt.textContent = plans && plans.length ? ` (${plans.length})` : '';
    if (!plans || !plans.length) {
      list.innerHTML =
        '<p class="visited-empty">まだ保存されたプランはありません。プランを作成すると、ここに履歴がたまります。</p>';
      return;
    }
    list.innerHTML = plans
      .map((p) => {
        const title = esc(p.theme || p.area || 'プラン');
        const dates = p.startDate ? `${p.startDate}〜${p.endDate || ''}` : '';
        const when = p.createdAt ? new Date(p.createdAt).toLocaleString('ja-JP') : '';
        return `<div class="hist-item">
          <button type="button" class="hist-open" data-id="${esc(p.id)}">
            <span class="hist-title">${title}</span>
            <span class="hist-sub">${esc(p.area || '')} ${dates}<br>${when}</span>
          </button>
          <button type="button" class="hist-del" data-id="${esc(p.id)}" title="削除" aria-label="削除">🗑</button>
        </div>`;
      })
      .join('');
  } catch {
    /* 履歴は任意 */
  }
}

async function deleteSavedPlan(id) {
  if (!confirm('この保存プランを一覧から消しますか？（データは残るので共有リンクからは見られます）')) return;
  try {
    await api('/plan/' + encodeURIComponent(id), { method: 'DELETE' });
    loadHistory();
  } catch (e) {
    setStatus('削除に失敗: ' + e.message, 'err');
  }
}

function renderItem(it, dayIndex, idx, count, clock) {
  const t = clock || it.time;
  const time = t ? `<span class="item-time">${esc(t)}</span>` : `<span class="item-time tba">時間自由</span>`;

  const move = `<span class="item-move">
    <button type="button" class="mv-up" data-day="${dayIndex}" data-idx="${idx}" aria-label="上へ" ${idx === 0 ? 'disabled' : ''}>▲</button>
    <button type="button" class="mv-down" data-day="${dayIndex}" data-idx="${idx}" aria-label="下へ" ${idx === count - 1 ? 'disabled' : ''}>▼</button>
  </span>`;

  const meta = [];
  if (it.category) meta.push(`<span class="badge">${catEmoji(it.category)} ${esc(it.category)}</span>`);
  if (it.location) meta.push(`<span>📍 ${esc(it.location)}</span>`);
  const cost = it.price != null ? it.price : it.estCost;
  if (cost != null) meta.push(`<span class="item-price">${cost === 0 ? '無料' : '目安 ' + yen(cost)}</span>`);

  const detail = [];
  if (it.why) detail.push(`<p class="why"><b>💡 おすすめ</b>${esc(it.why)}</p>`);
  if (it.tips) detail.push(`<p class="tips"><b>🎯 楽しみ方</b>${esc(it.tips)}</p>`);
  if (it.access) detail.push(`<p class="access"><b>🚃 行き方</b>${esc(it.access)}</p>`);
  const sub = [];
  if (it.duration) sub.push(`⏱ 滞在目安 ${esc(it.duration)}`);
  if (it.alt) sub.push(`🔄 ${esc(it.alt)}`);

  // 地図・公式サイト・情報元へのリンク（名称から確実に生成）
  const q = encodeURIComponent(`${it.title} ${it.location || ''}`.trim());
  const links = [
    `<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">📍 地図</a>`,
    `<a href="https://www.google.com/search?q=${encodeURIComponent(it.title + ' 公式')}" target="_blank" rel="noopener">🔎 公式サイト</a>`,
  ];
  if (it.url) links.push(`<a href="${esc(it.url)}" target="_blank" rel="noopener">📰 情報元</a>`);

  return `
    <div class="item">
      <div class="item-top">${time}<span class="item-title">${esc(it.title)}</span>${move}</div>
      ${meta.length ? `<div class="item-meta">${meta.join('')}</div>` : ''}
      ${detail.join('')}
      ${sub.length ? `<div class="item-sub">${sub.join('　·　')}</div>` : ''}
      <div class="item-foot">
        <div class="item-links">${links.join('')}</div>
        ${spotChecks(it.title, it.prefecture, it.url)}
      </div>
    </div>`;
}

function discoverDiag(discovered) {
  if (!discovered) return '';
  const s = discovered.stats;
  const stat = s ? `[検索候補 ${s.candidates} / 取得 ${s.fetched} / エンジン ${s.engine || 'なし'}]` : '';
  const note = discovered.note ? ' ' + discovered.note : '';
  return `${stat}${note}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

// --- bootstrap ---
window.addEventListener('DOMContentLoaded', async () => {
  initDates();
  $('plan-form').addEventListener('submit', submitPlan);
  $('collect-btn').addEventListener('click', deepCollect);
  $('share-btn').addEventListener('click', sharePlan);

  // ハンバーガーメニュー（保存プラン・行った場所）の開閉。
  $('menu-btn').addEventListener('click', openDrawer);
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-overlay').addEventListener('click', closeDrawer);

  $('history-refresh').addEventListener('click', loadHistory);
  $('history-list').addEventListener('click', (ev) => {
    const del = ev.target.closest('.hist-del');
    if (del && del.dataset.id) {
      deleteSavedPlan(del.dataset.id);
      return;
    }
    const open = ev.target.closest('.hist-open');
    if (open && open.dataset.id) {
      closeDrawer();
      loadAndRenderSavedPlan(open.dataset.id);
    }
  });

  // 行った場所ツリーの「削除」。
  $('visited-tree').addEventListener('click', (ev) => {
    const rm = ev.target.closest('.vt-remove');
    if (rm && rm.dataset.title) toggleVisited(rm.dataset.title, false);
  });

  // 行ってみたいリストの並び替え（↑↓）・削除。
  $('wishlist-list').addEventListener('click', (ev) => {
    const up = ev.target.closest('.wl-up');
    if (up) return moveWishlist(up.dataset.title, -1);
    const down = ev.target.closest('.wl-down');
    if (down) return moveWishlist(down.dataset.title, 1);
    const rm = ev.target.closest('.wl-remove');
    if (rm) toggleWishlist(rm.dataset.title, false);
  });

  // プラン内スポットの並び替え（↑↓・画面更新なしで移動時間を再計算）。
  $('plan-days').addEventListener('click', (ev) => {
    const up = ev.target.closest('.mv-up');
    if (up) return movePlanItem(Number(up.dataset.day), Number(up.dataset.idx), -1);
    const down = ev.target.closest('.mv-down');
    if (down) movePlanItem(Number(down.dataset.day), Number(down.dataset.idx), 1);
  });

  // スポットの「行った」「行きたい」チェック（イベント委譲）。
  document.addEventListener('change', (ev) => {
    const v = ev.target.closest('.visited-cb');
    if (v) {
      toggleVisited(v.dataset.title, v.checked, { area: currentArea, prefecture: v.dataset.pref, url: v.dataset.url });
      return;
    }
    const w = ev.target.closest('.wish-cb');
    if (w) {
      toggleWishlist(w.dataset.title, w.checked, { area: currentArea, prefecture: w.dataset.pref, url: w.dataset.url });
    }
  });

  $('startDate').addEventListener('change', () => {
    const s = $('startDate').value;
    if (s) $('endDate').value = addDays(s, 1);
  });

  loadHistory();
  loadWishlist();
  loadVisited();

  const sharedId = new URLSearchParams(location.search).get('plan');
  if (sharedId) {
    await loadSharedPlan(sharedId);
    return;
  }
  await loadCategories();
  // 進行中の処理（プラン作成 / じっくり収集）があればリロード後も再開＆進捗表示。
  const busy = readBusy();
  if (busy && busy.type === 'plan' && busy.jobId) {
    setBusy(true);
    setStatus('プラン作成を再開しています…', '');
    startPlanProgress();
    pollPlanJob(busy.jobId);
  } else if (busy && busy.type === 'collect' && busy.area) {
    setBusy(true);
    setStatus('じっくり収集を再開しています…', '');
    showProgress(0, 6, 0, false);
    pollCollect(busy.area);
  }
});
