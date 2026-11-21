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

test.before(async () => {
  server = createApp({ db: open(':memory:') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('fluxo completo: conta → base → entregadores → entregas → rotas → entregador', async () => {
  assert.strictEqual((await call('/api/me')).status, 401);

  let r = await call('/api/auth/register', { method: 'POST', body: { name: 'Loja Teste', email: 'a@b.com', password: '12345678' } });
  assert.strictEqual(r.status, 201);

  r = await call('/api/routes/plan', { method: 'POST', body: { date: '2026-11-21' } });
  assert.strictEqual(r.status, 400, 'sem base deve recusar');

  r = await call('/api/settings', { method: 'PUT', body: { depot_lat: -23.55, depot_lng: -46.63, start_time: '09:00', service_minutes: 4 } });
  assert.strictEqual(r.data.start_time, '09:00');

  for (const name of ['Carlos', 'Bia']) {
    r = await call('/api/drivers', { method: 'POST', body: { name, phone: '11999990000' } });
    assert.strictEqual(r.status, 201);
  }

  const text = [
    'Maria - https://maps.google.com/?q=-23.50,-46.60',
    'José - -23.51, -46.61',
    'Ana https://www.google.com/maps/place/x/@-23.6,-46.7,17z/data=!3d-23.60!4d-46.70',
    'Paulo -23.61, -46.71',
    'Endereço sem coordenada, Rua X 10',
  ].join('\n');
  r = await call('/api/deliveries/bulk', { method: 'POST', body: { date: '2026-11-21', text } });
  assert.strictEqual(r.data.results.length, 5);
  assert.strictEqual(r.data.results.filter((x) => x.ok).length, 4);

  r = await call('/api/routes/plan', { method: 'POST', body: { date: '2026-11-21' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.routes.length, 2);
  assert.strictEqual(r.data.routes.reduce((s, x) => s + x.stops, 0), 4);

  const list = (await call('/api/deliveries?date=2026-11-21')).data;
  const routed = list.filter((d) => d.route_id);
  assert.strictEqual(routed.length, 4);
  assert.ok(routed.every((d) => /^\d{2}:\d{2}$/.test(d.eta) && d.eta >= '09:00'));
  assert.ok(list.find((d) => d.lat == null), 'entrega sem localização continua na lista');

  // página do entregador: pública, só com o token
  const token = r.data.routes[0].token;
  const saved = cookie; cookie = '';
  const page = await call(`/api/driver/${token}`);
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.data.stops[0].stop_order, 1);
  const stopId = page.data.stops[0].id;
  r = await call(`/api/driver/${token}/stops/${stopId}`, { method: 'POST', body: { status: 'falhou', notes: 'cliente ausente' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('/api/driver/token-invalido')).status, 404);
  cookie = saved;

  const after = (await call('/api/deliveries?date=2026-11-21')).data.find((d) => d.id === stopId);
  assert.strictEqual(after.status, 'falhou');
  assert.match(after.notes, /cliente ausente/);
  assert.ok(after.delivered_at);
});

test('outra conta não enxerga os dados', async () => {
  const saved = cookie;
  cookie = '';
  await call('/api/auth/register', { method: 'POST', body: { name: 'Outra', email: 'c@d.com', password: '12345678' } });
  assert.strictEqual((await call('/api/deliveries?date=2026-11-21')).data.length, 0);
  assert.strictEqual((await call('/api/drivers')).data.length, 0);
  assert.strictEqual((await call('/api/deliveries/1', { method: 'PUT', body: { customer_name: 'hack' } })).status, 404);
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
  const list = (await call(`/api/deliveries?date=${local}`)).data;
  const d = list.find((x) => x.source === 'whatsapp');
  assert.ok(d, 'entrega do WhatsApp não foi criada');
  assert.strictEqual(d.customer_name, 'Cliente Zap');
  assert.strictEqual(d.lat, -23.52);
});
