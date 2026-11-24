/* Relatórios por entregador: entregas, km, pontualidade. */
const $ = (id) => document.getElementById(id);
let me;
let data;
let selected = null;
let pins = { items: [], pending: 0 };
let openPin = null;   // entrega com o mapa aberto
let pinMap = null;

const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const km = (x) => `${nf1.format(x)} km`;
const brDate = (d) => d.split('-').reverse().join('/');
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function presetRange(p) {
  const t = me.today;
  const [y, m] = t.split('-').map(Number);
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  if (p === 'today') return [t, t];
  if (p === '7') return [shift(t, -6), t];
  if (p === '30') return [shift(t, -29), t];
  if (p === 'month') return [first(y, m), t];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return [first(py, pm), shift(first(y, m), -1)];
}

async function start() {
  try {
    me = await api('/api/me');
  } catch {
    location.href = '/';
    return;
  }
  const [f, t] = presetRange('7');
  $('from').value = f;
  $('to').value = t;
  markPreset('7');
  await load();
}

function markPreset(p) {
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === p));
}

document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const [f, t] = presetRange(b.dataset.preset);
  $('from').value = f;
  $('to').value = t;
  markPreset(b.dataset.preset);
  load();
}));
$('apply').addEventListener('click', () => { markPreset(null); load(); });

async function load() {
  $('status').textContent = 'Carregando…';
  try {
    const q = `from=${$('from').value}&to=${$('to').value}`;
    [data, pins] = await Promise.all([api(`/api/reports/drivers?${q}`), api(`/api/reports/far-from-pin?${q}`)]);
  } catch (e) {
    $('status').textContent = e.message;
    return;
  }
  $('status').textContent = `${me.name} · ${brDate(data.from)} a ${brDate(data.to)}`;
  if (selected && !data.drivers.some((d) => d.driver_id === selected)) selected = null;
  render();
}

function tile(label, value, sub, alert) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>
    ${sub ? `<div class="tile-sub${alert ? ' alert' : ''}">${alert ? '⚠️ ' : ''}${sub}</div>` : ''}</div>`;
}

function render() {
  const t = data.totals;
  const defs = data.definitions;
  $('tiles').innerHTML = !t.deliveries ? '' : [
    tile('Entregas', nf0.format(t.delivered), `de ${nf0.format(t.deliveries)} em rota · ${nf0.format(t.failed)} falha(s)`),
    tile('Taxa de sucesso', pct(t.success_rate), 'entregues ÷ concluídas'),
    tile('Km planejados', km(t.km_planned), `${nf0.format(t.routes)} rota(s)`),
    tile('Km pelo GPS', km(t.km_gps), t.gps_coverage == null ? 'sem entregas concluídas' : `estimado · GPS em ${pct(t.gps_coverage)} das paradas`, t.gps_coverage != null && t.gps_coverage < 0.7),
    tile('No horário', pct(t.on_time_rate), t.late ? `${t.late} atrasada(s) · média +${t.avg_delay_min} min` : `até ${defs.tolerance_min} min da previsão`),
    tile('Longe do pino', nf0.format(t.far_from_pin),
      pins.pending ? `<a href="#pinCard">${pins.pending} para revisar</a>` : (t.far_from_pin ? 'todas revisadas' : `mais de ${defs.far_from_pin_m} m`),
      pins.pending > 0),
  ].join('');

  const tbody = $('drivers').querySelector('tbody');
  tbody.innerHTML = data.drivers.length ? data.drivers.map((d) => `
    <tr data-driver="${d.driver_id}" class="${d.driver_id === selected ? 'sel' : ''}" tabindex="0">
      <td>${esc(d.name)}${d.archived ? ' <span class="chip">removido</span>' : ''}</td>
      <td class="num">${d.days}</td><td class="num">${d.deliveries}</td><td class="num">${d.delivered}</td>
      <td class="num">${d.failed}</td><td class="num">${pct(d.success_rate)}</td><td class="num">${nf1.format(d.km_planned)}</td>
      <td class="num">${nf1.format(d.km_gps)} <span class="muted">(${pct(d.gps_coverage)})</span></td>
      <td class="num">${pct(d.on_time_rate)}</td><td class="num">${d.late ? `+${d.avg_delay_min} min` : '—'}</td>
      <td class="num">${d.far_from_pin}</td>
    </tr>`).join('')
    : `<tr><td colspan="11" class="muted">Nenhuma rota neste período.</td></tr>`;
  $('drivers').querySelector('tfoot').innerHTML = data.drivers.length > 1 ? `
    <tr><td>Total</td><td class="num">—</td><td class="num">${t.deliveries}</td><td class="num">${t.delivered}</td>
      <td class="num">${t.failed}</td><td class="num">${pct(t.success_rate)}</td><td class="num">${nf1.format(t.km_planned)}</td>
      <td class="num">${nf1.format(t.km_gps)}</td><td class="num">${pct(t.on_time_rate)}</td>
      <td class="num">${t.late ? `+${t.avg_delay_min} min` : '—'}</td><td class="num">${t.far_from_pin}</td></tr>` : '';

  renderDaily();
  renderPins();
  $('defs').innerHTML = `
    <li><b>Entregas</b>: as que estavam na rota do entregador no dia. <b>Sucesso</b> = entregues ÷ (entregues + falhas).</li>
    <li><b>Km planejados</b>: distância da rota gerada pelo operador. Recálculos feitos pelo entregador no meio do dia não entram (cobrem só o trecho restante).</li>
    <li><b>Km pelo GPS</b>: estimativa do caminho real, do ponto de partida até onde o entregador marcou cada parada, na ordem em que marcou (linha reta × ${nf1.format(defs.detour_factor)}). Entre parênteses, em quantas paradas o celular enviou o GPS: quanto maior, mais confiável.</li>
    <li><b>No horário</b>: entregues até ${defs.tolerance_min} min depois da previsão da rota do operador.</li>
    <li><b>Longe do pino</b>: entregues a mais de ${defs.far_from_pin_m} m do local cadastrado. Costuma indicar pino errado: vale corrigir o cadastro do cliente.</li>
    <li>Distâncias são reais pelas ruas só com o OSRM configurado; sem ele, também são estimativas.</li>`;
}

// ---------- entregas longe do pino ----------
const REVIEW_LABEL = { gps: '✅ corrigido para o local do GPS', mapa: '✅ ajustado no mapa', ok: '✔️ pino mantido' };
const fmtM = (m) => (m >= 1000 ? `${nf1.format(m / 1000)} km` : `${m} m`);

function renderPins() {
  $('farM').textContent = pins.far_from_pin_m;
  const show = $('showReviewed').checked;
  const list = pins.items.filter((i) => show || !i.review);
  $('pinCount').textContent = pins.items.length ? `(${pins.pending} para revisar de ${pins.items.length})` : '';
  if (openPin && !list.some((i) => i.delivery_id === openPin)) openPin = null;
  $('pinList').innerHTML = list.length ? list.map((i) => {
    const who = i.anonymized ? '<i>Cliente apagado (LGPD)</i>' : esc(i.customer_name || 'Sem nome');
    const actions = i.review ? `<span class="chip ok">${REVIEW_LABEL[i.review] || i.review}</span>` : `
      <div class="row" style="margin-top:.4rem">
        <button type="button" class="small" data-pin-map="${i.delivery_id}">${openPin === i.delivery_id ? 'Fechar mapa' : '🗺️ Ver no mapa'}</button>
        ${i.anonymized ? '' : `<button type="button" class="small primary" data-pin-gps="${i.delivery_id}">Usar local do GPS</button>`}
        <button type="button" class="small" data-pin-ok="${i.delivery_id}">Pino estava certo</button>
      </div>`;
    return `
    <li>
      <div class="grow">
        <div class="title">${who} <span class="muted">· ${brDate(i.date)} · ${esc(i.driver_name)}</span></div>
        <div class="muted">Marcado a <b>${fmtM(i.distance_m)}</b> do pino${i.reviewed_at ? ` · revisado em ${new Date(i.reviewed_at).toLocaleDateString('pt-BR')}` : ''}</div>
        ${actions}
        ${openPin === i.delivery_id ? `
          <div id="pinMap" class="pin-map"></div>
          <p class="muted pin-legend"><b class="lg p">P</b> pino cadastrado · <b class="lg e"></b> onde o entregador marcou (círculo) · <b class="lg n">✓</b> novo local (arraste)</p>
          <button type="button" class="small primary" data-pin-save="${i.delivery_id}">Salvar o local do marcador ✓</button>` : ''}
      </div>
    </li>`;
  }).join('') : `<li class="muted">${pins.items.length ? 'Tudo revisado neste período. 👍' : 'Nenhuma entrega longe do pino neste período.'}</li>`;
  if (openPin) drawPinMap(pins.items.find((i) => i.delivery_id === openPin));
}

async function drawPinMap(i) {
  if (pinMap) { pinMap.remove(); pinMap = null; }
  ({ map: pinMap } = await makeMap('pinMap'));
  const pin = L.marker([i.lat, i.lng], { icon: numberedIcon('P', '#c0392b') }).bindTooltip('Pino cadastrado').addTo(pinMap);
  // círculo (não pino) para continuar visível embaixo do marcador arrastável, que começa no mesmo ponto
  const gps = L.circleMarker([i.gps_lat, i.gps_lng], { radius: 16, color: '#1e8e3e', weight: 3, fillColor: '#1e8e3e', fillOpacity: 0.2 })
    .bindTooltip('Onde o entregador marcou').addTo(pinMap);
  L.polyline([[i.lat, i.lng], [i.gps_lat, i.gps_lng]], { color: '#888', dashArray: '4 6', weight: 2 }).addTo(pinMap);
  const pick = L.marker([i.gps_lat, i.gps_lng], { icon: numberedIcon('✓', '#1f77b4'), draggable: true, zIndexOffset: 1000 })
    .bindTooltip('Novo local: arraste até a entrada certa').addTo(pinMap);
  pinMap.on('click', (e) => pick.setLatLng(e.latlng));
  pinMap.fitBounds(L.featureGroup([pin, gps]).getBounds(), { padding: [40, 40], maxZoom: 18 });
  drawPinMap.pick = pick;
}

async function review(id, body) {
  try {
    const r = await api(`/api/deliveries/${id}/pin-review`, { method: 'POST', body });
    const extra = r.updated_pending ? ` ${r.updated_pending} entrega(s) pendente(s) do cliente também foram corrigidas.` : '';
    toast(body.decision === 'ok' ? 'Pino mantido.' : `Local do cliente corrigido.${extra}`, 4500);
    openPin = null;
    await load();
  } catch (e) {
    toast(e.message);
  }
}

$('pinList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.pinMap) {
    const id = Number(b.dataset.pinMap);
    openPin = openPin === id ? null : id;
    renderPins();
  } else if (b.dataset.pinGps) {
    review(Number(b.dataset.pinGps), { decision: 'gps' });
  } else if (b.dataset.pinOk) {
    review(Number(b.dataset.pinOk), { decision: 'ok' });
  } else if (b.dataset.pinSave) {
    const p = drawPinMap.pick.getLatLng();
    review(Number(b.dataset.pinSave), { decision: 'mapa', lat: p.lat, lng: p.lng });
  }
});
$('showReviewed').addEventListener('change', renderPins);

function renderDaily() {
  const card = $('dailyCard');
  if (!selected) { card.classList.add('hidden'); return; }
  const d = data.drivers.find((x) => x.driver_id === selected);
  const rows = data.daily.filter((x) => x.driver_id === selected);
  $('dailyTitle').textContent = `Dia a dia · ${d.name}`;
  card.querySelector('tbody').innerHTML = rows.map((r) => `
    <tr><td>${brDate(r.date)}</td><td class="num">${r.deliveries}</td><td class="num">${r.delivered}</td>
      <td class="num">${r.failed}</td><td class="num">${r.pending}</td><td class="num">${nf1.format(r.km_planned)}</td>
      <td class="num">${nf1.format(r.km_gps)} <span class="muted">(${pct(r.gps_coverage)})</span></td>
      <td class="num">${pct(r.on_time_rate)}</td><td class="num">${r.far_from_pin}</td></tr>`).join('');
  card.classList.remove('hidden');
}

function selectRow(tr) {
  if (!tr?.dataset.driver) return;
  const id = Number(tr.dataset.driver);
  selected = selected === id ? null : id;
  render();
  if (selected) $('dailyCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('drivers').addEventListener('click', (e) => selectRow(e.target.closest('tr')));
$('drivers').addEventListener('keydown', (e) => { if (e.key === 'Enter') selectRow(e.target.closest('tr')); });

// planilha dia a dia (abre no Excel / Google Planilhas)
$('csv').addEventListener('click', () => {
  if (!data?.daily.length) return toast('Nada para exportar neste período.');
  const names = new Map(data.drivers.map((d) => [d.driver_id, d.name]));
  const num = (x) => String(x).replace('.', ',');
  const share = (x) => (x == null ? '' : num(Math.round(x * 1000) / 10));
  const head = ['Data', 'Entregador', 'Entregas', 'Entregues', 'Falhas', 'Pendentes', 'Km planejados', 'Km GPS (estimado)',
    'Cobertura GPS %', 'No horário %', 'Atrasadas', 'Atraso médio (min)', 'Longe do pino'];
  const lines = data.daily.map((r) => [brDate(r.date), names.get(r.driver_id) || '', r.deliveries, r.delivered, r.failed, r.pending,
    num(r.km_planned), num(r.km_gps), share(r.gps_coverage), share(r.on_time_rate), r.late, r.avg_delay_min, r.far_from_pin]);
  const cell = (v) => (/[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = '﻿' + [head, ...lines].map((l) => l.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `rotafacil-entregadores-${data.from}-a-${data.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

start();
