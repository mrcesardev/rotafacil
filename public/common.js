/* Utilitários compartilhados entre o painel e a página do entregador. */
const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22'];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 3500) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function fmtKm(m) { return `${(m / 1000).toFixed(1).replace('.', ',')} km`; }
function fmtDuration(s) {
  const min = Math.round(s / 60);
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} min`;
}

function numberedIcon(n, color) {
  return L.divIcon({
    className: '',
    html: `<div class="pin" style="background:${color}"><span>${esc(n)}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -24],
  });
}
function depotIcon() {
  return L.divIcon({ className: '', html: '<div class="depot-pin">🏠</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
}

function navLinks(lat, lng) {
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  };
}

function waPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // número brasileiro sem DDI
  return d;
}

async function makeMap(el) {
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  const map = L.map(el, { zoomControl: true }).setView([-15.78, -47.93], 4);
  const streets = L.tileLayer(cfg.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: cfg.tileAttribution || '&copy; colaboradores do OpenStreetMap',
  }).addTo(map);
  if (cfg.satelliteUrl) {
    const sat = L.tileLayer(cfg.satelliteUrl, { maxZoom: 19, attribution: cfg.satelliteAttribution || '' });
    L.control.layers({ Mapa: streets, Satélite: sat }, null, { position: 'topright' }).addTo(map);
  }
  return { map, cfg };
}
