'use strict';
process.env.GEOCODING = 'off';
delete process.env.OSRM_URL;
delete process.env.VROOM_URL;

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { open } = require('../src/db');

let server;
let base;
let cookie = '';
const DATE = '2026-11-21';

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie, ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const deliveries = async () => (await call(`/api/deliveries?date=${DATE}`)).data;

test.before(async () => {
  server = createApp({ db: open(':memory:') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

let carlos;
let bia;

test('cadastro, entregadores e entregas atribuídas na colagem', async () => {
  assert.strictEqual((await call('/api/me')).status, 401);
  let r = await call('/api/auth/register', { method: 'POST', body: { name: 'Loja Teste', email: 'a@b.com', password: '12345678' } });
  assert.strictEqual(r.status, 201);
  await call('/api/settings', { method: 'PUT', body: { start_time: '09:00', service_minutes: 4 } });

  carlos = (await call('/api/drivers', { method: 'POST', body: { name: 'Carlos', phone: '11999990000' } })).data;
  bia = (await call('/api/drivers', { method: 'POST', body: { name: 'Bia' } })).data;

  r = await call('/api/deliveries/bulk', {
    method: 'POST',
    body: { date: DATE, driver_id: carlos.id, text: 'Maria - https://maps.google.com/?q=-23.50,-46.60\nJosé -23.51, -46.61\nLia -23.49, -46.59' },
  });
  assert.strictEqual(r.data.results.filter((x) => x.ok).length, 3);
  r = await call('/api/deliveries/bulk', { method: 'POST', body: { date: DATE, text: 'Ana -23.60, -46.70\nPaulo -23.61, -46.71' } });
  assert.strictEqual(r.data.results.length, 2);

  const list = await deliveries();
  assert.strictEqual(list.filter((d) => d.driver_id === carlos.id).length, 3);
  assert.strictEqual(list.filter((d) => d.driver_id == null).length, 2);
});

test('rota exige ponto de partida (do entregador ou base padrão)', async () => {
  const r = await call('/api/routes/plan', { method: 'POST', body: { date: DATE, driver_ids: [carlos.id] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.results[0].ok, false);
  assert.match(r.data.results[0].error, /ponto de partida/);
});

test('rota individual sai de onde o entregador está e só usa as entregas dele', async () => {
  let r = await call(`/api/drivers/${carlos.id}`, { method: 'PUT', body: { start_lat: -23.48, start_lng: -46.58, start_address: 'WhatsApp' } });
  assert.strictEqual(r.data.start_lat, -23.48);
  assert.ok(r.data.start_updated_at);

  r = await call('/api/routes/plan', { method: 'POST', body: { date: DATE, driver_ids: [carlos.id] } });
  assert.ok(r.data.results[0].ok, JSON.stringify(r.data));
  assert.strictEqual(r.data.routes.length, 1);
  const route = r.data.routes[0];
  assert.strictEqual(route.driver_id, carlos.id);
  assert.strictEqual(route.stops, 3);
  assert.strictEqual(route.start_lat, -23.48);

  const mine = (await deliveries()).filter((d) => d.driver_id === carlos.id).sort((a, b) => a.stop_order - b.stop_order);
  // saindo de -23.48 (norte), a ordem certa é Lia (-23.49) → Maria (-23.50) → José (-23.51)
  assert.deepStrictEqual(mine.map((d) => d.customer_name), ['Lia', 'Maria', 'José']);
  assert.ok(mine.every((d) => d.eta >= '09:00'));
  assert.ok((await deliveries()).filter((d) => d.driver_id == null).every((d) => d.route_id == null));
});

test('distribuir: atribuir em lote e gerar a rota de todos', async () => {
  const free = (await deliveries()).filter((d) => d.driver_id == null).map((d) => d.id);
  let r = await call('/api/deliveries/assign', { method: 'POST', body: { ids: free, driver_id: bia.id } });
  assert.strictEqual(r.data.changed, 2);
  // Bia sem ponto de partida: usa a base padrão
  await call('/api/settings', { method: 'PUT', body: { depot_lat: -23.55, depot_lng: -46.63 } });

  const before = (await call(`/api/routes?date=${DATE}`)).data[0].token;
  r = await call('/api/routes/plan', { method: 'POST', body: { date: DATE } });
  assert.ok(r.data.results.every((x) => x.ok), JSON.stringify(r.data.results));
  assert.strictEqual(r.data.routes.length, 2);
  const carlosRoute = r.data.routes.find((x) => x.driver_id === carlos.id);
  assert.strictEqual(carlosRoute.token, before, 'o link do entregador não muda ao recalcular');
  const biaRoute = r.data.routes.find((x) => x.driver_id === bia.id);
  assert.strictEqual(biaRoute.start_lat, -23.55);
  assert.strictEqual(biaRoute.stops, 2);
});

test('mover uma entrega de entregador tira ela da rota antiga', async () => {
  const lia = (await deliveries()).find((d) => d.customer_name === 'Lia');
  const r = await call(`/api/deliveries/${lia.id}`, { method: 'PUT', body: { driver_id: bia.id } });
  assert.strictEqual(r.data.driver_id, bia.id);
  assert.strictEqual(r.data.route_id, null);
  assert.strictEqual((await call(`/api/deliveries/${lia.id}`, { method: 'PUT', body: { driver_id: 99999 } })).status, 400);
});

test('entregador: marca entrega e recalcula pelo GPS mantendo a numeração', async () => {
  // devolve a Lia para o Carlos e recalcula
  const lia = (await deliveries()).find((d) => d.customer_name === 'Lia');
  await call(`/api/deliveries/${lia.id}`, { method: 'PUT', body: { driver_id: carlos.id } });
  const routes = (await call('/api/routes/plan', { method: 'POST', body: { date: DATE, driver_ids: [carlos.id] } })).data.routes;
  const token = routes.find((x) => x.driver_id === carlos.id).token;

  const saved = cookie; cookie = '';
  let page = await call(`/api/driver/${token}`);
  assert.strictEqual(page.status, 200);
  const first = page.data.stops[0];
  assert.strictEqual(first.customer_name, 'Lia');
  let r = await call(`/api/driver/${token}/stops/${first.id}`, { method: 'POST', body: { status: 'entregue' } });
  assert.strictEqual(r.status, 200);

  // agora ele está mais ao sul, perto do José: José deve vir antes da Maria
  r = await call(`/api/driver/${token}/start`, { method: 'POST', body: { lat: -23.515, lng: -46.615 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  page = await call(`/api/driver/${token}`);
  assert.deepStrictEqual(page.data.stops.map((s) => [s.stop_order, s.customer_name, s.status]), [
    [1, 'Lia', 'entregue'], [2, 'José', 'pendente'], [3, 'Maria', 'pendente'],
  ]);
  assert.strictEqual(page.data.start.lat, -23.515);
  assert.strictEqual((await call(`/api/driver/${token}/start`, { method: 'POST', body: { lat: 'x', lng: 1 } })).status, 400);
  assert.strictEqual((await call('/api/driver/token-invalido')).status, 404);

  r = await call(`/api/driver/${token}/stops/${page.data.stops[1].id}`, { method: 'POST', body: { status: 'falhou', notes: 'cliente ausente' } });
  assert.strictEqual(r.status, 200);
  cookie = saved;
  const jose = (await deliveries()).find((d) => d.customer_name === 'José');
  assert.strictEqual(jose.status, 'falhou');
  assert.match(jose.notes, /cliente ausente/);
});

test('outra conta não enxerga nem mexe nos dados', async () => {
  const saved = cookie;
  cookie = '';
  await call('/api/auth/register', { method: 'POST', body: { name: 'Outra', email: 'c@d.com', password: '12345678' } });
  assert.strictEqual((await deliveries()).length, 0);
  assert.strictEqual((await call('/api/drivers')).data.length, 0);
  assert.strictEqual((await call('/api/deliveries/1', { method: 'PUT', body: { customer_name: 'hack' } })).status, 404);
  assert.strictEqual((await call('/api/deliveries/assign', { method: 'POST', body: { ids: [1], driver_id: carlos.id } })).status, 400);
  const r = await call('/api/deliveries/assign', { method: 'POST', body: { ids: [1, 2], driver_id: null } });
  assert.strictEqual(r.data.changed, 0);
  cookie = saved;
});

test('webhook do WhatsApp cria entrega a partir da localização', async () => {
  process.env.WHATSAPP_APP_SECRET = 'segredo';
  await call('/api/settings', { method: 'PUT', body: { whatsapp_phone_number_id: 'PNID1' } });
  const payload = JSON.stringify({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'PNID1' },
      contacts: [{ wa_id: '5511988887777', profile: { name: 'Cliente Zap' } }],
      messages: [{ from: '5511988887777', type: 'location', location: { latitude: -23.52, longitude: -46.62, address: 'Rua do Zap, 1' } }],
    } }] }],
  });
  const bad = await call('/webhooks/whatsapp', { method: 'POST', raw: payload, headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=00' } });
  assert.strictEqual(bad.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'segredo').update(payload).digest('hex');
  const ok = await call('/webhooks/whatsapp', { method: 'POST', raw: payload, headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig } });
  assert.strictEqual(ok.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const d = (await call(`/api/deliveries?date=${local}`)).data.find((x) => x.source === 'whatsapp');
  assert.ok(d, 'entrega do WhatsApp não foi criada');
  assert.strictEqual(d.customer_name, 'Cliente Zap');
  assert.strictEqual(d.driver_id, null, 'chega sem entregador; o operador distribui');
});
