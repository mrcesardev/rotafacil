/* Página do destinatário: marca onde quer receber e acompanha a entrega. */
const $ = (id) => document.getElementById(id);
const token = location.pathname.split('/').pop();
let data;
let map;
let pin = null;
let editing = false;
let timer = null;

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};
const firstName = (s) => String(s || '').trim().split(/\s+/)[0];

async function load() {
  try {
    data = await api(`/api/r/${token}`);
  } catch (e) {
    $('title').textContent = e.status === 404 ? 'Link inválido' : 'Não foi possível carregar';
    $('subtitle').textContent = e.status === 404 ? 'Confira se o link está completo ou peça um novo à loja.' : e.message;
    $('map').classList.add('hidden');
    return;
  }
  $('store').textContent = data.operator_name;
  document.title = `Sua entrega · ${data.operator_name}`;
  if (!map) await setupMap();
  render();
}

async function setupMap() {
  ({ map } = await makeMap('map'));
  const c = data.lat != null ? [data.lat, data.lng] : data.map_center ? [data.map_center.lat, data.map_center.lng] : null;
  if (c) map.setView(c, data.lat != null ? 18 : 13);
  map.on('click', (e) => { if (isEditing()) placePin(e.latlng.lat, e.latlng.lng); });
}

const isEditing = () => data.phase === 'confirmar' || editing;

function placePin(lat, lng, zoom) {
  if (!pin) {
    pin = L.marker([lat, lng], { draggable: true, icon: homeIcon() }).addTo(map);
  } else {
    pin.setLatLng([lat, lng]);
  }
  pin.dragging[isEditing() ? 'enable' : 'disable']();
  if (zoom) map.setView([lat, lng], zoom);
  $('confirmBtn').disabled = !isEditing();
}

function homeIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="pin" style="background:#0f7b5f;width:34px;height:34px"><span style="font-size:15px">🏠</span></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 34],
  });
}

function render() {
  const editMode = isEditing() && data.editable;
  $('form').classList.toggle('hidden', !editMode);
  $('details').classList.toggle('hidden', !editMode);
  $('statusCard').classList.toggle('hidden', editMode);
  const hello = firstName(data.customer_name);

  if (editMode) {
    $('title').textContent = hello ? `Olá, ${hello}! 👋` : 'Olá! 👋';
    $('subtitle').innerHTML = `<b>${esc(data.operator_name)}</b> vai entregar sua encomenda. <b>Onde você quer receber?</b>`;
    $('name').value = $('name').value || data.customer_name || '';
    $('phone').value = $('phone').value || data.phone || '';
    $('reference').value = $('reference').value || data.reference || '';
    $('consentText').textContent = `Concordo que ${data.operator_name} use minha localização, nome e telefone apenas para realizar esta entrega.`;
    if (data.lat != null && !pin) placePin(data.lat, data.lng, 18);
    if (pin) pin.dragging.enable();
    $('confirmBtn').disabled = !pin;
  } else {
    renderStatus();
    if (data.lat != null) placePin(data.lat, data.lng, pin ? null : 17);
  }
  setTimeout(() => map.invalidateSize(), 50);

  clearInterval(timer);
  if (!editMode && (data.phase === 'confirmado' || data.phase === 'em_rota')) {
    timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
  }
}

function renderStatus() {
  const ref = data.reference ? `<p class="muted">Referência: ${esc(data.reference)}</p>` : '';
  const change = data.editable ? '<button type="button" id="change" style="margin-top:.6rem">Alterar local</button>' : '';
  let html = '';
  switch (data.phase) {
    case 'confirmado':
      $('title').textContent = '✅ Local confirmado';
      $('subtitle').textContent = 'Obrigado! Avisaremos por aqui quando sair para entrega.';
      html = `<p>Guarde este link: por ele você acompanha a entrega.</p>${ref}${change}`;
      break;
    case 'em_rota': {
      const t = data.tracking || {};
      const who = t.driver_first_name ? ` com <b>${esc(t.driver_first_name)}</b>` : '';
      const queue = t.stops_ahead === 0
        ? '<p class="big">Você é a <b>próxima entrega</b>! 🎉</p>'
        : `<p class="big">Faltam <b>${t.stops_ahead}</b> ${t.stops_ahead === 1 ? 'entrega' : 'entregas'} antes da sua.</p>`;
      $('title').textContent = '🛵 Saiu para entrega';
      $('subtitle').innerHTML = `Sua encomenda está a caminho${who}.`;
      html = `${queue}${t.eta ? `<p>Previsão: <b>≈ ${esc(t.eta)}</b> <span class="muted">(pode variar com o trânsito)</span></p>` : ''}${ref}
        <p class="muted">Esta página se atualiza sozinha.</p>`;
      break;
    }
    case 'entregue':
      $('title').textContent = '✅ Entregue';
      $('subtitle').textContent = data.completed_at ? `Sua encomenda foi entregue às ${fmtTime(data.completed_at)}.` : 'Sua encomenda foi entregue.';
      html = `<p>Obrigado por comprar com ${esc(data.operator_name)}!</p>`;
      break;
    case 'falhou':
      $('title').textContent = 'Não conseguimos entregar';
      $('subtitle').textContent = `${data.operator_name} vai entrar em contato para combinar uma nova entrega.`;
      break;
    default:
      $('title').textContent = 'Entrega em preparação';
      $('subtitle').textContent = `Fale com ${data.operator_name} para informar o local de entrega.`;
  }
  $('statusCard').innerHTML = html;
  $('statusCard').classList.toggle('hidden', !html);
  const btn = $('change');
  if (btn) btn.addEventListener('click', () => { editing = true; render(); });
}

// ---------- localização ----------
$('gps').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Seu celular não permite pegar a localização. Use a busca ou toque no mapa.');
  const btn = $('gps');
  btn.disabled = true;
  btn.textContent = 'Pegando sua localização…';
  navigator.geolocation.getCurrentPosition((pos) => {
    placePin(pos.coords.latitude, pos.coords.longitude, 18);
    btn.disabled = false;
    btn.textContent = '📍 Usar minha localização atual';
    toast(pos.coords.accuracy > 60
      ? 'Localização aproximada. Arraste o pino até a entrada certa.'
      : 'Confira se o pino está na entrada certa.');
  }, (err) => {
    btn.disabled = false;
    btn.textContent = '📍 Usar minha localização atual';
    toast(err.code === 1 ? 'Permissão negada. Use a busca ou toque no mapa.' : 'Não consegui pegar a localização. Use a busca ou toque no mapa.');
  }, { enableHighAccuracy: true, timeout: 20000 });
});

async function doSearch() {
  const q = $('search').value.trim();
  if (q.length < 4) return toast('Digite pelo menos rua e número.');
  $('searchBtn').disabled = true;
  try {
    const results = await api(`/api/r/${token}/search?q=${encodeURIComponent(q)}`);
    $('results').innerHTML = results.length
      ? results.map((r, i) => `<li><button type="button" class="small" data-i="${i}" style="text-align:left;width:100%">${esc(r.address)}</button></li>`).join('')
      : '<li class="muted">Nada encontrado. Tente outro termo ou toque no mapa.</li>';
    $('results').onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const r = results[Number(b.dataset.i)];
      placePin(r.lat, r.lng, 18);
      $('results').innerHTML = '';
      toast('Ajuste o pino até a entrada certa.');
    };
  } catch (e) {
    toast(e.message);
  } finally {
    $('searchBtn').disabled = false;
  }
}
$('searchBtn').addEventListener('click', doSearch);
$('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

// ---------- confirmar ----------
$('details').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('formError').classList.add('hidden');
  const fail = (msg) => { $('formError').textContent = msg; $('formError').classList.remove('hidden'); };
  if (!pin) return fail('Marque no mapa onde você quer receber.');
  if (!$('name').value.trim()) return fail('Informe seu nome.');
  if (!$('consent').checked) return fail('Para continuar, marque a caixa de concordância.');
  const p = pin.getLatLng();
  $('confirmBtn').disabled = true;
  try {
    data = await api(`/api/r/${token}`, {
      method: 'POST',
      body: {
        lat: p.lat, lng: p.lng, customer_name: $('name').value, phone: $('phone').value,
        reference: $('reference').value, consent: true,
      },
    });
    editing = false;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    fail(err.message);
    $('confirmBtn').disabled = false;
  }
});

load();
