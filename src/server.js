'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createDb, migrate } = require('./db');
const auth = require('./auth');
const { resolveLocation, splitBulk } = require('./location');
const { planDriverRoute, PlanError } = require('./planning');
const recipient = require('./recipient');
const D = require('./domain');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const clean = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const STATUSES = ['pendente', 'entregue', 'falhou'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({ db }) {
  const app = express();
  app.disable('x-powered-by');
  // atrás de proxy reverso (Caddy/Nginx), para o limite por IP usar o IP real do cliente
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  const requireAuth = auth.requireAuth(db);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const dateOf = (req, v) => (isDate(v) ? v : D.todayIn(req.org.timezone));
  const ev = (req, q, e) => D.logEvent(q, { orgId: req.org.id, userId: req.user.id, actor: 'usuario', ...e });

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
    try {
      await handleWhatsapp(JSON.parse(req.body.toString('utf8')));
    } catch (e) {
      console.error('[whatsapp]', e);
    }
  }));

  async function handleWhatsapp(payload) {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const org = await db.one('SELECT * FROM organizations WHERE whatsapp_phone_number_id = $1', [String(v.metadata?.phone_number_id || '')]);
        if (!org) continue;
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
          if (!loc || !validCoord(loc.lat, loc.lng)) continue;
          await db.tx(async (q) => {
            const c = await D.findOrCreateCustomer(q, org.id, { name: clean(names[msg.from], 120), phone: clean(msg.from, 30) });
            const d = await q.one(
              `INSERT INTO deliveries (org_id, date, customer_id, lat, lng, address, location_source, raw_input, source)
               VALUES ($1, $2, $3, $4, $5, $6, 'whatsapp', $7, 'whatsapp') RETURNING id`,
              [org.id, D.todayIn(org.timezone), c.id, loc.lat, loc.lng, clean(loc.address), clean(raw, 2000)],
            );
            await D.savePlace(q, org.id, c.id, { lat: loc.lat, lng: loc.lng, address: clean(loc.address) });
            await D.logEvent(q, { orgId: org.id, type: 'delivery.created', actor: 'cliente', deliveryId: d.id, data: { source: 'whatsapp' } });
          });
        }
      }
    }
  }

  app.use(express.json({ limit: '1mb' }));
  recipient.register(app, db, { wrap });

  // ---------- Autenticação e equipe ----------
  const sendSession = async (res, userId) => {
    const s = await auth.createSession(db, userId);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${s.token}; HttpOnly; Path=/; Max-Age=${s.maxAge}; SameSite=Lax${secure}`);
  };
  const validateNewUser = (b) => {
    const name = clean(b.user_name ?? b.name, 120);
    const email = clean(b.email, 200)?.toLowerCase();
    const password = String(b.password || '');
    if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Informe nome e e-mail válidos.');
    if (password.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
    return { name, email, password };
  };
  const emailTaken = (e) => e.code === '23505' && String(e.constraint).includes('users_email');

  app.post('/api/auth/register', wrap(async (req, res) => {
    const orgName = clean(req.body.org_name ?? req.body.name, 120);
    if (!orgName) throw new HttpError(400, 'Informe o nome da empresa.');
    const u = validateNewUser({ ...req.body, user_name: req.body.user_name || orgName });
    let userId;
    try {
      userId = await db.tx(async (q) => {
        const org = await q.one('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [orgName]);
        const user = await q.one(
          `INSERT INTO users (org_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'dono') RETURNING id`,
          [org.id, u.name, u.email, auth.hashPassword(u.password)],
        );
        await D.logEvent(q, { orgId: org.id, type: 'org.created', userId: user.id });
        return user.id;
      });
    } catch (e) {
      if (emailTaken(e)) throw new HttpError(409, 'E-mail já cadastrado.');
      throw e;
    }
    await sendSession(res, userId);
    res.status(201).json({ ok: true });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const user = await db.one('SELECT * FROM users WHERE lower(email) = lower($1)', [String(req.body.email || '').trim()]);
    if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    await sendSession(res, user.id);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', requireAuth, wrap(async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    res.json({ ok: true });
  }));

  const publicOrg = (o) => ({
    id: o.id, name: o.name, timezone: o.timezone, today: D.todayIn(o.timezone),
    depot_address: o.depot_address, depot_lat: o.depot_lat, depot_lng: o.depot_lng,
    start_time: String(o.start_time).slice(0, 5), service_minutes: o.service_minutes,
    return_to_start: o.return_to_start, retention_days: o.retention_days,
    whatsapp_phone_number_id: o.whatsapp_phone_number_id,
  });

  app.get('/api/me', requireAuth, (req, res) => res.json({ ...publicOrg(req.org), user: req.user }));

  app.put('/api/settings', requireAuth, auth.requireOwner, wrap(async (req, res) => {
    const b = req.body;
    const o = req.org;
    const num = (v, cur) => (v === undefined ? cur : v === null || v === '' ? null : Number(v));
    const lat = num(b.depot_lat, o.depot_lat);
    const lng = num(b.depot_lng, o.depot_lng);
    if ((lat == null) !== (lng == null) || (lat != null && !validCoord(lat, lng))) throw new HttpError(400, 'Coordenadas da base inválidas.');
    const start = b.start_time === undefined ? String(o.start_time).slice(0, 5) : String(b.start_time);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) throw new HttpError(400, 'Horário de saída inválido (use HH:MM).');
    const tz = b.timezone === undefined ? o.timezone : String(b.timezone);
    if (!D.isValidTimeZone(tz)) throw new HttpError(400, 'Fuso horário inválido.');
    const service = b.service_minutes === undefined ? o.service_minutes : Math.max(0, Math.min(120, parseInt(b.service_minutes, 10) || 0));
    const retention = b.retention_days === undefined ? o.retention_days : parseInt(b.retention_days, 10);
    if (!(retention >= 30 && retention <= 3650)) throw new HttpError(400, 'Retenção deve ficar entre 30 e 3650 dias.');
    try {
      await db.query(
        `UPDATE organizations SET name = $2, depot_address = $3, depot_lat = $4, depot_lng = $5, start_time = $6,
         service_minutes = $7, return_to_start = $8, whatsapp_phone_number_id = $9, timezone = $10, retention_days = $11
         WHERE id = $1`,
        [o.id, clean(b.name, 120) || o.name, b.depot_address === undefined ? o.depot_address : clean(b.depot_address), lat, lng, start,
          service, b.return_to_start === undefined ? o.return_to_start : !!b.return_to_start,
          b.whatsapp_phone_number_id === undefined ? o.whatsapp_phone_number_id : clean(b.whatsapp_phone_number_id, 40), tz, retention],
      );
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Esse número do WhatsApp já está ligado a outra conta.');
      throw e;
    }
    res.json(publicOrg(await db.one('SELECT * FROM organizations WHERE id = $1', [o.id])));
  }));

  app.get('/api/users', requireAuth, wrap(async (req, res) => {
    res.json(await db.many('SELECT id, name, email, role, created_at FROM users WHERE org_id = $1 ORDER BY role, name', [req.org.id]));
  }));

  app.post('/api/users', requireAuth, auth.requireOwner, wrap(async (req, res) => {
    const u = validateNewUser(req.body);
    const role = req.body.role === 'dono' ? 'dono' : 'operador';
    try {
      const user = await db.one(
        `INSERT INTO users (org_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, role, created_at`,
        [req.org.id, u.name, u.email, auth.hashPassword(u.password), role],
      );
      await ev(req, db, { type: 'user.created', data: { user_id: user.id, role } });
      res.status(201).json(user);
    } catch (e) {
      if (emailTaken(e)) throw new HttpError(409, 'E-mail já cadastrado.');
      throw e;
    }
  }));

  app.delete('/api/users/:id', requireAuth, auth.requireOwner, wrap(async (req, res) => {
    if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'Você não pode remover a si mesmo.');
    const r = await db.query('DELETE FROM users WHERE id = $1 AND org_id = $2', [req.params.id, req.org.id]);
    if (!r.rowCount) throw new HttpError(404, 'Usuário não encontrado.');
    await ev(req, db, { type: 'user.removed', data: { user_id: Number(req.params.id) } });
    res.json({ ok: true });
  }));

  // ---------- Localização ----------
  app.post('/api/parse', requireAuth, wrap(async (req, res) => {
    res.json(await resolveLocation(req.body.input));
  }));

  // ---------- Entregadores ----------
  const ownDriver = async (q, orgId, driverId) => {
    if (driverId == null || driverId === '') return null;
    const d = await q.one('SELECT * FROM drivers WHERE id = $1 AND org_id = $2 AND archived_at IS NULL', [Number(driverId) || 0, orgId]);
    if (!d) throw new HttpError(400, 'Entregador não encontrado.');
    return d;
  };

  app.get('/api/drivers', requireAuth, wrap(async (req, res) => res.json(await D.listDrivers(db, req.org.id))));

  app.post('/api/drivers', requireAuth, wrap(async (req, res) => {
    const name = clean(req.body.name, 120);
    if (!name) throw new HttpError(400, 'Informe o nome do entregador.');
    const d = await db.one('INSERT INTO drivers (org_id, name, phone) VALUES ($1, $2, $3) RETURNING id', [req.org.id, name, clean(req.body.phone, 30)]);
    await ev(req, db, { type: 'driver.created', driverId: d.id });
    res.status(201).json((await D.listDrivers(db, req.org.id)).find((x) => x.id === d.id));
  }));

  app.put('/api/drivers/:id', requireAuth, wrap(async (req, res) => {
    const d = await ownDriver(db, req.org.id, req.params.id).catch(() => null);
    if (!d) throw new HttpError(404, 'Entregador não encontrado.');
    const b = req.body;
    await db.query('UPDATE drivers SET name = $2, phone = $3 WHERE id = $1',
      [d.id, b.name === undefined ? d.name : clean(b.name, 120) || d.name, b.phone === undefined ? d.phone : clean(b.phone, 30)]);
    // novo ponto de partida: entra no histórico de posições
    if (b.start_lat !== undefined || b.start_lng !== undefined) {
      const lat = Number(b.start_lat);
      const lng = Number(b.start_lng);
      if (!validCoord(lat, lng)) throw new HttpError(400, 'Ponto de partida inválido.');
      const source = ['whatsapp', 'mapa', 'gps'].includes(b.start_source) ? b.start_source : 'whatsapp';
      await db.tx(async (q) => {
        await q.query('INSERT INTO driver_positions (org_id, driver_id, lat, lng, source, label) VALUES ($1, $2, $3, $4, $5, $6)',
          [req.org.id, d.id, lat, lng, source, clean(b.start_address, 200)]);
        await ev(req, q, { type: 'driver.position', driverId: d.id, lat, lng, data: { source } });
      });
    }
    res.json((await D.listDrivers(db, req.org.id)).find((x) => x.id === d.id));
  }));

  // remover = arquivar: some da equipe, mas o histórico de rotas continua
  app.delete('/api/drivers/:id', requireAuth, wrap(async (req, res) => {
    await db.tx(async (q) => {
      const r = await q.query('UPDATE drivers SET archived_at = now() WHERE id = $1 AND org_id = $2 AND archived_at IS NULL',
        [req.params.id, req.org.id]);
      if (!r.rowCount) throw new HttpError(404, 'Entregador não encontrado.');
      await q.query(`UPDATE deliveries SET driver_id = NULL WHERE driver_id = $1 AND status = 'pendente'`, [req.params.id]);
      await ev(req, q, { type: 'driver.archived', driverId: Number(req.params.id) });
    });
    res.json({ ok: true });
  }));

  // ---------- Entregas ----------
  /**
   * Cria a entrega. Cliente com telefone já conhecido é reaproveitado e, se a
   * entrega veio sem local, usa o último local dele.
   */
  async function createDelivery(q, req, { date, name, phone, driverId, notes, loc, rawInput, source, locationSource }) {
    const c = await D.findOrCreateCustomer(q, req.org.id, { name, phone });
    let place = loc;
    let locSource = locationSource;
    if (!place && !c.is_new) {
      const last = await D.lastPlace(q, c.id);
      if (last) {
        place = { lat: last.lat, lng: last.lng, address: last.address, reference: last.reference };
        locSource = 'recorrente';
      }
    }
    const d = await q.one(
      `INSERT INTO deliveries (org_id, date, customer_id, driver_id, lat, lng, address, reference, location_source, raw_input, source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [req.org.id, date, c.id, driverId, place?.lat ?? null, place?.lng ?? null, clean(place?.address), clean(place?.reference, 300),
        place ? locSource : null, clean(rawInput, 2000), source, clean(notes)],
    );
    if (place && locSource !== 'recorrente') {
      await D.savePlace(q, req.org.id, c.id, { lat: place.lat, lng: place.lng, address: clean(place.address) });
    }
    await ev(req, q, {
      type: 'delivery.created', deliveryId: d.id, driverId,
      data: { source, location: place ? locSource : null, recurring_customer: !c.is_new },
    });
    return { id: d.id, recurring: !c.is_new && locSource === 'recorrente' };
  }

  app.get('/api/deliveries', requireAuth, wrap(async (req, res) => {
    res.json(await D.listDeliveries(db, req.org, dateOf(req, req.query.date)));
  }));

  app.post('/api/deliveries', requireAuth, wrap(async (req, res) => {
    const b = req.body;
    const driver = await ownDriver(db, req.org.id, b.driver_id);
    let loc = null;
    let warning = null;
    const lat = b.lat != null && b.lat !== '' ? Number(b.lat) : null;
    const lng = b.lng != null && b.lng !== '' ? Number(b.lng) : null;
    if (lat != null && lng != null) {
      if (!validCoord(lat, lng)) throw new HttpError(400, 'Coordenadas inválidas.');
      loc = { lat, lng, address: b.address };
    } else if (b.input) {
      const r = await resolveLocation(b.input);
      if (r.error) warning = r.error;
      else loc = r;
    }
    const created = await db.tx((q) => createDelivery(q, req, {
      date: dateOf(req, b.date), name: clean(b.customer_name, 120), phone: clean(b.phone, 30), driverId: driver?.id ?? null,
      notes: b.notes, loc, rawInput: b.input, source: 'manual', locationSource: lat != null ? 'manual' : 'colado',
    }));
    res.status(201).json({ delivery: await D.getDelivery(db, req.org, created.id), recurring: created.recurring, warning });
  }));

  app.post('/api/deliveries/bulk', requireAuth, wrap(async (req, res) => {
    const date = dateOf(req, req.body.date);
    const driver = await ownDriver(db, req.org.id, req.body.driver_id);
    const items = splitBulk(req.body.text).slice(0, 300);
    const results = [];
    for (const it of items) {
      const loc = await resolveLocation(it.input);
      const created = await db.tx((q) => createDelivery(q, req, {
        date, name: clean(it.name, 120), phone: null, driverId: driver?.id ?? null,
        loc: loc.error ? null : loc, rawInput: it.input, source: 'colado', locationSource: 'colado',
      }));
      results.push({ id: created.id, name: it.name, ok: !loc.error, error: loc.error });
    }
    res.json({ results });
  }));

  // atribui várias entregas a um entregador (driver_id null = tirar do entregador)
  app.post('/api/deliveries/assign', requireAuth, wrap(async (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    const driver = await ownDriver(db, req.org.id, req.body.driver_id);
    const changed = await db.tx(async (q) => {
      const rows = await q.many(
        `UPDATE deliveries SET driver_id = $1
         WHERE id = ANY($2::bigint[]) AND org_id = $3 AND status = 'pendente' AND driver_id IS DISTINCT FROM $1
         RETURNING id`,
        [driver?.id ?? null, ids, req.org.id],
      );
      for (const r of rows) await ev(req, q, { type: 'delivery.assigned', deliveryId: r.id, driverId: driver?.id ?? null });
      return rows.length;
    });
    res.json({ changed });
  }));

  app.put('/api/deliveries/:id', requireAuth, wrap(async (req, res) => {
    const b = req.body;
    const out = await db.tx(async (q) => {
      const d = await q.one('SELECT * FROM deliveries WHERE id = $1 AND org_id = $2 FOR UPDATE', [Number(req.params.id) || 0, req.org.id]);
      if (!d) throw new HttpError(404, 'Entrega não encontrada.');
      const c = await q.one('SELECT * FROM customers WHERE id = $1', [d.customer_id]);

      // cliente: telefone novo pode ser de um cliente já conhecido
      let customerId = d.customer_id;
      if (b.phone !== undefined && D.phoneDigits(b.phone) !== c.phone_digits) {
        customerId = (await D.findOrCreateCustomer(q, req.org.id, { name: clean(b.customer_name, 120) ?? c.name, phone: clean(b.phone, 30) })).id;
      } else if (b.customer_name !== undefined) {
        await q.query('UPDATE customers SET name = $2 WHERE id = $1', [c.id, clean(b.customer_name, 120)]);
      }

      let lat = d.lat;
      let lng = d.lng;
      let locSource = d.location_source;
      if (b.lat !== undefined || b.lng !== undefined) {
        lat = b.lat === null || b.lat === '' ? null : Number(b.lat);
        lng = b.lng === null || b.lng === '' ? null : Number(b.lng);
        if ((lat == null) !== (lng == null) || (lat != null && !validCoord(lat, lng))) throw new HttpError(400, 'Coordenadas inválidas.');
        locSource = lat == null ? null : 'mapa';
      }
      const status = b.status === undefined ? d.status : STATUSES.includes(b.status) ? b.status : d.status;
      const driver = b.driver_id === undefined ? { id: d.driver_id } : await ownDriver(q, req.org.id, b.driver_id);
      const driverId = driver?.id ?? null;
      await q.query(
        `UPDATE deliveries SET customer_id = $2, lat = $3, lng = $4, location_source = $5, address = $6, notes = $7,
         status = $8, completed_at = CASE WHEN $8 = 'pendente' THEN NULL WHEN status = $8 THEN completed_at ELSE now() END,
         driver_id = $9 WHERE id = $1`,
        [d.id, customerId, lat, lng, locSource, b.address === undefined ? d.address : clean(b.address),
          b.notes === undefined ? d.notes : clean(b.notes), status, driverId],
      );
      if (driverId !== d.driver_id) await ev(req, q, { type: 'delivery.assigned', deliveryId: d.id, driverId });
      if (status !== d.status) await ev(req, q, { type: 'delivery.status', deliveryId: d.id, driverId, data: { status, by: 'operador' } });
      if (lat !== d.lat || lng !== d.lng) {
        await ev(req, q, { type: 'delivery.located', deliveryId: d.id, data: { source: locSource } });
        if (lat != null) await D.savePlace(q, req.org.id, customerId, { lat, lng });
      }
      return d.id;
    });
    res.json(await D.getDelivery(db, req.org, out));
  }));

  // gera (ou devolve) o link único para o cliente marcar o local e acompanhar a entrega
  app.post('/api/deliveries/:id/link', requireAuth, wrap(async (req, res) => {
    const d = await db.one('SELECT id, public_token FROM deliveries WHERE id = $1 AND org_id = $2', [Number(req.params.id) || 0, req.org.id]);
    if (!d) throw new HttpError(404, 'Entrega não encontrada.');
    let token = d.public_token;
    if (!token) {
      token = auth.randomToken(16);
      await db.query('UPDATE deliveries SET public_token = $2 WHERE id = $1', [d.id, token]);
      await ev(req, db, { type: 'delivery.link_created', deliveryId: d.id });
    }
    res.json({ token, path: `/r/${token}` });
  }));

  app.delete('/api/deliveries/:id', requireAuth, wrap(async (req, res) => {
    const r = await db.query('DELETE FROM deliveries WHERE id = $1 AND org_id = $2', [Number(req.params.id) || 0, req.org.id]);
    if (r.rowCount) await ev(req, db, { type: 'delivery.deleted', data: { delivery_id: Number(req.params.id) } });
    res.json({ ok: true });
  }));

  // ---------- Clientes (LGPD) ----------
  app.get('/api/customers', requireAuth, wrap(async (req, res) => {
    const q = clean(req.query.q, 100);
    const digits = String(q || '').replace(/\D/g, '');
    res.json(await db.many(
      `SELECT c.id, c.name, c.phone, c.created_at,
              (SELECT count(*) FROM deliveries d WHERE d.customer_id = c.id) AS deliveries,
              (SELECT max(date) FROM deliveries d WHERE d.customer_id = c.id) AS last_date
       FROM customers c
       WHERE c.org_id = $1 AND c.anonymized_at IS NULL
         AND ($2::text IS NULL OR lower(c.name) LIKE '%' || lower($2) || '%' OR ($3 <> '' AND c.phone_digits LIKE '%' || $3 || '%'))
       ORDER BY c.created_at DESC LIMIT 30`,
      [req.org.id, q, digits.length >= 4 ? digits : ''],
    ));
  }));

  app.delete('/api/customers/:id', requireAuth, auth.requireOwner, wrap(async (req, res) => {
    const ok = await db.tx(async (q) => {
      const done = await D.anonymizeCustomer(q, req.org.id, Number(req.params.id) || 0);
      if (done) await ev(req, q, { type: 'customer.anonymized', data: { customer_id: Number(req.params.id) } });
      return done;
    });
    if (!ok) throw new HttpError(404, 'Cliente não encontrado.');
    res.json({ ok: true });
  }));

  // ---------- Rotas ----------
  app.post('/api/routes/plan', requireAuth, wrap(async (req, res) => {
    const date = dateOf(req, req.body.date);
    const ids = Array.isArray(req.body.driver_ids) ? req.body.driver_ids.map(Number) : null;
    const drivers = (await db.many(
      `SELECT dr.* FROM drivers dr WHERE dr.org_id = $1 AND dr.archived_at IS NULL AND EXISTS (
         SELECT 1 FROM deliveries d WHERE d.driver_id = dr.id AND d.date = $2 AND d.status = 'pendente')
       ORDER BY dr.name`,
      [req.org.id, date],
    )).filter((d) => !ids || ids.includes(d.id));
    if (!drivers.length) throw new HttpError(400, 'Nenhum entregador com entregas pendentes atribuídas nesta data.');
    const results = [];
    for (const driver of drivers) {
      try {
        const r = await planDriverRoute(db, req.org, driver, date, { createdBy: 'operador', userId: req.user.id });
        results.push({ driver_id: driver.id, name: driver.name, ok: true, engine: r.result.engine, matrixSource: r.result.matrixSource, version: r.plan.version });
      } catch (e) {
        if (!(e instanceof PlanError)) throw e;
        results.push({ driver_id: driver.id, name: driver.name, ok: false, error: e.message });
      }
    }
    res.json({ results, routes: await D.listRoutes(db, req.org.id, date) });
  }));

  app.get('/api/routes', requireAuth, wrap(async (req, res) => {
    res.json(await D.listRoutes(db, req.org.id, dateOf(req, req.query.date)));
  }));

  // histórico de versões de uma rota (cada geração/recálculo)
  app.get('/api/routes/:id/versions', requireAuth, wrap(async (req, res) => {
    res.json(await db.many(
      `SELECT p.version, p.created_at, p.created_by, p.start_source, p.distance_m, p.duration_s, p.engine, p.matrix_source,
              (SELECT count(*) FROM route_stops s WHERE s.plan_id = p.id) AS stops
       FROM route_plans p JOIN routes r ON r.id = p.route_id
       WHERE r.id = $1 AND r.org_id = $2 ORDER BY p.version`,
      [Number(req.params.id) || 0, req.org.id],
    ));
  }));

  // ---------- Página do entregador (acesso por link, sem login) ----------
  const routeByToken = (token) => db.one(
    `SELECT r.*, dr.name AS driver_name, o.name AS operator_name, o.timezone,
            p.start_lat, p.start_lng, p.distance_m, p.duration_s, p.geometry
     FROM routes r JOIN drivers dr ON dr.id = r.driver_id JOIN organizations o ON o.id = r.org_id
     LEFT JOIN route_plans p ON p.id = r.current_plan_id
     WHERE r.token = $1`,
    [String(token)],
  );

  app.get('/api/driver/:token', wrap(async (req, res) => {
    const r = await routeByToken(req.params.token);
    if (!r) throw new HttpError(404, 'Rota não encontrada.');
    const stops = await db.many(
      `SELECT d.id, c.name AS customer_name, c.phone, d.address, d.notes, d.reference, d.lat, d.lng, d.status,
              cs.seq AS stop_order, cs.eta AS eta_at
       FROM current_stops cs JOIN deliveries d ON d.id = cs.delivery_id JOIN customers c ON c.id = d.customer_id
       WHERE cs.route_id = $1 ORDER BY cs.seq`,
      [r.id],
    );
    res.json({
      date: r.date, driver_name: r.driver_name, operator_name: r.operator_name,
      start: { lat: r.start_lat, lng: r.start_lng },
      distance_m: r.distance_m, duration_s: r.duration_s, geometry: r.geometry,
      stops: stops.map((s) => ({ ...s, eta: D.hhmmIn(s.eta_at, r.timezone) })),
    });
  }));

  // o entregador manda a posição atual (GPS) e a rota é recalculada a partir dali
  app.post('/api/driver/:token/start', wrap(async (req, res) => {
    const r = await routeByToken(req.params.token);
    if (!r) throw new HttpError(404, 'Rota não encontrada.');
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!validCoord(lat, lng)) throw new HttpError(400, 'Localização inválida.');
    await db.tx(async (q) => {
      await q.query(`INSERT INTO driver_positions (org_id, driver_id, lat, lng, source, label) VALUES ($1, $2, $3, $4, 'gps', 'GPS do entregador')`,
        [r.org_id, r.driver_id, lat, lng]);
      await D.logEvent(q, { orgId: r.org_id, type: 'driver.position', actor: 'entregador', driverId: r.driver_id, routeId: r.id, lat, lng, data: { source: 'gps' } });
    });
    const org = await db.one('SELECT * FROM organizations WHERE id = $1', [r.org_id]);
    const driver = await db.one('SELECT * FROM drivers WHERE id = $1', [r.driver_id]);
    try {
      await planDriverRoute(db, org, driver, r.date, { createdBy: 'entregador' });
    } catch (e) {
      if (e instanceof PlanError) throw new HttpError(400, e.message);
      throw e;
    }
    res.json({ ok: true });
  }));

  // marca entregue / não entregue; guarda a posição do GPS no momento, se o celular mandar
  app.post('/api/driver/:token/stops/:id', wrap(async (req, res) => {
    const r = await routeByToken(req.params.token);
    if (!r) throw new HttpError(404, 'Rota não encontrada.');
    const status = req.body.status;
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Status inválido.');
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const gps = validCoord(lat, lng) && req.body.lat != null ? { lat, lng } : { lat: null, lng: null };
    const note = clean(req.body.notes, 300);
    await db.tx(async (q) => {
      const upd = await q.query(
        `UPDATE deliveries d SET status = $1,
           completed_at = CASE WHEN $1 = 'pendente' THEN NULL ELSE now() END,
           notes = CASE WHEN $2::text IS NULL THEN notes ELSE COALESCE(notes || ' | ', '') || 'Entregador: ' || $2 END
         FROM current_stops cs
         WHERE cs.delivery_id = d.id AND cs.route_id = $3 AND d.id = $4`,
        [status, note, r.id, Number(req.params.id) || 0],
      );
      if (!upd.rowCount) throw new HttpError(404, 'Parada não encontrada nesta rota.');
      await D.logEvent(q, {
        orgId: r.org_id, type: 'delivery.status', actor: 'entregador', driverId: r.driver_id, routeId: r.id,
        deliveryId: Number(req.params.id), ...gps, data: { status, by: 'entregador', has_reason: !!note },
      });
    });
    res.json({ ok: true });
  }));

  app.get('/api/config', (req, res) => {
    res.json({
      tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; colaboradores do OpenStreetMap',
      satelliteUrl: process.env.SATELLITE_TILE_URL || null,
      satelliteAttribution: process.env.SATELLITE_ATTRIBUTION || '',
      osrm: !!process.env.OSRM_URL,
      vroom: !!process.env.VROOM_URL,
    });
  });

  app.get('/api/health', wrap(async (req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  }));

  // ---------- Front-end ----------
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '7d' }));
  app.get('/e/:token', (req, res) => res.sendFile(path.join(pub, 'driver.html')));
  app.get('/r/:token', (req, res) => res.sendFile(path.join(pub, 'recipient.html')));

  app.use((err, req, res, _next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro interno.' });
  });
  return app;
}

async function main() {
  const db = createDb();
  await migrate(db);
  const purge = () => D.purgeExpired(db)
    .then((r) => console.log('[lgpd] limpeza de dados vencidos:', JSON.stringify(r)))
    .catch((e) => console.error('[lgpd] falha na limpeza:', e.message));
  await purge();
  setInterval(purge, 6 * 3600 * 1000).unref();
  const port = Number(process.env.PORT || 3000);
  createApp({ db }).listen(port, () => console.log(`RotaFácil rodando em http://localhost:${port}`));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createApp, HttpError };
