'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { solve } = require('../src/routing/heuristic');
const { estimateMatrix } = require('../src/routing/matrix');
const { plan } = require('../src/routing/optimizer');

// gerador pseudoaleatório determinístico
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function clusters(depot, centers, perCluster, spread, seed = 1) {
  const r = rng(seed);
  const pts = [];
  for (const c of centers) {
    for (let i = 0; i < perCluster; i++) pts.push({ lat: c.lat + (r() - 0.5) * spread, lng: c.lng + (r() - 0.5) * spread });
  }
  return pts;
}

const depot = { lat: -23.55, lng: -46.63 };

test('cada parada aparece exatamente uma vez', () => {
  const stops = clusters(depot, [{ lat: -23.50, lng: -46.60 }, { lat: -23.60, lng: -46.70 }], 15, 0.03);
  const m = estimateMatrix([depot, ...stops]);
  const vehicles = [{ capacity: 20 }, { capacity: 20 }, { capacity: 20 }];
  const { routes, unassigned } = solve({ durations: m.durations, nJobs: stops.length, vehicles });
  const all = routes.flat().sort((a, b) => a - b);
  assert.deepStrictEqual(all, Array.from({ length: stops.length }, (_, i) => i + 1));
  assert.strictEqual(unassigned.length, 0);
  routes.forEach((r) => assert.ok(r.length <= 20));
});

test('respeita a capacidade e reporta o que não coube', () => {
  const stops = clusters(depot, [{ lat: -23.5, lng: -46.6 }], 10, 0.02);
  const m = estimateMatrix([depot, ...stops]);
  const { routes, unassigned } = solve({ durations: m.durations, nJobs: 10, vehicles: [{ capacity: 3 }, { capacity: 4 }] });
  assert.strictEqual(routes[0].length + routes[1].length, 7);
  assert.strictEqual(unassigned.length, 3);
});

test('separa regiões distantes entre entregadores', () => {
  const north = { lat: -23.40, lng: -46.63 };
  const south = { lat: -23.70, lng: -46.63 };
  const stops = clusters(depot, [north, south], 8, 0.02, 7);
  const m = estimateMatrix([depot, ...stops]);
  const { routes } = solve({ durations: m.durations, nJobs: stops.length, vehicles: [{ capacity: 10 }, { capacity: 10 }] });
  for (const r of routes) {
    const isNorth = r.map((idx) => stops[idx - 1].lat > depot.lat);
    assert.ok(isNorth.every((x) => x === isNorth[0]), 'uma rota misturou norte e sul');
  }
});

test('otimizado é bem melhor que a ordem de chegada', () => {
  const r = rng(42);
  const stops = Array.from({ length: 40 }, () => ({ lat: depot.lat + (r() - 0.5) * 0.15, lng: depot.lng + (r() - 0.5) * 0.15 }));
  const m = estimateMatrix([depot, ...stops]);
  const naive = (() => {
    let c = 0; let prev = 0;
    for (let i = 1; i <= stops.length; i++) { c += m.durations[prev][i]; prev = i; }
    return c + m.durations[prev][0];
  })();
  const { cost } = solve({ durations: m.durations, nJobs: stops.length, vehicles: [{ capacity: Infinity }] });
  assert.ok(cost < naive * 0.5, `otimizado ${cost} vs ingênuo ${naive}`);
});

test('plan() devolve ids, horários e métricas por entregador', async () => {
  const stops = clusters(depot, [{ lat: -23.5, lng: -46.6 }, { lat: -23.6, lng: -46.7 }], 5, 0.02)
    .map((p, i) => ({ id: 100 + i, ...p }));
  const res = await plan({ depot, stops, drivers: [{ id: 1 }, { id: 2 }], serviceSeconds: 120 });
  assert.strictEqual(res.engine, 'embutido');
  assert.strictEqual(res.routes.length, 2);
  const ids = res.routes.flatMap((r) => r.stopIds).sort();
  assert.deepStrictEqual(ids, stops.map((s) => s.id).sort());
  for (const r of res.routes) {
    assert.ok(r.distance_m > 0 && r.duration_s > 0);
    assert.strictEqual(r.arrivals.length, r.stopIds.length);
    for (let i = 1; i < r.arrivals.length; i++) assert.ok(r.arrivals[i] >= r.arrivals[i - 1] + 120);
  }
});

test('plan() usa o VROOM quando configurado (formato da API) e cai no embutido se ele falhar', async () => {
  const http = require('node:http');
  let received;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = JSON.parse(body);
      // devolve todas as paradas no veículo 1, em ordem inversa
      const steps = received.jobs.map((j) => ({ type: 'job', job: j.id })).reverse();
      res.end(JSON.stringify({ code: 0, routes: [{ vehicle: 1, steps: [{ type: 'start' }, ...steps, { type: 'end' }] }], unassigned: [] }));
    });
  }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const stops = [{ id: 7, lat: -23.5, lng: -46.6 }, { id: 8, lat: -23.51, lng: -46.61 }];
  try {
    process.env.VROOM_URL = `http://127.0.0.1:${srv.address().port}`;
    const res = await plan({ depot, stops, drivers: [{ id: 1, max_stops: 5 }, { id: 2 }], balance: false });
    assert.strictEqual(res.engine, 'vroom');
    assert.deepStrictEqual(received.vehicles.map((v) => v.capacity), [[5], undefined]);
    assert.strictEqual(received.matrices.car.durations.length, 3);
    assert.deepStrictEqual(res.routes[0].stopIds, []);
    assert.deepStrictEqual(res.routes[1].stopIds, [8, 7]);

    process.env.VROOM_URL = 'http://127.0.0.1:1';
    const fallback = await plan({ depot, stops, drivers: [{ id: 1 }] });
    assert.strictEqual(fallback.engine, 'embutido');
  } finally {
    delete process.env.VROOM_URL;
    srv.close();
  }
});

test('modo equilibrado: nenhum entregador fica sem paradas', async () => {
  const r = rng(5);
  const stops = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, lat: depot.lat + (r() - 0.5) * 0.2, lng: depot.lng + (r() - 0.5) * 0.2 }));
  const drivers = [1, 2, 3, 4, 5].map((id) => ({ id }));
  const res = await plan({ depot, stops, drivers, balance: true });
  for (const route of res.routes) {
    assert.ok(route.stopIds.length >= 22 && route.stopIds.length <= 38, `rota com ${route.stopIds.length} paradas`);
  }
  assert.strictEqual(res.routes.reduce((s, x) => s + x.stopIds.length, 0), 150);
});
