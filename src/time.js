'use strict';

// Chaves de tempo compartilhadas. Ficam em um módulo próprio porque o watcher e
// o alerts precisam concordar sobre onde o dia começa — usar UTC em um e horário
// local no outro faz o alerta de "gasto do dia" rearmar na hora errada.

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** AAAA-MM-DD no fuso local. */
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Timestamp do início do minuto. */
function minuteKey(ts) {
  return Math.floor(ts / 60000) * 60000;
}

/** Timestamp do início da hora, em UTC — é assim que a janela de 5h é ancorada. */
function hourFloor(ts) {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

/** Meia-noite local do dia de `ts`. */
function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = { dayKey, minuteKey, hourFloor, dayStart, HOUR_MS, DAY_MS };
