/* Painel do operador: cada entregador tem sua rota, saindo de onde ele está. */
const $ = (id) => document.getElementById(id);
const state = { me: null, drivers: [], deliveries: [], routes: [], picking: null, selected: new Set(), openLink: null };
let map;
let layers;

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const driverById = (id) => state.drivers.find((d) => d.id === id);
const driverColor = (id) => {
  const i = state.drivers.findIndex((d) => d.id === id);
  return i >= 0 ? COLORS[i % COLORS.length] : '#888';
};
const routeOf = (driverId) => state.routes.find((r) => r.driver_id === driverId);
const ago = (sqlDate) => {
  if (!sqlDate) return '';
  const min = Math.round((Date.now() - new Date(sqlDate.replace(' ', 'T') + 'Z')) / 60000);
  return min < 1 ? 'agora' : min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
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
  await refresh(true);
}

async function refresh(fit = false) {
  const date = $('date').value;
  [state.drivers, state.deliveries, state.routes] = await Promise.all([
    api('/api/drivers'),
    api(`/api/deliveries?date=${date}`),
    api(`/api/routes?date=${date}`),
  ]);
  const ids = new Set(state.deliveries.map((d) => d.id));
  state.selected.forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
  render(fit);
}

$('date').addEventListener('change', () => { state.selected.clear(); refresh(true); });

// ---------- abas no celular ----------
document.querySelectorAll('.mobile-tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.mobile-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('app').classList.toggle('show-map', b.dataset.view === 'map');
  if (map) setTimeout(() => map.invalidateSize(), 50);
}));
const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
function showMapOnMobile() {
  if (isMobile()) document.querySelector('.mobile-tabs [data-view=map]').click();
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
    : 'Sem base padrão.';
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
$('saveSettings').addEventListener('click', () => saveSettings().then(() => toast('Preferências salvas.')).catch((e) => toast(e.message)));

$('depotFromInput').addEventListener('click', async () => {
  const r = await api('/api/parse', { method: 'POST', body: { input: $('depotInput').value } });
  if (r.error) return toast(r.error);
  await saveSettings({ depot_lat: r.lat, depot_lng: r.lng, depot_address: r.address || $('depotInput').value });
  $('depotInput').value = '';
  map.setView([r.lat, r.lng], 14);
  toast('Base padrão definida.');
});
$('depotPick').addEventListener('click', () => {
  state.picking = { type: 'depot' };
  showMapOnMobile();
  toast('Clique no mapa onde fica a base.');
});

async function onMapClick(e) {
  const p = state.picking;
  if (!p) return;
  state.picking = null;
  const { lat, lng } = e.latlng;
  if (p.type === 'depot') {
    await saveSettings({ depot_lat: lat, depot_lng: lng, depot_address: 'Marcado no mapa' });
    toast('Base padrão definida.');
  } else if (p.type === 'driver') {
    await setDriverStart(p.id, lat, lng, 'Marcado no mapa');
  }
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

async function setDriverStart(id, lat, lng, address) {
  try {
    await api(`/api/drivers/${id}`, { method: 'PUT', body: { start_lat: lat, start_lng: lng, start_address: address } });
    const d = driverById(id);
    const hasRoute = routeOf(id);
    toast(hasRoute ? `Partida de ${d?.name} atualizada. Clique em “Gerar rota” para recalcular.` : `Partida de ${d?.name} definida.`);
    await refresh();
  } catch (err) { toast(err.message); }
}

function renderDrivers() {
  const counts = {};
  for (const d of state.deliveries) {
    if (d.driver_id && d.status === 'pendente') counts[d.driver_id] = (counts[d.driver_id] || 0) + 1;
  }
  const m = state.me;
  $('drivers').innerHTML = state.drivers.length ? state.drivers.map((d) => {
    const start = d.start_lat != null
      ? `📍 ${esc(d.start_address || 'Partida definida')} · ${ago(d.start_updated_at)}`
      : m.depot_lat != null ? '📍 Sai da base padrão' : '<span class="status-falhou">⚠️ Sem ponto de partida</span>';
    return `
    <li>
      <span class="badge" style="background:${driverColor(d.id)}">${counts[d.id] || 0}</span>
      <div class="grow">
        <div class="title">${esc(d.name)} <span class="muted">${esc(d.phone || '')}</span></div>
        <div class="muted">${start}</div>
        <div class="row" style="margin-top:.35rem">
          <button type="button" class="small" data-start="${d.id}">📍 Partida</button>
          <button type="button" class="small" data-start-map="${d.id}" title="Marcar no mapa">🗺️</button>
          <button type="button" class="small primary" data-plan="${d.id}" ${counts[d.id] ? '' : 'disabled'}>Gerar rota</button>
        </div>
      </div>
      <button class="small danger" data-driver-del="${d.id}" title="Remover">✕</button>
    </li>`;
  }).join('') : '<li class="muted">Cadastre os entregadores.</li>';

  const options = '<option value="">Sem entregador</option>'
    + state.drivers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  document.querySelectorAll('select.driver-select').forEach((s) => {
    const v = s.value;
    s.innerHTML = options;
    s.value = v;
  });
}

$('drivers').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.driverDel) {
    if (confirm('Remover este entregador? As entregas dele ficam sem entregador.')) {
      await api(`/api/drivers/${b.dataset.driverDel}`, { method: 'DELETE' });
      await refresh();
    }
  } else if (b.dataset.start) {
    const d = driverById(Number(b.dataset.start));
    const input = prompt(`Onde ${d.name} está agora? Cole a localização/link que ele mandou no WhatsApp.`);
    if (!input) return;
    const r = await api('/api/parse', { method: 'POST', body: { input } });
    if (r.error) return toast(r.error);
    await setDriverStart(d.id, r.lat, r.lng, r.address || 'Localização do WhatsApp');
  } else if (b.dataset.startMap) {
    const d = driverById(Number(b.dataset.startMap));
    state.picking = { type: 'driver', id: d.id };
    showMapOnMobile();
    toast(`Clique no mapa onde ${d.name} está.`);
  } else if (b.dataset.plan) {
    await planRoutes([Number(b.dataset.plan)], b);
  }
});

// ---------- link para o cliente ----------
const customerLink = (token) => `${location.origin}/r/${token}`;

function shareBox(d, token) {
  const link = customerLink(token);
  const name = firstWord(d.customer_name);
  const msg = encodeURIComponent(
    `Olá${name ? ` ${name}` : ''}! Aqui é da ${state.me.name}. Para receber sua encomenda, marque no mapa onde você quer receber: ${link}\n`
    + 'Pelo mesmo link você acompanha a entrega. 😉',
  );
  const wa = d.phone ? `https://wa.me/${waPhone(d.phone)}?text=${msg}` : `https://wa.me/?text=${msg}`;
  return `
    <div class="link-box">
      <div class="muted" style="overflow-wrap:anywhere">${esc(link)}</div>
      <div class="row" style="margin-top:.4rem">
        <a href="${wa}" target="_blank" rel="noopener"><button type="button" class="small primary" style="width:100%">Enviar no WhatsApp</button></a>
        <button type="button" class="small" data-copy="${esc(link)}">Copiar link</button>
      </div>
    </div>`;
}
const firstWord = (s) => String(s || '').trim().split(/\s+/)[0];

async function getLink(id) {
  const r = await api(`/api/deliveries/${id}/link`, { method: 'POST' });
  return r.token;
}

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('linkName').value.trim();
  if (!name) return toast('Informe o nome do cliente ou o número do pedido.');
  try {
    const { delivery } = await api('/api/deliveries', {
      method: 'POST',
      body: { date: $('date').value, customer_name: name, phone: $('linkPhone').value, driver_id: $('linkDriver').value || null },
    });
    const token = await getLink(delivery.id);
    $('linkResult').innerHTML = `<p class="muted" style="margin:.6rem 0 0">Link criado para <b>${esc(name)}</b>:</p>${shareBox(delivery, token)}`;
    $('linkName').value = '';
    $('linkPhone').value = '';
    await refresh();
  } catch (err) { toast(err.message); }
});

document.addEventListener('click', async (e) => {
  const link = e.target.closest('[data-copy]')?.dataset.copy;
  if (!link || e.target.closest('#routes')) return;
  await navigator.clipboard.writeText(link).catch(() => {});
  toast('Link copiado.');
});

// confirmações dos clientes aparecem sem recarregar a página
setInterval(() => {
  if (!state.me || document.visibilityState !== 'visible' || state.picking) return;
  if (document.activeElement?.closest('#deliveries, #drivers')) return;
  refresh().catch(() => {});
}, 30000);

// ---------- entregas ----------
$('bulkAdd').addEventListener('click', async () => {
  const text = $('bulkText').value.trim();
  if (!text) return;
  $('bulkAdd').disabled = true;
  $('bulkResult').textContent = 'Lendo localizações…';
  try {
    const { results } = await api('/api/deliveries/bulk', {
      method: 'POST',
      body: { date: $('date').value, text, driver_id: $('bulkDriver').value || null },
    });
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

function customerChip(d) {
  if (d.customer_confirmed_at) return ' <span class="chip ok" title="O cliente marcou o local no mapa">✅ confirmado pelo cliente</span>';
  if (d.public_token && d.status === 'pendente') return ' <span class="chip wait" title="Link enviado; o cliente ainda não marcou o local">⏳ aguardando cliente</span>';
  return '';
}

function renderDeliveries() {
  const ds = state.deliveries;
  const pending = ds.filter((d) => d.status === 'pendente');
  const unassigned = pending.filter((d) => !d.driver_id).length;
  $('countInfo').textContent = ds.length ? `(${ds.length} · ${pending.length} pendentes${unassigned ? ` · ${unassigned} sem entregador` : ''})` : '';
  $('assignBar').classList.toggle('hidden', !pending.length);
  $('selectAll').checked = pending.length > 0 && pending.every((d) => state.selected.has(d.id));

  const options = (sel) => '<option value="">Sem entregador</option>'
    + state.drivers.map((dr) => `<option value="${dr.id}" ${dr.id === sel ? 'selected' : ''}>${esc(dr.name)}</option>`).join('');

  $('deliveries').innerHTML = ds.length ? ds.map((d) => {
    const color = d.status !== 'pendente' ? '#999' : driverColor(d.driver_id);
    const statusTxt = d.status === 'pendente' ? '' : ` · <span class="status-${d.status}">${d.status}</span>`;
    const where = d.lat != null ? esc(d.address || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`) : '<span class="status-falhou">⚠️ sem localização</span>';
    return `
    <li>
      ${d.status === 'pendente'
        ? `<input type="checkbox" data-sel="${d.id}" ${state.selected.has(d.id) ? 'checked' : ''} style="width:auto;margin-top:.35rem" aria-label="Selecionar">`
        : '<span style="width:13px"></span>'}
      <span class="badge" style="background:${color}">${d.stop_order || '•'}</span>
      <div class="grow">
        <div class="title">${esc(d.customer_name || 'Sem nome')}${d.eta && d.status === 'pendente' ? ` <span class="muted">≈ ${esc(d.eta)}</span>` : ''}${customerChip(d)}</div>
        <div class="muted">${where}${statusTxt}</div>
        ${d.reference ? `<div class="muted">📝 ${esc(d.reference)}</div>` : ''}
        ${state.openLink?.id === d.id ? shareBox(d, state.openLink.token) : ''}
        ${d.status === 'pendente'
          ? `<select data-assign="${d.id}" style="margin-top:.3rem;padding:.2rem .4rem" aria-label="Entregador">${options(d.driver_id)}</select>`
          : `<div class="muted">${esc(driverById(d.driver_id)?.name || '')}</div>`}
      </div>
      <button class="small" data-link="${d.id}" title="Link para o cliente marcar o local e acompanhar">🔗</button>
      <button class="small" data-locate="${d.id}" title="Marcar/ajustar no mapa">📍</button>
      <button class="small" data-edit="${d.id}" title="Editar">✏️</button>
      <button class="small danger" data-del="${d.id}" title="Excluir">✕</button>
    </li>`;
  }).join('') : '<li class="muted">Nenhuma entrega nesta data.</li>';
}

$('selectAll').addEventListener('change', (e) => {
  for (const d of state.deliveries) {
    if (d.status !== 'pendente') continue;
    if (e.target.checked) state.selected.add(d.id); else state.selected.delete(d.id);
  }
  renderDeliveries();
});

$('assignBtn').addEventListener('click', async () => {
  if (!state.selected.size) return toast('Marque as entregas que quer atribuir.');
  const driverId = $('assignDriver').value || null;
  const r = await api('/api/deliveries/assign', { method: 'POST', body: { ids: [...state.selected], driver_id: driverId } });
  state.selected.clear();
  const name = driverId ? driverById(Number(driverId))?.name : null;
  toast(`${r.changed} entrega(s) ${name ? `atribuída(s) a ${name}` : 'sem entregador'}. Gere a rota para recalcular.`);
  await refresh();
});

$('deliveries').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.sel) {
    if (t.checked) state.selected.add(Number(t.dataset.sel)); else state.selected.delete(Number(t.dataset.sel));
    const pending = state.deliveries.filter((d) => d.status === 'pendente');
    $('selectAll').checked = pending.every((d) => state.selected.has(d.id));
  } else if (t.dataset.assign) {
    await api(`/api/deliveries/${t.dataset.assign}`, { method: 'PUT', body: { driver_id: t.value || null } });
    await refresh();
  }
});

$('deliveries').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = state.deliveries.find((x) => String(x.id) === (t.dataset.locate || t.dataset.edit || t.dataset.del || t.dataset.link));
  if (!d) return;
  if (t.dataset.link) {
    state.openLink = state.openLink?.id === d.id ? null : { id: d.id, token: await getLink(d.id) };
    return renderDeliveries();
  }
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
    if (d.lat == null) {
      const c = map.getCenter();
      await api(`/api/deliveries/${d.id}`, { method: 'PUT', body: { lat: c.lat, lng: c.lng } });
      await refresh();
      toast('Arraste o pino até o local correto.');
    } else {
      map.setView([d.lat, d.lng], 17);
    }
  }
});

// ---------- mapa ----------
function driverStartIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div class="depot-pin" style="background:${color}">🛵</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function render(fit = false) {
  renderDrivers();
  renderDeliveries();
  renderRoutes();
  layers.clearLayers();
  const bounds = [];
  const m = state.me;
  if (m.depot_lat != null) {
    L.marker([m.depot_lat, m.depot_lng], { icon: depotIcon(), zIndexOffset: 900 }).bindPopup('Base padrão').addTo(layers);
    bounds.push([m.depot_lat, m.depot_lng]);
  }
  for (const r of state.routes) {
    if (r.geometry) L.geoJSON(r.geometry, { style: { color: driverColor(r.driver_id), weight: 5, opacity: 0.75 } }).addTo(layers);
  }
  for (const dr of state.drivers) {
    if (dr.start_lat == null) continue;
    L.marker([dr.start_lat, dr.start_lng], { icon: driverStartIcon(driverColor(dr.id)), zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(dr.name)}</b><br>Ponto de partida ${esc(ago(dr.start_updated_at))}`).addTo(layers);
    bounds.push([dr.start_lat, dr.start_lng]);
  }
  for (const d of state.deliveries) {
    if (d.lat == null) continue;
    const color = d.status !== 'pendente' ? '#999' : d.driver_id ? driverColor(d.driver_id) : '#555';
    const drName = driverById(d.driver_id)?.name;
    const marker = L.marker([d.lat, d.lng], { icon: numberedIcon(d.stop_order || '•', color), draggable: d.status === 'pendente' })
      .bindPopup(`<b>${esc(d.customer_name || 'Sem nome')}</b><br>${esc(drName ? `Entregador: ${drName}` : 'Sem entregador')}${d.reference ? `<br>📝 ${esc(d.reference)}` : ''}${d.notes ? `<br><i>${esc(d.notes)}</i>` : ''}${d.eta ? `<br>Chegada ≈ ${esc(d.eta)}` : ''}<br><span class="muted">Arraste para ajustar</span>`)
      .addTo(layers);
    marker.on('dragend', async () => {
      const p = marker.getLatLng();
      await api(`/api/deliveries/${d.id}`, { method: 'PUT', body: { lat: p.lat, lng: p.lng, address: 'Ajustado no mapa' } });
      toast('Local atualizado. Gere a rota de novo para recalcular.');
      refresh();
    });
    bounds.push([d.lat, d.lng]);
  }
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
}

// ---------- rotas ----------
async function planRoutes(driverIds, button) {
  if (button) button.disabled = true;
  $('planInfo').textContent = 'Calculando…';
  try {
    const r = await api('/api/routes/plan', { method: 'POST', body: { date: $('date').value, driver_ids: driverIds } });
    const ok = r.results.filter((x) => x.ok);
    const bad = r.results.filter((x) => !x.ok);
    const first = ok[0];
    const how = first
      ? ` (${first.engine === 'vroom' ? 'VROOM' : 'otimizador embutido'}, ${first.matrixSource === 'osrm' ? 'distâncias reais pelas ruas' : 'distâncias estimadas; configure o OSRM para precisão'})`
      : '';
    $('planInfo').innerHTML = (ok.length ? `Rota gerada: ${ok.map((x) => esc(x.name)).join(', ')}${how}.` : '')
      + (bad.length ? `<span class="warn" style="display:block;margin-top:.3rem">${bad.map((x) => `${esc(x.name)}: ${esc(x.error)}`).join('<br>')}</span>` : '');
    await refresh(true);
    if (ok.length) showMapOnMobile();
  } catch (err) {
    $('planInfo').textContent = err.message;
  } finally {
    if (button) button.disabled = false;
  }
}

$('planBtn').addEventListener('click', () => {
  const unassigned = state.deliveries.filter((d) => d.status === 'pendente' && !d.driver_id).length;
  if (unassigned && !confirm(`${unassigned} entrega(s) ainda estão sem entregador e ficarão de fora. Continuar?`)) return;
  planRoutes(null, $('planBtn'));
});

function renderRoutes() {
  $('routes').innerHTML = state.routes.map((r) => {
    const link = `${location.origin}/e/${r.token}`;
    const msg = encodeURIComponent(`Olá ${r.driver_name || ''}! Sua rota de hoje (${r.stops} entregas): ${link}`);
    const wa = r.driver_phone ? `https://wa.me/${waPhone(r.driver_phone)}?text=${msg}` : `https://wa.me/?text=${msg}`;
    return `
    <div class="route-card" style="border-color:${driverColor(r.driver_id)}">
      <div class="title">${esc(r.driver_name || 'Entregador removido')}</div>
      <div class="muted">${r.stops} paradas · ${fmtKm(r.distance_m)} · ${fmtDuration(r.duration_s)} · ${r.done}/${r.stops} concluídas</div>
      <div class="row" style="margin-top:.3rem">
        <a href="${wa}" target="_blank" rel="noopener"><button type="button" class="small">Enviar no WhatsApp</button></a>
        <a href="${link}" target="_blank" rel="noopener"><button type="button" class="small">Abrir</button></a>
        <button type="button" class="small" data-copy="${esc(link)}">Copiar link</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted">Atribua entregas aos entregadores e gere as rotas: individualmente (“Gerar rota” no entregador) ou de todos de uma vez.</p>';
}
$('routes').addEventListener('click', async (e) => {
  const link = e.target.dataset.copy;
  if (link) {
    await navigator.clipboard.writeText(link).catch(() => {});
    toast('Link copiado.');
  }
});

start();
