'use strict';
/**
 * Relatório por entregador num período (datas no fuso da empresa).
 *
 * Definições:
 *  - entregas: as que estão na versão atual (definitiva) da rota do dia;
 *  - km planejados: distância do "plano de referência" de cada rota, que é a
 *    última versão gerada pelo operador. Recálculos do entregador cobrem só o
 *    trecho restante, então não servem para o total do dia;
 *  - km pelo GPS (estimado): partida → pontos onde o entregador marcou cada
 *    parada, na ordem em que marcou, em linha reta × fator de desvio urbano.
 *    Vem com a cobertura (quantas paradas tinham GPS);
 *  - no horário: entregue até TOLERANCE_MIN depois da previsão do plano de referência;
 *  - longe do pino: marcada a mais de FAR_M metros do local cadastrado.
 */
const { haversine } = require('./routing/matrix');
const { logEvent, savePlace } = require('./domain');

/** Última marcação (entregue/não entregue) feita pelo entregador para a entrega d. */
const LAST_MARK = `
  SELECT e.lat, e.lng, e.at FROM events e
  WHERE e.delivery_id = d.id AND e.type = 'delivery.status' AND e.actor_type = 'entregador'
    AND e.data->>'status' IN ('entregue', 'falhou')
  ORDER BY e.at DESC LIMIT 1`;

const TOLERANCE_MIN = 15;
const FAR_M = 150;
const DETOUR = Number(process.env.DETOUR_FACTOR || 1.35);

async function driverReport(db, orgId, from, to) {
  const routes = await db.many(
    `WITH r AS (
       SELECT r.id, r.driver_id, r.date FROM routes r WHERE r.org_id = $1 AND r.date BETWEEN $2 AND $3
     )
     SELECT r.id AS route_id, r.driver_id, r.date, ref.id AS ref_plan_id, ref.distance_m, ref.start_lat, ref.start_lng
     FROM r
     JOIN LATERAL (
       SELECT p.* FROM route_plans p WHERE p.route_id = r.id
       ORDER BY (p.created_by = 'operador') DESC, p.version DESC LIMIT 1
     ) ref ON true`,
    [orgId, from, to],
  );
  const stops = await db.many(
    `SELECT cs.route_id, d.id AS delivery_id, d.status, d.completed_at, d.lat, d.lng,
            COALESCE(ref_s.eta, cs.eta) AS eta,
            ev.lat AS gps_lat, ev.lng AS gps_lng, ev.at AS gps_at
     FROM current_stops cs
     JOIN deliveries d ON d.id = cs.delivery_id
     JOIN routes r ON r.id = cs.route_id
     LEFT JOIN LATERAL (
       SELECT p.id FROM route_plans p WHERE p.route_id = r.id
       ORDER BY (p.created_by = 'operador') DESC, p.version DESC LIMIT 1
     ) ref ON true
     LEFT JOIN route_stops ref_s ON ref_s.plan_id = ref.id AND ref_s.delivery_id = d.id
     LEFT JOIN LATERAL (${LAST_MARK}) ev ON true
     WHERE cs.org_id = $1 AND cs.date BETWEEN $2 AND $3`,
    [orgId, from, to],
  );
  const drivers = await db.many(
    `SELECT id, name, archived_at IS NOT NULL AS archived FROM drivers
     WHERE org_id = $1 AND id IN (SELECT driver_id FROM routes WHERE org_id = $1 AND date BETWEEN $2 AND $3)`,
    [orgId, from, to],
  );
  return aggregate({ routes, stops, drivers });
}

const emptyStats = () => ({
  days: 0, routes: 0, deliveries: 0, delivered: 0, failed: 0, pending: 0,
  km_planned: 0, km_gps: 0, gps_marked: 0, completed: 0,
  with_eta: 0, on_time: 0, delay_sum_min: 0, late: 0, far_from_pin: 0,
});

function add(a, b) {
  for (const k of Object.keys(a)) if (typeof a[k] === 'number') a[k] += b[k];
  return a;
}

function finish(s) {
  return {
    ...s,
    km_planned: round1(s.km_planned),
    km_gps: round1(s.km_gps),
    success_rate: s.completed ? s.delivered / s.completed : null,
    gps_coverage: s.completed ? s.gps_marked / s.completed : null,
    on_time_rate: s.with_eta ? s.on_time / s.with_eta : null,
    avg_delay_min: s.late ? Math.round(s.delay_sum_min / s.late) : 0,
  };
}
const round1 = (x) => Math.round(x * 10) / 10;

/** Agrega por rota (dia) e por entregador. Separado da consulta para ser testável. */
function aggregate({ routes, stops, drivers }) {
  const byRoute = new Map();
  for (const s of stops) {
    if (!byRoute.has(s.route_id)) byRoute.set(s.route_id, []);
    byRoute.get(s.route_id).push(s);
  }

  const daily = [];
  for (const r of routes) {
    const list = byRoute.get(r.route_id) || [];
    if (!list.length) continue;
    const st = emptyStats();
    st.days = 1;
    st.routes = 1;
    st.km_planned = (r.distance_m || 0) / 1000;
    for (const s of list) {
      st.deliveries++;
      if (s.status === 'entregue') st.delivered++;
      else if (s.status === 'falhou') st.failed++;
      else st.pending++;
      if (s.status === 'pendente') continue;
      st.completed++;
      if (s.gps_lat != null) st.gps_marked++;
      if (s.status === 'entregue' && s.eta && s.completed_at) {
        st.with_eta++;
        const delay = (new Date(s.completed_at) - new Date(s.eta)) / 60000;
        if (delay <= TOLERANCE_MIN) st.on_time++;
        else { st.late++; st.delay_sum_min += delay; }
      }
      if (s.status === 'entregue' && s.gps_lat != null && s.lat != null
        && haversine({ lat: s.gps_lat, lng: s.gps_lng }, { lat: s.lat, lng: s.lng }) > FAR_M) {
        st.far_from_pin++;
      }
    }
    // caminho estimado pelo GPS: partida → marcações na ordem em que aconteceram
    const marks = list.filter((s) => s.gps_lat != null).sort((a, b) => new Date(a.gps_at) - new Date(b.gps_at));
    let prev = r.start_lat != null ? { lat: r.start_lat, lng: r.start_lng } : null;
    let meters = 0;
    for (const m of marks) {
      const p = { lat: m.gps_lat, lng: m.gps_lng };
      if (prev) meters += haversine(prev, p) * DETOUR;
      prev = p;
    }
    st.km_gps = meters / 1000;
    daily.push({ driver_id: r.driver_id, date: r.date, route_id: r.route_id, ...st });
  }

  const names = new Map(drivers.map((d) => [d.id, d]));
  const perDriver = new Map();
  for (const d of daily) {
    if (!perDriver.has(d.driver_id)) perDriver.set(d.driver_id, emptyStats());
    add(perDriver.get(d.driver_id), d);
  }
  const rows = [...perDriver.entries()]
    .map(([id, st]) => ({ driver_id: id, name: names.get(id)?.name || '—', archived: !!names.get(id)?.archived, ...finish(st) }))
    .sort((a, b) => b.deliveries - a.deliveries || a.name.localeCompare(b.name));
  const totals = finish(daily.reduce((acc, d) => add(acc, d), emptyStats()));
  return {
    drivers: rows,
    totals,
    daily: daily.map(finish).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.driver_id - b.driver_id)),
    definitions: { tolerance_min: TOLERANCE_MIN, far_from_pin_m: FAR_M, detour_factor: DETOUR },
  };
}

// ---------- entregas longe do pino ----------

/** Entregas do período marcadas como entregues a mais de FAR_M do pino, com a revisão (se houver). */
async function farFromPin(db, orgId, from, to) {
  const rows = await db.many(
    `SELECT d.id AS delivery_id, d.date, d.lat, d.lng, d.customer_id, c.name AS customer_name, c.phone,
            c.anonymized_at IS NOT NULL AS anonymized, dr.name AS driver_name,
            ev.lat AS gps_lat, ev.lng AS gps_lng, ev.at AS gps_at,
            rv.data->>'decision' AS review, rv.at AS reviewed_at
     FROM current_stops cs
     JOIN deliveries d ON d.id = cs.delivery_id
     JOIN customers c ON c.id = d.customer_id
     JOIN drivers dr ON dr.id = cs.driver_id
     JOIN LATERAL (${LAST_MARK}) ev ON true
     LEFT JOIN LATERAL (
       SELECT e.data, e.at FROM events e WHERE e.delivery_id = d.id AND e.type = 'pin.reviewed'
       ORDER BY e.at DESC LIMIT 1
     ) rv ON true
     WHERE cs.org_id = $1 AND cs.date BETWEEN $2 AND $3 AND d.status = 'entregue'
       AND d.lat IS NOT NULL AND ev.lat IS NOT NULL
     ORDER BY d.date DESC, d.id`,
    [orgId, from, to],
  );
  const items = rows
    .map((r) => ({ ...r, distance_m: Math.round(haversine({ lat: r.lat, lng: r.lng }, { lat: r.gps_lat, lng: r.gps_lng })) }))
    .filter((r) => r.distance_m > FAR_M);
  return { items, pending: items.filter((i) => !i.review).length, far_from_pin_m: FAR_M };
}

class ReviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Revisão de uma entrega longe do pino:
 *  - 'gps':  o local certo é onde o entregador marcou;
 *  - 'mapa': o operador escolheu o ponto no mapa (lat/lng);
 *  - 'ok':   o pino estava certo (ex.: entregador marcou de longe).
 * Nos dois primeiros casos, o local corrigido vira o local verificado do cliente
 * e as entregas pendentes dele que ainda estavam no pino antigo são atualizadas.
 * A entrega concluída não muda: o histórico continua como aconteceu.
 */
async function reviewPin(db, org, userId, deliveryId, { decision, lat, lng }) {
  if (!['gps', 'mapa', 'ok'].includes(decision)) throw new ReviewError(400, 'Decisão inválida.');
  return db.tx(async (q) => {
    const d = await q.one(
      `SELECT d.*, c.anonymized_at FROM deliveries d JOIN customers c ON c.id = d.customer_id
       WHERE d.id = $1 AND d.org_id = $2 FOR UPDATE OF d`,
      [deliveryId, org.id],
    );
    if (!d) throw new ReviewError(404, 'Entrega não encontrada.');
    if (d.status !== 'entregue') throw new ReviewError(400, 'Só entregas concluídas podem ser revisadas.');

    let point = null;
    if (decision === 'gps') {
      const mark = await q.one(`SELECT lat, lng FROM (${LAST_MARK.replace('d.id', '$1')}) m`, [d.id]);
      if (!mark || mark.lat == null) throw new ReviewError(400, 'Esta entrega não tem GPS do entregador.');
      point = { lat: mark.lat, lng: mark.lng };
    } else if (decision === 'mapa') {
      const la = Number(lat);
      const ln = Number(lng);
      if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
        throw new ReviewError(400, 'Marque o local no mapa.');
      }
      point = { lat: la, lng: ln };
    }

    let updatedPending = 0;
    if (point) {
      if (d.anonymized_at) throw new ReviewError(400, 'Os dados deste cliente foram apagados (LGPD).');
      await savePlace(q, org.id, d.customer_id, { ...point, address: 'Corrigido pelo operador', verifiedBy: 'operador' });
      if (d.lat != null) {
        updatedPending = (await q.query(
          `UPDATE deliveries SET lat = $2, lng = $3, address = 'Corrigido pelo operador', location_source = 'mapa'
           WHERE customer_id = $1 AND status = 'pendente' AND abs(lat - $4) < 0.0003 AND abs(lng - $5) < 0.0003`,
          [d.customer_id, point.lat, point.lng, d.lat, d.lng],
        )).rowCount;
      }
    }
    await logEvent(q, {
      orgId: org.id, type: 'pin.reviewed', userId, deliveryId: d.id,
      lat: point?.lat ?? null, lng: point?.lng ?? null,
      data: { decision, updated_pending: updatedPending },
    });
    return { decision, updated_pending: updatedPending };
  });
}

module.exports = { driverReport, aggregate, farFromPin, reviewPin, ReviewError, TOLERANCE_MIN, FAR_M };
