'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { open } = require('./db');
const auth = require('./auth');
const { resolveLocation, splitBulk } = require('./location');
const { planRoute } = require('./routing/optimizer');
const { routeGeometry } = require('./routing/matrix');

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const clean = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);

const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function addSeconds(hhmm, seconds) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  const total = Math.round((h * 3600 + m * 60 + seconds) / 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function createApp({ db = open() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const requireAuth = auth.requireAuth(db);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- Webhook da API oficial do WhatsApp (Meta Cloud API) ----------
  // Precisa vir antes do express.json() para validar a assinatura com o corpo bruto.
  app.get('/webhooks/whatsapp', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN
      && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN;
    return ok ? res.send(req.query['hub.challenge']) : res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), wrap(async (req, res) => {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) return res.sendStatus(503);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    const got = String(req.headers['x-hub-signature-256'] || '');
    if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // a Meta exige resposta rápida; processa em seguida
    const payload = JSON.parse(req.body.toString('utf8'));
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const op = db.prepare('SELECT * FROM operators WHERE whatsapp_phone_number_id = ?').get(String(v.metadata?.phone_number_id || ''));
        if (!op) continue;
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const msg of v.messages || []) {
          let loc = null;
          let raw = null;
          if (msg.type === 'location') {
            loc = { lat: msg.location.latitude, lng: msg.location.longitude, address: msg.location.address || msg.location.name };
            raw = JSON.stringify(msg.location);
          } else if (msg.type === 'text') {
            raw = msg.text.body;
            const r = await resolveLocation(raw);
            if (!r.error) loc = r;
          }
          if (!loc) continue;
          db.prepare(`INSERT INTO deliveries (operator_id, date, customer_name, phone, address, lat, lng, raw_input, source)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp')`)
            .run(op.id, today(), clean(names[msg.from], 120), clean(msg.from, 30), clean(loc.address), loc.lat, loc.lng, clean(raw, 2000));
        }
      }
    }
  }));

  app.use(express.json({ limit: '1mb' }));

  // ---------- Autenticação ----------
  const sendSession = (res, operatorId) => {
    const s = auth.createSession(db, operatorId);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${s.token}; HttpOnly; Path=/; Max-Age=${s.maxAge}; SameSite=Lax${secure}`);
  };
  const publicOperator = (o) => {
    const { password_hash, ...rest } = o;
    return { ...rest, return_to_depot: !!o.return_to_depot };
  };

  app.post('/api/auth/register', (req, res) => {
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 200)?.toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !email || !email.includes('@')) return res.status(400).json({ error: 'Informe nome e e-mail válidos.' });
    if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (db.prepare('SELECT 1 FROM operators WHERE email = ?').get(email)) return res.status(409).json({ error: 'E-mail já cadastrado.' });
    const r = db.prepare('INSERT INTO operators (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, auth.hashPassword(password));
    sendSession(res, Number(r.lastInsertRowid));
    res.status(201).json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const op = db.prepare('SELECT * FROM operators WHERE email = ?').get(email);
    if (!op || !auth.verifyPassword(String(req.body.password || ''), op.password_hash)) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    sendSession(res, op.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => res.json(publicOperator(req.operator)));

  app.put('/api/settings', requireAuth, (req, res) => {
    const b = req.body;
    const o = req.operator;
    const num = (v, fallback) => (v === undefined ? fallback : v === null || v === '' ? null : Number(v));
    const lat = num(b.depot_lat, o.depot_lat);
    const lng = num(b.depot_lng, o.depot_lng);
    if ((lat != null && !Number.isFinite(lat)) || (lng != null && !Number.isFinite(lng))) {
      return res.status(400).json({ error: 'Coordenadas da base inválidas.' });
    }
    const start = b.start_time === undefined ? o.start_time : String(b.start_time);
    if (!/^\d{2}:\d{2}$/.test(start)) return res.status(400).json({ error: 'Horário de saída inválido (use HH:MM).' });
    const service = b.service_minutes === undefined ? o.service_minutes : Math.max(0, Math.min(120, parseInt(b.service_minutes, 10) || 0));
    const waId = b.whatsapp_phone_number_id === undefined ? o.whatsapp_phone_number_id : clean(b.whatsapp_phone_number_id, 40);
    try {
      db.prepare(`UPDATE operators SET depot_address = ?, depot_lat = ?, depot_lng = ?, service_minutes = ?, start_time = ?,
                  return_to_depot = ?, whatsapp_phone_number_id = ? WHERE id = ?`)
        .run(b.depot_address === undefined ? o.depot_address : clean(b.depot_address), lat, lng, service, start,
          b.return_to_depot === undefined ? o.return_to_depot : (b.return_to_depot ? 1 : 0), waId, o.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Esse número do WhatsApp já está ligado a outra conta.' });
      throw e;
    }
    res.json(publicOperator(db.prepare('SELECT * FROM operators WHERE id = ?').get(o.id)));
  });

  // ---------- Localização ----------
  app.post('/api/parse', requireAuth, wrap(async (req, res) => {
    res.json(await resolveLocation(req.body.input));
  }));

  // ---------- Entregadores ----------
  app.get('/api/drivers', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT * FROM drivers WHERE operator_id = ? ORDER BY active DESC, name').all(req.operator.id));
  });
  app.post('/api/drivers', requireAuth, (req, res) => {
    const name = clean(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Informe o nome do entregador.' });
    const r = db.prepare('INSERT INTO drivers (operator_id, name, phone) VALUES (?, ?, ?)')
      .run(req.operator.id, name, clean(req.body.phone, 30));
    res.status(201).json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(r.lastInsertRowid));
  });
  app.put('/api/drivers/:id', requireAuth, (req, res) => {
    const d = db.prepare('SELECT * FROM drivers WHERE id = ? AND operator_id = ?').get(req.params.id, req.operator.id);
    if (!d) return res.status(404).json({ error: 'Entregador não encontrado.' });
    const b = req.body;
    db.prepare('UPDATE drivers SET name = ?, phone = ?, active = ? WHERE id = ?').run(
      b.name === undefined ? d.name : clean(b.name, 120) || d.name,
      b.phone === undefined ? d.phone : clean(b.phone, 30),
      b.active === undefined ? d.active : (b.active ? 1 : 0),
      d.id,
    );
    // ponto de partida: onde o entregador está agora (null limpa e volta a usar a base)
    if (b.start_lat !== undefined || b.start_lng !== undefined) {
      const lat = b.start_lat == null || b.start_lat === '' ? null : Number(b.start_lat);
      const lng = b.start_lng == null || b.start_lng === '' ? null : Number(b.start_lng);
      if ((lat == null) !== (lng == null) || (lat != null && !validCoord(lat, lng))) {
        return res.status(400).json({ error: 'Ponto de partida inválido.' });
      }
      setDriverStart(d.id, lat, lng, lat == null ? null : clean(b.start_address));
    }
    res.json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(d.id));
  });
  app.delete('/api/drivers/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM drivers WHERE id = ? AND operator_id = ?').run(req.params.id, req.operator.id);
    res.json({ ok: true });
  });

  // ---------- Entregas ----------
  const ownDriver = (opId, driverId) => {
    if (driverId == null || driverId === '') return null;
    const d = db.prepare('SELECT id FROM drivers WHERE id = ? AND operator_id = ?').get(Number(driverId), opId);
    if (!d) { const e = new Error('Entregador não encontrado.'); e.status = 400; throw e; }
    return d.id;
  };

  const insertDelivery = (opId, date, f) => db.prepare(
    `INSERT INTO deliveries (operator_id, date, customer_name, phone, address, notes, lat, lng, raw_input, source, driver_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(opId, date, clean(f.customer_name, 120), clean(f.phone, 30), clean(f.address), clean(f.notes),
    f.lat ?? null, f.lng ?? null, clean(f.raw_input, 2000), f.source || 'manual', f.driver_id ?? null);

  app.get('/api/deliveries', requireAuth, (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : today();
    res.json(db.prepare(
      `SELECT * FROM deliveries WHERE operator_id = ? AND date = ?
       ORDER BY driver_id IS NULL, driver_id, stop_order IS NULL, stop_order, id`,
    ).all(req.operator.id, date));
  });

  app.post('/api/deliveries', requireAuth, wrap(async (req, res) => {
    const b = req.body;
    const date = isDate(b.date) ? b.date : today();
    const driverId = ownDriver(req.operator.id, b.driver_id);
    let lat = b.lat != null && b.lat !== '' ? Number(b.lat) : null;
    let lng = b.lng != null && b.lng !== '' ? Number(b.lng) : null;
    let address = b.address;
    let warning = null;
    if ((lat == null || lng == null) && b.input) {
      const r = await resolveLocation(b.input);
      if (r.error) warning = r.error;
      else { lat = r.lat; lng = r.lng; address = address || r.address; }
    }
    const r = insertDelivery(req.operator.id, date, { ...b, lat, lng, address, raw_input: b.input, driver_id: driverId });
    res.status(201).json({ delivery: db.prepare('SELECT * FROM deliveries WHERE id = ?').get(r.lastInsertRowid), warning });
  }));

  app.post('/api/deliveries/bulk', requireAuth, wrap(async (req, res) => {
    const date = isDate(req.body.date) ? req.body.date : today();
    const driverId = ownDriver(req.operator.id, req.body.driver_id);
    const items = splitBulk(req.body.text).slice(0, 300);
    const results = [];
    for (const it of items) {
      const loc = await resolveLocation(it.input);
      const r = insertDelivery(req.operator.id, date, {
        customer_name: it.name, lat: loc.lat, lng: loc.lng, address: loc.address, raw_input: it.input, source: 'colado', driver_id: driverId,
      });
      results.push({ id: Number(r.lastInsertRowid), name: it.name, ok: !loc.error, error: loc.error });
    }
    res.json({ results });
  }));

  // atribui várias entregas a um entregador (driver_id null = tirar do entregador)
  app.post('/api/deliveries/assign', requireAuth, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    const driverId = ownDriver(req.operator.id, req.body.driver_id);
    const upd = db.prepare(
      `UPDATE deliveries SET driver_id = ?, route_id = NULL, stop_order = NULL, eta = NULL
       WHERE id = ? AND operator_id = ? AND status = 'pendente' AND driver_id IS NOT ?`,
    );
    let changed = 0;
    for (const id of ids) changed += Number(upd.run(driverId, id, req.operator.id, driverId).changes);
    res.json({ changed });
  });

  app.put('/api/deliveries/:id', requireAuth, (req, res) => {
    const d = db.prepare('SELECT * FROM deliveries WHERE id = ? AND operator_id = ?').get(req.params.id, req.operator.id);
    if (!d) return res.status(404).json({ error: 'Entrega não encontrada.' });
    const b = req.body;
    const pick = (k, max) => (b[k] === undefined ? d[k] : clean(b[k], max));
    const coord = (k) => (b[k] === undefined ? d[k] : b[k] === null || b[k] === '' ? null : Number(b[k]));
    const status = b.status === undefined ? d.status : ['pendente', 'entregue', 'falhou'].includes(b.status) ? b.status : d.status;
    const driverId = b.driver_id === undefined ? d.driver_id : ownDriver(req.operator.id, b.driver_id);
    const moved = driverId !== d.driver_id;
    db.prepare(`UPDATE deliveries SET customer_name = ?, phone = ?, address = ?, notes = ?, lat = ?, lng = ?, status = ?,
                delivered_at = CASE WHEN ? = 'pendente' THEN NULL WHEN ? != status THEN datetime('now') ELSE delivered_at END,
                driver_id = ?, route_id = ?, stop_order = ?, eta = ?
                WHERE id = ?`)
      .run(pick('customer_name', 120), pick('phone', 30), pick('address'), pick('notes'), coord('lat'), coord('lng'), status, status, status,
        driverId, moved ? null : d.route_id, moved ? null : d.stop_order, moved ? null : d.eta, d.id);
    res.json(db.prepare('SELECT * FROM deliveries WHERE id = ?').get(d.id));
  });

  app.delete('/api/deliveries/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM deliveries WHERE id = ? AND operator_id = ?').run(req.params.id, req.operator.id);
    res.json({ ok: true });
  });

  // ---------- Rotas (uma por entregador, saindo de onde ele está) ----------
  function setDriverStart(driverId, lat, lng, address) {
    db.prepare(`UPDATE drivers SET start_lat = ?, start_lng = ?, start_address = ?,
                start_updated_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE id = ?`)
      .run(lat, lng, address, lat, driverId);
  }

  /**
   * Otimiza a rota de um entregador com as entregas pendentes atribuídas a ele.
   * Mantém o mesmo link (token) se a rota já existia, para o entregador não perder o acesso.
   */
  async function planDriverRoute(op, driver, date, { clock } = {}) {
    const start = driver.start_lat != null
      ? { lat: driver.start_lat, lng: driver.start_lng }
      : op.depot_lat != null ? { lat: op.depot_lat, lng: op.depot_lng } : null;
    if (!start) throw new Error(`Defina onde ${driver.name} está (ponto de partida) ou uma base padrão.`);

    const stops = db.prepare(
      `SELECT id, lat, lng FROM deliveries WHERE operator_id = ? AND date = ? AND driver_id = ?
       AND status = 'pendente' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY id`,
    ).all(op.id, date, driver.id);
    const result = await planRoute({
      start, stops, returnToStart: !!op.return_to_depot, serviceSeconds: (op.service_minutes || 0) * 60,
    });

    const byId = new Map(stops.map((s) => [s.id, s]));
    const pts = [start, ...result.stopIds.map((id) => byId.get(id))];
    if (op.return_to_depot) pts.push(start);
    const geometry = await routeGeometry(pts);

    db.exec('BEGIN');
    try {
      let route = db.prepare('SELECT * FROM routes WHERE driver_id = ? AND date = ?').get(driver.id, date);
      const engine = `${result.engine}/${result.matrixSource}`;
      if (route) {
        db.prepare(`UPDATE routes SET distance_m = ?, duration_s = ?, geometry = ?, engine = ?, start_lat = ?, start_lng = ?,
                    created_at = datetime('now') WHERE id = ?`)
          .run(result.distance_m, result.duration_s, JSON.stringify(geometry), engine, start.lat, start.lng, route.id);
      } else {
        const ins = db.prepare(`INSERT INTO routes (operator_id, driver_id, date, token, distance_m, duration_s, geometry, engine, start_lat, start_lng)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(op.id, driver.id, date, auth.randomToken(12), result.distance_m, result.duration_s, JSON.stringify(geometry), engine, start.lat, start.lng);
        route = { id: Number(ins.lastInsertRowid) };
      }
      // entregas que saíram deste entregador deixam a rota
      db.prepare(`UPDATE deliveries SET route_id = NULL, stop_order = NULL, eta = NULL
                  WHERE route_id = ? AND status = 'pendente'`).run(route.id);
      // paradas já concluídas mantêm a numeração; as pendentes continuam a contagem
      const done = db.prepare(`SELECT COALESCE(MAX(stop_order), 0) AS m FROM deliveries WHERE route_id = ? AND status != 'pendente'`).get(route.id).m;
      const upd = db.prepare('UPDATE deliveries SET route_id = ?, stop_order = ?, eta = ? WHERE id = ?');
      const base = clock || op.start_time;
      result.stopIds.forEach((id, i) => upd.run(route.id, done + i + 1, addSeconds(base, result.arrivals[i]), id));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return result;
  }

  // Gera a rota de um entregador (driver_ids: [id]) ou de todos que têm entregas atribuídas.
  app.post('/api/routes/plan', requireAuth, wrap(async (req, res) => {
    const op = req.operator;
    const date = isDate(req.body.date) ? req.body.date : today();
    const ids = Array.isArray(req.body.driver_ids) ? req.body.driver_ids.map(Number) : null;
    const drivers = db.prepare(
      `SELECT dr.* FROM drivers dr WHERE dr.operator_id = ? AND EXISTS (
         SELECT 1 FROM deliveries d WHERE d.driver_id = dr.id AND d.date = ? AND d.status = 'pendente')
       ORDER BY dr.name`,
    ).all(op.id, date).filter((d) => !ids || ids.includes(d.id));
    if (!drivers.length) {
      return res.status(400).json({ error: 'Nenhum entregador com entregas pendentes atribuídas nesta data.' });
    }
    const results = [];
    for (const driver of drivers) {
      try {
        const r = await planDriverRoute(op, driver, date);
        results.push({ driver_id: driver.id, name: driver.name, ok: true, engine: r.engine, matrixSource: r.matrixSource });
      } catch (e) {
        results.push({ driver_id: driver.id, name: driver.name, ok: false, error: e.message });
      }
    }
    res.json({ results, routes: listRoutes(op.id, date) });
  }));

  function listRoutes(operatorId, date) {
    return db.prepare(
      `SELECT r.*, dr.name AS driver_name, dr.phone AS driver_phone,
              (SELECT COUNT(*) FROM deliveries d WHERE d.route_id = r.id) AS stops,
              (SELECT COUNT(*) FROM deliveries d WHERE d.route_id = r.id AND d.status != 'pendente') AS done
       FROM routes r LEFT JOIN drivers dr ON dr.id = r.driver_id
       WHERE r.operator_id = ? AND r.date = ? ORDER BY dr.name`,
    ).all(operatorId, date).map((r) => ({ ...r, geometry: r.geometry ? JSON.parse(r.geometry) : null }));
  }

  app.get('/api/routes', requireAuth, (req, res) => {
    res.json(listRoutes(req.operator.id, isDate(req.query.date) ? req.query.date : today()));
  });

  // ---------- Página do entregador (acesso por link, sem login) ----------
  const routeByToken = (token) => db.prepare(
    `SELECT r.*, dr.name AS driver_name, o.name AS operator_name
     FROM routes r LEFT JOIN drivers dr ON dr.id = r.driver_id JOIN operators o ON o.id = r.operator_id
     WHERE r.token = ?`,
  ).get(token);

  app.get('/api/driver/:token', (req, res) => {
    const r = routeByToken(req.params.token);
    if (!r) return res.status(404).json({ error: 'Rota não encontrada.' });
    const stops = db.prepare(
      `SELECT id, customer_name, phone, address, notes, lat, lng, status, stop_order, eta
       FROM deliveries WHERE route_id = ? ORDER BY stop_order`,
    ).all(r.id);
    res.json({
      date: r.date, driver_name: r.driver_name, operator_name: r.operator_name,
      start: { lat: r.start_lat, lng: r.start_lng },
      distance_m: r.distance_m, duration_s: r.duration_s,
      geometry: r.geometry ? JSON.parse(r.geometry) : null, stops,
    });
  });

  // o entregador manda a posição atual (GPS do celular) e a rota é recalculada a partir dali
  app.post('/api/driver/:token/start', wrap(async (req, res) => {
    const r = routeByToken(req.params.token);
    if (!r || !r.driver_id) return res.status(404).json({ error: 'Rota não encontrada.' });
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!validCoord(lat, lng)) return res.status(400).json({ error: 'Localização inválida.' });
    setDriverStart(r.driver_id, lat, lng, 'GPS do entregador');
    const op = db.prepare('SELECT * FROM operators WHERE id = ?').get(r.operator_id);
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(r.driver_id);
    try {
      await planDriverRoute(op, driver, r.date, { clock: nowHHMM() });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    res.json({ ok: true });
  }));

  app.post('/api/driver/:token/stops/:id', (req, res) => {
    const r = db.prepare('SELECT id FROM routes WHERE token = ?').get(req.params.token);
    if (!r) return res.status(404).json({ error: 'Rota não encontrada.' });
    const status = req.body.status;
    if (!['pendente', 'entregue', 'falhou'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
    const upd = db.prepare(
      `UPDATE deliveries SET status = :status,
       delivered_at = CASE WHEN :status = 'pendente' THEN NULL ELSE datetime('now') END,
       notes = CASE WHEN :note IS NULL THEN notes ELSE COALESCE(notes || ' | ', '') || 'Entregador: ' || :note END
       WHERE id = :id AND route_id = :route`,
    ).run({ status, note: clean(req.body.notes), id: Number(req.params.id), route: r.id });
    if (!upd.changes) return res.status(404).json({ error: 'Parada não encontrada nesta rota.' });
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; colaboradores do OpenStreetMap',
      osrm: !!process.env.OSRM_URL,
      vroom: !!process.env.VROOM_URL,
    });
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // ---------- Front-end ----------
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '7d' }));
  app.get('/e/:token', (req, res) => res.sendFile(path.join(pub, 'driver.html')));

  app.use((err, req, res, _next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro interno.' });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`RotaFácil rodando em http://localhost:${port}`));
}

module.exports = { createApp, addSeconds };
