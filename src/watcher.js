'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { costOf } = require('./pricing');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = 1500;
const TIMELINE_MINUTES = 60;
const DAILY_DAYS = 14;
const PROJECT_LIMIT = 10;
const RECENT_MAX = 60;
const BLOCK_MS = 5 * 60 * 60 * 1000;
// Uma sessão conta como "ativa" se recebeu tokens nos últimos 5 minutos.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function emptyTotals() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, messages: 0 };
}

function addTotals(target, delta) {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheWrite += delta.cacheWrite;
  target.cacheRead += delta.cacheRead;
  target.cost += delta.cost;
  target.messages += 1;
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function minuteKey(ts) {
  return Math.floor(ts / 60000) * 60000;
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
    this.days = new Map(); // dayKey -> { tokens, cost }
    this.seen = new Set(); // requestIds já contabilizados
    this.recent = []; // últimas chamadas lidas, para o feed ao vivo
    this.modelDays = new Map(); // `modelo|AAAA-MM-DD` -> { tokens, cost, messages }
    this.totals = emptyTotals();
    this.timer = null;
    this.scanning = false;
    this.ready = false;
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

  ingest(line, dirName) {
    // Pré-filtro barato: só linhas de assistant com usage importam.
    if (line.length < 40 || line.indexOf('"usage"') === -1) return false;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    const usage = entry.message && entry.message.usage;
    if (!usage) return false;

    const key = entry.requestId || entry.uuid;
    if (!key || this.seen.has(key)) return false;
    this.seen.add(key);

    const delta = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    };
    const model = (entry.message && entry.message.model) || 'unknown';
    delta.cost = costOf(model, delta);

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    const projectName = entry.cwd ? path.basename(entry.cwd) : dirName;
    const sessionId = entry.session_id || dirName;

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

    const tokens = delta.input + delta.output + delta.cacheWrite + delta.cacheRead;
    const mk = minuteKey(ts);
    const minute = this.minutes.get(mk) || { tokens: 0, cost: 0 };
    minute.tokens += tokens;
    minute.cost += delta.cost;
    this.minutes.set(mk, minute);

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
    const md = this.modelDays.get(mdKey) || { model, date: dk, tokens: 0, cost: 0, messages: 0 };
    md.tokens += tokens;
    md.cost += delta.cost;
    md.messages += 1;
    this.modelDays.set(mdKey, md);

    return true;
  }

  /**
   * Reproduz as janelas que o `/usage` usa: um bloco de 5 horas que começa na
   * primeira chamada após um intervalo ocioso, e a janela semanal de 7 dias.
   * As porcentagens de limite do plano vêm do servidor e não existem aqui, então
   * só o consumo absoluto é calculado.
   */
  usageWindows(now) {
    const blockStart = this.currentBlockStart(now);
    const block = { tokens: 0, cost: 0, start: blockStart, active: blockStart !== null };
    if (blockStart !== null) {
      for (const [t, m] of this.minutes) {
        if (t >= blockStart && t < blockStart + BLOCK_MS) {
          block.tokens += m.tokens;
          block.cost += m.cost;
        }
      }
      block.resetAt = blockStart + BLOCK_MS;
      block.resetIn = Math.max(0, block.resetAt - now);
      block.elapsed = Math.min(1, (now - blockStart) / BLOCK_MS);
    } else {
      block.resetAt = null;
      block.resetIn = 0;
      block.elapsed = 0;
    }

    const weekStart = now - 7 * 86400000;
    const week = { tokens: 0, cost: 0, byModel: [] };
    const perModel = new Map();
    for (const md of this.modelDays.values()) {
      const dayTs = Date.parse(md.date + 'T00:00:00');
      if (dayTs < weekStart - 86400000) continue;
      week.tokens += md.tokens;
      week.cost += md.cost;
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
   * Início do bloco de 5h vigente. Um bloco começa na primeira atividade e dura
   * 5 horas fixas; a atividade seguinte ao fim dele abre um bloco novo.
   * Devolve null quando o último bloco já expirou (nenhum bloco aberto agora).
   */
  currentBlockStart(now) {
    const times = [...this.minutes.keys()]
      .filter((t) => t > now - 7 * 86400000)
      .sort((a, b) => a - b);
    if (times.length === 0) return null;

    let start = times[0];
    for (const t of times) {
      if (t >= start + BLOCK_MS) start = t;
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

    const timeline = [];
    const startMinute = minuteKey(now) - (TIMELINE_MINUTES - 1) * 60000;
    for (let t = startMinute; t <= minuteKey(now); t += 60000) {
      const m = this.minutes.get(t);
      timeline.push({ t, tokens: m ? m.tokens : 0, cost: m ? m.cost : 0 });
    }

    const daily = [];
    for (let i = DAILY_DAYS - 1; i >= 0; i--) {
      const dk = dayKey(now - i * 86400000);
      const d = this.days.get(dk);
      daily.push({
        date: dk,
        tokens: d ? d.tokens : 0,
        cost: d ? d.cost : 0,
        messages: d ? d.messages : 0,
      });
    }

    const today = this.days.get(dayKey(now)) || { tokens: 0, cost: 0 };

    // Taxa dos últimos 5 minutos, em tokens/min.
    const recent = timeline.slice(-5);
    const rate = recent.reduce((a, b) => a + b.tokens, 0) / recent.length;

    return {
      ready: this.ready,
      now,
      // Cópia: os agregados internos continuam sendo mutados a cada leitura.
      totals: { ...this.totals },
      today,
      rate,
      current: sessions.find((s) => s.active) || sessions[0] || null,
      sessions: sessions.slice(0, 30),
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
