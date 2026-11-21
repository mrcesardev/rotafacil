/* Painel do operador */
const $ = (id) => document.getElementById(id);
const state = { me: null, drivers: [], deliveries: [], routes: [], pickingDepot: false };
let map;
let layers;

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// ---------- autenticação ----------
let authMode = 'login';
document.querySelectorAll('#auth .tabs button').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.mode;
  document.querySelectorAll('#auth .tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('nameField').classList.toggle('hidden', authMode !== 'register');
  $('authPassword').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
}));

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').classList.add('hidden');
  try {
    await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: { name: $('authName').value, email: $('authEmail').value, password: $('authPassword').value },
    });
    await start();
  } catch (err) {
    $('authError').textContent = err.message;
    $('authError').classList.remove('hidden');
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ---------- inicialização ----------
async function start() {
  try {
    state.me = await api('/api/me');
  } catch {
    $('auth').classList.remove('hidden');
    $('app').classList.add('hidden');
    return;
  }
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  if (!map) {
    ({ map } = await makeMap('map'));
    layers = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
  }
  $('date').value = $('date').value || localToday();
  fillSettings();
  if (state.me.depot_lat == null) {
    $('settings').classList.remove('hidden');
    toast('Comece definindo o ponto de partida (base) dos entregadores.');
  }
  await refresh(true);
}

async function refresh(fit = false) {
  const date = $('date').value;
  [state.drivers, state.deliveries, state.routes] = await Promise.all([
    api('/api/drivers'),
    api(`/api/deliveries?date=${date}`),
    api(`/api/routes?date=${date}`),
  ]);
  render(fit);
}

$('date').addEventListener('change', () => refresh(true));

// ---------- abas no celular ----------
document.querySelectorAll('.mobile-tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.mobile-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('app').classList.toggle('show-map', b.dataset.view === 'map');
  if (map) setTimeout(() => map.invalidateSize(), 50);
}));
function showMapOnMobile() {
  if (window.matchMedia('(max-width: 800px)').matches) document.querySelector('.mobile-tabs [data-view=map]').click();
}

// ---------- configurações ----------
function fillSettings() {
  const m = state.me;
  $('startTime').value = m.start_time;
  $('serviceMin').value = m.service_minutes;
  $('returnDepot').checked = m.return_to_depot;
  $('waId').value = m.whatsapp_phone_number_id || '';
  $('depotInfo').textContent = m.depot_lat != null
    ? `Base: ${m.depot_address || ''} (${m.depot_lat.toFixed(5)}, ${m.depot_lng.toFixed(5)})`
    : 'Base ainda não definida.';
}
$('toggleSettings').addEventListener('click', () => $('settings').classList.toggle('hidden'));

async function saveSettings(extra = {}) {
  state.me = await api('/api/settings', {
    method: 'PUT',
    body: {
      start_time: $('startTime').value || '08:00',
      service_minutes: $('serviceMin').value,
      return_to_depot: $('returnDepot').checked,
      whatsapp_phone_number_id: $('waId').value,
      ...extra,
    },
  });
  fillSettings();
  render();
}
$('saveSettings').addEventListener('click', () => saveSettings().then(() => toast('Configurações salvas.')).catch((e) => toast(e.message)));

$('depotFromInput').addEventListener('click', async () => {
  const r = await api('/api/parse', { method: 'POST', body: { input: $('depotInput').value } });
  if (r.error) return toast(r.error);
  await saveSettings({ depot_lat: r.lat, depot_lng: r.lng, depot_address: r.address || $('depotInput').value });
  map.setView([r.lat, r.lng], 14);
  toast('Base definida.');
});
$('depotPick').addEventListener('click', () => {
  state.pickingDepot = true;
  showMapOnMobile();
  toast('Clique no mapa onde fica a base.');
});
async function onMapClick(e) {
  if (!state.pickingDepot) return;
  state.pickingDepot = false;
  await saveSettings({ depot_lat: e.latlng.lat, depot_lng: e.latlng.lng, depot_address: 'Marcado no mapa' });
  toast('Base definida.');
}

// ---------- entregadores ----------
$('driverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/drivers', { method: 'POST', body: { name: $('driverName').value, phone: $('driverPhone').value } });
    $('driverName').value = '';
    $('driverPhone').value = '';
    await refresh();
  } catch (err) { toast(err.message); }
});

function renderDrivers() {
  $('drivers').innerHTML = state.drivers.length ? state.drivers.map((d) => `
    <li>
      <input type="checkbox" data-driver-active="${d.id}" ${d.active ? 'checked' : ''} style="width:auto;margin-top:.2rem" title="Trabalha hoje">
      <div class="grow">
        <div class="title">${esc(d.name)}</div>
        <div class="muted">${esc(d.phone || 'sem telefone')} · máx. paradas:
          <input type="number" min="0" value="${d.max_stops || ''}" placeholder="∞" data-driver-max="${d.id}" style="width:4.5rem;padding:.1rem .3rem">
        </div>
      </div>
      <button class="small danger" data-driver-del="${d.id}" title="Remover">✕</button>
    </li>`).join('') : '<li class="muted">Cadastre pelo menos um entregador.</li>';
}
$('drivers').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.driverActive) await api(`/api/drivers/${t.dataset.driverActive}`, { method: 'PUT', body: { active: t.checked } });
  if (t.dataset.driverMax) await api(`/api/drivers/${t.dataset.driverMax}`, { method: 'PUT', body: { max_stops: t.value } });
  await refresh();
});
$('drivers').addEventListener('click', async (e) => {
  const id = e.target.dataset.driverDel;
  if (id && confirm('Remover este entregador?')) {
    await api(`/api/drivers/${id}`, { method: 'DELETE' });
    await refresh();
  }
});

// ---------- entregas ----------
$('bulkAdd').addEventListener('click', async () => {
  const text = $('bulkText').value.trim();
  if (!text) return;
  $('bulkAdd').disabled = true;
  $('bulkResult').textContent = 'Lendo localizações…';
  try {
    const { results } = await api('/api/deliveries/bulk', { method: 'POST', body: { date: $('date').value, text } });
    const bad = results.filter((r) => !r.ok);
    $('bulkResult').innerHTML = `${results.length - bad.length} de ${results.length} localizadas.`
      + (bad.length ? `<br><span class="warn" style="display:block;margin-top:.3rem">Sem localização: ${bad.map((b) => esc(b.name || `#${b.id}`)).join(', ')}. Use “📍” na lista para marcar no mapa.</span>` : '');
    $('bulkText').value = '';
    await refresh(true);
  } catch (err) {
    $('bulkResult').textContent = err.message;
  } finally {
    $('bulkAdd').disabled = false;
  }
});

const driverColor = (driverId) => {
  const i = state.routes.findIndex((r) => r.driver_id === driverId);
  return i >= 0 ? COLORS[i % COLORS.length] : '#888';
};

function renderDeliveries() {
  const ds = state.deliveries;
  const pending = ds.filter((d) => d.status === 'pendente').length;
  $('countInfo').textContent = ds.length ? `(${ds.length} · ${pending} pendentes)` : '';
  $('deliveries').innerHTML = ds.length ? ds.map((d) => {
    const color = d.route_id ? driverColor(d.driver_id) : '#888';
    const statusTxt = d.status === 'pendente' ? '' : ` · <span class="status-${d.status}">${d.status}</span>`;
    return `
    <li>
      <span class="badge" style="background:${color}">${d.stop_order || '•'}</span>
      <div class="grow">
        <div class="title">${esc(d.customer_name || 'Sem nome')}${d.eta ? ` <span class="muted">≈ ${esc(d.eta)}</span>` : ''}</div>
        <div class="muted">${d.lat != null ? esc(d.address || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`) : '<span class="status-falhou">⚠️ sem localização</span>'}${statusTxt}</div>
      </div>
      <button class="small" data-locate="${d.id}" title="Marcar/ajustar no mapa">📍</button>
      <button class="small" data-edit="${d.id}" title="Editar">✏️</button>
      <button class="small danger" data-del="${d.id}" title="Excluir">✕</button>
    </li>`;
  }).join('') : '<li class="muted">Nenhuma entrega nesta data.</li>';
}

$('deliveries').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = state.deliveries.find((x) => String(x.id) === (t.dataset.locate || t.dataset.edit || t.dataset.del));
  if (!d) return;
  if (t.dataset.del && confirm(`Excluir a entrega de ${d.customer_name || 'cliente sem nome'}?`)) {
    await api(`/api/deliveries/${d.id}`, { method: 'DELETE' });
    return refresh();
  }
  if (t.dataset.edit) {
    const name = prompt('Nome do cliente', d.customer_name || '');
    if (name === null) return;
    const notes = prompt('Observações (ex.: apto, ponto de referência)', d.notes || '');
    await api(`/api/deliveries/${d.id}`, { method: 'PUT', body: { customer_name: name, notes: notes ?? d.notes } });
    return refresh();
  }
  if (t.dataset.locate) {
    showMapOnMobile();
    const center = d.lat != null ? [d.lat, d.lng] : map.getCenter();
    if (d.lat == null) {
      await api(`/api/deliveries/${d.id}`, { method: 'PUT', body: { lat: center.lat, lng: center.lng } });
      await refresh();
      toast('Arraste o pino até o local correto.');
    } else {
      map.setView(center, 17);
    }
  }
});

// ---------- mapa ----------
function render(fit = false) {
  renderDrivers();
  renderDeliveries();
  renderRoutes();
  layers.clearLayers();
  const bounds = [];
  const m = state.me;
  if (m.depot_lat != null) {
    L.marker([m.depot_lat, m.depot_lng], { icon: depotIcon(), zIndexOffset: 1000 }).bindPopup('Base').addTo(layers);
    bounds.push([m.depot_lat, m.depot_lng]);
  }
  state.routes.forEach((r, i) => {
    if (r.geometry) {
      L.geoJSON(r.geometry, { style: { color: COLORS[i % COLORS.length], weight: 5, opacity: 0.75 } }).addTo(layers);
    }
  });
  for (const d of state.deliveries) {
    if (d.lat == null) continue;
    const color = d.status !== 'pendente' ? '#999' : d.route_id ? driverColor(d.driver_id) : '#555';
    const marker = L.marker([d.lat, d.lng], { icon: numberedIcon(d.stop_order || '•', color), draggable: d.status === 'pendente' })
      .bindPopup(`<b>${esc(d.customer_name || 'Sem nome')}</b><br>${esc(d.address || '')}${d.notes ? `<br><i>${esc(d.notes)}</i>` : ''}${d.eta ? `<br>Chegada ≈ ${esc(d.eta)}` : ''}<br><span class="muted">Arraste para ajustar</span>`)
      .addTo(layers);
    marker.on('dragend', async () => {
      const p = marker.getLatLng();
      await api(`/api/deliveries/${d.id}`, { method: 'PUT', body: { lat: p.lat, lng: p.lng, address: 'Ajustado no mapa' } });
      toast('Local atualizado. Gere as rotas de novo para recalcular.');
      refresh();
    });
    bounds.push([d.lat, d.lng]);
  }
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
}

// ---------- rotas ----------
$('planBtn').addEventListener('click', async () => {
  const active = state.drivers.filter((d) => d.active);
  if (!active.length) return toast('Cadastre/ative pelo menos um entregador.');
  if (state.routes.length && !confirm('Isso substitui as rotas atuais desta data (os links antigos param de funcionar). Continuar?')) return;
  $('planBtn').disabled = true;
  $('planInfo').textContent = 'Calculando…';
  try {
    const r = await api('/api/routes/plan', {
      method: 'POST',
      body: { date: $('date').value, driver_ids: active.map((d) => d.id), balance: $('balance').checked },
    });
    const engine = r.engine === 'vroom' ? 'VROOM' : 'otimizador embutido';
    const dist = r.matrixSource === 'osrm' ? 'distâncias reais pelas ruas (OSRM)' : 'distâncias estimadas (configure o OSRM para precisão)';
    $('planInfo').innerHTML = `Calculado com ${engine}, ${dist}.`
      + (r.unassigned.length ? `<br><span class="warn" style="display:block">${r.unassigned.length} entrega(s) não couberam no limite de paradas.</span>` : '');
    await refresh(true);
    showMapOnMobile();
  } catch (err) {
    $('planInfo').textContent = err.message;
  } finally {
    $('planBtn').disabled = false;
  }
});

function renderRoutes() {
  const total = state.routes.reduce((a, r) => ({ d: a.d + r.distance_m, t: Math.max(a.t, r.duration_s) }), { d: 0, t: 0 });
  $('routes').innerHTML = state.routes.map((r, i) => {
    const link = `${location.origin}/e/${r.token}`;
    const msg = encodeURIComponent(`Olá ${r.driver_name || ''}! Sua rota de hoje (${r.stops} entregas): ${link}`);
    const wa = r.driver_phone ? `https://wa.me/${waPhone(r.driver_phone)}?text=${msg}` : `https://wa.me/?text=${msg}`;
    return `
    <div class="route-card" style="border-color:${COLORS[i % COLORS.length]}">
      <div class="title">${esc(r.driver_name || 'Entregador removido')}</div>
      <div class="muted">${r.stops} paradas · ${fmtKm(r.distance_m)} · ${fmtDuration(r.duration_s)} · ${r.done}/${r.stops} concluídas</div>
      <div class="row" style="margin-top:.3rem">
        <a href="${wa}" target="_blank" rel="noopener"><button type="button" class="small">Enviar no WhatsApp</button></a>
        <a href="${link}" target="_blank" rel="noopener"><button type="button" class="small">Abrir</button></a>
        <button type="button" class="small" data-copy="${esc(link)}">Copiar link</button>
      </div>
    </div>`;
  }).join('') + (state.routes.length ? `<p class="muted">Total: ${fmtKm(total.d)} · rota mais longa: ${fmtDuration(total.t)}</p>` : '');
}
$('routes').addEventListener('click', async (e) => {
  const link = e.target.dataset.copy;
  if (link) {
    await navigator.clipboard.writeText(link).catch(() => {});
    toast('Link copiado.');
  }
});

start();
