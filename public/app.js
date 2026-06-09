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
let currentCandidates = [];
// ホテル選択→滞在費の連動用。
let planHotels = [];
let planCostParts = null; // { nights, food, activities, transport, budget }
let selectedHotelIdx = 0;
const HOTELS_SHOWN = 4; // 最初に展開表示するホテル件数（以降は「もっと見る」）
let pendingMustInclude = null; // 行きたいリストから作成する際の必須スポット
let pendingRefine = null; // 自然言語の調整指示（作り直し/別案）
let planMap = null; // Leaflet マップ
let planMapLayers = []; // マップ上のマーカー/線

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
    // 各項目自身の time を尊重する。計算上の到着より後ろならその時刻に合わせる
    // （朝食など本来早い予定が、前項目の積み上げで11:00等にズレるのを防ぐ）。
    const own = parseClock(items[i].time);
    if (own != null && own >= cur) cur = own;
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

// 日帰りモード: 終了日欄を隠して開始日に揃える（宿泊なし）。
function setDayTrip(on) {
  const ef = $('endDate-field');
  if (ef) ef.classList.toggle('hidden', on);
  const ed = $('endDate');
  if (ed) ed.required = !on;
  const lbl = $('startDate-label');
  if (lbl) lbl.textContent = on ? '日付' : '開始日';
  if (on && ed) ed.value = $('startDate').value;
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
  $('thorough').checked = !!req.thorough;
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

// 保存ボタンの表示状態。saved=true で「保存済み」、false で「保存」に。
function setSaveButton(saved) {
  const b = $('save-btn');
  if (!b) return;
  b.classList.remove('hidden');
  if (saved) {
    b.textContent = '✓ 保存済み';
    b.disabled = true;
    b.classList.add('saved');
  } else {
    b.textContent = '💾 このプランを保存';
    b.disabled = false;
    b.classList.remove('saved');
  }
}

// 編集したら「変更を保存」に戻す（再保存で内容も更新される）。
function markPlanDirty() {
  const b = $('save-btn');
  if (!b) return;
  b.classList.remove('hidden', 'saved');
  b.disabled = false;
  b.textContent = '💾 変更を保存';
}

// 「保存」を押したプランだけを履歴に残す。編集後の内容も一緒に保存する。
async function saveCurrentPlan() {
  if (!currentPlanId || !currentPlan) return;
  try {
    await api('/plan/' + encodeURIComponent(currentPlanId) + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: currentPlan }),
    });
    setSaveButton(true);
    setStatus('プランを保存しました。メニューの「保存したプラン」から開けます。', 'ok');
    loadHistory();
  } catch (e) {
    setStatus('保存に失敗: ' + e.message, 'err');
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
    $('print-btn').classList.remove('hidden');
    $('packing-btn').classList.remove('hidden');
    $('refine-box').classList.remove('hidden');
    setSaveButton(d.saved !== false);
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

// バックグラウンド処理（プラン作成 / じっくり収集）のキャンセル管理。
// bgGen を増やすと、進行中のポーリングは自分の世代と一致しなくなり停止する。
let bgGen = 0;
let activeOp = null;

function showCancel() {
  const b = $('cancel-btn');
  if (b) b.classList.remove('hidden');
}
function hideCancel() {
  const b = $('cancel-btn');
  if (b) b.classList.add('hidden');
}

// 進行中のバックグラウンド処理をキャンセルする。
// 標準の confirm() の代わりに使う、デザインを整えた確認モーダル。Promise<boolean> を返す。
function uiConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = $('modal-overlay');
    const titleEl = $('modal-title');
    const msgEl = $('modal-msg');
    const okBtn = $('modal-ok');
    const cancelBtn = $('modal-cancel');
    titleEl.textContent = opts.title || '';
    titleEl.style.display = opts.title ? '' : 'none';
    msgEl.textContent = message || '';
    okBtn.textContent = opts.okText || 'OK';
    cancelBtn.textContent = opts.cancelText || 'キャンセル';
    okBtn.classList.toggle('danger', !!opts.danger);
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => okBtn.focus(), 0);
    const done = (val) => {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => {
      if (e.target === overlay) done(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

async function cancelOp() {
  if (
    !(await uiConfirm('進行中の作成・収集を中止します。', {
      title: '本当にキャンセルしますか？',
      okText: 'キャンセルする',
      cancelText: '続ける',
      danger: true,
    }))
  )
    return;
  const op = activeOp;
  bgGen++; // 進行中のポーリングを無効化
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  stopPlanProgress();
  activeOp = null;
  if (op) {
    try {
      if (op.type === 'plan' && op.jobId) {
        await api('/plan/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: op.jobId }),
        });
      } else if (op.type === 'collect' && op.area) {
        await api('/collect/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ area: op.area }),
        });
      }
    } catch {
      /* キャンセル通知の失敗は無視（ポーリングは既に停止済み） */
    }
  }
  clearBusy();
  setBusy(false);
  hideProgressBar();
  hideCancel();
  setStatus('処理をキャンセルしました。', '');
}

function showProgress(doneRounds, totalRounds, collected, done) {
  const wrap = $('collect-progress');
  wrap.classList.remove('hidden');
  wrap.classList.toggle('done', !!done);
  $('cp-fill').classList.remove('indet');
  const pct = totalRounds ? Math.round((doneRounds / totalRounds) * 100) : done ? 100 : 0;
  $('cp-fill').style.width = (done ? 100 : pct) + '%';
  $('cp-label').innerHTML = done
    ? '✅ 収集完了'
    : `<span class="cp-spin"></span>じっくり収集中… ${doneRounds}/${totalRounds} ラウンド（${pct}%）`;
  $('cp-count').textContent = `合計 ${collected} 件`;
}

// 入力エリアに似た収集済みエリアがあれば「同じ？」と確認し、同じなら過去データを使う。
async function resolveArea(area) {
  if (!area) return area;
  try {
    const r = await api('/areas/similar?area=' + encodeURIComponent(area));
    if (r.match && r.match !== area) {
      const same = await uiConfirm(
        `同じなら、過去に収集したデータを使います（収集の手間とAI消費を節約できます）。`,
        { title: `「${r.match}」と同じ場所ですか？`, okText: '同じ（使う）', cancelText: '違う' },
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

async function deepCollect(force = false) {
  // 必須チェック: エリアは必須（ブラウザ標準の警告も表示）。
  const area0 = $('area').value.trim();
  if (!area0) {
    $('area').reportValidity();
    setStatus('エリア・行き先を入力してください。', 'err');
    $('area').focus();
    return;
  }
  $('recollect-btn').classList.add('hidden'); // 操作のたびに一旦隠す（収集済み時だけ後で出す）
  // 本当に収集するか確認する（時間と無料枠を使うため）。
  const ok = force
    ? await uiConfirm(
        `収集済みでも、もう一度バックグラウンドで情報を集め直します（無料のAI枠を使います）。`,
        { title: `「${area0}」を再収集しますか？`, okText: '再収集する', cancelText: 'やめる' },
      )
    : await uiConfirm(
        `バックグラウンドで数分かけて情報を集めます（無料のAI枠を使います）。途中でキャンセルもできます。`,
        { title: `「${area0}」をじっくり収集しますか？`, okText: '収集する', cancelText: 'やめる' },
      );
  if (!ok) return;
  setBusy(true);
  let area = await resolveArea(area0);
  const keyword = $('keyword').value.trim() || undefined;
  const interests = [...selectedInterests];
  showIndet(force ? '再収集を開始中…' : '収集できるか確認中…');
  try {
    const r = await api('/collect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ area, keyword, interests, force }),
    });
    // 既に収集中／収集済みなら、再収集せずメッセージを出す（AI消費の無駄を防ぐ）。
    if (r.ok === false) {
      hideProgressBar();
      setBusy(false);
      setStatus(r.message || 'このエリアは既に収集済みです。', r.reason === 'running' ? '' : 'ok');
      // 「収集済み」のときだけ、その場で再収集できるボタンを出す。
      if (r.reason === 'collected') $('recollect-btn').classList.remove('hidden');
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
    const gen = ++bgGen;
    activeOp = { type: 'collect', area, gen };
    saveBusy({ type: 'collect', area });
    setStatus(
      `バックグラウンドで収集を開始しました（最大${r.totalRounds}ラウンド・数分）。画面を閉じても・更新してもOK、サーバーが続行します。`,
      'ok',
    );
    showProgress(0, r.totalRounds, 0, false);
    showCancel();
    pollCollect(area, gen);
  } catch (e) {
    hideProgressBar();
    setBusy(false);
    clearBusy();
    setStatus('開始に失敗: ' + e.message, 'err');
  }
}

// 開いている間だけ進捗をポーリング（閉じてもサーバー側は継続。リロードでも再開）。
function pollCollect(area, gen) {
  if (pollTimer) clearTimeout(pollTimer);
  let tries = 0;
  const tick = async () => {
    if (gen !== bgGen) return; // キャンセル等で世代が変わったら停止
    tries++;
    try {
      const s = await api('/collect/status?area=' + encodeURIComponent(area));
      if (gen !== bgGen) return;
      if (s.found) {
        const doneRounds = Math.max(0, s.round - 1);
        if (s.status === 'cancelled') {
          hideProgressBar();
          hideCancel();
          activeOp = null;
          setBusy(false);
          clearBusy();
          setStatus('じっくり収集をキャンセルしました。', '');
          return;
        }
        if (s.status === 'done') {
          showProgress(s.totalRounds, s.totalRounds, s.collected, true);
          hideCancel();
          activeOp = null;
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
      hideCancel();
      activeOp = null;
    }
  };
  pollTimer = setTimeout(tick, 6000);
}

function buildPlanBody() {
  const dayTrip = !!($('dayTrip') && $('dayTrip').checked);
  const body = {
    area: $('area').value.trim() || undefined,
    startDate: $('startDate').value,
    // 日帰りは終了日＝開始日（宿泊なし）。
    endDate: dayTrip ? $('startDate').value : $('endDate').value,
    interests: [...selectedInterests],
    budget: $('budget').value ? Number($('budget').value) : undefined,
    pace: $('pace').value,
    weather: $('weather').value,
    companions: $('companions').value || undefined,
    vibe: $('vibe').value || undefined,
    origin: $('origin').value.trim() || undefined,
    transport: $('transport').value || undefined,
    adults: $('adults') ? Number($('adults').value) : undefined,
    maxHours: $('maxHours') && $('maxHours').value ? Number($('maxHours').value) : undefined,
    keyword: $('keyword').value.trim() || undefined,
    hotelFeatures: getHotelFeatures(),
    thorough: $('thorough').checked,
  };
  // 行きたいリスト由来の必須スポット / 自然言語の調整指示（いずれも1回限り）。
  if (pendingMustInclude && pendingMustInclude.length) body.mustInclude = pendingMustInclude;
  if (pendingRefine) body.refine = pendingRefine;
  pendingMustInclude = null;
  pendingRefine = null;
  return body;
}

// 進行中は「プラン作成」「じっくり収集」両方のボタンを無効化する。
function setBusy(busy) {
  const main = $('submit-btn');
  main.disabled = busy;
  main.classList.toggle('loading', busy);
  $('collect-btn').disabled = busy;
  const rc = $('recollect-btn');
  if (rc) rc.disabled = busy;
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
let planMode = 'manual'; // 'manual' = 自分で決める / 'auto' = おまかせ（行き先もAI）

function setPlanMode(mode) {
  planMode = mode;
  $('tab-manual').classList.toggle('active', mode === 'manual');
  $('tab-auto').classList.toggle('active', mode === 'auto');
  $('area-field').classList.toggle('hidden', mode === 'auto');
  $('auto-note').classList.toggle('hidden', mode !== 'auto');
  // 移動時間の上限はおまかせ（行き先をAIが選ぶ）時のみ意味があるので、その時だけ表示。
  const mh = $('maxHours-field');
  if (mh) mh.classList.toggle('hidden', mode !== 'auto');
  $('suggest-results').classList.add('hidden');
  $('area').required = mode === 'manual';
  $('submit-btn').querySelector('.btn-label').textContent =
    mode === 'auto' ? '🎲 行き先を提案してもらう' : 'プランを作成する';
}

function submitPlan(ev) {
  ev.preventDefault();
  if (planMode === 'auto') suggestAreasFlow();
  else startPlan();
}

// 直近に提案された行き先（「再考」で除外して別案を出すために保持）。
let lastSuggested = [];

// おまかせ: 条件から行き先を3案AIに提案させ、カードで表示する。
// exclude を渡すと、その行き先を避けて別案を出す（再考ボタン用）。
async function suggestAreasFlow(exclude) {
  const body = buildPlanBody();
  if (!body.startDate || !body.endDate) {
    setStatus('日程を入れてください。', 'err');
    return;
  }
  if (exclude && exclude.length) body.exclude = exclude;
  setBusy(true);
  $('result').classList.add('hidden'); // 行き先を選び直すので前回プランは画面に残さない
  showIndet(exclude && exclude.length ? 'AIが別の行き先を考えています…' : 'AIが行き先を考えています…');
  setStatus('条件に合う行き先をAIが3案考えています…', '');
  try {
    const r = await api('/suggest-areas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    hideProgressBar();
    setBusy(false);
    const areas = r.areas || [];
    // 再考の累積除外: 今回出た案も次の「再考」では避ける。
    lastSuggested = Array.from(new Set([...(exclude || []), ...areas.map((a) => a.area)]));
    renderSuggestions(areas);
  } catch (e) {
    hideProgressBar();
    setBusy(false);
    setStatus('行き先の提案に失敗しました: ' + e.message, 'err');
  }
}

function renderSuggestions(areas) {
  const box = $('suggest-results');
  if (!areas.length) {
    box.classList.add('hidden');
    setStatus('提案が得られませんでした。条件を変えて再度お試しください。', 'err');
    return;
  }
  setStatus('行き先を選ぶと、その地でプランを作成します。', 'ok');
  box.innerHTML =
    `<div class="suggest-h">🎲 AIのおすすめ行き先（${areas.length}案）</div>` +
    areas
      .map((a, i) => {
        const hl = (a.highlights || []).map((h) => `<span class="tag">${esc(h)}</span>`).join('');
        const cost = a.roughCost ? `<span class="suggest-cost">目安 ${yen(a.roughCost)}/人</span>` : '';
        return `<div class="suggest-card" data-area="${esc(a.area)}">
        <div class="suggest-top"><span class="suggest-area">${esc(a.area)}</span>${cost}</div>
        ${a.hook ? `<p class="suggest-hook">✨ ${esc(a.hook)}</p>` : ''}
        ${a.reason ? `<p class="suggest-reason">${esc(a.reason)}</p>` : ''}
        ${hl ? `<div class="highlights">${hl}</div>` : ''}
        <button type="button" class="btn-secondary suggest-pick" data-i="${i}">この行き先でプランを作成 →</button>
      </div>`;
      })
      .join('') +
    `<button type="button" id="suggest-again" class="btn-secondary suggest-again">🔄 別の案を再考する</button>`;
  box.classList.remove('hidden');
  box.querySelectorAll('.suggest-pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.suggest-card');
      const area = card ? card.getAttribute('data-area') : '';
      if (!area) return;
      $('area').value = area;
      setPlanMode('manual'); // 行き先が決まったので通常モードへ
      box.classList.add('hidden');
      startPlan();
    });
  });
  // 再考: これまで提案された行き先を除外して別案を出す。
  const again = $('suggest-again');
  if (again) again.addEventListener('click', () => suggestAreasFlow(lastSuggested));
  // プラン作成ボタンの下に出るので、提案までスクロールして見せる。
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 🎒 持ち物リスト: 現在のプラン条件（行き先・日付・天気・予定）からAIに作らせる。
async function genPacking() {
  if (!currentPlan) return;
  const acts = (currentPlan.days || []).flatMap((d) => (d.items || []).map((it) => it.title)).slice(0, 16);
  const body = {
    area: $('area').value.trim() || currentArea || undefined,
    startDate: $('startDate').value,
    endDate: $('endDate').value,
    weather: $('weather').value,
    companions: $('companions').value || undefined,
    adults: $('adults') ? Number($('adults').value) : undefined,
    activities: acts,
  };
  const box = $('packing-box');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="info-card"><div class="info-h">🎒 持ち物リスト</div><p class="info-note">AIが作成中…</p></div>';
  $('packing-btn').disabled = true;
  try {
    const r = await api('/packing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderPacking(r.groups || []);
  } catch (e) {
    box.innerHTML = `<div class="info-card"><div class="info-h">🎒 持ち物リスト</div><p class="info-note">作成に失敗しました: ${esc(e.message)}</p></div>`;
  } finally {
    $('packing-btn').disabled = false;
  }
}

function renderPacking(groups) {
  const box = $('packing-box');
  if (!groups.length) {
    box.innerHTML =
      '<div class="info-card"><div class="info-h">🎒 持ち物リスト</div><p class="info-note">うまく生成できませんでした。もう一度お試しください。</p></div>';
    return;
  }
  const list = groups
    .map(
      (g) =>
        `<div class="pack-group"><div class="pack-title">${esc(g.title)}</div>${(g.items || [])
          .map((it) => `<label class="pack-item"><input type="checkbox" /> <span>${esc(it)}</span></label>`)
          .join('')}</div>`,
    )
    .join('');
  box.innerHTML = `<div class="info-card"><div class="info-h">🎒 持ち物リスト</div>${list}<p class="info-note">※AIの提案です。チェックして使ってください。</p></div>`;
}

// 実際にプラン作成ジョブを開始する（フォーム送信・行きたい作成・作り直しから共通で使う）。
async function startPlan() {
  if (!validateForm()) return;
  setBusy(true);
  $('recollect-btn').classList.add('hidden'); // 再収集ボタンが残らないよう隠す
  // 再作成中は前回のプランを画面に残さない（古い結果が見えたままにしない）。
  $('result').classList.add('hidden');
  // 新規作成中は前回プランの保存/共有/印刷/調整ボタンを隠す（完成後に出し直す）。
  $('save-btn').classList.add('hidden');
  $('share-btn').classList.add('hidden');
  $('print-btn').classList.add('hidden');
  $('packing-btn').classList.add('hidden');
  $('packing-box').classList.add('hidden');
  $('refine-box').classList.add('hidden');
  try {
    await resolveArea($('area').value.trim());
    const body = buildPlanBody();
    const r = await api('/plan/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const gen = ++bgGen;
    activeOp = { type: 'plan', jobId: r.jobId, gen };
    saveBusy({ type: 'plan', jobId: r.jobId });
    setStatus('プランを作成中…（画面を閉じても作成は続きます。あとで開き直すと結果が出ます）', '');
    startPlanProgress();
    showCancel();
    pollPlanJob(r.jobId, gen);
  } catch (e) {
    stopPlanProgress();
    hideProgressBar();
    setBusy(false);
    setStatus('エラー: ' + e.message, 'err');
  }
}

// 「行ってみたい」リストを起点にプランを作成する。
function genFromWishlist() {
  if (!wishlistRows.length) {
    setStatus('先に「行ってみたい」にスポットを追加してください（各スポットの⭐から）。', 'err');
    return;
  }
  // 行きたいスポットで最も多い都道府県をエリアにする（フォームのエリアが優先）。
  const prefCount = {};
  wishlistRows.forEach((w) => {
    const p = w.prefecture || '';
    if (p && p !== '未分類') prefCount[p] = (prefCount[p] || 0) + 1;
  });
  const topPref = Object.entries(prefCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  const area = $('area').value.trim() || topPref || '';
  if (!area) {
    closeDrawer();
    setStatus('行きたいスポットのエリアが特定できませんでした。エリアを入力してから再度お試しください。', 'err');
    $('area').focus();
    return;
  }
  $('area').value = area;
  // そのエリアに属する（都道府県が一致/包含する）行きたいスポットを優先。なければ全件。
  const inArea = wishlistRows.filter(
    (w) => !w.prefecture || w.prefecture === topPref || area.includes(w.prefecture) || w.prefecture.includes(area),
  );
  pendingMustInclude = (inArea.length ? inArea : wishlistRows).map((w) => w.title).slice(0, 12);
  closeDrawer();
  setStatus(`行きたいスポット${pendingMustInclude.length}件を入れたプランを作成します…`, '');
  startPlan();
}

// 自然言語の指示でプランを作り直す / 別案を出す。
function refinePlan(instruction) {
  if (!currentPlan) return;
  pendingRefine = instruction;
  startPlan();
}

let planLastPct = 0;

// プラン作成の進捗は、サーバー(/plan-status)が返す実ステージ(stage/progress)を表示する。
// 重い工程（抽出・AI組み立て）は1回の処理待ちなので、その間は実%のまま“流れる”
// アニメ（.working）で「動作中」を示す。偽の時間ベースバーは廃止。
function startPlanProgress() {
  planLastPct = 4;
  setRealPlanProgress('プラン作成を開始しています…', planLastPct);
}
function stopPlanProgress() {
  /* タイマーは持たない（実進捗ベース）。互換のため関数は残す。 */
}
// label と pct（0-100）でプラン進捗バーを更新する。pct は後退させない。
function setRealPlanProgress(label, pct) {
  const wrap = $('collect-progress');
  wrap.classList.remove('hidden', 'done');
  const fill = $('cp-fill');
  fill.classList.remove('indet');
  fill.classList.add('working'); // 流れるアニメ＝処理中（固まって見えない）
  const next = Math.max(planLastPct, Math.min(100, Math.round(pct || 0)));
  planLastPct = next;
  fill.style.width = next + '%';
  $('cp-label').innerHTML = `<span class="cp-spin"></span>${esc(label || '作成中…')}`;
  $('cp-count').textContent = next + '%';
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
  fill.classList.remove('indet', 'working');
  fill.style.width = '0%';
  planLastPct = 0;
}

async function pollPlanJob(jobId, gen) {
  for (let i = 0; i < 160; i++) {
    if (gen !== bgGen) return; // キャンセル等で世代が変わったら停止
    let s;
    try {
      s = await api('/plan-status?id=' + encodeURIComponent(jobId));
    } catch {
      await sleep(3000);
      continue;
    }
    if (gen !== bgGen) return;
    if (s.found && s.status === 'cancelled') {
      stopPlanProgress();
      hideProgressBar();
      hideCancel();
      activeOp = null;
      clearBusy();
      setBusy(false);
      setStatus('プラン作成をキャンセルしました。', '');
      return;
    }
    if (s.found && s.status === 'done' && s.planId) {
      stopPlanProgress();
      hideProgressBar();
      hideCancel();
      activeOp = null;
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
      hideCancel();
      activeOp = null;
      clearBusy();
      setBusy(false);
      setStatus('作成に失敗: ' + (s.error || '不明なエラー'), 'err');
      return;
    }
    // 進行中：サーバーが報告する実ステージ進捗を表示する。
    if (s.found && s.status === 'pending') {
      setRealPlanProgress(s.stage || 'プランを作成中…', s.progress || planLastPct);
    }
    await sleep(2500);
  }
  stopPlanProgress();
  hideProgressBar();
  hideCancel();
  activeOp = null;
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
  $('print-btn').classList.remove('hidden');
  $('packing-btn').classList.remove('hidden');
  $('refine-box').classList.remove('hidden');
  setSaveButton(!!d.saved);
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
          hours: e.hours,
          lat: e.lat,
          lng: e.lng,
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
  // 全体の楽しみ方（プランナーの意図）。「なぜこのプランか」は表示しない。
  const enjoyment = plan.enjoyment
    ? `<div class="why-card enjoy"><div class="why-h">✨ このプランの楽しみ方</div><p>${esc(plan.enjoyment)}</p></div>`
    : '';
  const advice = (plan.advice || []).length
    ? `<div class="advice"><div class="advice-h">🧭 上手く回るコツ</div><ul>${plan.advice
        .slice(0, 2)
        .map((a) => `<li>${esc(a)}</li>`)
        .join('')}</ul></div>`
    : '';

  // ホテル選択→滞在費の連動用に、費用の各内訳とホテル一覧を保持する。
  planHotels = plan.hotels && plan.hotels.length ? plan.hotels : [];
  selectedHotelIdx = planHotels.findIndex((h) => h.nightlyPrice != null);
  if (selectedHotelIdx < 0) selectedHotelIdx = 0;
  const cb = plan.costBreakdown;
  planCostParts = cb
    ? { nights: cb.nights, food: cb.food, activities: cb.activities, transport: cb.transport, budget: cb.budget }
    : null;

  const notice = plan.notice ? `<div class="plan-notice">⚠️ ${esc(plan.notice)}</div>` : '';
  let html = `<div class="summary-box">${notice}${theme}${summaryText}${highlights}</div>`;
  html += enjoyment;
  if (plan.forecast && plan.forecast.length) html += renderForecast(plan.forecast);
  if (plan.travel) html += renderTravel(plan.travel);
  // ホテルを先に出し、選んだ宿で下の費用カードが更新されるようにする。
  if (planHotels.length) html += renderHotels(planHotels);
  if (planCostParts) html += renderCostCard();
  html += advice;
  $('plan-summary').innerHTML = html;
  wireHotelSelection();

  renderPlanDays();
  // 候補は同期作成時は data.candidates、保存プラン取得時は plan に内包される。
  renderCandidates(data.candidates || (data.plan && data.plan.candidates));

  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 全日のスポットを描画し、評価欄・地図も更新する（編集・並び替えのたびに呼ぶ）。
function renderPlanDays() {
  if (!currentPlan) return;
  const daysEl = $('plan-days');
  daysEl.innerHTML = (currentPlan.days || [])
    .map((day, i) => `<div class="day" data-day="${i}">${renderDayInner(day, i)}</div>`)
    .join('');
  renderEval();
  renderMap();
}

// 日ごとの色
const DAY_COLORS = ['#4f46e5', '#0ea5e9', '#f97316', '#15803d', '#db2777', '#7c3aed', '#0891b2'];

// プランのスポットを地図にピン表示し、日ごとに線で結ぶ（Leaflet+OpenStreetMap・無料）。
function renderMap() {
  const wrap = $('plan-map');
  if (!wrap) return;
  if (typeof L === 'undefined' || !currentPlan) {
    wrap.classList.add('hidden');
    return;
  }
  const allPts = [];
  (currentPlan.days || []).forEach((day) => {
    (day.items || []).forEach((it) => {
      if (it.lat != null && it.lng != null) allPts.push([it.lat, it.lng]);
    });
  });
  if (!allPts.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  if (!planMap) {
    planMap = L.map(wrap, { scrollWheelZoom: false }).setView(allPts[0], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 18,
    }).addTo(planMap);
  }
  planMapLayers.forEach((l) => planMap.removeLayer(l));
  planMapLayers = [];
  currentPlan.days.forEach((day, di) => {
    const color = DAY_COLORS[di % DAY_COLORS.length];
    const latlngs = [];
    (day.items || []).forEach((it, idx) => {
      if (it.lat == null || it.lng == null) return;
      const icon = L.divIcon({
        className: 'map-pin',
        html: `<span style="background:${color}">${idx + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -12],
      });
      const m = L.marker([it.lat, it.lng], { icon })
        .bindPopup(`<b>${esc(it.title)}</b><br>DAY${di + 1}${it.time ? ' ' + esc(it.time) : ''}`)
        .addTo(planMap);
      planMapLayers.push(m);
      latlngs.push([it.lat, it.lng]);
    });
    if (latlngs.length >= 2) {
      const line = L.polyline(latlngs, { color, weight: 3, opacity: 0.6, dashArray: '6 6' }).addTo(planMap);
      planMapLayers.push(line);
    }
  });
  planMap.fitBounds(allPts, { padding: [30, 30], maxZoom: 14 });
  // 非表示→表示直後はサイズがずれるので再計算。
  setTimeout(() => planMap && planMap.invalidateSize(), 60);
}

// 1日分の中身（見出し＋ルート＋スポット＋移動）を生成。並び替え時の再描画にも使う。
function renderDayInner(day, i) {
  const d = new Date(day.date + 'T00:00:00');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const dayTheme = day.theme ? `<div class="day-theme">${esc(day.theme)}</div>` : '';
  const items = day.items || [];
  const route = dayRouteLink(items);
  let body;
  if (items.length) {
    const sched = computeSchedule(items, currentTransport);
    body = items
      .map((it, idx) => {
        const item = renderItem(it, i, idx, items.length, sched.times[idx]);
        const connector = idx < items.length - 1 ? renderConnector(sched.legs[idx]) : '';
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

// プラン内のスポットを並び替える。日の端では前日/翌日へ移動（複数日対応）。
// 画面更新なしで全日を再描画し、評価も再計算する。
function movePlanItem(dayIndex, idx, dir) {
  const days = currentPlan && currentPlan.days;
  if (!days) return;
  const items = days[dayIndex].items;
  const j = idx + dir;
  if (j >= 0 && j < items.length) {
    // 同じ日の中で入れ替え
    [items[idx], items[j]] = [items[j], items[idx]];
  } else if (dir === -1 && dayIndex > 0) {
    // 前日の末尾へ
    const [it] = items.splice(idx, 1);
    days[dayIndex - 1].items.push(it);
  } else if (dir === 1 && dayIndex < days.length - 1) {
    // 翌日の先頭へ
    const [it] = items.splice(idx, 1);
    days[dayIndex + 1].items.unshift(it);
  } else {
    return; // 端で移動先なし
  }
  renderPlanDays();
  markPlanDirty();
}

// プランからスポットを外す。
function removePlanItem(dayIndex, idx) {
  const day = currentPlan && currentPlan.days && currentPlan.days[dayIndex];
  if (!day) return;
  day.items.splice(idx, 1);
  renderPlanDays();
  markPlanDirty();
}

// 見つかったスポット一覧からプランへ追加する（1日目の末尾に。重複は防ぐ）。
function addSpotToPlan(candIdx) {
  if (!currentPlan || !currentPlan.days || !currentPlan.days.length) {
    setStatus('先にプランを作成してください。', 'err');
    return;
  }
  const c = currentCandidates[candIdx];
  if (!c) return;
  const exists = currentPlan.days.some((d) => d.items.some((it) => it.title === c.title));
  if (exists) {
    setStatus(`「${c.title}」は既にプランに入っています。`, '');
    return;
  }
  currentPlan.days[0].items.push({
    title: c.title,
    category: c.category,
    location: c.location,
    url: c.url,
    price: c.price,
    hours: c.hours,
    description: c.description,
    lat: c.lat,
    lng: c.lng,
  });
  renderPlanDays();
  markPlanDirty();
  setStatus(`「${c.title}」を1日目に追加しました。↑↓で好きな順・日に動かせます。`, 'ok');
  $('plan-days').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 営業時間 "9:00-17:00" を分（0:00からの分数）の範囲に。深夜跨ぎ・24時間にも対応。
function parseHoursRange(s) {
  if (!s) return null;
  const str = String(s);
  if (/24\s*時間/.test(str)) return { open: 0, close: 1440 };
  const m = str.match(/(\d{1,2}):(\d{2})\s*[-〜~–—]+\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]);
  let close = Number(m[3]) * 60 + Number(m[4]);
  if (close <= open) close += 1440; // 深夜営業
  return { open, close };
}

// プランをクライアント側で評価する（移動・営業時間・詰め込みを現実的にチェック）。
function evaluatePlan(plan, mode) {
  const days = plan.days || [];
  const warnings = [];
  const points = [];
  let totalSpots = 0;
  let totalKm = 0;
  let totalTravelMin = 0;
  const catCount = {};
  days.forEach((day, di) => {
    const items = day.items || [];
    totalSpots += items.length;
    items.forEach((it) => {
      const c = it.category || 'その他';
      catCount[c] = (catCount[c] || 0) + 1;
    });
    if (!items.length) {
      warnings.push(`${di + 1}日目: 予定が空です。スポットを追加しましょう。`);
      return;
    }
    const sched = computeSchedule(items, mode);
    sched.legs.forEach((leg, i) => {
      if (!leg) return;
      totalKm += leg.km || 0;
      totalTravelMin += leg.minutes || 0;
      if (leg.minutes >= 90) {
        warnings.push(
          `${di + 1}日目: 「${items[i].title}」→「${items[i + 1].title}」の移動が約${leg.minutes}分と長め。移動時間がタイトすぎないか確認を。`,
        );
      }
    });
    items.forEach((it, i) => {
      const hr = parseHoursRange(it.hours);
      const start = parseClock(sched.times[i]);
      if (!hr || start == null) return;
      const stay = parseDurationMin(it.duration);
      if (start < hr.open) {
        warnings.push(
          `${di + 1}日目: 「${it.title}」の到着(${sched.times[i]})が営業開始(${fmtClock(hr.open)})より早い計算です。`,
        );
      } else if (start + stay > hr.close) {
        warnings.push(
          `${di + 1}日目: 「${it.title}」は営業終了(${fmtClock(hr.close % 1440)})に間に合わない計算です（到着${sched.times[i]}＋滞在約${stay}分）。`,
        );
      }
    });
    const lastStart = parseClock(sched.times[items.length - 1]) ?? 0;
    const endMin = lastStart + parseDurationMin(items[items.length - 1].duration);
    if (endMin > 21 * 60) {
      warnings.push(`${di + 1}日目: 最後の予定が${fmtClock(endMin % 1440)}終わりと遅め。詰め込みすぎかもしれません。`);
    }
    if (items.length >= 6) {
      warnings.push(`${di + 1}日目: スポットが${items.length}件と多め。ゆっくり楽しめない可能性があります。`);
    }
  });
  points.push(`全${days.length}日・スポット計${totalSpots}件`);
  if (totalKm > 0) {
    points.push(`移動の合計 約${Math.round(totalKm)}km・約${Math.round(totalTravelMin)}分（${mode || '公共交通'}）`);
  }
  const catText = Object.entries(catCount)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${catEmoji(c)}${c}${n}`)
    .join('・');
  if (catText) points.push(`内訳: ${catText}`);

  // 具体的な「楽しみ方・グルメ・注意点」を、いま入っているスポットから組み立てる。
  const allItems = days.flatMap((d) => d.items || []);
  return {
    points,
    warnings,
    enjoy: buildEnjoy(allItems),
    food: buildFood(allItems),
    caution: buildCaution(warnings),
  };
}

function clip(s, n) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// スポットの楽しみ方を、実際に入っているスポットの tips/why/概要から具体的に（〜100字）。
function buildEnjoy(items) {
  const withText = items
    .map((it) => ({ name: it.title, txt: it.tips || it.why || it.description || '' }))
    .filter((x) => x.txt);
  if (!withText.length) {
    return 'スポットを追加すると、その楽しみ方がここに具体的に表示されます。各スポットのカードの「楽しみ方」も参考に。';
  }
  withText.sort((a, b) => b.txt.length - a.txt.length);
  const parts = [];
  let len = 0;
  for (const x of withText) {
    const piece = `「${x.name}」では${clip(x.txt, 55)}`;
    parts.push(piece);
    len += piece.length;
    if (len >= 90 || parts.length >= 2) break;
  }
  return parts.join('。') + '。';
}

// 美味しいご飯（グルメ）の提案。グルメが無ければ追加を促す。
function buildFood(items) {
  const gourmet = items.filter((it) => it.category === 'グルメ');
  if (!gourmet.length) {
    return '食事スポットがまだありません。下の一覧から🍜グルメを1〜2件プランに追加すると、ランチ・ディナーが決まって満足度が上がります。';
  }
  const parts = gourmet.slice(0, 2).map((g) => {
    const t = g.tips || g.description || '';
    return t ? `「${g.title}」で${clip(t, 45)}` : `「${g.title}」`;
  });
  const more = gourmet.length > 2 ? `ほか${gourmet.length - 2}件のグルメも候補に。` : '';
  return `食事は${parts.join('、')}がおすすめ。${more}`;
}

// 気をつける点。警告があれば要約し、無ければ一般的な注意を〜100字で。
function buildCaution(warnings) {
  if (warnings.length) {
    const top = warnings.slice(0, 2).join(' / ');
    return clip(top, 120) + ' 時間に余裕を持たせ、無理なら1件減らす調整も検討を。';
  }
  return '大きな無理はありません。各スポットの営業時間・定休日、当日の天候、人気店の予約や行列の有無は念のため事前に確認しておくと安心です。';
}

// 評価欄を再描画する（プラン編集のたびに呼ばれ、再計算される）。
function renderEval() {
  const el = $('plan-eval');
  if (!el) return;
  if (!currentPlan) {
    el.innerHTML = '';
    return;
  }
  const r = evaluatePlan(currentPlan, currentTransport);
  const points = r.points.length
    ? `<ul class="eval-points">${r.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '';
  const warnList = r.warnings.length
    ? `<ul class="eval-warns">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';
  el.innerHTML = `<div class="eval-card">
    <div class="eval-h">📝 プラン評価<span class="eval-note">編集すると自動で再計算</span></div>
    <div class="eval-points-h">📌 ポイント</div>${points}
    <div class="eval-blurb"><div class="eb-h">😋 楽しみ方</div><p>${esc(r.enjoy)}</p></div>
    <div class="eval-blurb food"><div class="eb-h">🍴 美味しいご飯</div><p>${esc(r.food)}</p></div>
    <div class="eval-blurb caution"><div class="eb-h">⚠ 気をつける点</div><p>${esc(r.caution)}</p>${warnList}</div>
  </div>`;
}

// 大カテゴリー（中カテゴリーをまとめる括り）
const MAJOR_CATS = [
  { name: '観光・体験', emoji: '🗺️', mids: ['観光', '歴史', 'アート', '自然', '体験'] },
  { name: 'グルメ', emoji: '🍜', mids: ['グルメ'] },
  { name: 'イベント・祭り', emoji: '🎉', mids: ['イベント', '祭り', '音楽', 'テック'] },
  { name: '宿泊', emoji: '♨️', mids: ['宿泊'] },
];
function majorOf(mid) {
  for (const m of MAJOR_CATS) if (m.mids.includes(mid)) return m;
  return { name: 'その他', emoji: '📍', mids: [] };
}

// 宿泊カテゴリーを、名称からホテル/旅館などの中カテゴリーに振り分ける。
const ACCOM_TYPES = ['ホテル', '旅館', 'リゾート', 'ペンション', '民宿', 'ゲストハウス', 'コテージ', 'その他の宿'];
const ACCOM_EMOJI = {
  ホテル: '🏨',
  旅館: '♨️',
  リゾート: '🏝️',
  ペンション: '🏡',
  民宿: '🏠',
  ゲストハウス: '🛏️',
  コテージ: '🏕️',
  その他の宿: '🛏️',
};
function accommodationType(title) {
  const t = String(title || '');
  if (/旅館|旅亭|温泉宿|湯宿/.test(t)) return '旅館';
  if (/ホテル|HOTEL|Hotel/.test(t)) return 'ホテル';
  if (/リゾート|RESORT|Resort|グランピング/.test(t)) return 'リゾート';
  if (/ペンション/.test(t)) return 'ペンション';
  if (/民宿/.test(t)) return '民宿';
  if (/ゲストハウス|ホステル|hostel|guesthouse/i.test(t)) return 'ゲストハウス';
  if (/コテージ|ヴィラ|villa/i.test(t)) return 'コテージ';
  return 'その他の宿';
}
// 中カテゴリーの絵文字（宿泊の細分は専用、その他は通常カテゴリー絵文字）。
function midEmoji(mid) {
  return ACCOM_EMOJI[mid] || catEmoji(mid);
}
// 中カテゴリーの並び順（宿泊の細分も含む）。
const MID_ORDER = ['観光', '歴史', 'アート', '自然', '体験', 'グルメ', 'イベント', '祭り', '音楽', 'テック'].concat(
  ACCOM_TYPES,
);

function candCard(c, idx) {
  const q = encodeURIComponent(`${c.title} ${c.location || ''}`.trim());
  const cat = c.category ? `<span class="badge">${catEmoji(c.category)} ${esc(c.category)}</span>` : '';
  const price = c.price != null ? `<span class="item-price">${c.price === 0 ? '無料' : '目安 ' + yen(c.price)}</span>` : '';
  const loc = c.location ? `<span class="cand-loc">📍 ${esc(c.location)}</span>` : '';
  // 営業時間は必ず明記（不明なら要確認とする）
  const hours = `<span class="cand-hours">🕒 営業時間: ${c.hours ? esc(c.hours) : '公式サイトで要確認'}</span>`;
  const desc = c.description
    ? `<p class="cand-desc">${esc(c.description)}</p>`
    : `<p class="cand-desc cand-desc-empty">概要はまだありません。下のリンクで確認できます。</p>`;
  const links =
    `<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">📍 地図</a>` +
    ` <a href="https://www.google.com/search?q=${encodeURIComponent(c.title + ' 公式')}" target="_blank" rel="noopener">🔎 公式</a>` +
    (c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">📰 情報元</a>` : '');
  return `<details class="cand">
    <summary><span class="cand-name">${esc(c.title)}</span>${cat}${price}</summary>
    <div class="cand-body"><div class="cand-meta">${loc}${hours}</div>${desc}<div class="cand-links">${links}</div>
      <div class="cand-actions"><button type="button" class="cand-add" data-cand-idx="${idx}">＋ プランに追加</button></div>
      <div class="item-foot">${spotChecks(c.title, c.prefecture, c.url)}</div></div>
  </details>`;
}

// 見つかったスポットを【大カテゴリー＞中カテゴリー＞スポット】の3階層で表示する。
function renderCandidates(candidates) {
  const el = $('plan-extra');
  if (!el) return;
  currentCandidates = candidates || [];
  if (!currentCandidates.length) {
    el.innerHTML = '';
    return;
  }
  // 大 → 中 → [{c, i}]。宿泊は名称からホテル/旅館などの中カテゴリーに分ける。
  const majors = {};
  currentCandidates.forEach((c, i) => {
    let mid = c.category || 'その他';
    let major;
    if (c.category === '宿泊') {
      major = '宿泊';
      mid = accommodationType(c.title);
    } else {
      major = majorOf(mid).name;
    }
    majors[major] = majors[major] || {};
    (majors[major][mid] = majors[major][mid] || []).push({ c, i });
  });
  const majorOrder = MAJOR_CATS.map((m) => m.name).concat(['その他']);
  const majorKeys = Object.keys(majors).sort(
    (a, b) => (majorOrder.indexOf(a) + 1 || 99) - (majorOrder.indexOf(b) + 1 || 99),
  );
  const html = majorKeys
    .map((mName) => {
      const mids = majors[mName];
      const total = Object.values(mids).reduce((n, arr) => n + arr.length, 0);
      const midKeys = Object.keys(mids).sort((a, b) => {
        const ia = MID_ORDER.indexOf(a);
        const ib = MID_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ja');
      });
      const midHtml = midKeys
        .map((mid) => {
          const cards = mids[mid].map(({ c, i }) => candCard(c, i)).join('');
          return `<details class="mid-group">
            <summary><span class="mid-name">${midEmoji(mid)} ${esc(mid)}</span><span class="cat-count">${mids[mid].length}</span></summary>
            <div class="cand-list">${cards}</div>
          </details>`;
        })
        .join('');
      const emoji = (MAJOR_CATS.find((m) => m.name === mName) || { emoji: '📍' }).emoji;
      return `<details class="major-group">
        <summary><span class="major-name">${emoji} ${esc(mName)}</span><span class="cat-count">${total}</span></summary>
        <div class="mid-groups">${midHtml}</div>
      </details>`;
    })
    .join('');
  el.innerHTML = `<div class="cand-head">🔎 見つかったスポット<br><span class="cand-sub">（${currentCandidates.length}件・カテゴリーをタップで展開）</span></div><div class="major-groups">${html}</div>`;
}

const yen = (n) => '¥' + Number(n || 0).toLocaleString();

function renderTravel(t) {
  const bits = [];
  if (t.distance) bits.push(`距離 ${esc(t.distance)}`);
  if (t.duration) bits.push(`片道 ${esc(t.duration)}`);
  if (t.costRoundTrip) bits.push(`往復 ${yen(t.costRoundTrip)}`);
  const mode = t.mode ? `（${esc(t.mode)}）` : '';
  // 乗換案内：出発地→目的地の公共交通ルート（Googleマップ transit）。
  const transitLink =
    t.from && t.to
      ? `<div class="item-links"><a href="https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(t.from)}&destination=${encodeURIComponent(t.to)}&travelmode=transit" target="_blank" rel="noopener">🚉 乗換案内</a></div>`
      : '';
  return `<div class="info-card">
    <div class="info-h">🚆 ${esc(t.from || '出発地')} → ${esc(t.to || '目的地')}${mode}</div>
    ${bits.length ? `<div class="pills">${bits.map((b) => `<span class="pill">${b}</span>`).join('')}</div>` : ''}
    ${t.note ? `<p class="info-note">${esc(t.note)}</p>` : ''}
    ${transitLink}
  </div>`;
}

// 選択中ホテルの料金を反映した費用カードを組み立てる。
function renderCostCard() {
  const p = planCostParts;
  if (!p) return '';
  const hotel = planHotels[selectedHotelIdx];
  const unknown = !!(hotel && hotel.nightlyPrice == null);
  const nightly = hotel && hotel.nightlyPrice != null ? hotel.nightlyPrice : 0;
  const nights = p.nights || 0;
  const hotelTotal = nightly * nights;
  const stayTotal = hotelTotal + (p.food || 0) + (p.activities || 0);
  const transport = p.transport || 0;
  const grandTotal = stayTotal + transport;
  const withinBudget = p.budget != null ? stayTotal <= p.budget : undefined;
  return renderCost({
    nights,
    hotel: hotelTotal,
    hotelName: hotel ? hotel.name : undefined,
    hotelUnknown: unknown,
    food: p.food || 0,
    activities: p.activities || 0,
    stayTotal,
    transport,
    grandTotal,
    budget: p.budget,
    withinBudget,
  });
}

function renderCost(c) {
  // 日帰り（0泊）は宿泊費の行を出さない。
  const hotelLabel = `ホテル${c.nights ? `（${c.nights}泊）` : ''}${c.hotelName ? `・${esc(c.hotelName)}` : ''}`;
  const hotelVal = c.hotelUnknown ? '料金不明' : yen(c.hotel);
  const hotelRow = c.nights ? `<div class="cost-row"><span>${hotelLabel}</span><span>${hotelVal}</span></div>` : '';
  const rows =
    hotelRow +
    `<div class="cost-row"><span>食事</span><span>${yen(c.food)}</span></div>` +
    `<div class="cost-row"><span>観光・体験</span><span>${yen(c.activities)}</span></div>`;
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
  return `<div class="info-card" id="cost-card">
    <div class="info-h">💰 費用の目安（1人）</div>
    ${rows}${stay}${transport}${grand}${budget}
    <p class="info-note">※選んだ宿泊先で滞在費が変わります。AIによる概算で、実際の料金は各予約サイト等でご確認ください。</p>
  </div>`;
}

function renderHotels(hotels) {
  const anyDated = hotels.some((h) => h.datedPrice);
  const list = hotels
    .map((h, idx) => {
      const name = h.url
        ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.name)}</a>`
        : esc(h.name);
      const link = h.url
        ? `<a class="hotel-link" href="${esc(h.url)}" target="_blank" rel="noopener">楽天トラベルで見る →</a>`
        : `<a class="hotel-link" href="https://www.google.com/search?q=${encodeURIComponent(h.name + ' 宿泊 予約')}" target="_blank" rel="noopener">空室・料金を探す →</a>`;
      const priceLabel = h.datedPrice ? '/ 泊・人〜（指定日）' : '/ 泊・人〜';
      const checked = idx === selectedHotelIdx ? ' checked' : '';
      const extra = idx >= HOTELS_SHOWN ? ' hotel-extra hidden' : '';
      return `<div class="hotel${checked ? ' selected' : ''}${extra}" data-hotel="${idx}">
      <label class="hotel-pick"><input type="radio" name="hotelsel" class="hotel-radio" data-idx="${idx}"${checked}><span>この宿で計算</span></label>
      <div class="hotel-top"><span class="hotel-name">${name}</span>${
        h.nightlyPrice
          ? `<span class="hotel-price${h.datedPrice ? ' dated' : ''}">${yen(h.nightlyPrice)} ${priceLabel}</span>`
          : '<span class="hotel-price">料金不明</span>'
      }</div>
      ${h.area ? `<div class="hotel-area">📍 ${esc(h.area)}</div>` : ''}
      ${h.why ? `<div class="hotel-why">${esc(h.why)}</div>` : ''}
      <div class="hotel-actions">${link}</div>
    </div>`;
    })
    .join('');
  const moreBtn =
    hotels.length > HOTELS_SHOWN
      ? `<button type="button" class="hotel-more" id="hotel-more-btn">▼ 他の${hotels.length - HOTELS_SHOWN}件を表示</button>`
      : '';
  return `<div class="info-card">
    <div class="info-h">🏨 宿泊の候補（${hotels.length}件・${anyDated ? '指定日の空室・' : ''}安い順／選んで滞在費に反映）</div>
    ${list}
    ${moreBtn}
    <p class="info-note">${
      anyDated
        ? '※価格は指定した宿泊日の空室の最低料金（1泊1人〜）です。最新の空室・プランは予約ページでご確認ください。'
        : '※価格は目安です。空室・料金・プランは予約ページでご確認ください。'
    }</p>
  </div>`;
}

// ホテルのラジオ選択で費用カードを更新／「もっと見る」で残りを展開。
function wireHotelSelection() {
  document.querySelectorAll('.hotel-radio').forEach((r) => {
    r.addEventListener('change', () => {
      selectedHotelIdx = Number(r.getAttribute('data-idx')) || 0;
      const card = $('cost-card');
      if (card) card.outerHTML = renderCostCard();
      document.querySelectorAll('.hotel').forEach((el) => {
        el.classList.toggle('selected', Number(el.getAttribute('data-hotel')) === selectedHotelIdx);
      });
    });
  });
  const moreBtn = $('hotel-more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      document.querySelectorAll('.hotel-extra').forEach((el) => el.classList.remove('hidden'));
      moreBtn.remove();
    });
  }
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
        <div class="fc-emoji">${esc(day.emoji)}</div>
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
  if (
    !(await uiConfirm('一覧から消します（データは残るので共有リンクからは見られます）。', {
      title: 'この保存プランを消しますか？',
      okText: '消す',
      cancelText: 'やめる',
      danger: true,
    }))
  )
    return;
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

  // 端では前日/翌日へ移動できる（複数日対応）。全体の先頭/末尾だけ無効化。
  const totalDays = (currentPlan && currentPlan.days && currentPlan.days.length) || 1;
  const upDisabled = dayIndex === 0 && idx === 0;
  const downDisabled = dayIndex === totalDays - 1 && idx === count - 1;
  const move = `<span class="item-move">
    <button type="button" class="mv-up" data-day="${dayIndex}" data-idx="${idx}" aria-label="上へ/前日へ" ${upDisabled ? 'disabled' : ''}>▲</button>
    <button type="button" class="mv-down" data-day="${dayIndex}" data-idx="${idx}" aria-label="下へ/翌日へ" ${downDisabled ? 'disabled' : ''}>▼</button>
    <button type="button" class="it-del" data-day="${dayIndex}" data-idx="${idx}" aria-label="プランから外す" title="プランから外す">✕</button>
  </span>`;

  const meta = [];
  if (it.category) meta.push(`<span class="badge">${catEmoji(it.category)} ${esc(it.category)}</span>`);
  if (it.location) meta.push(`<span>📍 ${esc(it.location)}</span>`);
  if (it.hours) meta.push(`<span class="item-hours">🕒 ${esc(it.hours)}</span>`);
  const cost = it.price != null ? it.price : it.estCost;
  if (cost != null) meta.push(`<span class="item-price">${cost === 0 ? '無料' : '目安 ' + yen(cost)}</span>`);

  const detail = [];
  // 「おすすめ」と「楽しみ方」は1つの「オススメの楽しみ方」に統合（重複回避）。
  const enjoy = it.why || it.tips;
  if (enjoy) detail.push(`<p class="why"><b>💡 オススメの楽しみ方</b>${esc(enjoy)}</p>`);
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
  // 口コミ：グルメは食べログ（フリーワード検索＋地名で絞り）、それ以外はGoogleの「口コミ・評判」検索。
  const cat = it.category || '';
  const kw = `${it.title} ${it.location || ''}`.trim();
  if (cat.includes('グルメ') || cat.includes('食') || cat.includes('レストラン') || cat.includes('カフェ')) {
    links.push(`<a href="https://tabelog.com/rst/rstsearch/?sw=${encodeURIComponent(kw)}" target="_blank" rel="noopener">⭐ 口コミ</a>`);
  } else {
    links.push(`<a href="https://www.google.com/search?q=${encodeURIComponent(it.title + ' 口コミ 評判')}" target="_blank" rel="noopener">⭐ 口コミ</a>`);
  }
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
// エリア入力の地名オートコンプリート（県＋市を確定させ、荻/萩の取り違え等を防ぐ）。
function setupAreaAutocomplete() {
  const input = $('area');
  const list = $('area-suggest');
  if (!input || !list) return;
  let timer = null;
  const hide = () => {
    list.classList.add('hidden');
    list.innerHTML = '';
  };
  const render = (places) => {
    if (!places || !places.length) return hide();
    list.innerHTML = places
      .map((p) => `<li data-v="${esc(p.value)}">📍 ${esc(p.label)}</li>`)
      .join('');
    list.classList.remove('hidden');
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (q.length < 1) return hide();
    timer = setTimeout(async () => {
      try {
        const r = await api('/places?q=' + encodeURIComponent(q));
        render(r.places);
      } catch {
        hide();
      }
    }, 160);
  });
  // mousedown は blur より先に発火するので選択が確実に入る。
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-v]');
    if (!li) return;
    e.preventDefault();
    input.value = li.getAttribute('data-v');
    hide();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  initDates();
  setupAreaAutocomplete();
  $('tab-manual').addEventListener('click', () => setPlanMode('manual'));
  $('tab-auto').addEventListener('click', () => setPlanMode('auto'));
  $('plan-form').addEventListener('submit', submitPlan);
  $('collect-btn').addEventListener('click', () => deepCollect(false));
  $('recollect-btn').addEventListener('click', () => deepCollect(true));
  $('share-btn').addEventListener('click', sharePlan);
  $('packing-btn').addEventListener('click', genPacking);
  $('save-btn').addEventListener('click', saveCurrentPlan);
  $('print-btn').addEventListener('click', () => window.print());
  $('wish-plan-btn').addEventListener('click', genFromWishlist);
  $('refine-btn').addEventListener('click', async () => {
    const v = $('refine-input').value.trim();
    if (!v) {
      setStatus('変えたい内容を入力してください（例：グルメ多めに）。', 'err');
      $('refine-input').focus();
      return;
    }
    const ok = await uiConfirm(`「${v}」でプランを作り直します。今表示中のプランは置き換わります。`, {
      title: 'この内容で作り直す',
      okText: '作り直す',
      cancelText: 'やめる',
    });
    if (!ok) return;
    refinePlan(v);
  });
  $('variant-btn').addEventListener('click', () =>
    refinePlan('前回とは違う構成・別のスポットや切り口で、新鮮な別案にしてください'),
  );
  $('refine-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('refine-btn').click();
    }
  });

  // ハンバーガーメニュー（保存プラン・行った場所）の開閉。
  $('menu-btn').addEventListener('click', openDrawer);
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-overlay').addEventListener('click', closeDrawer);
  $('cancel-btn').addEventListener('click', cancelOp);

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

  // プラン内スポットの並び替え（↑↓・複数日対応）と削除。編集ごとに評価を再計算。
  $('plan-days').addEventListener('click', (ev) => {
    const up = ev.target.closest('.mv-up');
    if (up) return movePlanItem(Number(up.dataset.day), Number(up.dataset.idx), -1);
    const down = ev.target.closest('.mv-down');
    if (down) return movePlanItem(Number(down.dataset.day), Number(down.dataset.idx), 1);
    const del = ev.target.closest('.it-del');
    if (del) removePlanItem(Number(del.dataset.day), Number(del.dataset.idx));
  });

  // 見つかったスポット一覧からプランへ追加。
  $('plan-extra').addEventListener('click', (ev) => {
    const add = ev.target.closest('.cand-add');
    if (add) addSpotToPlan(Number(add.dataset.candIdx));
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
    if (!s) return;
    if ($('dayTrip') && $('dayTrip').checked) {
      // 日帰りは終了日＝開始日。
      $('endDate').value = s;
      return;
    }
    const e = $('endDate').value;
    // 終了日が未設定 or 開始日より前のときだけ自動補完（既存の複数日設定を壊さない）。
    if (!e || e < s) $('endDate').value = addDays(s, 1);
  });

  if ($('dayTrip')) $('dayTrip').addEventListener('change', () => setDayTrip($('dayTrip').checked));

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
    const gen = ++bgGen;
    activeOp = { type: 'plan', jobId: busy.jobId, gen };
    setBusy(true);
    setStatus('プラン作成を再開しています…', '');
    startPlanProgress();
    showCancel();
    pollPlanJob(busy.jobId, gen);
  } else if (busy && busy.type === 'collect' && busy.area) {
    const gen = ++bgGen;
    activeOp = { type: 'collect', area: busy.area, gen };
    setBusy(true);
    setStatus('じっくり収集を再開しています…', '');
    showProgress(0, 6, 0, false);
    showCancel();
    pollCollect(busy.area, gen);
  }
});
