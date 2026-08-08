'use strict';

// Preços em USD por milhão de tokens (MTok).
//
// Só `input` e `output` são tabelados: as taxas de cache são múltiplos fixos do
// preço de input em toda a linha Claude, então derivá-las evita a tabela ficar
// inconsistente quando um preço for atualizado à mão.
//
//   cache write 5 min  = 1.25 x input
//   cache write 1 hora = 2.00 x input
//   cache read         = 0.10 x input
const CACHE_5M = 1.25;
const CACHE_1H = 2.0;
const CACHE_READ = 0.1;

// A ordem importa: o primeiro `match` que casar vence, então as regras mais
// específicas (família + versão) vêm antes das genéricas por família.
const TABLE = [
  // Opus 4, 4.1 e 3 ficaram na faixa antiga; de Opus 4.5 em diante o preço caiu.
  { id: 'opus-legacy', match: /opus-4-\d{8}|opus-4-1|opus-4$|opus-3/, input: 15, output: 75 },
  { id: 'opus', match: /opus/, input: 5, output: 25 },
  { id: 'sonnet', match: /sonnet/, input: 3, output: 15 },
  { id: 'fable', match: /fable/, input: 3, output: 15 },
  { id: 'haiku-legacy', match: /3[-_.]5[-_.]haiku|haiku[-_.]3|3[-_.]haiku/, input: 0.8, output: 4 },
  { id: 'haiku', match: /haiku/, input: 1, output: 5 },
];

const DEFAULT = TABLE.find((t) => t.id === 'sonnet');

/** Modelos sem preço de API: entradas locais do próprio Claude Code. */
const NON_BILLABLE = /^(<synthetic>|unknown|)$/i;

function isBillable(model) {
  return !NON_BILLABLE.test(String(model || '').trim());
}

function ratesFor(model) {
  if (!model) return DEFAULT;
  const m = String(model).toLowerCase();
  return TABLE.find((t) => t.match.test(m)) || DEFAULT;
}

/**
 * Custo de uma chamada.
 * @param {string} model
 * @param {{input:number, output:number, cacheWrite5m:number, cacheWrite1h:number, cacheRead:number}} u
 */
function costOf(model, u) {
  const r = ratesFor(model);
  const write5m = u.cacheWrite5m || 0;
  const write1h = u.cacheWrite1h || 0;
  return (
    ((u.input || 0) * r.input +
      (u.output || 0) * r.output +
      write5m * r.input * CACHE_5M +
      write1h * r.input * CACHE_1H +
      (u.cacheRead || 0) * r.input * CACHE_READ) /
    1e6
  );
}

module.exports = { TABLE, ratesFor, costOf, isBillable, CACHE_5M, CACHE_1H, CACHE_READ };
