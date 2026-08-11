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
  // Sob qual duração de bloco a cota foi calibrada. Se `BLOCK_HOURS` mudar, a
  // cota antiga deixa de valer: os blocos são encadeados, então outra duração
  // desloca o início de todos eles e o consumo medido vira outro número. Sem
  // esse registro o painel mostraria uma porcentagem errada com cara de certa.
  blockCalHours: 0,
  // Timestamp do INÍCIO de um bloco conhecido, informado a partir do `/usage`.
  // 0 = detectar pelos transcripts.
  //
  // Existe porque a janela do servidor conta uso de outros dispositivos e do
  // claude.ai, que não aparecem nos arquivos locais: quando o bloco abre fora
  // desta máquina, a detecção local começa a contar tarde e o reset sai errado.
  blockAnchor: 0,
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
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Só chaves conhecidas sobrevivem: campos de versões antigas ficariam no
    // arquivo para sempre, sem ninguém lendo.
    cache = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined) cache[k] = saved[k];
    }
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
  if (!(cache.blockCalHours > 0)) cache.blockCalHours = 0;
  if (!(cache.blockAnchor > 0)) cache.blockAnchor = 0;
  // Cota sem calibração não existe: zerar uma zera a outra.
  if (cache.blockCostLimit === 0) cache.blockCalHours = 0;
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
