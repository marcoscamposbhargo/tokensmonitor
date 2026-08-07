'use strict';

// Preços em USD por milhão de tokens (MTok).
// Ajuste aqui se a tabela oficial mudar.
const TABLE = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
  fable: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

const DEFAULT = TABLE.sonnet;

function ratesFor(model) {
  if (!model) return DEFAULT;
  const m = String(model).toLowerCase();
  if (m.includes('opus')) return TABLE.opus;
  if (m.includes('haiku')) return TABLE.haiku;
  if (m.includes('fable')) return TABLE.fable;
  if (m.includes('sonnet')) return TABLE.sonnet;
  return DEFAULT;
}

// usage: { input, output, cacheWrite, cacheRead }
function costOf(model, usage) {
  const r = ratesFor(model);
  return (
    (usage.input * r.input +
      usage.output * r.output +
      usage.cacheWrite * r.cacheWrite +
      usage.cacheRead * r.cacheRead) /
    1e6
  );
}

module.exports = { TABLE, ratesFor, costOf };
