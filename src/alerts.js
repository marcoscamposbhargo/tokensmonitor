'use strict';

const LEVELS = { ok: 0, warn: 1, over: 2 };

function sumTokens(t) {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

/** Descreve os quatro limites possíveis a partir do snapshot e da config. */
function candidates(snapshot, config) {
  const day = new Date(snapshot.now).toISOString().slice(0, 10);
  const cur = snapshot.current;
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
      level: AlertTracker.level(c.value, c.limit, config.warnAt),
    };
  }
  // Sessão ausente: mantém as chaves para a interface não quebrar.
  for (const k of ['sessionTokens', 'session']) {
    if (!out[k]) out[k] = { unit: k === 'session' ? 'usd' : 'tokens', value: 0, limit: 0, level: 'ok' };
  }
  return out;
}

module.exports = { AlertTracker, status };
