/* Página do entregador: abre pelo link enviado no WhatsApp, sem login. */
const token = location.pathname.split('/').pop();
let map;
let layer;
let data;

async function load(fit = false) {
  try {
    data = await api(`/api/driver/${token}`);
  } catch (e) {
    document.getElementById('title').textContent = e.message;
    document.getElementById('map').classList.add('hidden');
    return;
  }
  const done = data.stops.filter((s) => s.status !== 'pendente').length;
  document.getElementById('title').textContent = `Rota de ${data.driver_name || 'entregador'}`;
  document.getElementById('summary').textContent =
    `${data.date.split('-').reverse().join('/')} · ${data.stops.length} entregas · ${fmtKm(data.distance_m)} · ${fmtDuration(data.duration_s)} · ${done} concluídas`;

  if (!map) {
    ({ map } = await makeMap('map'));
    layer = L.layerGroup().addTo(map);
  }
  layer.clearLayers();
  const bounds = [];
  if (data.geometry) L.geoJSON(data.geometry, { style: { color: COLORS[0], weight: 5, opacity: 0.7 } }).addTo(layer);
  if (data.depot.lat != null) {
    L.marker([data.depot.lat, data.depot.lng], { icon: depotIcon() }).addTo(layer);
    bounds.push([data.depot.lat, data.depot.lng]);
  }
  const next = data.stops.find((s) => s.status === 'pendente');
  for (const s of data.stops) {
    const color = s.status !== 'pendente' ? '#999' : s === next ? '#0f7b5f' : COLORS[0];
    L.marker([s.lat, s.lng], { icon: numberedIcon(s.stop_order, color) })
      .bindPopup(`<b>${s.stop_order}. ${esc(s.customer_name || 'Cliente')}</b>`).addTo(layer);
    bounds.push([s.lat, s.lng]);
  }
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });

  document.getElementById('stops').innerHTML = data.stops.map((s) => {
    const nav = navLinks(s.lat, s.lng);
    const cls = s.status !== 'pendente' ? 'done' : s === next ? 'next' : '';
    const label = s.status === 'entregue' ? '✅ Entregue' : s.status === 'falhou' ? '❌ Não entregue' : s === next ? '➡️ Próxima' : '';
    return `
    <div class="card stop ${cls}">
      <div class="row">
        <span class="badge shrink" style="background:${s.status !== 'pendente' ? '#999' : COLORS[0]}">${s.stop_order}</span>
        <div>
          <div class="title">${esc(s.customer_name || 'Cliente')} ${label ? `<span class="muted">${label}</span>` : ''}</div>
          <div class="muted">${[s.eta ? `Previsão ≈ ${esc(s.eta)}` : '', esc(s.address || '')].filter(Boolean).join(' · ')}</div>
          ${s.notes ? `<div class="muted"><i>${esc(s.notes)}</i></div>` : ''}
        </div>
      </div>
      <div class="row actions">
        <a href="${nav.google}" target="_blank" rel="noopener"><button type="button" style="width:100%">Google Maps</button></a>
        <a href="${nav.waze}" target="_blank" rel="noopener"><button type="button" style="width:100%">Waze</button></a>
        ${s.phone ? `<a href="https://wa.me/${waPhone(s.phone)}" target="_blank" rel="noopener"><button type="button" style="width:100%">WhatsApp</button></a>` : ''}
      </div>
      <div class="row actions">
        ${s.status === 'pendente'
          ? `<button type="button" class="primary" data-status="entregue" data-id="${s.id}">Entregue</button>
             <button type="button" class="danger" data-status="falhou" data-id="${s.id}">Não entregue</button>`
          : `<button type="button" data-status="pendente" data-id="${s.id}">Desfazer</button>`}
      </div>
    </div>`;
  }).join('');
}

document.getElementById('stops').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b) return;
  let notes;
  if (b.dataset.status === 'falhou') {
    notes = prompt('Motivo (ex.: cliente ausente, endereço não encontrado)');
    if (notes === null) return;
  }
  b.disabled = true;
  try {
    await api(`/api/driver/${token}/stops/${b.dataset.id}`, { method: 'POST', body: { status: b.dataset.status, notes } });
    await load();
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
});

load(true);
