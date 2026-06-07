'use strict';

const $ = (id) => document.getElementById(id);
const selectedInterests = new Set();
let currentPlanId = null;

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
  const pct = totalRounds ? Math.round((doneRounds / totalRounds) * 100) : done ? 100 : 0;
  $('cp-fill').style.width = (done ? 100 : pct) + '%';
  $('cp-label').innerHTML = done
    ? '✅ 収集完了'
    : `<span class="cp-spin"></span>じっくり収集中… ${doneRounds}/${totalRounds} ラウンド`;
  $('cp-count').textContent = `合計 ${collected} 件`;
}

async function deepCollect() {
  const area = $('area').value.trim();
  if (!area) {
    setStatus('エリア・行き先を入力してください。', 'err');
    $('area').focus();
    return;
  }
  const btn = $('collect-btn');
  btn.disabled = true;
  const keyword = $('keyword').value.trim() || undefined;
  const interests = [...selectedInterests];
  try {
    const r = await api('/collect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ area, keyword, interests }),
    });
    setStatus(
      `バックグラウンドで収集を開始しました（最大${r.totalRounds}ラウンド・数分）。画面を閉じてもOK、サーバーが続行します。`,
      'ok',
    );
    showProgress(0, r.totalRounds, 0, false);
    pollCollect(area);
  } catch (e) {
    setStatus('開始に失敗: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// 開いている間だけ進捗をポーリング（閉じてもサーバー側は継続する）。
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
          return;
        }
        showProgress(doneRounds, s.totalRounds, s.collected, false);
        setStatus('じっくり収集中… 画面を閉じてもサーバーが続行します。', '');
      }
    } catch {
      /* 一時失敗は無視 */
    }
    if (tries < 80) pollTimer = setTimeout(tick, 8000);
  };
  pollTimer = setTimeout(tick, 6000);
}

async function submitPlan(ev) {
  ev.preventDefault();
  if (!validateForm()) return;
  const btn = $('submit-btn');
  btn.disabled = true;
  btn.classList.add('loading');
  const autoScrape = $('autoScrape').checked;
  setStatus(autoScrape ? '情報を集めてプランを作成中…（初回は数十秒かかります）' : 'プランを作成中…');
  try {
    const body = {
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
      autoScrape,
    };
    const data = await api('/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderPlan(data);
    currentPlanId = data.id;
    if (currentPlanId) $('share-btn').classList.remove('hidden');
    if (data.candidateCount === 0) {
      setStatus(`条件に合う候補が見つかりませんでした。${discoverDiag(data.discovered)}`, 'err');
    } else {
      const extra = [];
      if (data.discovered && data.discovered.total) extra.push(`自動収集 ${data.discovered.total}件`);
      if (data.scrape && data.scrape.ran && data.scrape.total) extra.push(`登録ソース ${data.scrape.total}件`);
      const suffix = extra.length ? ` ・ ${extra.join(' / ')}` : '';
      setStatus(`プランが完成しました（候補 ${data.candidateCount}件${suffix}）`, 'ok');
    }
  } catch (e) {
    setStatus('エラー: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function renderPlan(data) {
  const plan = data.plan;
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
  if (plan.travel) html += renderTravel(plan.travel);
  if (plan.costBreakdown) html += renderCost(plan.costBreakdown);
  if (plan.hotels && plan.hotels.length) html += renderHotels(plan.hotels);
  html += advice;
  $('plan-summary').innerHTML = html;

  const daysEl = $('plan-days');
  daysEl.innerHTML = '';
  plan.days.forEach((day, i) => daysEl.insertAdjacentHTML('beforeend', renderDay(day, i)));

  renderCandidates(data.candidates);

  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCandidates(candidates) {
  const el = $('plan-extra');
  if (!el) return;
  if (!candidates || !candidates.length) {
    el.innerHTML = '';
    return;
  }
  const items = candidates
    .map((c) => {
      const q = encodeURIComponent(`${c.title} ${c.location || ''}`.trim());
      const cat = c.category ? `<span class="badge">${catEmoji(c.category)} ${esc(c.category)}</span>` : '';
      const price = c.price != null ? `<span class="item-price">${c.price === 0 ? '無料' : '目安 ' + yen(c.price)}</span>` : '';
      const links =
        `<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">📍地図</a>` +
        (c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">📰情報元</a>` : '');
      return `<div class="cand"><div class="cand-name">${esc(c.title)}</div><div class="cand-meta">${cat}${price} ${links}</div></div>`;
    })
    .join('');
  el.innerHTML = `<details class="cand-box"><summary>🔎 見つかったスポット一覧（${candidates.length}件）</summary><div class="cand-list">${items}</div></details>`;
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
      return `<div class="hotel">
      <div class="hotel-top"><span class="hotel-name">${name}</span>${
        h.nightlyPrice ? `<span class="hotel-price">${yen(h.nightlyPrice)} / 泊・人〜</span>` : ''
      }</div>
      ${h.area ? `<div class="hotel-area">📍 ${esc(h.area)}</div>` : ''}
      ${h.why ? `<div class="hotel-why">${esc(h.why)}</div>` : ''}
    </div>`;
    })
    .join('');
  return `<div class="info-card">
    <div class="info-h">🏨 宿泊の候補（${hotels.length}件・予算内/安い順）</div>
    ${list}
    <p class="info-note">※価格は目安です。空室・料金・プランは予約ページでご確認ください。</p>
  </div>`;
}

function renderDay(day, i) {
  const d = new Date(day.date + 'T00:00:00');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const dayTheme = day.theme ? `<div class="day-theme">${esc(day.theme)}</div>` : '';
  const items = day.items.length
    ? day.items.map(renderItem).join('')
    : '<div class="empty-day">この日の候補は見つかりませんでした。条件をゆるめてみてください。</div>';
  return `
    <div class="day">
      <div class="day-head">
        <div class="day-num"><small>DAY</small>${i + 1}</div>
        <div>
          <div class="day-date">${d.getMonth() + 1}/${d.getDate()}<span>(${wd})</span></div>
          ${dayTheme}
        </div>
      </div>
      <div class="items">${items}</div>
    </div>`;
}

function renderItem(it) {
  const time = it.time
    ? `<span class="item-time">${esc(it.time)}</span>`
    : `<span class="item-time tba">時間自由</span>`;

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
      <div class="item-top">${time}<span class="item-title">${esc(it.title)}</span></div>
      ${meta.length ? `<div class="item-meta">${meta.join('')}</div>` : ''}
      ${detail.join('')}
      ${sub.length ? `<div class="item-sub">${sub.join('　·　')}</div>` : ''}
      <div class="item-links">${links.join('')}</div>
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
  $('startDate').addEventListener('change', () => {
    const s = $('startDate').value;
    if (s) $('endDate').value = addDays(s, 1);
  });

  const sharedId = new URLSearchParams(location.search).get('plan');
  if (sharedId) await loadSharedPlan(sharedId);
  else await loadCategories();
});
