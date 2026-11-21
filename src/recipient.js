'use strict';
/**
 * Área do destinatário (acesso pelo link único da entrega, sem login):
 *  1. confirma nome/telefone e marca no mapa onde quer receber;
 *  2. depois acompanha a entrega (posição na fila, previsão, entregue).
 *
 * Só expõe o necessário: nunca as observações internas do operador nem dados
 * de outras entregas da rota.
 */
const { searchAddress } = require('./location');
const D = require('./domain');

/** Versão do texto de consentimento mostrado ao cliente (guardada com o aceite). */
const CONSENT_VERSION = '2026-11-v1';

const clean = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Limite simples por IP para as rotas públicas (memória do processo). */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}

function register(app, db, { wrap }) {
  const byToken = (q, token) => q.one(
    `SELECT d.*, c.name AS customer_name, c.phone, c.phone_digits,
            o.name AS operator_name, o.timezone, o.depot_lat, o.depot_lng,
            cs.route_id, cs.seq, cs.eta
     FROM deliveries d
     JOIN customers c ON c.id = d.customer_id
     JOIN organizations o ON o.id = d.org_id
     LEFT JOIN current_stops cs ON cs.delivery_id = d.id
     WHERE d.public_token = $1`,
    [String(token)],
  );

  async function view(d) {
    const editable = d.status === 'pendente' && d.route_id == null;
    let phase;
    if (d.status === 'entregue') phase = 'entregue';
    else if (d.status === 'falhou') phase = 'falhou';
    else if (d.route_id != null) phase = 'em_rota';
    else if (d.customer_confirmed_at && d.lat != null) phase = 'confirmado';
    else phase = 'confirmar';

    const out = {
      phase,
      editable,
      operator_name: d.operator_name,
      date: d.date,
      customer_name: d.customer_name,
      phone: d.phone,
      reference: d.reference,
      lat: d.lat,
      lng: d.lng,
      confirmed_at: d.customer_confirmed_at,
      completed_at: d.status !== 'pendente' ? d.completed_at : null,
      consent_version: CONSENT_VERSION,
      // centro inicial do mapa: região da loja, arredondada (~1 km) para não expor o endereço exato
      map_center: d.depot_lat != null ? { lat: Math.round(d.depot_lat * 100) / 100, lng: Math.round(d.depot_lng * 100) / 100 } : null,
    };
    if (phase === 'em_rota') {
      const r = await db.one(
        `SELECT dr.name AS driver_name,
                (SELECT count(*) FROM current_stops cs JOIN deliveries x ON x.id = cs.delivery_id
                 WHERE cs.route_id = $1 AND x.status = 'pendente' AND cs.seq < $2) AS ahead
         FROM routes r JOIN drivers dr ON dr.id = r.driver_id WHERE r.id = $1`,
        [d.route_id, d.seq],
      );
      out.tracking = {
        driver_first_name: (r?.driver_name || '').split(/\s+/)[0] || null,
        stops_ahead: r?.ahead ?? 0,
        eta: D.hhmmIn(d.eta, d.timezone),
      };
    }
    return out;
  }

  const publicLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 120 });
  const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });
  const searchLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
  const notFound = (res) => res.status(404).json({ error: 'Link inválido ou expirado.' });

  app.get('/api/r/:token', publicLimit, wrap(async (req, res) => {
    const d = await byToken(db, req.params.token);
    if (!d) return notFound(res);
    res.json(await view(d));
  }));

  app.post('/api/r/:token', writeLimit, wrap(async (req, res) => {
    const b = req.body || {};
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    const result = await db.tx(async (q) => {
      const d = await byToken(q, req.params.token);
      if (!d) return { status: 404 };
      if (d.status !== 'pendente') return { status: 409, error: 'Esta entrega já foi finalizada.' };
      if (d.route_id != null) {
        return { status: 409, error: `Sua encomenda já saiu para entrega. Para mudar o local, fale com ${d.operator_name}.` };
      }
      if (!validCoord(lat, lng) || b.lat == null) return { status: 400, error: 'Marque no mapa onde você quer receber.' };
      if (!b.consent) return { status: 400, error: 'É preciso aceitar o uso dos dados para a entrega.' };
      const name = clean(b.customer_name, 120) || d.customer_name;
      if (!name) return { status: 400, error: 'Informe seu nome.' };

      // telefone informado pode ser de um cliente que já existe (recorrente)
      let customerId = d.customer_id;
      const phone = clean(b.phone, 30);
      if (phone && D.phoneDigits(phone) && D.phoneDigits(phone) !== d.phone_digits) {
        customerId = (await D.findOrCreateCustomer(q, d.org_id, { name, phone })).id;
      } else {
        await q.query('UPDATE customers SET name = $2, phone = COALESCE($3, phone) WHERE id = $1', [d.customer_id, name, phone]);
      }
      const reference = clean(b.reference, 300);
      await q.query(
        `UPDATE deliveries SET customer_id = $2, reference = $3, lat = $4, lng = $5, address = 'Marcado pelo cliente',
         location_source = 'cliente', customer_confirmed_at = now(),
         consent_at = COALESCE(consent_at, now()), consent_version = COALESCE(consent_version, $6)
         WHERE id = $1`,
        [d.id, customerId, reference, lat, lng, CONSENT_VERSION],
      );
      await D.savePlace(q, d.org_id, customerId, { lat, lng, address: 'Marcado pelo cliente', reference, confirmed: true });
      await D.logEvent(q, { orgId: d.org_id, type: 'delivery.customer_confirmed', actor: 'cliente', deliveryId: d.id, data: { consent_version: CONSENT_VERSION } });
      return { status: 200 };
    });
    if (result.status === 404) return notFound(res);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json(await view(await byToken(db, req.params.token)));
  }));

  // busca de endereço para o cliente achar a casa no mapa
  app.get('/api/r/:token/search', searchLimit, wrap(async (req, res) => {
    const d = await byToken(db, req.params.token);
    if (!d) return notFound(res);
    const q = clean(req.query.q, 200);
    if (!q || q.length < 4) return res.json([]);
    try {
      res.json(await searchAddress(q, { limit: 5 }));
    } catch {
      res.json([]);
    }
  }));
}

module.exports = { register, rateLimit, CONSENT_VERSION };
