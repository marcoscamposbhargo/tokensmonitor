'use strict';

const el = (id) => document.getElementById(id);
// Quantas linhas cada aba mostra — o resto vira resumo, para o painel não virar
// uma lista rolando sem fim.
const LIST_MAX = 8;
let tab = 'live';
let last = null;
const prevModelTokens = new Map(); // modelo -> tokens na última renderização
const deltaFlash = new Map(); // modelo -> { tokens, until }

const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};

const usd = (n) => '$' + (n < 10 ? n.toFixed(2) : Math.round(n));

const sumTokens = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

// claude-haiku-4-5-20251001 -> haiku-4-5
const shortModel = (m) =>
  String(m)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');

function ago(ms) {
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'min';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h';
  return Math.round(ms / 86400000) + 'd';
}

/* ---------- topo ---------- */

const SCOPES = [
  { key: 'dailyTokens', title: 'tokens/dia', unit: 'tokens' },
  { key: 'sessionTokens', title: 'tokens/sessão', unit: 'tokens' },
  { key: 'daily', title: 'custo/dia', unit: 'usd' },
  { key: 'session', title: 'custo/sessão', unit: 'usd' },
];

const showValue = (v, unit) => (unit === 'usd' ? usd(v) : fmt(v));

const activeAlerts = (data) =>
  SCOPES.map((s) => ({ ...s, ...data.alerts[s.key] })).filter((a) => a.limit > 0);

function renderLimits(data) {
  const rows = activeAlerts(data);
  el('limits').innerHTML = rows
    .map((a) => {
      const pct = Math.min(100, (a.value / a.limit) * 100);
      return `<div class="limit${a.level === 'ok' ? '' : ' ' + a.level}">
        <div class="limit-head">
          <span>${a.title}</span>
          <span>${showValue(a.value, a.unit)} / ${showValue(a.limit, a.unit)}</span>
        </div>
        <div class="track"><span style="width:${pct}%"></span></div>
      </div>`;
    })
    .join('');
}

function renderBanner(data) {
  const banner = el('banner');
  const hit = activeAlerts(data).filter((a) => a.level !== 'ok');
  const worst = hit.find((a) => a.level === 'over') || hit[0];
  if (!worst) {
    banner.className = 'banner hidden';
    return;
  }
  banner.className = 'banner ' + worst.level;
  banner.textContent = `${worst.level === 'over' ? '⚠️ Estourou' : '⏳ Perto do limite'}: ${worst.title} ${showValue(worst.value, worst.unit)} de ${showValue(worst.limit, worst.unit)}`;
}

const SERIES = [
  { key: 'input', label: 'input', color: '#58a6ff' },
  { key: 'output', label: 'output', color: '#f778ba' },
  { key: 'cacheWrite', label: 'cache write', color: '#d29922' },
  { key: 'cacheRead', label: 'cache read', color: '#3fb950' },
];

function renderBreakdown(totals) {
  const total = sumTokens(totals) || 1;
  el('bar').innerHTML = SERIES.map(
    (s) => `<span style="width:${((totals[s.key] / total) * 100).toFixed(2)}%;background:${s.color}"></span>`
  ).join('');
  el('legend').innerHTML = SERIES.map(
    (s) => `<li><i style="background:${s.color}"></i>${s.label} ${fmt(totals[s.key])}</li>`
  ).join('');
}

function renderChart(timeline) {
  const canvas = el('chart');
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 70;
  if (canvas.width !== Math.round(w * ratio)) {
    canvas.width = w * ratio;
    canvas.height = h * ratio;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(1, ...timeline.map((p) => p.tokens));
  const bw = w / timeline.length;
  timeline.forEach((p, i) => {
    const bh = p.tokens > 0 ? Math.max(1, (p.tokens / max) * (h - 2)) : 1;
    ctx.fillStyle = p.tokens > 0 ? '#58a6ff' : '#1f2733';
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
  });

  ctx.fillStyle = '#8b98a9';
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.fillText('pico ' + fmt(max), 4, 10);
}

/* ---------- listas ---------- */

function renderLive(data) {
  const recent = data.recent || [];
  if (recent.length === 0) return '<div class="empty">Aguardando chamadas…</div>';
  return recent
    .slice(0, LIST_MAX)
    .map((r, i) => {
      const age = data.now - r.ts;
      const fresh = age < 15000;
      return `<div class="ev${fresh ? ' fresh' : ''}${i === 0 && fresh ? ' first' : ''}">
        <span class="ev-when">${ago(age)}</span>
        <span class="ev-model">${shortModel(r.model)}</span>
        <span class="ev-proj" title="${r.project}">${r.project}</span>
        <span class="ev-tok">+${fmt(r.tokens)}</span>
      </div>`;
    })
    .join('');
}

function bar(name, value, total, note, extraClass) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return `<div class="brow${extraClass || ''}">
    <div class="brow-top">
      <span class="name" title="${name}">${name}</span>
      <span class="val">${fmt(value)}</span>
    </div>
    <div class="track"><span style="width:${pct}%"></span></div>
    <div class="brow-note">${note}</div>
  </div>`;
}

function renderModels(data) {
  if (data.models.length === 0) return '<div class="empty">Sem dados</div>';
  const total = data.models.reduce((a, m) => a + sumTokens(m.totals), 0) || 1;
  return data.models
    .map((m) => {
      const tk = sumTokens(m.totals);
      const flash = deltaFlash.get(m.name);
      const badge =
        flash && flash.until > Date.now() ? `<span class="delta">+${fmt(flash.tokens)}</span>` : '';
      const note = `${m.totals.messages.toLocaleString('pt-BR')} chamadas · ${((tk / total) * 100).toFixed(0)}% · ${usd(m.totals.cost)}`;
      return bar(shortModel(m.name) + badge, tk, total, note, m.active ? ' active' : '');
    })
    .join('');
}

function renderProjects(data) {
  if (data.projects.length === 0) return '<div class="empty">Sem dados</div>';
  const top = sumTokens(data.projects[0].totals) || 1;
  const shown = data.projects.slice(0, 5);
  const rest = data.projects.slice(5);
  let html = shown
    .map((p) => {
      const tk = sumTokens(p.totals);
      const active = Date.now() - p.lastTs < 5 * 60 * 1000;
      return bar(p.name, tk, top, `${p.sessions} sessões · ${usd(p.totals.cost)}`, active ? ' active' : '');
    })
    .join('');
  const o = data.othersProjects || { count: 0, tokens: 0, cost: 0 };
  const hidden = rest.reduce(
    (a, p) => ({ count: a.count + 1, tokens: a.tokens + sumTokens(p.totals), cost: a.cost + p.totals.cost }),
    { count: o.count, tokens: o.tokens, cost: o.cost }
  );
  if (hidden.count > 0) {
    html += `<div class="empty">+ outros ${hidden.count} projetos · ${fmt(hidden.tokens)} · ${usd(hidden.cost)}</div>`;
  }
  return html;
}

function dur(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Mesmas janelas do /usage: bloco de 5h, semana e histórico diário. */
function renderUsage(data) {
  const u = data.usage;
  const b = u.block;
  const blockPct = b.elapsed * 100;

  let html = b.active
    ? `<div class="uwin">
        <div class="uwin-head">
          <span>Bloco de 5h</span>
          <span class="uwin-reset">reseta em ${dur(b.resetIn)} · ${hhmm(b.resetAt)}</span>
        </div>
        <div class="uwin-val">${fmt(b.tokens)} tokens <small>${usd(b.cost)}</small></div>
        <div class="track"><span style="width:${blockPct}%"></span></div>
        <div class="uwin-note">iniciado ${hhmm(b.start)} · ${blockPct.toFixed(0)}% do tempo decorrido</div>
      </div>`
    : `<div class="uwin">
        <div class="uwin-head"><span>Bloco de 5h</span></div>
        <div class="uwin-val">—</div>
        <div class="uwin-note">nenhum bloco aberto; começa na próxima chamada</div>
      </div>`;

  const w = u.week;
  html += `<div class="uwin">
    <div class="uwin-head"><span>Últimos 7 dias</span></div>
    <div class="uwin-val">${fmt(w.tokens)} tokens <small>${usd(w.cost)}</small></div>
  </div>`;

  const wtotal = w.tokens || 1;
  html += w.byModel
    .slice(0, 4)
    .map((m) => {
      const pct = (m.tokens / wtotal) * 100;
      return `<div class="brow">
        <div class="brow-top">
          <span class="name">${shortModel(m.name)}</span>
          <span class="val">${fmt(m.tokens)}</span>
        </div>
        <div class="track"><span style="width:${pct}%"></span></div>
        <div class="brow-note">${pct.toFixed(0)}% da semana · ${usd(m.cost)}</div>
      </div>`;
    })
    .join('');

  const days = data.daily.slice().reverse();
  const dmax = Math.max(1, ...days.map((d) => d.tokens));
  html += '<div class="usep">Consumo diário</div>';
  html += days
    .map((d) => {
      const [, mo, da] = d.date.split('-');
      const today = d.date === data.daily[data.daily.length - 1].date;
      return `<div class="uday${today ? ' today' : ''}">
        <span class="uday-date">${da}/${mo}</span>
        <span class="uday-bar"><i style="width:${(d.tokens / dmax) * 100}%"></i></span>
        <span class="uday-tok">${d.tokens ? fmt(d.tokens) : '—'}</span>
        <span class="uday-cost">${d.tokens ? usd(d.cost) : ''}</span>
      </div>`;
    })
    .join('');

  return html;
}

function renderList(data) {
  const list = el('list');
  if (tab === 'live') list.innerHTML = renderLive(data);
  else if (tab === 'usage') list.innerHTML = renderUsage(data);
  else if (tab === 'models') list.innerHTML = renderModels(data);
  else list.innerHTML = renderProjects(data);
}

/* ---------- render principal ---------- */

/** Guarda o crescimento de cada modelo desde a última leitura, para o badge. */
function trackDeltas(data) {
  const now = Date.now();
  for (const m of data.models) {
    const tk = sumTokens(m.totals);
    const prev = prevModelTokens.get(m.name);
    if (prev !== undefined && tk > prev) {
      deltaFlash.set(m.name, { tokens: tk - prev, until: now + 6000 });
    }
    prevModelTokens.set(m.name, tk);
  }
  for (const [name, f] of deltaFlash) {
    if (f.until <= now) deltaFlash.delete(name);
  }
}

function renderConfig(cfg) {
  el('in-daily-tok').value = cfg.dailyTokenLimit / 1e6;
  el('in-session-tok').value = cfg.sessionTokenLimit / 1e6;
  el('in-daily').value = cfg.dailyLimit;
  el('in-session').value = cfg.sessionLimit;
  el('in-warn').value = Math.round(cfg.warnAt * 100);
  el('in-notify').checked = !!cfg.notify;
  el('in-sound').checked = !!cfg.sound;
}

function render(data) {
  last = data;
  trackDeltas(data);

  const cur = data.current;
  el('today-tokens').textContent = fmt(data.today.tokens);
  el('today-cost').textContent = usd(data.today.cost) + ' estimado';
  el('cur-tokens').textContent = cur ? fmt(sumTokens(cur.totals)) : '—';
  el('cur-project').textContent = cur ? cur.project : 'nenhuma sessão';
  el('rate').textContent = fmt(data.rate);
  el('cur-model').textContent = cur ? shortModel(cur.model) : '—';
  el('cur-cost').textContent = cur ? usd(cur.totals.cost) + ' na sessão' : '—';
  el('live-dot').classList.toggle('live', !!(cur && cur.active));

  renderBreakdown(cur ? cur.totals : data.totals);
  renderBanner(data);
  renderLimits(data);
  renderChart(data.timeline);
  renderList(data);

  el('footer-total').textContent = `${fmt(sumTokens(data.totals))} tokens · ${usd(data.totals.cost)} · ${data.totals.messages.toLocaleString('pt-BR')} chamadas`;
}

/* ---------- eventos ---------- */

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    tab = btn.dataset.tab;
    if (last) renderList(last);
  });
});

el('btn-cfg').addEventListener('click', (e) => {
  const open = el('settings').classList.toggle('hidden');
  e.currentTarget.classList.toggle('on', !open);
});

async function saveConfig() {
  renderConfig(
    await window.tokens.setConfig({
      dailyTokenLimit: (Number(el('in-daily-tok').value) || 0) * 1e6,
      sessionTokenLimit: (Number(el('in-session-tok').value) || 0) * 1e6,
      dailyLimit: Number(el('in-daily').value) || 0,
      sessionLimit: Number(el('in-session').value) || 0,
      warnAt: (Number(el('in-warn').value) || 80) / 100,
      notify: el('in-notify').checked,
      sound: el('in-sound').checked,
    })
  );
}

['in-daily-tok', 'in-session-tok', 'in-daily', 'in-session', 'in-warn', 'in-notify', 'in-sound'].forEach(
  (id) => el(id).addEventListener('change', saveConfig)
);

// Relógio do feed: mantém "há Xs" correndo mesmo sem dados novos.
setInterval(() => {
  if (!last) return;
  last.now = Date.now();
  if (tab === 'live' || tab === 'usage' || deltaFlash.size > 0) renderList(last);
}, 1000);

document.body.addEventListener('click', () => window.tokens.stopFlash());
el('btn-close').addEventListener('click', () => window.tokens.close());
el('btn-min').addEventListener('click', () => window.tokens.minimize());
el('btn-open').addEventListener('click', () => window.tokens.openProjects());
el('btn-pin').addEventListener('click', (e) => {
  window.tokens.pin(e.currentTarget.classList.toggle('on'));
});

window.addEventListener('resize', () => last && renderChart(last.timeline));

window.tokens.onUpdate(render);
window.tokens.snapshot().then((data) => {
  renderConfig(data.config);
  render(data);
});
