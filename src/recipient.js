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
  const byToken = (token) => db.prepare(
    `SELECT d.*, o.name AS operator_name, o.depot_lat, o.depot_lng FROM deliveries d JOIN operators o ON o.id = d.operator_id
     WHERE d.public_token = ?`,
  ).get(String(token));

  function view(d) {
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
      delivered_at: d.status !== 'pendente' ? d.delivered_at : null,
      // centro inicial do mapa: região da loja, arredondada (~1 km) para não expor o endereço exato
      map_center: d.depot_lat != null ? { lat: Math.round(d.depot_lat * 100) / 100, lng: Math.round(d.depot_lng * 100) / 100 } : null,
    };
    if (phase === 'em_rota') {
      const r = db.prepare('SELECT r.*, dr.name AS driver_name FROM routes r LEFT JOIN drivers dr ON dr.id = r.driver_id WHERE r.id = ?').get(d.route_id);
      const ahead = db.prepare(
        `SELECT COUNT(*) AS n FROM deliveries WHERE route_id = ? AND status = 'pendente' AND stop_order < ?`,
      ).get(d.route_id, d.stop_order).n;
      out.tracking = {
        driver_first_name: (r?.driver_name || '').split(/\s+/)[0] || null,
        stops_ahead: ahead,
        eta: d.eta,
      };
    }
    return out;
  }

  const publicLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 120 });
  const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });
  const searchLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

  app.get('/api/r/:token', publicLimit, (req, res) => {
    const d = byToken(req.params.token);
    if (!d) return res.status(404).json({ error: 'Link inválido ou expirado.' });
    res.json(view(d));
  });

  app.post('/api/r/:token', writeLimit, (req, res) => {
    const d = byToken(req.params.token);
    if (!d) return res.status(404).json({ error: 'Link inválido ou expirado.' });
    if (d.status !== 'pendente') return res.status(409).json({ error: 'Esta entrega já foi finalizada.' });
    if (d.route_id != null) {
      return res.status(409).json({ error: `Sua encomenda já saiu para entrega. Para mudar o local, fale com ${d.operator_name}.` });
    }
    const b = req.body || {};
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (!validCoord(lat, lng)) return res.status(400).json({ error: 'Marque no mapa onde você quer receber.' });
    if (!b.consent) return res.status(400).json({ error: 'É preciso aceitar o uso dos dados para a entrega.' });
    const name = clean(b.customer_name, 120) || d.customer_name;
    if (!name) return res.status(400).json({ error: 'Informe seu nome.' });
    db.prepare(
      `UPDATE deliveries SET customer_name = ?, phone = ?, reference = ?, lat = ?, lng = ?,
       address = 'Marcado pelo cliente', customer_confirmed_at = datetime('now'),
       consent_at = COALESCE(consent_at, datetime('now')) WHERE id = ?`,
    ).run(name, clean(b.phone, 30) || d.phone, clean(b.reference, 300), lat, lng, d.id);
    res.json(view(byToken(req.params.token)));
  });

  // busca de endereço para o cliente achar a casa no mapa
  app.get('/api/r/:token/search', searchLimit, wrap(async (req, res) => {
    const d = byToken(req.params.token);
    if (!d) return res.status(404).json({ error: 'Link inválido ou expirado.' });
    const q = clean(req.query.q, 200);
    if (!q || q.length < 4) return res.json([]);
    try {
      res.json(await searchAddress(q, { limit: 5 }));
    } catch {
      res.json([]);
    }
  }));
}

module.exports = { register, rateLimit };
