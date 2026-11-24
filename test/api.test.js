'use strict';
process.env.GEOCODING = 'off';
delete process.env.OSRM_URL;
delete process.env.VROOM_URL;

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { createTestDb } = require('./helpers');
const D = require('../src/domain');

let db;
let server;
let base;
let cookie = '';
const DATE = '2026-11-21';

async function call(path, { method = 'GET', body, headers = {}, raw, as } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: as ?? cookie, ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.get('set-cookie');
  if (set && as === undefined) cookie = set.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, setCookie: set };
}
const deliveries = async (date = DATE) => (await call(`/api/deliveries?date=${date}`)).data;
const anon = { as: '' }; // chamada sem login (entregador/cliente)

test.before(async () => {
  db = await createTestDb();
  server = createApp({ db }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await db.drop();
});

let carlos;
let bia;

test('cadastro cria empresa + dono; sessão guardada só como hash', async () => {
  assert.strictEqual((await call('/api/me')).status, 401);
  const r = await call('/api/auth/register', { method: 'POST', body: { org_name: 'Loja Teste', user_name: 'Ana Dona', email: 'a@b.com', password: '12345678' } });
  assert.strictEqual(r.status, 201);
  const token = cookie.split('=')[1];
  const rows = await db.many('SELECT token_hash FROM sessions');
  assert.strictEqual(rows.length, 1);
  assert.notStrictEqual(rows[0].token_hash, token);
  assert.strictEqual(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));

  const me = (await call('/api/me')).data;
  assert.strictEqual(me.name, 'Loja Teste');
  assert.strictEqual(me.user.role, 'dono');
  assert.strictEqual(me.timezone, 'America/Sao_Paulo');
  assert.strictEqual((await call('/api/auth/register', { method: 'POST', body: { org_name: 'X', email: 'A@B.com', password: '12345678' }, as: '' })).status, 409);
});

test('equipe: dono adiciona operador; operador não mexe em configurações', async () => {
  let r = await call('/api/users', { method: 'POST', body: { name: 'Op', email: 'op@b.com', password: 'senha-op-1', role: 'operador' } });
  assert.strictEqual(r.status, 201);
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'OP@b.com', password: 'senha-op-1' }, as: '' });
  const opCookie = login.setCookie.split(';')[0];
  r = await call('/api/me', { as: opCookie });
  assert.strictEqual(r.data.user.role, 'operador');
  assert.strictEqual(r.data.name, 'Loja Teste', 'mesma empresa');
  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { start_time: '10:00' }, as: opCookie })).status, 403);
  assert.strictEqual((await call('/api/users', { method: 'POST', body: { name: 'X', email: 'x@b.com', password: '12345678' }, as: opCookie })).status, 403);
  assert.strictEqual((await call('/api/drivers', { as: opCookie })).status, 200, 'operador trabalha normalmente');
  assert.strictEqual((await call('/api/users')).data.length, 2);
});

test('configurações validam fuso e horário', async () => {
  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { timezone: 'Lua/Base' } })).status, 400);
  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { start_time: '25:00' } })).status, 400);
  const r = await call('/api/settings', { method: 'PUT', body: { start_time: '09:00', service_minutes: 4 } });
  assert.strictEqual(r.data.start_time, '09:00');
});

test('entregadores e entregas atribuídas na colagem', async () => {
  carlos = (await call('/api/drivers', { method: 'POST', body: { name: 'Carlos', phone: '11999990000' } })).data;
  bia = (await call('/api/drivers', { method: 'POST', body: { name: 'Bia' } })).data;

  let r = await call('/api/deliveries/bulk', {
    method: 'POST',
    body: { date: DATE, driver_id: carlos.id, text: 'Maria - https://maps.google.com/?q=-23.50,-46.60\nJosé -23.51, -46.61\nLia -23.49, -46.59' },
  });
  assert.strictEqual(r.data.results.filter((x) => x.ok).length, 3);
  r = await call('/api/deliveries/bulk', { method: 'POST', body: { date: DATE, text: 'Ana -23.60, -46.70\nPaulo -23.61, -46.71' } });
  assert.strictEqual(r.data.results.length, 2);

  const list = await deliveries();
  assert.strictEqual(list.filter((d) => d.driver_id === carlos.id).length, 3);
  assert.strictEqual(list.filter((d) => d.driver_id == null).length, 2);
  assert.strictEqual(list.find((d) => d.customer_name === 'Maria').location_source, 'colado');
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
  assert.strictEqual(Number(route.stops), 3);
  assert.strictEqual(route.start_lat, -23.48);
  assert.strictEqual(route.version, 1);

  const mine = (await deliveries()).filter((d) => d.driver_id === carlos.id).sort((a, b) => a.stop_order - b.stop_order);
  assert.deepStrictEqual(mine.map((d) => d.customer_name), ['Lia', 'Maria', 'José']);
  // data no futuro: previsões partem do horário de saída (09:00 no fuso da empresa)
  assert.deepStrictEqual(mine.map((d) => d.eta >= '09:00'), [true, true, true]);
  assert.ok((await deliveries()).filter((d) => d.driver_id == null).every((d) => d.route_id == null));
});

test('distribuir: atribuir em lote e gerar a rota de todos (link estável, nova versão)', async () => {
  const free = (await deliveries()).filter((d) => d.driver_id == null).map((d) => d.id);
  let r = await call('/api/deliveries/assign', { method: 'POST', body: { ids: free, driver_id: bia.id } });
  assert.strictEqual(r.data.changed, 2);
  await call('/api/settings', { method: 'PUT', body: { depot_lat: -23.55, depot_lng: -46.63 } });

  const before = (await call(`/api/routes?date=${DATE}`)).data[0].token;
  r = await call('/api/routes/plan', { method: 'POST', body: { date: DATE } });
  assert.ok(r.data.results.every((x) => x.ok), JSON.stringify(r.data.results));
  assert.strictEqual(r.data.routes.length, 2);
  const carlosRoute = r.data.routes.find((x) => x.driver_id === carlos.id);
  assert.strictEqual(carlosRoute.token, before, 'o link do entregador não muda ao recalcular');
  assert.strictEqual(carlosRoute.version, 2, 'recalcular cria uma versão nova');
  const versions = (await call(`/api/routes/${carlosRoute.id}/versions`)).data;
  assert.deepStrictEqual(versions.map((v) => v.version), [1, 2]);
  const biaRoute = r.data.routes.find((x) => x.driver_id === bia.id);
  assert.strictEqual(biaRoute.start_lat, -23.55, 'sem posição, sai da base');
});

test('mover uma entrega de entregador tira ela da rota antiga sem apagar o histórico', async () => {
  const lia = (await deliveries()).find((d) => d.customer_name === 'Lia');
  const r = await call(`/api/deliveries/${lia.id}`, { method: 'PUT', body: { driver_id: bia.id } });
  assert.strictEqual(r.data.driver_id, bia.id);
  assert.strictEqual(r.data.route_id, null, 'não aparece mais na rota do Carlos');
  const old = await db.one('SELECT count(*)::int AS n FROM route_stops WHERE delivery_id = $1', [lia.id]);
  assert.ok(old.n >= 1, 'versões antigas continuam guardadas');
  assert.strictEqual((await call(`/api/deliveries/${lia.id}`, { method: 'PUT', body: { driver_id: 99999 } })).status, 400);
  await call(`/api/deliveries/${lia.id}`, { method: 'PUT', body: { driver_id: carlos.id } });
});

test('entregador: marca com GPS e recalcula pela posição, mantendo a numeração', async () => {
  const routes = (await call('/api/routes/plan', { method: 'POST', body: { date: DATE, driver_ids: [carlos.id] } })).data.routes;
  const token = routes.find((x) => x.driver_id === carlos.id).token;

  let page = await call(`/api/driver/${token}`, anon);
  assert.strictEqual(page.status, 200);
  const first = page.data.stops[0];
  assert.strictEqual(first.customer_name, 'Lia');
  let r = await call(`/api/driver/${token}/stops/${first.id}`, { method: 'POST', body: { status: 'entregue', lat: -23.4901, lng: -46.5899 }, ...anon });
  assert.strictEqual(r.status, 200);
  const e = await db.one(`SELECT lat, lng, actor_type, data FROM events WHERE type = 'delivery.status' AND delivery_id = $1`, [first.id]);
  assert.deepStrictEqual([e.lat, e.lng, e.actor_type, e.data.status], [-23.4901, -46.5899, 'entregador', 'entregue']);

  r = await call(`/api/driver/${token}/start`, { method: 'POST', body: { lat: -23.515, lng: -46.615 }, ...anon });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  page = await call(`/api/driver/${token}`, anon);
  assert.deepStrictEqual(page.data.stops.map((s) => [s.stop_order, s.customer_name, s.status]), [
    [1, 'Lia', 'entregue'], [2, 'José', 'pendente'], [3, 'Maria', 'pendente'],
  ]);
  assert.strictEqual(page.data.start.lat, -23.515);
  const positions = await db.many('SELECT source FROM driver_positions WHERE driver_id = $1 ORDER BY recorded_at', [carlos.id]);
  assert.deepStrictEqual(positions.map((p) => p.source), ['whatsapp', 'gps'], 'histórico de posições');
  const plan = await db.one(`SELECT created_by FROM route_plans p JOIN routes r ON r.current_plan_id = p.id WHERE r.token = $1`, [token]);
  assert.strictEqual(plan.created_by, 'entregador');

  assert.strictEqual((await call(`/api/driver/${token}/start`, { method: 'POST', body: { lat: 'x', lng: 1 }, ...anon })).status, 400);
  assert.strictEqual((await call('/api/driver/token-invalido', anon)).status, 404);
  r = await call(`/api/driver/${token}/stops/${page.data.stops[1].id}`, { method: 'POST', body: { status: 'falhou', notes: 'cliente ausente' }, ...anon });
  assert.strictEqual(r.status, 200);
  const jose = (await deliveries()).find((d) => d.customer_name === 'José');
  assert.strictEqual(jose.status, 'falhou');
  assert.ok(jose.completed_at);
  assert.match(jose.notes, /cliente ausente/);
});

test('banco recusa dados inconsistentes (CHECKs)', async () => {
  const d = (await deliveries())[0];
  await assert.rejects(db.query(`UPDATE deliveries SET status = 'perdida' WHERE id = $1`, [d.id]), /check/);
  await assert.rejects(db.query(`UPDATE deliveries SET status = 'entregue', completed_at = NULL WHERE id = $1`, [d.id]), /check/);
  await assert.rejects(db.query(`UPDATE deliveries SET lat = 10, lng = NULL WHERE id = $1`, [d.id]), /check/);
});

test('cliente recorrente: mesmo telefone reaproveita cadastro e último local', async () => {
  let r = await call('/api/deliveries', { method: 'POST', body: { date: DATE, customer_name: 'Rosa', phone: '(11) 98888-7777', lat: -23.53, lng: -46.62 } });
  const first = r.data.delivery;
  r = await call('/api/deliveries', { method: 'POST', body: { date: '2026-11-22', customer_name: 'Rosa Lima', phone: '11988887777' } });
  assert.strictEqual(r.data.recurring, true);
  const second = r.data.delivery;
  assert.strictEqual(second.customer_id, first.customer_id, 'mesmo cliente');
  assert.strictEqual(second.lat, -23.53);
  assert.strictEqual(second.location_source, 'recorrente');
  assert.strictEqual(second.customer_name, 'Rosa Lima', 'nome atualizado no cadastro');
  const found = (await call('/api/customers?q=8888')).data;
  assert.strictEqual(found.length, 1);
  assert.strictEqual(Number(found[0].deliveries), 2);
});

test('outra empresa não enxerga nem mexe nos dados', async () => {
  const other = (await call('/api/auth/register', { method: 'POST', body: { org_name: 'Outra', email: 'c@d.com', password: '12345678' }, as: '' })).setCookie.split(';')[0];
  const o = { as: other };
  assert.strictEqual((await call(`/api/deliveries?date=${DATE}`, o)).data.length, 0);
  assert.strictEqual((await call('/api/drivers', o)).data.length, 0);
  assert.strictEqual((await call('/api/customers', o)).data.length, 0);
  const someId = (await deliveries())[0].id;
  assert.strictEqual((await call(`/api/deliveries/${someId}`, { method: 'PUT', body: { notes: 'hack' }, ...o })).status, 404);
  assert.strictEqual((await call('/api/deliveries/assign', { method: 'POST', body: { ids: [someId], driver_id: carlos.id }, ...o })).status, 400);
  assert.strictEqual((await call('/api/deliveries/assign', { method: 'POST', body: { ids: [someId], driver_id: null }, ...o })).data.changed, 0);
  assert.strictEqual((await call(`/api/deliveries/${someId}/link`, { method: 'POST', ...o })).status, 404);
});

test('destinatário: link → marca o local → acompanha → entregue', async () => {
  let r = await call('/api/deliveries', { method: 'POST', body: { date: DATE, customer_name: 'Rita Souza', phone: '11977776666', driver_id: carlos.id, notes: 'cliente chata, cobrar frete' } });
  const id = r.data.delivery.id;
  r = await call(`/api/deliveries/${id}/link`, { method: 'POST' });
  const token = r.data.token;
  assert.strictEqual((await call(`/api/deliveries/${id}/link`, { method: 'POST' })).data.token, token, 'link é estável');

  let page = await call(`/api/r/${token}`, anon);
  assert.strictEqual(page.data.phase, 'confirmar');
  assert.strictEqual(page.data.customer_name, 'Rita Souza');
  assert.ok(!JSON.stringify(page.data).includes('cobrar frete'), 'observação interna não pode vazar');
  assert.deepStrictEqual(page.data.map_center, { lat: -23.55, lng: -46.63 });

  assert.strictEqual((await call(`/api/r/${token}`, { method: 'POST', body: { lat: -23.47, lng: -46.57 }, ...anon })).status, 400, 'exige aceite');
  assert.strictEqual((await call(`/api/r/${token}`, { method: 'POST', body: { consent: true }, ...anon })).status, 400, 'exige pino');
  assert.strictEqual((await call('/api/r/nao-existe', anon)).status, 404);

  r = await call(`/api/r/${token}`, { method: 'POST', body: { lat: -23.47, lng: -46.57, consent: true, reference: 'Portão azul' }, ...anon });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.phase, 'confirmado');

  const row = await db.one('SELECT consent_version, location_source, customer_confirmed_at FROM deliveries WHERE id = $1', [id]);
  assert.strictEqual(row.consent_version, '2026-11-v1');
  assert.strictEqual(row.location_source, 'cliente');
  const place = await db.one('SELECT cp.confirmed_by_customer, cp.reference FROM customer_places cp JOIN deliveries d ON d.customer_id = cp.customer_id WHERE d.id = $1', [id]);
  assert.deepStrictEqual([place.confirmed_by_customer, place.reference], [true, 'Portão azul'], 'local salvo para a próxima compra');

  const plan = await call('/api/routes/plan', { method: 'POST', body: { date: DATE, driver_ids: [carlos.id] } });
  const routeToken = plan.data.routes.find((x) => x.driver_id === carlos.id).token;
  page = await call(`/api/r/${token}`, anon);
  assert.strictEqual(page.data.phase, 'em_rota');
  assert.strictEqual(page.data.tracking.driver_first_name, 'Carlos');
  assert.match(page.data.tracking.eta, /^\d{2}:\d{2}$/);
  const stops = (await call(`/api/driver/${routeToken}`, anon)).data.stops;
  const mine = stops.find((s) => s.id === id);
  assert.strictEqual(mine.reference, 'Portão azul');
  const expectedAhead = stops.filter((s) => s.status === 'pendente' && s.stop_order < mine.stop_order).length;
  assert.strictEqual(page.data.tracking.stops_ahead, expectedAhead);

  assert.strictEqual((await call(`/api/r/${token}`, { method: 'POST', body: { lat: -23.4, lng: -46.5, consent: true }, ...anon })).status, 409);

  for (const s of stops.filter((x) => x.status === 'pendente' && x.stop_order < mine.stop_order)) {
    await call(`/api/driver/${routeToken}/stops/${s.id}`, { method: 'POST', body: { status: 'entregue' }, ...anon });
  }
  assert.strictEqual((await call(`/api/r/${token}`, anon)).data.tracking.stops_ahead, 0);
  await call(`/api/driver/${routeToken}/stops/${id}`, { method: 'POST', body: { status: 'entregue' }, ...anon });
  page = await call(`/api/r/${token}`, anon);
  assert.strictEqual(page.data.phase, 'entregue');
  assert.ok(page.data.completed_at);
});

test('fuso horário da empresa: "hoje" e previsões no horário local', async () => {
  await call('/api/settings', { method: 'PUT', body: { timezone: 'America/Manaus', start_time: '00:00' } });
  const me = (await call('/api/me')).data;
  assert.strictEqual(me.today, D.todayIn('America/Manaus'));
  await call('/api/deliveries', { method: 'POST', body: { customer_name: 'Hoje', lat: -3.1, lng: -60.0, driver_id: bia.id } });
  const r = await call('/api/routes/plan', { method: 'POST', body: { driver_ids: [bia.id] } });
  assert.ok(r.data.results[0].ok, JSON.stringify(r.data));
  const d = (await deliveries(me.today)).find((x) => x.customer_name === 'Hoje');
  const nowManaus = D.hhmmIn(new Date(), 'America/Manaus');
  assert.ok(d.eta >= nowManaus || nowManaus >= '23:00', `eta ${d.eta} antes de agora ${nowManaus} (Manaus)`);
  assert.strictEqual(d.eta, D.hhmmIn(d.eta_at, 'America/Manaus'));
  await call('/api/settings', { method: 'PUT', body: { timezone: 'America/Sao_Paulo', start_time: '09:00' } });
});

test('eventos registram o histórico sem dados pessoais', async () => {
  const types = (await db.many('SELECT DISTINCT type FROM events ORDER BY 1')).map((r) => r.type);
  for (const t of ['delivery.created', 'delivery.assigned', 'delivery.status', 'delivery.customer_confirmed', 'route.planned', 'driver.position']) {
    assert.ok(types.includes(t), `faltou evento ${t}`);
  }
  const all = JSON.stringify(await db.many('SELECT data FROM events'));
  for (const pii of ['Rita', 'Maria', '11977776666', 'Portão']) assert.ok(!all.includes(pii), `evento com dado pessoal: ${pii}`);
});

test('LGPD: apagar dados de um cliente', async () => {
  const rita = (await call('/api/customers?q=Rita')).data[0];
  assert.ok(rita);
  assert.strictEqual((await call(`/api/customers/${rita.id}`, { method: 'DELETE' })).status, 200);
  const c = await db.one('SELECT name, phone, anonymized_at FROM customers WHERE id = $1', [rita.id]);
  assert.deepStrictEqual([c.name, c.phone, !!c.anonymized_at], [null, null, true]);
  const d = await db.one('SELECT lat, reference, notes, public_token, status FROM deliveries WHERE customer_id = $1', [rita.id]);
  assert.deepStrictEqual([d.lat, d.reference, d.notes, d.public_token, d.status], [null, null, null, null, 'entregue'], 'status fica para a estatística');
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM customer_places WHERE customer_id = $1', [rita.id])).n, 0);
});

test('LGPD: retenção apaga dados pessoais antigos e sessões vencidas', async () => {
  const org = await db.one(`SELECT id FROM organizations WHERE name = 'Loja Teste'`);
  await db.query('UPDATE organizations SET retention_days = 30 WHERE id = $1', [org.id]);
  const c = await db.one(`INSERT INTO customers (org_id, name, phone, created_at) VALUES ($1, 'Antigo', '119', now() - interval '400 days') RETURNING id`, [org.id]);
  const old = await db.one(
    `INSERT INTO deliveries (org_id, date, customer_id, lat, lng, address, notes, source, status, completed_at)
     VALUES ($1, '2025-01-10', $2, -23.5, -46.6, 'Rua X', 'obs', 'manual', 'entregue', '2025-01-10 15:00Z') RETURNING id`,
    [org.id, c.id],
  );
  await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'velha', id, now() - interval '1 day' FROM users LIMIT 1`);
  const out = await D.purgeExpired(db);
  assert.ok(out.deliveries >= 1 && out.customers >= 1 && out.sessions >= 1, JSON.stringify(out));
  const d = await db.one('SELECT lat, address, notes, status FROM deliveries WHERE id = $1', [old.id]);
  assert.deepStrictEqual([d.lat, d.address, d.notes, d.status], [null, null, null, 'entregue']);
  assert.strictEqual((await db.one('SELECT name FROM customers WHERE id = $1', [c.id])).name, null);
  assert.ok((await deliveries()).some((x) => x.lat != null), 'dados recentes continuam');
  await db.query('UPDATE organizations SET retention_days = 365 WHERE id = $1', [org.id]);
});

test('webhook do WhatsApp cria entrega e cliente a partir da localização', async () => {
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
  await new Promise((r) => setTimeout(r, 200));
  const today = (await call('/api/me')).data.today;
  const d = (await deliveries(today)).find((x) => x.source === 'whatsapp');
  assert.ok(d, 'entrega do WhatsApp não foi criada');
  assert.strictEqual(d.customer_name, 'Cliente Zap', 'mesmo telefone da Rosa (5511988887777): cadastro atualizado');
  assert.strictEqual(d.driver_id, null);
});

test('destinatário: limite de tentativas por IP', async () => {
  let last;
  for (let i = 0; i < 25; i++) last = await call('/api/r/qualquer', { method: 'POST', body: {}, ...anon });
  assert.strictEqual(last.status, 429);
});

test('arquivar entregador mantém as rotas e libera as entregas pendentes', async () => {
  const pend = (await deliveries()).filter((d) => d.driver_id === bia.id && d.status === 'pendente').length;
  assert.strictEqual((await call(`/api/drivers/${bia.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await call('/api/drivers')).data.some((d) => d.id === bia.id));
  assert.strictEqual((await deliveries()).filter((d) => d.driver_id === bia.id && d.status === 'pendente').length, 0);
  assert.ok(pend >= 0);
  const routes = await db.one('SELECT count(*)::int AS n FROM routes WHERE driver_id = $1', [bia.id]);
  assert.ok(routes.n >= 1, 'rotas antigas continuam no histórico');
});
