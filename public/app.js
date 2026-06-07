'use strict';

const $ = (id) => document.getElementById(id);
const selectedInterests = new Set();

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

async function loadCategories() {
  try {
    const { categories } = await api('/categories');
    const box = $('interests');
    box.innerHTML = '';
    categories.forEach((cat) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${catEmoji(cat)} ${cat}`;
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        if (selectedInterests.has(cat)) selectedInterests.delete(cat);
        else selectedInterests.add(cat);
      });
      box.appendChild(chip);
    });
  } catch (e) {
    console.error(e);
  }
}

// --- plan ---
async function submitPlan(ev) {
  ev.preventDefault();
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
      autoScrape,
    };
    const data = await api('/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderPlan(data);
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
  const metaParts = [];
  if (plan.totalEstimatedCost) metaParts.push(`<span class="cost">概算 ¥${plan.totalEstimatedCost.toLocaleString()} / 人</span>`);
  const meta = metaParts.length ? `<div class="summary-meta">${metaParts.join(' ')}</div>` : '';
  const highlights = (plan.highlights || []).length
    ? `<div class="highlights">${plan.highlights.map((h) => `<span class="tag">★ ${esc(h)}</span>`).join('')}</div>`
    : '';
  const advice = (plan.advice || []).length
    ? `<div class="advice"><div class="advice-h">🧭 楽しみ方のヒント</div><ul>${plan.advice
        .map((a) => `<li>${esc(a)}</li>`)
        .join('')}</ul></div>`
    : '';
  $('plan-summary').innerHTML =
    `<div class="summary-box">${theme}${summaryText}${meta}${highlights}</div>${advice}`;

  const daysEl = $('plan-days');
  daysEl.innerHTML = '';
  plan.days.forEach((day, i) => daysEl.insertAdjacentHTML('beforeend', renderDay(day, i)));

  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const title = it.url
    ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>`
    : esc(it.title);
  const meta = [];
  if (it.category) meta.push(`<span class="badge">${catEmoji(it.category)} ${esc(it.category)}</span>`);
  if (it.location) meta.push(`<span>📍 ${esc(it.location)}</span>`);
  if (it.price != null) meta.push(`<span class="item-price">¥${Number(it.price).toLocaleString()}</span>`);

  const detail = [];
  if (it.why) detail.push(`<p class="why"><b>💡 おすすめ</b>${esc(it.why)}</p>`);
  if (it.tips) detail.push(`<p class="tips"><b>🎯 楽しみ方</b>${esc(it.tips)}</p>`);
  if (it.access) detail.push(`<p class="access"><b>🚃 行き方</b>${esc(it.access)}</p>`);
  const sub = [];
  if (it.duration) sub.push(`⏱ 滞在目安 ${esc(it.duration)}`);
  if (it.alt) sub.push(`🔄 ${esc(it.alt)}`);

  return `
    <div class="item">
      <div class="item-top">${time}<span class="item-title">${title}</span></div>
      ${meta.length ? `<div class="item-meta">${meta.join('')}</div>` : ''}
      ${detail.join('')}
      ${sub.length ? `<div class="item-sub">${sub.join('　·　')}</div>` : ''}
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
window.addEventListener('DOMContentLoaded', () => {
  initDates();
  loadCategories();
  $('plan-form').addEventListener('submit', submitPlan);
  $('startDate').addEventListener('change', () => {
    const s = $('startDate').value;
    if (s) $('endDate').value = addDays(s, 1);
  });
});
