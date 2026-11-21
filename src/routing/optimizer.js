'use strict';
const { buildMatrix } = require('./matrix');
const heuristic = require('./heuristic');

/**
 * Planeja as rotas do dia.
 * @param {object} p
 * @param {{lat:number,lng:number}} p.depot
 * @param {{id:number,lat:number,lng:number}[]} p.stops
 * @param {{id:number,max_stops?:number}[]} p.drivers
 * @param {boolean} p.balance  distribuir as paradas de forma equilibrada entre os entregadores
 * @param {boolean} p.returnToDepot
 * @param {number} p.serviceSeconds  tempo parado em cada entrega
 */
async function plan({ depot, stops, drivers, balance = true, returnToDepot = true, serviceSeconds = 180 }) {
  if (!drivers.length) throw new Error('Selecione pelo menos um entregador.');
  if (!stops.length) throw new Error('Não há entregas pendentes com localização para esta data.');

  const points = [depot, ...stops];
  const matrix = await buildMatrix(points);

  const n = stops.length;
  const fair = Math.ceil(n / Math.min(drivers.length, n));
  // Modo equilibrado: cada entregador fica entre 75% e 125% da divisão igual,
  // folga que ainda deixa o otimizador agrupar as paradas por região.
  const vehicles = drivers.map((d) => {
    let cap = d.max_stops > 0 ? d.max_stops : Infinity;
    let min = 0;
    if (balance) {
      cap = Math.min(cap, Math.max(1, Math.ceil(fair * 1.25)));
      min = Math.min(cap, Math.floor(fair * 0.75));
    }
    return { id: d.id, capacity: cap, min };
  });

  let result = null;
  let engine = 'embutido';
  if (process.env.VROOM_URL) {
    try {
      result = await solveWithVroom({ matrix, vehicles, n, returnToDepot, serviceSeconds });
      // o VROOM não tem "mínimo de paradas": se deixou alguém abaixo, refaz com divisão igual
      if (balance && result.routes.some((r, k) => r.length < vehicles[k].min)) {
        const tight = vehicles.map((v) => ({ ...v, capacity: Math.min(v.capacity, fair) }));
        const retry = await solveWithVroom({ matrix, vehicles: tight, n, returnToDepot, serviceSeconds });
        if (!retry.routes.some((r, k) => r.length < vehicles[k].min)) result = retry;
        else result = null; // deixa o embutido, que garante o mínimo
      }
      if (result) engine = 'vroom';
    } catch (e) {
      console.warn(`[optimizer] VROOM indisponível (${e.message}); usando otimizador embutido.`);
    }
  }
  if (!result) {
    result = heuristic.solve({ durations: matrix.durations, nJobs: n, vehicles, returnToDepot });
  }

  const routes = vehicles.map((v, k) => {
    const seq = result.routes[k];
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
    if (returnToDepot && seq.length) {
      dist += matrix.distances[prev][0];
      dur += matrix.durations[prev][0];
    }
    return {
      driverId: v.id,
      stopIds: seq.map((idx) => stops[idx - 1].id),
      arrivals,
      distance_m: dist,
      duration_s: dur,
    };
  });

  return {
    engine,
    matrixSource: matrix.source,
    routes,
    unassigned: result.unassigned.map((idx) => stops[idx - 1].id),
  };
}

async function solveWithVroom({ matrix, vehicles, n, returnToDepot, serviceSeconds }) {
  const body = {
    vehicles: vehicles.map((v, k) => ({
      id: k,
      profile: 'car',
      start_index: 0,
      ...(returnToDepot ? { end_index: 0 } : {}),
      ...(Number.isFinite(v.capacity) ? { capacity: [v.capacity] } : {}),
    })),
    jobs: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      location_index: i + 1,
      service: serviceSeconds,
      delivery: [1],
    })),
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
  const routes = vehicles.map(() => []);
  for (const r of out.routes || []) {
    routes[r.vehicle] = r.steps.filter((s) => s.type === 'job').map((s) => s.job);
  }
  return { routes, unassigned: (out.unassigned || []).map((u) => u.id) };
}

module.exports = { plan };
