'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { solve } = require('../src/routing/heuristic');
const { estimateMatrix } = require('../src/routing/matrix');
const { planRoute } = require('../src/routing/optimizer');

// gerador pseudoaleatório determinístico
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const start = { lat: -23.55, lng: -46.63 };
const randomStops = (n, seed, spread = 0.15) => {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: start.lat + (r() - 0.5) * spread, lng: start.lng + (r() - 0.5) * spread }));
};
const tourCost = (m, order, back) => {
  let c = 0; let prev = 0;
  for (const i of order) { c += m.durations[prev][i]; prev = i; }
  return c + (back ? m.durations[prev][0] : 0);
};

test('cada parada aparece exatamente uma vez', () => {
  const stops = randomStops(60, 1);
  const m = estimateMatrix([start, ...stops]);
  const { order } = solve({ durations: m.durations, nJobs: stops.length });
  assert.deepStrictEqual([...order].sort((a, b) => a - b), stops.map((_, i) => i + 1));
});

test('pontos em linha reta saindo do início são visitados em ordem', () => {
  // entregador parado no começo de uma avenida: deve ir do mais perto ao mais longe
  const line = [5, 1, 4, 2, 3].map((k) => ({ lat: start.lat + k * 0.01, lng: start.lng }));
  const m = estimateMatrix([start, ...line]);
  const { order } = solve({ durations: m.durations, nJobs: line.length, returnToDepot: false });
  assert.deepStrictEqual(order.map((i) => line[i - 1].lat), [...line.map((p) => p.lat)].sort((a, b) => a - b));
});

test('otimizado é bem melhor que a ordem de chegada das mensagens', () => {
  const stops = randomStops(40, 42);
  const m = estimateMatrix([start, ...stops]);
  const naive = tourCost(m, stops.map((_, i) => i + 1), true);
  const { cost } = solve({ durations: m.durations, nJobs: stops.length, returnToDepot: true });
  assert.ok(cost < naive * 0.5, `otimizado ${cost} vs ingênuo ${naive}`);
});

test('fica perto do ótimo em rotas pequenas (comparado com força bruta)', () => {
  const permutations = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
  for (let seed = 1; seed <= 5; seed++) {
    const stops = randomStops(7, seed);
    const m = estimateMatrix([start, ...stops]);
    const best = Math.min(...permutations([1, 2, 3, 4, 5, 6, 7]).map((p) => tourCost(m, p, false)));
    const { cost } = solve({ durations: m.durations, nJobs: 7, returnToDepot: false });
    assert.ok(cost <= best * 1.05, `semente ${seed}: ${cost} vs ótimo ${best}`);
  }
});

test('planRoute() devolve ids, horários e métricas', async () => {
  const stops = randomStops(10, 3);
  const res = await planRoute({ start, stops, serviceSeconds: 120 });
  assert.strictEqual(res.engine, 'embutido');
  assert.deepStrictEqual([...res.stopIds].sort((a, b) => a - b), stops.map((s) => s.id));
  assert.ok(res.distance_m > 0 && res.duration_s > 0);
  for (let i = 1; i < res.arrivals.length; i++) assert.ok(res.arrivals[i] >= res.arrivals[i - 1] + 120);
});

test('planRoute() usa o VROOM quando configurado e cai no embutido se ele falhar', async () => {
  let received;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = JSON.parse(body);
      const steps = received.jobs.map((j) => ({ type: 'job', job: j.id })).reverse();
      res.end(JSON.stringify({ code: 0, routes: [{ vehicle: 0, steps: [{ type: 'start' }, ...steps, { type: 'end' }] }], unassigned: [] }));
    });
  }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const stops = [{ id: 7, lat: -23.5, lng: -46.6 }, { id: 8, lat: -23.51, lng: -46.61 }];
  try {
    process.env.VROOM_URL = `http://127.0.0.1:${srv.address().port}`;
    const res = await planRoute({ start, stops });
    assert.strictEqual(res.engine, 'vroom');
    assert.strictEqual(received.vehicles.length, 1);
    assert.strictEqual(received.vehicles[0].end_index, undefined, 'sem volta ao início por padrão');
    assert.strictEqual(received.matrices.car.durations.length, 3);
    assert.deepStrictEqual(res.stopIds, [8, 7]);

    process.env.VROOM_URL = 'http://127.0.0.1:1';
    assert.strictEqual((await planRoute({ start, stops })).engine, 'embutido');
  } finally {
    delete process.env.VROOM_URL;
    srv.close();
  }
});
