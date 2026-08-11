'use strict';

const el = (id) => document.getElementById(id);
// Quantas linhas cada aba mostra — o resto vira resumo, para o painel não virar
// uma lista rolando sem fim.
const LIST_MAX = 8;
let tab = 'live';
let last = null;
let hover = -1; // índice do minuto sob o cursor no gráfico, -1 = nenhum
const prevModelTokens = new Map(); // modelo -> tokens na última renderização
const deltaFlash = new Map(); // modelo -> { tokens, until }

const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};

// Abaixo de $10 os centavos importam; acima deles só poluem a coluna.
const usd = (n) => '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('pt-BR'));

const sumTokens = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

// claude-haiku-4-5-20251001 -> haiku-4-5
const shortModel = (m) =>
  String(m)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function ago(ms) {
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'min';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h';
  return Math.round(ms / 86400000) + 'd';
}

function dur(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/* ---------- limites ---------- */

const SCOPES = [
  { key: 'blockCost', title: 'cota do bloco', unit: 'usd' },
  { key: 'weekCost', title: 'cota da semana', unit: 'usd' },
  { key: 'weekFableCost', title: 'cota Fable', unit: 'usd' },
  { key: 'dailyTokens', title: 'tokens/dia', unit: 'tokens' },
  { key: 'sessionTokens', title: 'tokens/sessão', unit: 'tokens' },
  { key: 'daily', title: 'custo/dia', unit: 'usd' },
  { key: 'session', title: 'custo/sessão', unit: 'usd' },
];

const showValue = (v, unit) => (unit === 'usd' ? usd(v) : fmt(v));

const activeAlerts = (data) =>
  SCOPES.map((s) => ({ ...s, ...data.alerts[s.key] })).filter((a) => a.limit > 0);

function renderLimits(data) {
  // Bloco e semanas já têm barra própria (destaque do topo e aba Uso); repetir
  // aqui seria a mesma informação duas vezes.
  const own = new Set(['blockCost', 'weekCost', 'weekFableCost']);
  const rows = activeAlerts(data).filter((a) => !own.has(a.key));
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
  banner.textContent = `${worst.level === 'over' ? 'Estourou' : 'Perto do limite'}: ${worst.title} — ${showValue(worst.value, worst.unit)} de ${showValue(worst.limit, worst.unit)}`;
}

/* ---------- composição ---------- */

const SERIES = [
  { key: 'input', label: 'input', color: 'var(--s-input)' },
  { key: 'output', label: 'output', color: 'var(--s-output)' },
  { key: 'cacheWrite', label: 'cache escrito', color: 'var(--s-cwrite)' },
  { key: 'cacheRead', label: 'cache lido', color: 'var(--s-cread)' },
];

function renderBreakdown(totals) {
  const total = sumTokens(totals) || 1;
  el('bar').innerHTML = SERIES.map(
    (s) => `<span style="width:${((totals[s.key] / total) * 100).toFixed(2)}%;background:${s.color}"></span>`
  ).join('');
  el('legend').innerHTML = SERIES.map(
    (s) =>
      `<li><i style="background:${s.color}"></i>${s.label}<b>${fmt(totals[s.key])}</b></li>`
  ).join('');
}

/* ---------- gráfico ---------- */

// Cores lidas do CSS uma vez: o canvas não entende var().
const css = getComputedStyle(document.documentElement);
const C = {
  accent: css.getPropertyValue('--accent').trim() || '#58a6ff',
  panel2: css.getPropertyValue('--panel-2').trim() || '#1b2432',
  faint: css.getPropertyValue('--faint').trim() || '#6f7d90',
  line: css.getPropertyValue('--line-soft').trim() || '#1e2734',
  ok: css.getPropertyValue('--ok').trim() || '#3fb950',
};

function renderChart(timeline) {
  const canvas = el('chart');
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 76;
  if (!w) return;
  if (canvas.width !== Math.round(w * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padTop = 12; // espaço para o rótulo do pico
  const padBottom = 11; // espaço para os rótulos de tempo
  const plot = h - padTop - padBottom;
  const max = Math.max(1, ...timeline.map((p) => p.tokens));
  const bw = w / timeline.length;

  // Linha de base e meia-altura: dão escala sem competir com os dados.
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  for (const frac of [0, 0.5]) {
    const y = Math.round(padTop + plot * frac) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  timeline.forEach((p, i) => {
    const x = i * bw;
    const isLast = i === timeline.length - 1;
    if (p.tokens > 0) {
      const bh = Math.max(1.5, (p.tokens / max) * plot);
      const grad = ctx.createLinearGradient(0, padTop + plot - bh, 0, padTop + plot);
      grad.addColorStop(0, isLast ? C.ok : C.accent);
      grad.addColorStop(1, 'rgba(88,166,255,0.25)');
      ctx.fillStyle = i === hover ? '#ffffff' : grad;
      ctx.fillRect(x, padTop + plot - bh, Math.max(1, bw - 1), bh);
    } else {
      ctx.fillStyle = C.panel2;
      ctx.fillRect(x, padTop + plot - 1.5, Math.max(1, bw - 1), 1.5);
    }
  });

  ctx.fillStyle = C.faint;
  ctx.font = '9px Inter, "Segoe UI", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('pico ' + fmt(max) + '/min', 0, 8);
  ctx.fillText('-60 min', 0, h - 2);
  ctx.textAlign = 'right';
  ctx.fillText('agora', w, h - 2);
  ctx.textAlign = 'left';
}

function chartReadout(data) {
  const tl = data.timeline;
  const p = hover >= 0 && hover < tl.length ? tl[hover] : null;
  if (p) {
    return `${hhmm(p.t)} · ${fmt(p.tokens)} tokens · ${usd(p.cost)}`;
  }
  const total = tl.reduce((a, b) => a + b.tokens, 0);
  const cost = tl.reduce((a, b) => a + b.cost, 0);
  return `${fmt(total)} tokens · ${usd(cost)} na hora`;
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
        <span class="ev-model">${esc(shortModel(r.model))}</span>
        <span class="ev-proj" title="${esc(r.project)}">${esc(r.project)}</span>
        <span class="ev-tok">+${fmt(r.tokens)}</span>
      </div>`;
    })
    .join('');
}

function bar(name, value, total, note, extraClass) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return `<div class="brow${extraClass || ''}">
    <div class="brow-top">
      <span class="name">${name}</span>
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
    .slice(0, LIST_MAX)
    .map((m) => {
      const tk = sumTokens(m.totals);
      const flash = deltaFlash.get(m.name);
      const badge =
        flash && flash.until > Date.now() ? `<span class="delta">+${fmt(flash.tokens)}</span>` : '';
      const note = `${m.totals.messages.toLocaleString('pt-BR')} chamadas · ${((tk / total) * 100).toFixed(0)}% · ${usd(m.totals.cost)}`;
      return bar(esc(shortModel(m.name)) + badge, tk, total, note, m.active ? ' active' : '');
    })
    .join('');
}

function renderProjects(data) {
  if (data.projects.length === 0) return '<div class="empty">Sem dados</div>';
  const top = sumTokens(data.projects[0].totals) || 1;
  const shown = data.projects.slice(0, 6);
  const rest = data.projects.slice(6);
  let html = shown
    .map((p) => {
      const tk = sumTokens(p.totals);
      const note = `${p.sessions} ${p.sessions === 1 ? 'sessão' : 'sessões'} · ${usd(p.totals.cost)} · ${ago(data.now - p.lastTs)} atrás`;
      return bar(esc(p.name), tk, top, note, p.active ? ' active' : '');
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

/**
 * Uma janela de 7 dias. Com cota calibrada mostra a porcentagem e a barra; sem
 * cota, mostra o total absoluto — que é tudo que dá para saber sem calibrar.
 */
function window7(title, agg, limit, alert, { note }) {
  const pct = limit > 0 ? (agg.cost / limit) * 100 : null;
  const level = (alert && alert.level) || 'ok';
  const head =
    pct === null
      ? `<span>${title}</span>`
      : `<span>${title}</span><span class="uwin-reset${level !== 'ok' ? ' ' + level : ''}">${pct.toFixed(pct < 10 ? 1 : 0)}% da cota</span>`;
  const track =
    pct === null
      ? ''
      : `<div class="track${level !== 'ok' ? ' ' + level : ''}"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></div>`;
  return `<div class="uwin">
    <div class="uwin-head">${head}</div>
    <div class="uwin-val">${fmt(agg.tokens)} tokens <small>${usd(agg.cost)}</small></div>
    ${track}
    <div class="uwin-note">${note}</div>
  </div>`;
}

/**
 * Distribuição por tamanho de contexto nas últimas 24h. Contexto grande é o que
 * mais encarece cada chamada, então a leitura importa mesmo com cache.
 */
function renderContext(ctx) {
  if (!ctx || ctx.cost === 0) return '';
  let html = `<div class="usep">Contexto · últimas ${ctx.hours}h</div>`;
  html += ctx.rows
    .map((r) => {
      const pct = r.share * 100;
      return `<div class="uday">
        <span class="uday-date">${r.label}</span>
        <span class="uday-bar"><i style="width:${pct}%"></i></span>
        <span class="uday-tok">${pct.toFixed(0)}%</span>
        <span class="uday-cost">${r.cost > 0 ? usd(r.cost) : ''}</span>
      </div>`;
    })
    .join('');
  return html;
}

/** Mesmas janelas do `/usage`: bloco de 5h, semana e histórico diário. */
function renderUsage(data) {
  const u = data.usage;
  const b = u.block;
  const blockPct = b.elapsed * 100;

  let html = b.active
    ? `<div class="uwin">
        <div class="uwin-head">
          <span>Bloco de ${b.hours}h</span>
          <span class="uwin-reset">reseta em ${dur(b.resetIn)} · ${hhmm(b.resetAt)}</span>
        </div>
        <div class="uwin-val">${fmt(b.tokens)} tokens <small>${usd(b.cost)}</small></div>
        <div class="track"><span style="width:${blockPct}%"></span></div>
        <div class="uwin-note">iniciado ${hhmm(b.start)} · ${blockPct.toFixed(0)}% do tempo · ritmo ${fmt(b.burnRate)} tok/min</div>
      </div>`
    : `<div class="uwin">
        <div class="uwin-head"><span>Bloco de ${b.hours}h</span></div>
        <div class="uwin-val">—</div>
        <div class="uwin-note">nenhum bloco aberto; começa na próxima chamada</div>
      </div>`;

  const w = u.week;
  const cfg = data.config || {};
  html += window7('Últimos 7 dias', w, cfg.weekCostLimit, data.alerts.weekCost, {
    note: `${w.messages.toLocaleString('pt-BR')} chamadas · média ${fmt(w.tokens / 7)}/dia`,
  });
  // O Fable tem cota semanal separada no `/usage`, então aparece como janela
  // própria em vez de virar só mais uma linha na divisão por modelo.
  if (w.fable && w.fable.cost > 0) {
    html += window7('Fable · 7 dias', w.fable, cfg.weekFableCostLimit, data.alerts.weekFableCost, {
      note: `${w.fable.messages.toLocaleString('pt-BR')} chamadas · cota própria no /usage`,
    });
  }

  const wtotal = w.tokens || 1;
  html += w.byModel
    .slice(0, 4)
    .map((m) => {
      const pct = (m.tokens / wtotal) * 100;
      return bar(
        esc(shortModel(m.name)),
        m.tokens,
        wtotal,
        `${pct.toFixed(0)}% da semana · ${usd(m.cost)}`
      );
    })
    .join('');

  html += renderContext(data.context);

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

// Janela sob a qual a cota do bloco foi calibrada. Editar a cota na mão vale
// para a janela vigente, então o valor acompanha o bloco atual.
let calBlockHours = 0;

function renderConfig(cfg) {
  // Sem procedência, a cota fica marcada como não calibrada — cair para a janela
  // atual aqui revalidaria silenciosamente uma cota velha.
  calBlockHours = cfg.blockCalHours || 0;
  el('in-block-cost').value = cfg.blockCostLimit ? cfg.blockCostLimit.toFixed(2) : 0;
  el('in-week-cost').value = cfg.weekCostLimit ? cfg.weekCostLimit.toFixed(2) : 0;
  el('in-week-fable-cost').value = cfg.weekFableCostLimit ? cfg.weekFableCostLimit.toFixed(2) : 0;
  el('in-daily-tok').value = cfg.dailyTokenLimit / 1e6;
  el('in-session-tok').value = cfg.sessionTokenLimit / 1e6;
  el('in-daily').value = cfg.dailyLimit;
  el('in-session').value = cfg.sessionLimit;
  el('in-warn').value = Math.round(cfg.warnAt * 100);
  el('in-notify').checked = !!cfg.notify;
  el('in-sound').checked = !!cfg.sound;
}

function renderHero(data) {
  const b = data.usage.block;
  const hero = el('hero');
  const stale = !!(data.alerts.blockCost && data.alerts.blockCost.stale);
  // Cota calibrada sob outra janela nao vale: cai para o modo absoluto e avisa.
  const limit = stale ? 0 : (data.config && data.config.blockCostLimit) || 0;
  el('hero-title').textContent = `Bloco de ${b.hours}h`;
  hero.classList.toggle('idle', !b.active);
  hero.classList.remove('warn', 'over');

  if (!b.active) {
    el('hero-reset').textContent = 'inativo';
    el('hero-tokens').textContent = '—';
    el('hero-unit').textContent = '';
    el('hero-cost').textContent = '';
    el('hero-track').style.width = '0%';
    el('hero-note').textContent = 'nenhum bloco aberto; começa na próxima chamada';
    el('hero-proj').textContent = '';
    return;
  }

  el('hero-reset').textContent = `reseta em ${dur(b.resetIn)}`;
  el('hero-cost').textContent = usd(b.cost);

  if (limit > 0) {
    // Com a cota calibrada a métrica principal vira a mesma do `/usage`. A conta
    // é sobre o custo, então mudar de modelo já entra ponderado sem recalibrar.
    const pct = (b.cost / limit) * 100;
    const level = (data.alerts.blockCost && data.alerts.blockCost.level) || 'ok';
    if (level !== 'ok') hero.classList.add(level);
    el('hero-tokens').textContent = pct.toFixed(pct < 10 ? 1 : 0) + '%';
    el('hero-unit').textContent = 'da cota';
    el('hero-track').style.width = Math.min(100, pct).toFixed(1) + '%';
    el('hero-note').textContent = `${fmt(b.tokens)} tokens · ${fmt(b.burnRate)} tok/min`;
    // Projeção só faz sentido depois que o bloco andou o bastante para ter média.
    el('hero-proj').textContent =
      b.elapsed > 0.08 ? `projeção ${((b.projectedCost / limit) * 100).toFixed(0)}% no reset` : '';
    return;
  }

  el('hero-tokens').textContent = fmt(b.tokens);
  el('hero-unit').textContent = 'tokens';
  el('hero-track').style.width = (b.elapsed * 100).toFixed(1) + '%';
  el('hero-note').textContent = stale
    ? `cota calibrada para janela de ${data.config.blockCalHours || '?'}h — recalibrar`
    : `${hhmm(b.start)}–${hhmm(b.resetAt)} · ${fmt(b.burnRate)} tok/min`;
  el('hero-proj').textContent =
    b.elapsed > 0.08 ? `projeção ${fmt(b.projected)} · ${usd(b.projectedCost)}` : '';
}

function render(data) {
  last = data;
  trackDeltas(data);

  const cur = data.current;
  const liveNow = !!(cur && cur.active);

  el('today-tokens').textContent = fmt(data.today.tokens);
  el('today-cost').textContent = usd(data.today.cost);
  el('cur-tokens').textContent = cur ? fmt(sumTokens(cur.totals)) : '—';
  el('cur-project').textContent = cur ? cur.project : 'nenhuma sessão';
  el('rate').textContent = fmt(data.rate);
  // Custo por hora no mesmo ritmo dos últimos 5 minutos fechados.
  el('rate-sub').textContent = data.costRate > 0 ? `${usd(data.costRate * 60)}/h` : 'tok/min';

  const dot = el('live-dot');
  dot.classList.toggle('live', liveNow);
  const chip = el('head-chip');
  chip.classList.toggle('live', liveNow);
  chip.textContent = liveNow ? `${shortModel(cur.model)} · ${fmt(data.rate)}/min` : 'ocioso';

  el('mix-title').textContent = cur ? 'Composição da sessão' : 'Composição total';
  el('mix-model').textContent = cur
    ? `${shortModel(cur.model)} · ${usd(cur.totals.cost)}`
    : `${usd(data.totals.cost)}`;

  renderHero(data);
  renderBreakdown(cur ? cur.totals : data.totals);
  renderBanner(data);
  renderLimits(data);
  renderChart(data.timeline);
  el('chart-readout').textContent = chartReadout(data);
  renderList(data);

  el('footer-total').textContent = `${fmt(sumTokens(data.totals))} tokens · ${usd(data.totals.cost)} · ${data.totals.messages.toLocaleString('pt-BR')} chamadas · ${data.sessionCount} sessões`;
}

/* ---------- eventos ---------- */

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    tab = btn.dataset.tab;
    if (last) renderList(last);
  });
});

el('btn-cfg').addEventListener('click', (e) => {
  const open = !el('settings').classList.toggle('hidden');
  e.currentTarget.classList.toggle('on', open);
});

async function saveConfig() {
  renderConfig(
    await window.tokens.setConfig({
      blockCostLimit: Number(el('in-block-cost').value) || 0,
      blockCalHours: calBlockHours,
      weekCostLimit: Number(el('in-week-cost').value) || 0,
      weekFableCostLimit: Number(el('in-week-fable-cost').value) || 0,
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

// Editar a cota na mão é um ato deliberado: vale para a janela vigente.
el('in-block-cost').addEventListener('change', () => {
  calBlockHours = last ? last.usage.block.hours : 0;
});

[
  'in-block-cost',
  'in-week-cost',
  'in-week-fable-cost',
  'in-daily-tok',
  'in-session-tok',
  'in-daily',
  'in-session',
  'in-warn',
  'in-notify',
  'in-sound',
].forEach((id) => el(id).addEventListener('change', saveConfig));

/**
 * Calibração: o limite do plano não vem em nenhum arquivo local, mas a
 * porcentagem que o `/usage` mostra é o consumo do bloco dividido por ele.
 * Com o consumo já medido aqui, informar a porcentagem revela a cota.
 *
 * A cota fica em custo, não em tokens, justamente para não precisar recalibrar a
 * cada troca de modelo: o custo já pondera Opus contra Haiku na mesma régua.
 */
el('in-cal-pct').addEventListener('change', async () => {
  const pct = Number(el('in-cal-pct').value);
  const b = last && last.usage.block;
  if (!(pct > 0) || !b || !b.active || b.cost === 0) {
    el('cal-hint').textContent =
      'Precisa de um bloco aberto com consumo para calibrar. Rode uma chamada e tente de novo.';
    return;
  }
  el('in-block-cost').value = (b.cost / (pct / 100)).toFixed(2);
  // Guarda sob qual janela a cota foi deduzida, para ela se invalidar sozinha
  // caso BLOCK_HOURS mude depois.
  calBlockHours = b.hours;
  await saveConfig();
  el('cal-hint').textContent = `Calibrado: ${usd(b.cost)} equivalem a ${pct}%, então a cota do bloco é ~${el('in-block-cost').value} em custo estimado. Trocar de modelo não exige recalibrar.`;
});

/** Mesma calibração, agora para as duas janelas de 7 dias. */
function calibrateWeek(pctField, costField, pick) {
  el(pctField).addEventListener('change', async () => {
    const pct = Number(el(pctField).value);
    const w = last && last.usage.week;
    const value = w ? pick(w) : 0;
    if (!(pct > 0) || !value) {
      el('cal-week-hint').textContent =
        'Precisa de consumo na janela para calibrar. Rode uma chamada e tente de novo.';
      return;
    }
    el(costField).value = (value / (pct / 100)).toFixed(2);
    await saveConfig();
    el('cal-week-hint').textContent = `Calibrado: ${usd(value)} equivalem a ${pct}%, então a cota é ~${el(costField).value} em custo estimado.`;
  });
}

calibrateWeek('in-cal-week', 'in-week-cost', (w) => w.cost);
calibrateWeek('in-cal-week-fable', 'in-week-fable-cost', (w) => (w.fable ? w.fable.cost : 0));

// Leitura ponto a ponto do gráfico — o painel é pequeno demais para tooltip.
const chartEl = el('chart');
chartEl.addEventListener('mousemove', (e) => {
  if (!last) return;
  const rect = chartEl.getBoundingClientRect();
  const i = Math.floor(((e.clientX - rect.left) / rect.width) * last.timeline.length);
  const clamped = Math.max(0, Math.min(last.timeline.length - 1, i));
  if (clamped === hover) return;
  hover = clamped;
  renderChart(last.timeline);
  el('chart-readout').textContent = chartReadout(last);
});
chartEl.addEventListener('mouseleave', () => {
  if (hover === -1 || !last) return;
  hover = -1;
  renderChart(last.timeline);
  el('chart-readout').textContent = chartReadout(last);
});

document.body.addEventListener('click', () => window.tokens.stopFlash());
el('btn-close').addEventListener('click', () => window.tokens.close());
el('btn-min').addEventListener('click', () => window.tokens.minimize());
el('btn-open').addEventListener('click', () => window.tokens.openProjects());
el('btn-pin').addEventListener('click', (e) => {
  const on = e.currentTarget.classList.toggle('on');
  e.currentTarget.setAttribute('aria-pressed', String(on));
  window.tokens.pin(on);
});

window.addEventListener('resize', () => last && renderChart(last.timeline));

// Relógio do feed: mantém "há Xs" e a contagem do reset correndo sem dados novos.
setInterval(() => {
  if (!last) return;
  last.now = Date.now();
  const b = last.usage.block;
  if (b.active) {
    b.resetIn = Math.max(0, b.resetAt - last.now);
    b.elapsed = Math.min(1, 1 - b.resetIn / (b.hours * 3600000));
    renderHero(last);
  }
  if (tab === 'live' || tab === 'usage' || deltaFlash.size > 0) renderList(last);
}, 1000);

window.tokens.onUpdate(render);
window.tokens.snapshot().then((data) => {
  renderConfig(data.config);
  render(data);
});
