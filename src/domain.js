'use strict';
/**
 * Regras de negócio sobre o banco: fuso horário, eventos, clientes recorrentes,
 * consultas de leitura e retenção de dados (LGPD).
 */

// ---------- fuso horário ----------
function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
/** Dia de hoje (YYYY-MM-DD) no fuso da organização. */
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** Hora local HH:MM de um instante, no fuso da organização. */
const hhmmIn = (instant, tz) => (instant
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
  : null);

// ---------- eventos ----------
/**
 * Registra um acontecimento. Não coloque dados pessoais em `data` (nomes,
 * telefones, endereços): eventos são guardados para estatística.
 */
function logEvent(q, { orgId, type, actor = 'usuario', userId = null, driverId = null, deliveryId = null, routeId = null, lat = null, lng = null, data = {} }) {
  return q.query(
    `INSERT INTO events (org_id, type, actor_type, user_id, driver_id, delivery_id, route_id, lat, lng, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [orgId, type, actor, userId, driverId, deliveryId, routeId, lat, lng, JSON.stringify(data)],
  );
}

// ---------- clientes ----------
function phoneDigits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // número brasileiro sem DDI
  return d.length >= 12 ? d : null;
}

/** Acha o cliente pelo telefone (cliente recorrente) ou cria um novo. */
async function findOrCreateCustomer(q, orgId, { name, phone }) {
  const digits = phoneDigits(phone);
  if (digits) {
    return q.one(
      `INSERT INTO customers (org_id, name, phone, phone_digits) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, phone_digits) WHERE phone_digits IS NOT NULL
       DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name), phone = EXCLUDED.phone, anonymized_at = NULL
       RETURNING *, (xmax = 0) AS is_new`,
      [orgId, name || null, phone, digits],
    );
  }
  return q.one(
    'INSERT INTO customers (org_id, name, phone) VALUES ($1, $2, $3) RETURNING *, true AS is_new',
    [orgId, name || null, phone || null],
  );
}

/** Último local do cliente (de preferência um que ele mesmo confirmou). */
function lastPlace(q, customerId) {
  return q.one(
    `SELECT * FROM customer_places WHERE customer_id = $1
     ORDER BY confirmed_by_customer DESC, last_used_at DESC LIMIT 1`,
    [customerId],
  );
}

/** Guarda o local para a próxima entrega; pontos a menos de ~30 m contam como o mesmo lugar. */
async function savePlace(q, orgId, customerId, { lat, lng, address = null, reference = null, confirmed = false }) {
  const near = await q.one(
    `SELECT id FROM customer_places WHERE customer_id = $1 AND abs(lat - $2) < 0.0003 AND abs(lng - $3) < 0.0003
     ORDER BY last_used_at DESC LIMIT 1`,
    [customerId, lat, lng],
  );
  if (near) {
    await q.query(
      `UPDATE customer_places SET lat = $2, lng = $3, address = COALESCE($4, address), reference = COALESCE($5, reference),
       confirmed_by_customer = confirmed_by_customer OR $6, last_used_at = now() WHERE id = $1`,
      [near.id, lat, lng, address, reference, confirmed],
    );
  } else {
    await q.query(
      `INSERT INTO customer_places (org_id, customer_id, lat, lng, address, reference, confirmed_by_customer)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, customerId, lat, lng, address, reference, confirmed],
    );
  }
}

/** LGPD: apaga os dados pessoais de um cliente, mantendo números agregados. */
async function anonymizeCustomer(q, orgId, customerId) {
  const c = await q.one('SELECT id FROM customers WHERE id = $1 AND org_id = $2', [customerId, orgId]);
  if (!c) return false;
  await q.query(
    `UPDATE customers SET name = NULL, phone = NULL, phone_digits = NULL, anonymized_at = now() WHERE id = $1`, [customerId]);
  await q.query('DELETE FROM customer_places WHERE customer_id = $1', [customerId]);
  await q.query(
    `UPDATE deliveries SET lat = NULL, lng = NULL, address = NULL, reference = NULL, raw_input = NULL, notes = NULL, public_token = NULL
     WHERE customer_id = $1`, [customerId]);
  await q.query(
    `UPDATE events SET lat = NULL, lng = NULL WHERE delivery_id IN (SELECT id FROM deliveries WHERE customer_id = $1)`, [customerId]);
  return true;
}

// ---------- leituras ----------
const DELIVERY_SELECT = `
  SELECT d.id, d.date, d.customer_id, c.name AS customer_name, c.phone, d.driver_id,
         d.lat, d.lng, d.address, d.reference, d.location_source, d.raw_input, d.source, d.notes,
         d.status, d.completed_at, d.public_token, d.customer_confirmed_at, d.created_at,
         cs.route_id, cs.seq AS stop_order, cs.eta AS eta_at
  FROM deliveries d
  JOIN customers c ON c.id = d.customer_id
  LEFT JOIN current_stops cs ON cs.delivery_id = d.id`;

const shapeDelivery = (tz) => (r) => ({ ...r, eta: hhmmIn(r.eta_at, tz) });

async function listDeliveries(db, org, date) {
  const rows = await db.many(
    `${DELIVERY_SELECT} WHERE d.org_id = $1 AND d.date = $2
     ORDER BY d.driver_id IS NULL, d.driver_id, cs.seq IS NULL, cs.seq, d.id`,
    [org.id, date],
  );
  return rows.map(shapeDelivery(org.timezone));
}

async function getDelivery(q, org, id) {
  const r = await q.one(`${DELIVERY_SELECT} WHERE d.org_id = $1 AND d.id = $2`, [org.id, id]);
  return r && shapeDelivery(org.timezone)(r);
}

/** Posição de partida considerada "atual" (mais antiga que isso é ignorada). */
const POSITION_MAX_AGE_HOURS = 16;

function listDrivers(db, orgId) {
  return db.many(
    `SELECT dr.id, dr.name, dr.phone, p.lat AS start_lat, p.lng AS start_lng, p.label AS start_address,
            p.source AS start_source, p.recorded_at AS start_updated_at,
            (p.recorded_at < now() - make_interval(hours => ${POSITION_MAX_AGE_HOURS})) AS start_stale
     FROM drivers dr
     LEFT JOIN LATERAL (SELECT * FROM driver_positions WHERE driver_id = dr.id ORDER BY recorded_at DESC LIMIT 1) p ON true
     WHERE dr.org_id = $1 AND dr.archived_at IS NULL
     ORDER BY dr.name, dr.id`,
    [orgId],
  );
}

async function listRoutes(db, orgId, date) {
  const rows = await db.many(
    `SELECT r.id, r.driver_id, r.date, r.token, dr.name AS driver_name, dr.phone AS driver_phone,
            p.version, p.distance_m, p.duration_s, p.geometry, p.engine, p.matrix_source,
            p.start_lat, p.start_lng, p.created_at AS planned_at,
            (SELECT count(*) FROM current_stops cs WHERE cs.route_id = r.id) AS stops,
            (SELECT count(*) FROM current_stops cs JOIN deliveries d ON d.id = cs.delivery_id
              WHERE cs.route_id = r.id AND d.status <> 'pendente') AS done
     FROM routes r
     JOIN drivers dr ON dr.id = r.driver_id
     JOIN route_plans p ON p.id = r.current_plan_id
     WHERE r.org_id = $1 AND r.date = $2
     ORDER BY dr.name, dr.id`,
    [orgId, date],
  );
  return rows.filter((r) => r.stops > 0);
}

// ---------- retenção (LGPD) ----------
/**
 * Apaga dados pessoais mais antigos que o prazo de retenção de cada organização.
 * Mantém o que é estatística (status, datas, km), sem ligar a uma pessoa.
 */
async function purgeExpired(db) {
  const cutoff = `((now() AT TIME ZONE o.timezone)::date - o.retention_days)`;
  const age = `make_interval(days => o.retention_days)`;
  const out = {};
  out.deliveries = (await db.query(
    `UPDATE deliveries d SET lat = NULL, lng = NULL, address = NULL, reference = NULL, raw_input = NULL, notes = NULL, public_token = NULL
     FROM organizations o WHERE o.id = d.org_id AND d.date < ${cutoff}
     AND (d.lat IS NOT NULL OR d.address IS NOT NULL OR d.reference IS NOT NULL OR d.raw_input IS NOT NULL
          OR d.notes IS NOT NULL OR d.public_token IS NOT NULL)`)).rowCount;
  out.routePlans = (await db.query(
    `UPDATE route_plans p SET geometry = NULL, start_lat = NULL, start_lng = NULL
     FROM routes r JOIN organizations o ON o.id = r.org_id
     WHERE p.route_id = r.id AND r.date < ${cutoff} AND (p.geometry IS NOT NULL OR p.start_lat IS NOT NULL)`)).rowCount;
  out.driverPositions = (await db.query(
    `DELETE FROM driver_positions dp USING organizations o
     WHERE o.id = dp.org_id AND dp.recorded_at < now() - ${age}`)).rowCount;
  out.events = (await db.query(
    `UPDATE events e SET lat = NULL, lng = NULL FROM organizations o
     WHERE o.id = e.org_id AND e.at < now() - ${age} AND e.lat IS NOT NULL`)).rowCount;
  out.customers = (await db.query(
    `UPDATE customers c SET name = NULL, phone = NULL, phone_digits = NULL, anonymized_at = now()
     FROM organizations o
     WHERE o.id = c.org_id AND c.anonymized_at IS NULL AND c.created_at < now() - ${age}
     AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.customer_id = c.id AND d.date >= ${cutoff})`)).rowCount;
  await db.query(
    `DELETE FROM customer_places cp USING customers c WHERE cp.customer_id = c.id AND c.anonymized_at IS NOT NULL`);
  out.sessions = (await db.query('DELETE FROM sessions WHERE expires_at < now()')).rowCount;
  return out;
}

module.exports = {
  isValidTimeZone, todayIn, hhmmIn,
  logEvent,
  phoneDigits, findOrCreateCustomer, lastPlace, savePlace, anonymizeCustomer,
  listDeliveries, getDelivery, listDrivers, listRoutes, POSITION_MAX_AGE_HOURS,
  purgeExpired,
};
