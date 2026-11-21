'use strict';
process.env.GEOCODING = 'off';
delete process.env.OSRM_URL;
delete process.env.VROOM_URL;

const test = require('node:test');
const assert = require('node:assert');
const { aggregate } = require('../src/reports');
const { haversine } = require('../src/routing/matrix');
const { createApp } = require('../src/server');
const { createTestDb } = require('./helpers');

const at = (hhmm, date = '2026-11-20') => new Date(`${date}T${hhmm}:00-03:00`).toISOString();

test('agregação: contagens, km, pontualidade e pino errado (conta feita à mão)', () => {
  const start = { lat: -15.80, lng: -47.90 };
  const p1 = { lat: -15.81, lng: -47.90 };
  const p2 = { lat: -15.82, lng: -47.90 };
  const routes = [
    { route_id: 1, driver_id: 10, date: '2026-11-20', distance_m: 5400, start_lat: start.lat, start_lng: start.lng },
    { route_id: 2, driver_id: 10, date: '2026-11-21', distance_m: 3000, start_lat: start.lat, start_lng: start.lng },
    { route_id: 3, driver_id: 20, date: '2026-11-20', distance_m: 1000, start_lat: start.lat, start_lng: start.lng },
  ];
  const stops = [
    // dia 20, entregador 10: no horário, com GPS no pino
    { route_id: 1, status: 'entregue', ...p1, eta: at('09:00'), completed_at: at('09:10'), gps_lat: p1.lat, gps_lng: p1.lng, gps_at: at('09:10') },
    // atrasada 40 min e marcada a ~1,1 km do pino (pino errado)
    { route_id: 1, status: 'entregue', lat: -15.83, lng: -47.90, eta: at('09:30'), completed_at: at('10:10'), gps_lat: p2.lat, gps_lng: p2.lng, gps_at: at('10:10') },
    // falhou, sem GPS
    { route_id: 1, status: 'falhou', ...p2, eta: at('10:00'), completed_at: at('10:30'), gps_lat: null },
    // dia 21: uma pendente
    { route_id: 2, status: 'pendente', ...p1, eta: at('09:00', '2026-11-21'), completed_at: null, gps_lat: null },
    // entregador 20: entregue sem previsão
    { route_id: 3, status: 'entregue', ...p1, eta: null, completed_at: at('11:00'), gps_lat: null },
  ];
  const r = aggregate({ routes, stops, drivers: [{ id: 10, name: 'Carlos' }, { id: 20, name: 'Bia', archived: true }] });

  const carlos = r.drivers.find((d) => d.driver_id === 10);
  assert.strictEqual(carlos.days, 2);
  assert.deepStrictEqual([carlos.deliveries, carlos.delivered, carlos.failed, carlos.pending], [4, 2, 1, 1]);
  assert.strictEqual(carlos.success_rate, 2 / 3);
  assert.strictEqual(carlos.km_planned, 8.4);
  const expectedGps = (haversine(start, p1) + haversine(p1, p2)) * 1.35 / 1000;
  assert.strictEqual(carlos.km_gps, Math.round(expectedGps * 10) / 10);
  assert.strictEqual(carlos.gps_coverage, 2 / 3);
  assert.deepStrictEqual([carlos.with_eta, carlos.on_time, carlos.late, carlos.avg_delay_min], [2, 1, 1, 40]);
  assert.strictEqual(carlos.on_time_rate, 0.5);
  assert.strictEqual(carlos.far_from_pin, 1);

  const bia = r.drivers.find((d) => d.driver_id === 20);
  assert.strictEqual(bia.archived, true);
  assert.strictEqual(bia.on_time_rate, null, 'sem previsão não entra na pontualidade');
  assert.strictEqual(bia.km_gps, 0);

  assert.strictEqual(r.totals.deliveries, 5);
  assert.strictEqual(r.totals.km_planned, 9.4);
  assert.strictEqual(r.daily.length, 3);
  assert.deepStrictEqual(r.daily.map((d) => d.date), ['2026-11-20', '2026-11-20', '2026-11-21']);
});

test('relatório pela API: plano do operador é a referência, GPS e período', async () => {
  const db = await createTestDb();
  const server = createApp({ db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, { method = 'GET', body, auth = true } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('/api/auth/register', { method: 'POST', body: { org_name: 'Loja', email: 'r@r.com', password: '12345678' } });
    await call('/api/settings', { method: 'PUT', body: { timezone: 'America/Cuiaba' } });
    const carlos = (await call('/api/drivers', { method: 'POST', body: { name: 'Carlos' } })).data;
    await call(`/api/drivers/${carlos.id}`, { method: 'PUT', body: { start_lat: -15.60, start_lng: -56.10 } });
    const DATE = '2026-11-20';
    await call('/api/deliveries/bulk', { method: 'POST', body: { date: DATE, driver_id: carlos.id, text: 'A -15.61, -56.10\nB -15.62, -56.10\nC -15.63, -56.10' } });
    const plan = (await call('/api/routes/plan', { method: 'POST', body: { date: DATE } })).data;
    const route = plan.routes[0];
    const page = (await call(`/api/driver/${route.token}`, { auth: false })).data;
    const [s1, s2] = page.stops;
    await call(`/api/driver/${route.token}/stops/${s1.id}`, { method: 'POST', auth: false, body: { status: 'entregue', lat: s1.lat, lng: s1.lng } });
    // entregador recalcula: a versão nova é menor, mas o km planejado do dia continua o do operador
    await call(`/api/driver/${route.token}/start`, { method: 'POST', auth: false, body: { lat: -15.612, lng: -56.10 } });
    await call(`/api/driver/${route.token}/stops/${s2.id}`, { method: 'POST', auth: false, body: { status: 'falhou', notes: 'ausente' } });

    let r = await call(`/api/reports/drivers?from=${DATE}&to=${DATE}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const row = r.data.drivers[0];
    assert.strictEqual(row.name, 'Carlos');
    assert.deepStrictEqual([row.deliveries, row.delivered, row.failed, row.pending], [3, 1, 1, 1]);
    assert.strictEqual(row.km_planned, Math.round(route.distance_m / 100) / 10, 'km do plano do operador');
    assert.strictEqual(row.gps_marked, 1);
    assert.strictEqual(row.gps_coverage, 0.5);
    assert.ok(row.km_gps > 0);
    assert.strictEqual(r.data.daily.length, 1);

    r = await call('/api/reports/drivers?from=2026-11-21&to=2026-11-25');
    assert.strictEqual(r.data.drivers.length, 0, 'fora do período não aparece');
    assert.strictEqual((await call('/api/reports/drivers?from=2026-12-01&to=2026-11-01')).status, 400);
    assert.strictEqual((await call('/api/reports/drivers?from=2024-01-01&to=2026-01-01')).status, 400);
    r = await call('/api/reports/drivers');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.from <= r.data.to, 'padrão: últimos 7 dias');
    assert.strictEqual((await call('/api/reports/drivers', { auth: false })).status, 401);
  } finally {
    server.close();
    await db.drop();
  }
});

test('longe do pino: lista, corrige pelo GPS e o cliente passa a usar o local certo', async () => {
  const db = await createTestDb();
  const server = createApp({ db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = { a: '', b: '' };
  const call = async (path, { method = 'GET', body, as = 'a' } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(as ? { cookie: jar[as] } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set && as) jar[as] = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('/api/auth/register', { method: 'POST', body: { org_name: 'Loja', email: 'p@p.com', password: '12345678' } });
    await call('/api/settings', { method: 'PUT', body: { depot_lat: -16.68, depot_lng: -49.25 } });
    const drv = (await call('/api/drivers', { method: 'POST', body: { name: 'Carlos' } })).data;
    const DATE = '2026-11-20';
    const wrongPin = { lat: -16.700, lng: -49.250 };
    const realDoor = { lat: -16.704, lng: -49.250 }; // ~445 m ao sul
    const mk = (body) => call('/api/deliveries', { method: 'POST', body: { date: DATE, driver_id: drv.id, ...body } });
    const ana = (await mk({ customer_name: 'Ana', phone: '62999990001', ...wrongPin })).data.delivery;
    const beto = (await mk({ customer_name: 'Beto', phone: '62999990002', lat: -16.69, lng: -49.24 })).data.delivery;
    const caio = (await mk({ customer_name: 'Caio', phone: '62999990003', lat: -16.71, lng: -49.26 })).data.delivery;
    // pedido futuro da Ana já criado com o pino errado (deve ser corrigido junto)
    const anaTomorrow = (await call('/api/deliveries', { method: 'POST', body: { date: '2026-11-22', customer_name: 'Ana', phone: '62999990001', ...wrongPin } })).data.delivery;

    const route = (await call('/api/routes/plan', { method: 'POST', body: { date: DATE } })).data.routes[0];
    const mark = (id, body) => call(`/api/driver/${route.token}/stops/${id}`, { method: 'POST', as: '', body });
    await mark(ana.id, { status: 'entregue', ...realDoor });                       // longe
    await mark(beto.id, { status: 'entregue', lat: -16.6901, lng: -49.2401 });     // perto
    await mark(caio.id, { status: 'entregue', lat: -16.72, lng: -49.26 });         // longe (~1,1 km)

    let far = (await call(`/api/reports/far-from-pin?from=${DATE}&to=${DATE}`)).data;
    assert.deepStrictEqual(far.items.map((i) => i.customer_name).sort(), ['Ana', 'Caio']);
    const itemAna = far.items.find((i) => i.delivery_id === ana.id);
    assert.ok(itemAna.distance_m > 400 && itemAna.distance_m < 500, `distância ${itemAna.distance_m}`);
    assert.strictEqual(itemAna.review, null);
    assert.strictEqual(far.pending, 2);
    const rep = (await call(`/api/reports/drivers?from=${DATE}&to=${DATE}`)).data;
    assert.strictEqual(rep.totals.far_from_pin, 2, 'mesmo número do relatório');

    // Ana: usar o GPS do entregador
    let r = await call(`/api/deliveries/${ana.id}/pin-review`, { method: 'POST', body: { decision: 'gps' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.updated_pending, 1, 'pedido futuro corrigido junto');
    const fixedTomorrow = (await call('/api/deliveries?date=2026-11-22')).data.find((d) => d.id === anaTomorrow.id);
    assert.deepStrictEqual([fixedTomorrow.lat, fixedTomorrow.lng], [realDoor.lat, realDoor.lng]);
    const histAna = await db.one('SELECT lat, lng FROM deliveries WHERE id = $1', [ana.id]);
    assert.deepStrictEqual([histAna.lat, histAna.lng], [wrongPin.lat, wrongPin.lng], 'histórico não muda');
    // próximo pedido da Ana sem local: usa o corrigido
    const next = (await call('/api/deliveries', { method: 'POST', body: { date: '2026-11-25', customer_name: 'Ana', phone: '(62) 99999-0001' } })).data;
    assert.strictEqual(next.recurring, true);
    assert.deepStrictEqual([next.delivery.lat, next.delivery.lng], [realDoor.lat, realDoor.lng]);

    // Caio: o pino estava certo (entregador marcou de longe)
    r = await call(`/api/deliveries/${caio.id}/pin-review`, { method: 'POST', body: { decision: 'ok' } });
    assert.strictEqual(r.status, 200);
    far = (await call(`/api/reports/far-from-pin?from=${DATE}&to=${DATE}`)).data;
    assert.strictEqual(far.pending, 0);
    assert.deepStrictEqual(far.items.map((i) => i.review).sort(), ['gps', 'ok']);
    const caioNext = (await call('/api/deliveries', { method: 'POST', body: { date: '2026-11-25', customer_name: 'Caio', phone: '62999990003' } })).data;
    assert.deepStrictEqual([caioNext.delivery.lat, caioNext.delivery.lng], [-16.71, -49.26], 'pino original mantido');

    // validações e isolamento
    assert.strictEqual((await call(`/api/deliveries/${beto.id}/pin-review`, { method: 'POST', body: { decision: 'mapa' } })).status, 400);
    assert.strictEqual((await call(`/api/deliveries/${beto.id}/pin-review`, { method: 'POST', body: { decision: 'xpto' } })).status, 400);
    assert.strictEqual((await call(`/api/deliveries/${anaTomorrow.id}/pin-review`, { method: 'POST', body: { decision: 'ok' } })).status, 400, 'pendente não se revisa');
    await call('/api/auth/register', { method: 'POST', as: 'b', body: { org_name: 'Outra', email: 'o@o.com', password: '12345678' } });
    assert.strictEqual((await call(`/api/deliveries/${caio.id}/pin-review`, { method: 'POST', as: 'b', body: { decision: 'ok' } })).status, 404);
    assert.strictEqual((await call(`/api/reports/far-from-pin?from=${DATE}&to=${DATE}`, { as: 'b' })).data.items.length, 0);
  } finally {
    server.close();
    await db.drop();
  }
});

test('local verificado mais recente vence: correção do operador depois da confirmação do cliente', async () => {
  const db = await createTestDb();
  const D = require('../src/domain');
  try {
    const org = await db.one(`INSERT INTO organizations (name) VALUES ('X') RETURNING id`);
    const c = await db.one(`INSERT INTO customers (org_id, name) VALUES ($1, 'Y') RETURNING id`, [org.id]);
    await D.savePlace(db, org.id, c.id, { lat: -16.70, lng: -49.25, confirmed: true, verifiedBy: 'cliente' });
    await D.savePlace(db, org.id, c.id, { lat: -16.60, lng: -49.20 }); // só usado, não verificado
    assert.strictEqual((await D.lastPlace(db, c.id)).lat, -16.70, 'verificado vence o apenas usado');
    await D.savePlace(db, org.id, c.id, { lat: -16.704, lng: -49.25, verifiedBy: 'operador' });
    const p = await D.lastPlace(db, c.id);
    assert.deepStrictEqual([p.lat, p.verified_by], [-16.704, 'operador']);
  } finally {
    await db.drop();
  }
});
