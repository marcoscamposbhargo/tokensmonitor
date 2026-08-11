'use strict';

const { dayKey } = require('./time');

const LEVELS = { ok: 0, warn: 1, over: 2 };

function sumTokens(t) {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

/**
 * A cota do bloco só vale para a duração de janela em que foi calibrada. Com
 * outra duração os blocos passam a ser recortados em outros pontos, e o consumo
 * medido vira outro número — a porcentagem ficaria errada parecendo certa.
 */
function blockCalStale(block, config) {
  return config.blockCostLimit > 0 && config.blockCalHours !== block.hours;
}

/** Descreve os limites possíveis a partir do snapshot e da config. */
function candidates(snapshot, config) {
  // Mesmo dia local que o watcher usa para agregar — em UTC o alerta rearmaria
  // no meio da tarde em vez de na virada do dia.
  const day = dayKey(snapshot.now);
  const cur = snapshot.current;
  const block = snapshot.usage && snapshot.usage.block;
  const week = snapshot.usage && snapshot.usage.week;
  const list = [
    {
      scope: 'dailyTokens',
      unit: 'tokens',
      key: `dayTok:${day}`,
      label: 'Tokens do dia',
      value: snapshot.today.tokens,
      limit: config.dailyTokenLimit,
    },
    {
      scope: 'daily',
      unit: 'usd',
      key: `day:${day}`,
      label: 'Gasto do dia',
      value: snapshot.today.cost,
      limit: config.dailyLimit,
    },
  ];
  if (block && block.active) {
    list.push({
      scope: 'blockCost',
      // Calibrada sob outra duração de janela, a cota não vale mais — vira 0, que
      // é o mesmo que "sem limite", em vez de alertar com um número errado.
      stale: blockCalStale(block, config),
      // Custo é a régua da cota do bloco: já pondera modelo e tipo de token.
      unit: 'usd',
      // A chave carrega o início do bloco: cada bloco novo rearma o alerta.
      key: `block:${block.start}`,
      label: `Cota do bloco de ${block.hours}h`,
      value: block.cost,
      limit: blockCalStale(block, config) ? 0 : config.blockCostLimit,
    });
  }
  if (week) {
    // A chave carrega o início da semana móvel: vira o dia, rearma o alerta.
    list.push(
      {
        scope: 'weekCost',
        unit: 'usd',
        key: `week:${week.start}`,
        label: 'Cota dos 7 dias',
        value: week.cost,
        limit: config.weekCostLimit,
      },
      {
        scope: 'weekFableCost',
        unit: 'usd',
        key: `weekFable:${week.start}`,
        label: 'Cota Fable dos 7 dias',
        value: week.fable ? week.fable.cost : 0,
        limit: config.weekFableCostLimit,
      }
    );
  }
  if (cur) {
    list.push(
      {
        scope: 'sessionTokens',
        unit: 'tokens',
        key: `sessTok:${cur.id}`,
        label: `Tokens da sessão ${cur.project}`,
        value: sumTokens(cur.totals),
        limit: config.sessionTokenLimit,
      },
      {
        scope: 'session',
        unit: 'usd',
        key: `sess:${cur.id}`,
        label: `Gasto da sessão ${cur.project}`,
        value: cur.totals.cost,
        limit: config.sessionLimit,
      }
    );
  }
  return list;
}

/**
 * Decide o nível de alerta (ok / warn / over) para cada limite e devolve
 * apenas as transições novas — cada limite só dispara uma vez por nível.
 */
class AlertTracker {
  constructor() {
    this.fired = new Map(); // key -> nível já disparado
  }

  static level(value, limit, warnAt) {
    if (!limit || limit <= 0) return 'ok';
    if (value >= limit) return 'over';
    if (value >= limit * warnAt) return 'warn';
    return 'ok';
  }

  /** @returns {Array} alertas novos: { scope, unit, key, label, value, limit, level } */
  check(snapshot, config) {
    const out = [];
    for (const c of candidates(snapshot, config)) {
      const level = AlertTracker.level(c.value, c.limit, config.warnAt);
      const prev = this.fired.get(c.key) || 'ok';
      if (LEVELS[level] > LEVELS[prev]) {
        this.fired.set(c.key, level);
        out.push({ ...c, level });
      } else if (LEVELS[level] < LEVELS[prev]) {
        // Limite foi afrouxado nas configurações: rearma o alerta.
        this.fired.set(c.key, level);
      }
    }
    return out;
  }

  reset() {
    this.fired.clear();
  }
}

/** Estado atual (sem memória) para colorir a interface. */
function status(snapshot, config) {
  const out = {};
  for (const c of candidates(snapshot, config)) {
    out[c.scope] = {
      unit: c.unit,
      label: c.label,
      value: c.value,
      limit: c.limit,
      stale: !!c.stale,
      level: AlertTracker.level(c.value, c.limit, config.warnAt),
    };
  }
  // Sessão ou bloco ausente: mantém as chaves para a interface não quebrar.
  for (const k of ['sessionTokens', 'session', 'blockCost', 'weekCost', 'weekFableCost']) {
    if (!out[k]) {
      out[k] = { unit: k === 'sessionTokens' ? 'tokens' : 'usd', value: 0, limit: 0, level: 'ok' };
    }
  }
  return out;
}

module.exports = { AlertTracker, status, blockCalStale };
