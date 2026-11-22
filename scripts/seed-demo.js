#!/usr/bin/env node
'use strict';
/**
 * Cria uma conta de demonstração com uma semana de entregas em Goiânia,
 * usando a API do servidor que já está rodando (npm start).
 *
 *   npm run demo                     # servidor em http://localhost:3000
 *   BASE_URL=http://localhost:3999 npm run demo
 *
 * Login criado: demo@rotafacil.local / demo1234
 * Os horários de conclusão são ajustados direto no banco (DATABASE_URL) para
 * o relatório de pontualidade ficar realista.
 */
const { createDb } = require('../src/db');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = 'demo@rotafacil.local';
const PASSWORD = 'demo1234';
let cookie = '';
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  if (res.status >= 400) throw new Error(`${method} ${path}: ${data?.error || res.status}`);
  return data;
}
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function main() {
  try {
    await call('/api/auth/register', { method: 'POST', body: { org_name: 'Doces da Ana (demo)', user_name: 'Ana', email: EMAIL, password: PASSWORD } });
  } catch (e) {
    if (!/cadastrado/.test(e.message)) throw e;
    console.log(`A conta ${EMAIL} já existe: nada a fazer. Entre com ${EMAIL} / ${PASSWORD}.`);
    return;
  }
  await call('/api/settings', {
    method: 'PUT',
    body: { timezone: 'America/Sao_Paulo', start_time: '08:30', service_minutes: 4, depot_lat: -16.6869, depot_lng: -49.2648, depot_address: 'Centro, Goiânia' },
  });
  const today = (await call('/api/me')).today;
  const centers = { 'Carlos Lima': [-16.67, -49.27], 'Bia Souza': [-16.71, -49.24], 'Rafa Gomes': [-16.64, -49.22] };
  const drivers = {};
  for (const name of Object.keys(centers)) {
    drivers[name] = await call('/api/drivers', { method: 'POST', body: { name, phone: '62999990000' } });
  }

  for (let back = 6; back >= 0; back--) {
    const day = shift(today, -back);
    for (const [name, [clat, clng]] of Object.entries(centers)) {
      if (name === 'Rafa Gomes' && (back === 5 || back === 2)) continue; // folgas
      const dr = drivers[name];
      await call(`/api/drivers/${dr.id}`, { method: 'PUT', body: { start_lat: clat + 0.01, start_lng: clng - 0.01, start_source: 'whatsapp', start_address: 'Localização do WhatsApp' } });
      const n = 6 + Math.floor(rnd() * 6);
      const text = Array.from({ length: n }, (_, i) => `Cliente ${String.fromCharCode(65 + i)}${back} ${(clat + (rnd() - 0.5) * 0.06).toFixed(5)}, ${(clng + (rnd() - 0.5) * 0.06).toFixed(5)}`).join('\n');
      await call('/api/deliveries/bulk', { method: 'POST', body: { date: day, driver_id: dr.id, text } });
      const plan = await call('/api/routes/plan', { method: 'POST', body: { date: day, driver_ids: [dr.id] } });
      const route = plan.routes.find((r) => r.driver_id === dr.id);
      const page = await call(`/api/driver/${route.token}`, { auth: false });
      for (const [i, st] of page.stops.entries()) {
        if (back === 0 && i >= Math.ceil(page.stops.length / 2)) break; // hoje: metade ainda pendente
        const fail = rnd() < (name === 'Bia Souza' ? 0.12 : 0.05);
        const gps = rnd() < (name === 'Rafa Gomes' ? 0.6 : 0.92);
        const far = rnd() < 0.08;
        await call(`/api/driver/${route.token}/stops/${st.id}`, {
          method: 'POST',
          auth: false,
          body: {
            status: fail ? 'falhou' : 'entregue',
            ...(fail ? { notes: 'cliente ausente' } : {}),
            ...(gps ? { lat: st.lat + (far ? 0.004 : (rnd() - 0.5) * 0.0004), lng: st.lng + (rnd() - 0.5) * 0.0004 } : {}),
          },
        });
      }
    }
  }

  // hoje: um pedido aguardando o cliente marcar o local pelo link
  const { delivery } = await call('/api/deliveries', { method: 'POST', body: { date: today, customer_name: 'Rita Souza', phone: '62988887777' } });
  const link = await call(`/api/deliveries/${delivery.id}/link`, { method: 'POST' });

  // horários de conclusão realistas (previsão ± alguns minutos) para o relatório
  const db = createDb();
  try {
    await db.query(
      `UPDATE deliveries d SET completed_at = cs.eta + make_interval(mins => (CASE WHEN dr.name = 'Bia Souza'
          THEN -5 + (random() * 45)::int ELSE -10 + (random() * 28)::int END))
       FROM current_stops cs JOIN drivers dr ON dr.id = cs.driver_id JOIN organizations o ON o.id = cs.org_id
       WHERE cs.delivery_id = d.id AND d.status <> 'pendente' AND cs.eta IS NOT NULL AND cs.date < $1
         AND o.name = 'Doces da Ana (demo)'`,
      [today],
    );
    await db.query(
      `UPDATE events e SET at = d.completed_at FROM deliveries d JOIN organizations o ON o.id = d.org_id
       WHERE e.delivery_id = d.id AND e.type = 'delivery.status' AND d.completed_at IS NOT NULL AND o.name = 'Doces da Ana (demo)'`,
    );
  } finally {
    await db.close();
  }

  console.log(`Pronto! Abra ${BASE} e entre com ${EMAIL} / ${PASSWORD}`);
  console.log(`Link de cliente para testar: ${BASE}${link.path}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
