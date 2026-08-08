'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { costOf, isBillable } = require('./pricing');
const { dayKey, minuteKey, hourFloor, dayStart, DAY_MS } = require('./time');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = 1500;
const TIMELINE_MINUTES = 60;
const DAILY_DAYS = 14;
const PROJECT_LIMIT = 10;
const RECENT_MAX = 60;
// Duração da janela de limite que o `/usage` reporta — ele a chama de
// "Session (5hr)". Vai junto no snapshot para os rótulos da interface não
// descolarem da constante.
//
// O valor não é cosmético: a janela é encadeada, ou seja, cada bloco começa onde
// o anterior terminou. Errar a duração desloca o início de todos os blocos
// seguintes e o total sai completamente fora.
const BLOCK_HOURS = 5;
const BLOCK_MS = BLOCK_HOURS * 60 * 60 * 1000;
// Uma sessão conta como "ativa" se recebeu tokens nos últimos 5 minutos.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
// Minutos além disso não alimentam nenhuma janela e só ocupam memória.
const MINUTE_RETENTION_MS = 30 * DAY_MS;
// Acima disso o índice de deduplicação rotaciona (ver `remember`).
const SEEN_MAX = 200000;

function emptyTotals() {
  return {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    cost: 0,
    messages: 0,
  };
}

function addTotals(target, delta) {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheWrite += delta.cacheWrite;
  target.cacheWrite5m += delta.cacheWrite5m;
  target.cacheWrite1h += delta.cacheWrite1h;
  target.cacheRead += delta.cacheRead;
  target.cost += delta.cost;
  target.messages += 1;
}

/**
 * Lê incrementalmente os .jsonl de ~/.claude/projects e agrega consumo de
 * tokens por sessão, por projeto e por janela de tempo.
 */
class TokenWatcher extends EventEmitter {
  constructor() {
    super();
    this.files = new Map(); // filePath -> { offset, remainder }
    this.sessions = new Map(); // sessionId -> session
    this.projects = new Map(); // projectName -> aggregate
    this.models = new Map(); // model -> aggregate
    this.minutes = new Map(); // minuteKey -> { tokens, cost }
    this.days = new Map(); // dayKey -> { tokens, cost, messages }
    // Deduplicação em duas gerações: quando a atual enche, ela vira a antiga e
    // uma nova começa vazia. Mantém memória limitada sem perder as chaves
    // recentes, que são as únicas que podem reaparecer em sessões retomadas.
    this.seen = new Set();
    this.seenOld = new Set();
    this.recent = []; // últimas chamadas lidas, para o feed ao vivo
    this.modelDays = new Map(); // `modelo|AAAA-MM-DD` -> { tokens, cost, messages, dayTs }
    this.totals = emptyTotals();
    this.skipped = 0; // entradas ignoradas por não terem preço (erro/sintéticas)
    this.timer = null;
    this.scanning = false;
    this.ready = false;
    this.minuteOrder = []; // chaves de `minutes` em ordem, recalculado sob demanda
    this.minuteOrderDirty = true;
  }

  async start() {
    await this.scan(true);
    this.ready = true;
    this.emitUpdate();
    this.timer = setInterval(() => {
      this.scan(false).catch((err) => this.emit('error', err));
    }, POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async listFiles() {
    let dirs;
    try {
      dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const full = path.join(PROJECTS_DIR, dir.name);
      let entries;
      try {
        entries = await fsp.readdir(full);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.endsWith('.jsonl')) out.push({ file: path.join(full, name), dir: dir.name });
      }
    }
    return out;
  }

  async scan(initial) {
    if (this.scanning) return;
    this.scanning = true;
    let changed = false;
    try {
      const files = await this.listFiles();
      for (const { file, dir } of files) {
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        const state = this.files.get(file) || { offset: 0, remainder: '' };
        // Arquivo truncado/recriado: relê do zero.
        if (stat.size < state.offset) {
          state.offset = 0;
          state.remainder = '';
        }
        if (stat.size === state.offset) {
          this.files.set(file, state);
          continue;
        }
        const text = await this.readRange(file, state.offset, stat.size);
        state.offset = stat.size;
        const buf = state.remainder + text;
        const lines = buf.split('\n');
        state.remainder = lines.pop() || '';
        this.files.set(file, state);
        for (const line of lines) {
          if (this.ingest(line, dir)) changed = true;
        }
      }
      if (changed) this.prune();
    } finally {
      this.scanning = false;
    }
    if (changed && !initial) this.emitUpdate();
  }

  readRange(file, start, end) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = fs.createReadStream(file, { start, end: end - 1, encoding: 'utf8' });
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(chunks.join('')));
    });
  }

  /** @returns {boolean} true se a chave é nova (ou seja, deve ser contabilizada). */
  remember(key) {
    if (this.seen.has(key) || this.seenOld.has(key)) return false;
    if (this.seen.size >= SEEN_MAX) {
      this.seenOld = this.seen;
      this.seen = new Set();
    }
    this.seen.add(key);
    return true;
  }

  ingest(line, dirName) {
    // Pré-filtro barato: só linhas de assistant com usage importam.
    if (line.length < 40 || line.indexOf('"usage"') === -1) return false;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (entry.type !== 'assistant') return false;
    const message = entry.message;
    const usage = message && message.usage;
    if (!usage) return false;

    const model = (message && message.model) || 'unknown';
    // Respostas sintéticas e erros de API aparecem como assistant com usage
    // zerado; contá-las inflava o número de chamadas sem somar token nenhum.
    if (entry.isApiErrorMessage || !isBillable(model)) {
      this.skipped += 1;
      return false;
    }

    // A mesma chamada reaparece quando uma sessão é retomada e o transcript é
    // copiado para um arquivo novo. `message.id` + `requestId` identifica a
    // chamada de forma estável entre cópias; o uuid muda em algumas delas.
    const key = (message.id || entry.uuid || '') + '|' + (entry.requestId || '');
    if (key === '|' || !this.remember(key)) return false;

    // Só o total de cache_creation é garantido; a divisão 5 min / 1 hora vem no
    // objeto `cache_creation` e muda o preço (1.25x contra 2x o input).
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const split = usage.cache_creation || null;
    let cacheWrite1h = split ? split.ephemeral_1h_input_tokens || 0 : 0;
    let cacheWrite5m = split ? split.ephemeral_5m_input_tokens || 0 : cacheWrite;
    // Se a divisão não bate com o total, o total manda e a sobra vai para 5 min.
    const splitSum = cacheWrite5m + cacheWrite1h;
    if (splitSum !== cacheWrite) {
      if (splitSum === 0) cacheWrite5m = cacheWrite;
      else if (splitSum < cacheWrite) cacheWrite5m += cacheWrite - splitSum;
      else {
        cacheWrite1h = Math.min(cacheWrite1h, cacheWrite);
        cacheWrite5m = cacheWrite - cacheWrite1h;
      }
    }

    const delta = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheWrite,
      cacheWrite5m,
      cacheWrite1h,
      cacheRead: usage.cache_read_input_tokens || 0,
    };
    const tokens = delta.input + delta.output + delta.cacheWrite + delta.cacheRead;
    if (tokens === 0) return false;
    delta.cost = costOf(model, delta);

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    const projectName = entry.cwd ? path.basename(entry.cwd) : dirName;
    // O campo no transcript é `sessionId`; `session_id` é aceito só por garantia
    // de compatibilidade com transcripts antigos.
    const sessionId = entry.sessionId || entry.session_id || dirName;

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        project: projectName,
        model,
        totals: emptyTotals(),
        firstTs: ts,
        lastTs: ts,
      };
      this.sessions.set(sessionId, session);
    }
    session.model = model;
    session.project = projectName;
    session.lastTs = Math.max(session.lastTs, ts);
    session.firstTs = Math.min(session.firstTs, ts);
    addTotals(session.totals, delta);

    let project = this.projects.get(projectName);
    if (!project) {
      project = { name: projectName, totals: emptyTotals(), sessions: new Set(), lastTs: ts };
      this.projects.set(projectName, project);
    }
    project.sessions.add(sessionId);
    project.lastTs = Math.max(project.lastTs, ts);
    addTotals(project.totals, delta);

    let modelAgg = this.models.get(model);
    if (!modelAgg) {
      modelAgg = { name: model, totals: emptyTotals(), lastTs: ts };
      this.models.set(model, modelAgg);
    }
    modelAgg.lastTs = Math.max(modelAgg.lastTs, ts);
    addTotals(modelAgg.totals, delta);

    addTotals(this.totals, delta);

    const mk = minuteKey(ts);
    const minute = this.minutes.get(mk);
    if (minute) {
      minute.tokens += tokens;
      minute.cost += delta.cost;
    } else {
      this.minutes.set(mk, { tokens, cost: delta.cost });
      this.minuteOrderDirty = true;
    }

    this.recent.push({ ts, model, project: projectName, sessionId, tokens, cost: delta.cost });
    // Mantém as mais recentes por horário — a ordem de leitura dos arquivos não
    // é cronológica, então ordenar aqui evita mostrar chamadas antigas no feed.
    if (this.recent.length > RECENT_MAX * 2) {
      this.recent.sort((a, b) => a.ts - b.ts);
      this.recent = this.recent.slice(-RECENT_MAX);
    }

    const dk = dayKey(ts);
    const day = this.days.get(dk) || { tokens: 0, cost: 0, messages: 0 };
    day.tokens += tokens;
    day.cost += delta.cost;
    day.messages += 1;
    this.days.set(dk, day);

    const mdKey = model + '|' + dk;
    const md =
      this.modelDays.get(mdKey) ||
      { model, date: dk, dayTs: dayStart(ts), tokens: 0, cost: 0, messages: 0 };
    md.tokens += tokens;
    md.cost += delta.cost;
    md.messages += 1;
    this.modelDays.set(mdKey, md);

    return true;
  }

  /** Descarta minutos antigos demais para qualquer janela exibida. */
  prune() {
    const cutoff = Date.now() - MINUTE_RETENTION_MS;
    let removed = false;
    for (const t of this.minutes.keys()) {
      if (t < cutoff) {
        this.minutes.delete(t);
        removed = true;
      }
    }
    if (removed) this.minuteOrderDirty = true;
  }

  /** Chaves de minuto em ordem crescente, recalculadas só quando mudam. */
  sortedMinutes() {
    if (this.minuteOrderDirty) {
      this.minuteOrder = [...this.minutes.keys()].sort((a, b) => a - b);
      this.minuteOrderDirty = false;
    }
    return this.minuteOrder;
  }

  /**
   * Reproduz as janelas que o `/usage` usa: o bloco de `BLOCK_HOURS` horas
   * ancorado na hora cheia da primeira chamada, e a janela dos últimos 7 dias.
   * As porcentagens de limite do plano vêm do servidor e não existem aqui, então
   * só o consumo absoluto é calculado.
   */
  usageWindows(now) {
    const blockStart = this.currentBlockStart(now);
    const block = {
      hours: BLOCK_HOURS,
      tokens: 0,
      cost: 0,
      messages: 0,
      start: blockStart,
      active: blockStart !== null,
    };
    if (blockStart !== null) {
      const end = blockStart + BLOCK_MS;
      for (const [t, m] of this.minutes) {
        if (t >= blockStart && t < end) {
          block.tokens += m.tokens;
          block.cost += m.cost;
        }
      }
      block.resetAt = end;
      block.resetIn = Math.max(0, end - now);
      block.elapsed = Math.min(1, (now - blockStart) / BLOCK_MS);
      // Ritmo do bloco: quanto sairia até o reset mantendo a média até agora.
      const elapsedMin = Math.max(1, (now - blockStart) / 60000);
      block.burnRate = block.tokens / elapsedMin;
      block.projected = block.elapsed > 0 ? block.tokens / block.elapsed : block.tokens;
      block.projectedCost = block.elapsed > 0 ? block.cost / block.elapsed : block.cost;
    } else {
      block.resetAt = null;
      block.resetIn = 0;
      block.elapsed = 0;
      block.burnRate = 0;
      block.projected = 0;
      block.projectedCost = 0;
    }

    // Últimos 7 dias corridos, contando o dia de hoje inteiro.
    const weekStart = dayStart(now) - 6 * DAY_MS;
    const week = { tokens: 0, cost: 0, messages: 0, start: weekStart, byModel: [] };
    const perModel = new Map();
    for (const md of this.modelDays.values()) {
      if (md.dayTs < weekStart) continue;
      week.tokens += md.tokens;
      week.cost += md.cost;
      week.messages += md.messages;
      const agg = perModel.get(md.model) || { name: md.model, tokens: 0, cost: 0, messages: 0 };
      agg.tokens += md.tokens;
      agg.cost += md.cost;
      agg.messages += md.messages;
      perModel.set(md.model, agg);
    }
    week.byModel = [...perModel.values()].sort((a, b) => b.tokens - a.tokens);
    week.resetAt = null;

    return { block, week };
  }

  /**
   * Início do bloco vigente, ancorado na hora cheia — é assim que o servidor
   * conta a janela. Um bloco novo começa quando o anterior completa a duração
   * cheia ou quando esse mesmo tempo passa sem nenhuma chamada.
   * Devolve null quando o último bloco já expirou (nenhum bloco aberto agora).
   */
  currentBlockStart(now) {
    const times = this.sortedMinutes();
    let i = 0;
    while (i < times.length && times[i] <= now - 7 * DAY_MS) i++;
    if (i >= times.length) return null;

    let start = hourFloor(times[i]);
    let prev = times[i];
    for (; i < times.length; i++) {
      const t = times[i];
      if (t - start >= BLOCK_MS || t - prev >= BLOCK_MS) start = hourFloor(t);
      prev = t;
    }
    return now < start + BLOCK_MS ? start : null;
  }

  snapshot() {
    const now = Date.now();

    const sessions = [...this.sessions.values()]
      .map((s) => ({
        id: s.id,
        project: s.project,
        model: s.model,
        totals: { ...s.totals },
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        active: now - s.lastTs < ACTIVE_WINDOW_MS,
      }))
      .sort((a, b) => b.lastTs - a.lastTs);

    const allProjects = [...this.projects.values()]
      .map((p) => ({
        name: p.name,
        totals: { ...p.totals },
        sessions: p.sessions.size,
        lastTs: p.lastTs,
        active: now - p.lastTs < ACTIVE_WINDOW_MS,
      }))
      .sort((a, b) => b.totals.cost - a.totals.cost);
    // Só os 10 projetos de maior custo aparecem na lista.
    const projects = allProjects.slice(0, PROJECT_LIMIT);
    const hiddenProjects = allProjects.slice(PROJECT_LIMIT);
    const othersProjects = hiddenProjects.reduce(
      (acc, p) => {
        acc.count += 1;
        acc.cost += p.totals.cost;
        acc.tokens += p.totals.input + p.totals.output + p.totals.cacheWrite + p.totals.cacheRead;
        return acc;
      },
      { count: 0, cost: 0, tokens: 0 }
    );

    const nowMinute = minuteKey(now);
    const timeline = [];
    const startMinute = nowMinute - (TIMELINE_MINUTES - 1) * 60000;
    for (let t = startMinute; t <= nowMinute; t += 60000) {
      const m = this.minutes.get(t);
      timeline.push({ t, tokens: m ? m.tokens : 0, cost: m ? m.cost : 0 });
    }

    const daily = [];
    for (let i = DAILY_DAYS - 1; i >= 0; i--) {
      const dk = dayKey(now - i * DAY_MS);
      const d = this.days.get(dk);
      daily.push({
        date: dk,
        tokens: d ? d.tokens : 0,
        cost: d ? d.cost : 0,
        messages: d ? d.messages : 0,
      });
    }

    const today = this.days.get(dayKey(now)) || { tokens: 0, cost: 0, messages: 0 };

    // Taxa dos últimos 5 minutos fechados. O minuto corrente fica de fora: ele
    // está pela metade e puxaria a média para baixo a cada segundo.
    const closed = timeline.slice(-6, -1);
    const rate = closed.length ? closed.reduce((a, b) => a + b.tokens, 0) / closed.length : 0;
    // Custo por minuto na mesma janela, para estimar gasto por hora.
    const costRate = closed.length ? closed.reduce((a, b) => a + b.cost, 0) / closed.length : 0;

    return {
      ready: this.ready,
      now,
      // Cópia: os agregados internos continuam sendo mutados a cada leitura.
      totals: { ...this.totals },
      today,
      rate,
      costRate,
      skipped: this.skipped,
      current: sessions.find((s) => s.active) || sessions[0] || null,
      sessions: sessions.slice(0, 30),
      sessionCount: this.sessions.size,
      projects,
      othersProjects,
      recent: [...this.recent].sort((a, b) => b.ts - a.ts).slice(0, 25),
      usage: this.usageWindows(now),
      models: [...this.models.values()]
        .map((m) => ({
          name: m.name,
          totals: { ...m.totals },
          lastTs: m.lastTs,
          active: now - m.lastTs < ACTIVE_WINDOW_MS,
        }))
        .sort((a, b) => b.totals.cost - a.totals.cost),
      timeline,
      daily,
    };
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }
}

module.exports = { TokenWatcher, PROJECTS_DIR };
