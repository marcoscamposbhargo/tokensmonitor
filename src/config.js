'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Limites em USD. 0 desliga o limite — padrão desligado, porque o custo é
  // estimativa de preço de tabela da API e não reflete plano de assinatura.
  dailyLimit: 0,
  sessionLimit: 0,
  // Limites em tokens (soma de input + output + cache). 0 desliga.
  dailyTokenLimit: 0,
  sessionTokenLimit: 0,
  // Cota de um bloco, medida em custo estimado (USD). O limite do plano não
  // existe em arquivo nenhum: é deduzido comparando o consumo do bloco atual com
  // a porcentagem que o `/usage` mostra (ver calibração no renderer).
  //
  // A régua é o custo, e não a contagem de tokens, porque a cota do plano é
  // ponderada por modelo — um token de Opus pesa 5x um de Haiku. Como o custo já
  // embute esse peso, trocar de modelo no meio do bloco se corrige sozinho e a
  // calibração continua valendo.
  blockCostLimit: 0,
  // Mesma ideia para as janelas semanais que o `/usage` reporta: a geral e a do
  // Fable, que tem cota própria.
  weekCostLimit: 0,
  weekFableCostLimit: 0,
  // Fração do limite que dispara o aviso amarelo.
  warnAt: 0.8,
  notify: true,
  sound: true,
};

let filePath = null;
let cache = { ...DEFAULTS };

function init(userDataDir) {
  filePath = path.join(userDataDir, 'config.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get() {
  return { ...cache };
}

function set(patch) {
  cache = { ...cache, ...patch };
  if (cache.warnAt < 0.1) cache.warnAt = 0.1;
  if (cache.warnAt > 1) cache.warnAt = 1;
  const limits = [
    'dailyLimit',
    'sessionLimit',
    'dailyTokenLimit',
    'sessionTokenLimit',
    'blockCostLimit',
    'weekCostLimit',
    'weekFableCostLimit',
  ];
  for (const k of limits) {
    if (!(cache[k] > 0)) cache[k] = 0;
  }
  if (filePath) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
    } catch {
      // Config é conveniência: falha de escrita não derruba o monitor.
    }
  }
  return get();
}

module.exports = { init, get, set, DEFAULTS };
