'use strict';
const { buildMatrix } = require('./matrix');
const heuristic = require('./heuristic');

/**
 * Otimiza a ordem das paradas de UM entregador, saindo de onde ele está.
 * (A escolha de quais entregas vão para cada entregador é do operador.)
 *
 * @param {object} p
 * @param {{lat:number,lng:number}} p.start  posição atual do entregador
 * @param {{id:number,lat:number,lng:number}[]} p.stops
 * @param {boolean} p.returnToStart  volta ao ponto de partida no fim
 * @param {number} p.serviceSeconds  tempo parado em cada entrega
 */
async function planRoute({ start, stops, returnToStart = false, serviceSeconds = 180 }) {
  if (!stops.length) throw new Error('Nenhuma entrega pendente com localização para este entregador.');

  const matrix = await buildMatrix([start, ...stops]);
  const n = stops.length;

  let seq = null;
  let engine = 'embutido';
  if (process.env.VROOM_URL) {
    try {
      seq = await solveWithVroom({ matrix, n, returnToStart, serviceSeconds });
      engine = 'vroom';
    } catch (e) {
      console.warn(`[optimizer] VROOM indisponível (${e.message}); usando otimizador embutido.`);
    }
  }
  if (!seq) {
    seq = heuristic.solve({ durations: matrix.durations, nJobs: n, returnToDepot: returnToStart }).order;
  }

  let dist = 0;
  let dur = 0;
  let prev = 0;
  const arrivals = [];
  for (const idx of seq) {
    dist += matrix.distances[prev][idx];
    dur += matrix.durations[prev][idx];
    arrivals.push(dur);
    dur += serviceSeconds;
    prev = idx;
  }
  if (returnToStart) {
    dist += matrix.distances[prev][0];
    dur += matrix.durations[prev][0];
  }
  return {
    engine,
    matrixSource: matrix.source,
    stopIds: seq.map((idx) => stops[idx - 1].id),
    arrivals,
    distance_m: dist,
    duration_s: dur,
  };
}

async function solveWithVroom({ matrix, n, returnToStart, serviceSeconds }) {
  const body = {
    vehicles: [{ id: 0, profile: 'car', start_index: 0, ...(returnToStart ? { end_index: 0 } : {}) }],
    jobs: Array.from({ length: n }, (_, i) => ({ id: i + 1, location_index: i + 1, service: serviceSeconds })),
    matrices: { car: { durations: matrix.durations, distances: matrix.distances } },
  };
  const res = await fetch(process.env.VROOM_URL.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const out = await res.json();
  if (out.code !== 0) throw new Error(out.error || `código ${out.code}`);
  const seq = (out.routes?.[0]?.steps || []).filter((s) => s.type === 'job').map((s) => s.job);
  if (seq.length !== n) throw new Error('VROOM não incluiu todas as paradas');
  return seq;
}

module.exports = { planRoute };
