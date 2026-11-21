'use strict';
/**
 * Gera uma nova versão da rota de um entregador para um dia.
 * - parte da posição atual do entregador (ou da base padrão);
 * - paradas já concluídas mantêm a ordem; as pendentes são otimizadas;
 * - o link do entregador (routes.token) é o mesmo em todas as versões.
 */
const { randomToken } = require('./auth');
const { planRoute } = require('./routing/optimizer');
const { routeGeometry } = require('./routing/matrix');
const { logEvent, todayIn, POSITION_MAX_AGE_HOURS } = require('./domain');

class PlanError extends Error {}

async function planDriverRoute(db, org, driver, date, { createdBy = 'operador', userId = null } = {}) {
  const pos = await db.one(
    `SELECT lat, lng FROM driver_positions
     WHERE driver_id = $1 AND recorded_at > now() - make_interval(hours => $2)
     ORDER BY recorded_at DESC LIMIT 1`,
    [driver.id, POSITION_MAX_AGE_HOURS],
  );
  let start;
  if (pos) start = { lat: pos.lat, lng: pos.lng, source: 'entregador' };
  else if (org.depot_lat != null) start = { lat: org.depot_lat, lng: org.depot_lng, source: 'base' };
  else throw new PlanError(`Defina onde ${driver.name} está (ponto de partida) ou uma base padrão.`);

  const pending = await db.many(
    `SELECT id, lat, lng FROM deliveries
     WHERE org_id = $1 AND date = $2 AND driver_id = $3 AND status = 'pendente' AND lat IS NOT NULL
     ORDER BY id`,
    [org.id, date, driver.id],
  );
  if (!pending.length) throw new PlanError('Nenhuma entrega pendente com localização para este entregador.');

  // concluídas da versão atual continuam no início, na mesma ordem
  const done = await db.many(
    `SELECT cs.delivery_id FROM current_stops cs JOIN deliveries d ON d.id = cs.delivery_id
     WHERE cs.driver_id = $1 AND cs.date = $2 AND d.status <> 'pendente' ORDER BY cs.seq`,
    [driver.id, date],
  );

  // de quando partem as previsões: horário de saída do dia, ou agora se já passou
  const t = await db.one(
    `SELECT (($1::date + $2::time) AT TIME ZONE $3) AS start_at, now() AS now`,
    [date, org.start_time, org.timezone],
  );
  const isToday = date === todayIn(org.timezone);
  const baseTime = createdBy === 'entregador' || (isToday && t.start_at < t.now) ? t.now : t.start_at;

  const result = await planRoute({
    start,
    stops: pending,
    returnToStart: org.return_to_start,
    serviceSeconds: org.service_minutes * 60,
  });
  const byId = new Map(pending.map((s) => [s.id, s]));
  const pts = [start, ...result.stopIds.map((id) => byId.get(id))];
  if (org.return_to_start) pts.push(start);
  const geometry = await routeGeometry(pts);

  return db.tx(async (q) => {
    await q.query(
      `INSERT INTO routes (org_id, driver_id, date, token) VALUES ($1, $2, $3, $4)
       ON CONFLICT (driver_id, date) DO NOTHING`,
      [org.id, driver.id, date, randomToken(12)],
    );
    const route = await q.one('SELECT * FROM routes WHERE driver_id = $1 AND date = $2 FOR UPDATE', [driver.id, date]);
    const { v } = await q.one('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM route_plans WHERE route_id = $1', [route.id]);
    const plan = await q.one(
      `INSERT INTO route_plans (route_id, version, start_lat, start_lng, start_source, base_time, distance_m, duration_s,
                                geometry, engine, matrix_source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [route.id, v, start.lat, start.lng, start.source, baseTime, result.distance_m, result.duration_s,
        JSON.stringify(geometry), result.engine, result.matrixSource, createdBy],
    );
    const ids = [...done.map((d) => d.delivery_id), ...result.stopIds];
    const seqs = ids.map((_, i) => i + 1);
    const base = new Date(baseTime).getTime();
    const etas = [...done.map(() => null), ...result.arrivals.map((s) => new Date(base + s * 1000).toISOString())];
    await q.query(
      `INSERT INTO route_stops (plan_id, delivery_id, seq, eta)
       SELECT $1, unnest($2::bigint[]), unnest($3::int[]), unnest($4::timestamptz[])`,
      [plan.id, ids, seqs, etas],
    );
    await q.query('UPDATE routes SET current_plan_id = $1 WHERE id = $2', [plan.id, route.id]);
    await logEvent(q, {
      orgId: org.id,
      type: 'route.planned',
      actor: createdBy === 'entregador' ? 'entregador' : 'usuario',
      userId,
      driverId: driver.id,
      routeId: route.id,
      lat: start.lat,
      lng: start.lng,
      data: {
        version: v, stops: ids.length, pending: result.stopIds.length, distance_m: Math.round(result.distance_m),
        duration_s: Math.round(result.duration_s), engine: result.engine, matrix: result.matrixSource, start: start.source,
      },
    });
    return { route, plan, result };
  });
}

module.exports = { planDriverRoute, PlanError };
