'use strict';

const $ = (id) => document.getElementById(id);
const selectedInterests = new Set();

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

// --- 初期化 ---
function initDates() {
  const today = new Date();
  const inAWeek = new Date(today.getTime() + 7 * 86400000);
  const end = new Date(inAWeek.getTime() + 86400000);
  $('startDate').value = inAWeek.toISOString().slice(0, 10);
  $('endDate').value = end.toISOString().slice(0, 10);
}

async function loadCategories() {
  try {
    const { categories } = await api('/categories');
    const box = $('interests');
    box.innerHTML = '';
    categories.forEach((cat) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = cat;
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

async function loadSources() {
  try {
    const { sources } = await api('/sources');
    const tbody = $('sources-table').querySelector('tbody');
    tbody.innerHTML = '';
    sources.forEach((s) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${esc(s.id)}</code></td>
        <td>${esc(s.name)}</td>
        <td>${s.enabled ? '<span class="badge-on">有効</span>' : '<span class="badge-off">無効</span>'}</td>
        <td>${s.last_run_at ? new Date(s.last_run_at).toLocaleString('ja-JP') : '—'}</td>
        <td>${esc(s.last_status || '—')}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
  }
}

// --- プラン生成 ---
async function submitPlan(ev) {
  ev.preventDefault();
  const btn = ev.submitter;
  if (btn) btn.disabled = true;
  setStatus('プランを作成中...');
  try {
    const body = {
      area: $('area').value.trim() || undefined,
      startDate: $('startDate').value,
      endDate: $('endDate').value,
      interests: [...selectedInterests],
      budget: $('budget').value ? Number($('budget').value) : undefined,
      pace: $('pace').value,
      engine: $('useAi').checked ? 'ai' : 'rule',
    };
    const data = await api('/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderPlan(data);
    setStatus(`完成（候補 ${data.candidateCount} 件 / エンジン: ${data.plan.engine}）`, 'ok');
  } catch (e) {
    setStatus('エラー: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderPlan(data) {
  const plan = data.plan;
  $('result').classList.remove('hidden');

  const cost = plan.totalEstimatedCost
    ? `<span class="cost">概算費用: ¥${plan.totalEstimatedCost.toLocaleString()}</span>`
    : '';
  const highlights = (plan.highlights || []).length
    ? `<div class="highlights">${plan.highlights.map((h) => `<span class="tag">★ ${esc(h)}</span>`).join('')}</div>`
    : '';
  $('plan-summary').innerHTML = `<div class="summary-box"><div>${esc(plan.summary)}</div>${cost}${highlights}</div>`;

  const daysEl = $('plan-days');
  daysEl.innerHTML = '';
  plan.days.forEach((day, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'day';
    const dateLabel = formatDate(day.date, i);
    const items = day.items.length
      ? day.items.map(renderItem).join('')
      : '<p class="hint">この日の候補が見つかりませんでした。条件をゆるめるか、データを追加してください。</p>';
    wrap.innerHTML = `<div class="day-head">${dateLabel}</div>${items}`;
    daysEl.appendChild(wrap);
  });

  $('result').scrollIntoView({ behavior: 'smooth' });
}

function renderItem(it) {
  const time = it.time ? `<div class="time">${esc(it.time)}</div>` : '<div class="time">—</div>';
  const cat = it.category ? `<span class="cat">${esc(it.category)}</span>` : '';
  const loc = it.location ? `📍 ${esc(it.location)}` : '';
  const price = it.price != null ? ` / ¥${Number(it.price).toLocaleString()}` : '';
  const title = it.url
    ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>`
    : esc(it.title);
  return `
    <div class="item">
      ${time}
      <div class="body">
        <div class="title">${title}</div>
        <div class="meta">${cat}${loc}${price}</div>
      </div>
    </div>`;
}

// --- 補助操作 ---
async function runDemo(ev) {
  const btn = ev.currentTarget;
  btn.disabled = true;
  setStatus('サンプルデータを投入中...');
  try {
    const data = await api('/demo', { method: 'POST' });
    setStatus(`サンプル ${data.inserted} 件を投入しました。エリアに「箱根」と入れて作成してみてください。`, 'ok');
  } catch (e) {
    setStatus('エラー: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function runScrape(ev) {
  const btn = ev.currentTarget;
  btn.disabled = true;
  setStatus('スクレイピングを実行中...（有効なソースのみ）');
  try {
    const summary = await api('/scrape', { method: 'POST' });
    const results = summary.results || [];
    const ok = results.filter((r) => r.status === 'ok').length;
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'error');
    await loadSources();

    if (results.length === 0) {
      setStatus('有効なソースがありません。sources テーブルで対象を有効化してください（README参照）。', 'err');
    } else if (failed.length) {
      const detail = failed.map((r) => `${r.source}: ${r.message}`).join(' / ');
      setStatus(`一部失敗（取得 ${summary.total} 件 / 成功 ${ok}）。失敗: ${detail}`, 'err');
    } else if (ok === 0 && skipped.length) {
      const detail = skipped.map((r) => `${r.source}: ${r.message}`).join(' / ');
      setStatus(`実行対象なし（スキップ）。${detail}`, 'err');
    } else {
      setStatus(`完了: ${summary.total} 件取得 / 成功 ${ok} ソース。`, 'ok');
    }
  } catch (e) {
    setStatus('エラー: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function formatDate(iso, i) {
  const d = new Date(iso + 'T00:00:00');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `Day ${i + 1} ・ ${d.getMonth() + 1}/${d.getDate()}(${wd})`;
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
  loadSources();
  $('plan-form').addEventListener('submit', submitPlan);
  $('demo-btn').addEventListener('click', runDemo);
  $('scrape-btn').addEventListener('click', runScrape);
  $('refresh-sources').addEventListener('click', loadSources);
});
