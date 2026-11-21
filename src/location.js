'use strict';
/**
 * Extrai coordenadas do que o cliente manda no WhatsApp:
 *  - coordenadas soltas: "-23.5505, -46.6333"
 *  - links do Google Maps (longos e curtos maps.app.goo.gl / goo.gl/maps)
 *  - links "geo:" e de Waze / Apple Maps / OpenStreetMap
 *  - endereço em texto (geocodificado via Nominatim, se habilitado)
 */

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const SEP = '\\s*,\\s*|\\s*%2C\\s*|\\s+';

const URL_PATTERNS = [
  new RegExp(`!3d${NUM}!4d${NUM}`),                       // .../data=!3d-23.5!4d-46.6 (ponto exato do pino)
  new RegExp(`[?&](?:q|query|ll|destination|daddr|center|sll)=(?:loc:)?${NUM}(?:${SEP})${NUM}`, 'i'),
  new RegExp(`/(?:place|search|dir)/${NUM}(?:${SEP})\\+?${NUM}`, 'i'),
  new RegExp(`@${NUM},${NUM}`),                            // .../@-23.5,-46.6,17z (centro do mapa)
  new RegExp(`geo:${NUM},${NUM}`, 'i'),
  new RegExp(`[?&]mlat=${NUM}&mlon=${NUM}`, 'i'),          // openstreetmap.org
  new RegExp(`#map=\\d+/${NUM}/${NUM}`, 'i'),              // openstreetmap.org
];

const SHORT_LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\/[^\s]+/i;
const ANY_URL = /https?:\/\/[^\s<>"]+/i;
const BARE_COORDS = new RegExp(`(?:^|[^\\d.\\-])${NUM}\\s*[,;]\\s*${NUM}(?![\\d.])`);

function valid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** Tenta extrair coordenadas de um texto/URL sem acessar a rede. */
function extractCoords(text) {
  if (!text) return null;
  let s = String(text);
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch { /* texto com % solto */ }

  for (const re of URL_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (valid(lat, lng)) return { lat, lng };
    }
  }
  // Waze: ll=lat,lng já coberto; Apple Maps usa ll= ou q= também.
  const withoutUrls = s.replace(/https?:\/\/[^\s]+/g, ' ');
  const m = withoutUrls.match(BARE_COORDS);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    // exige casas decimais para não confundir com números de casa/telefone
    if (valid(lat, lng) && m[1].includes('.') && m[2].includes('.')) return { lat, lng };
  }
  return null;
}

/** Segue redirecionamentos de links curtos (sem baixar conteúdo pesado). */
async function resolveShortLink(url, { fetchImpl = fetch, maxHops = 5 } = {}) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      if (extractCoords(current)) return current;
      continue;
    }
    // algumas páginas devolvem 200 com a URL final embutida no HTML
    if (res.ok) {
      const body = (await res.text()).slice(0, 200000);
      const m = body.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s\\]+/);
      if (m && extractCoords(m[0])) return m[0];
    }
    break;
  }
  return current;
}

let lastNominatimCall = 0;
async function geocode(address, { fetchImpl = fetch } = {}) {
  const base = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  if (process.env.GEOCODING === 'off') return null;
  // política do Nominatim público: no máximo 1 requisição por segundo
  const wait = lastNominatimCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();
  const params = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1', countrycodes: process.env.GEOCODE_COUNTRY || 'br' });
  const res = await fetchImpl(`${base}/search?${params}`, {
    headers: { 'User-Agent': 'RotaFacil/0.1 (roteirizador de entregas)', 'Accept-Language': 'pt-BR' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const [hit] = await res.json();
  if (!hit) return null;
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), address: hit.display_name };
}

/**
 * Converte a entrada (mensagem, link ou endereço) em coordenadas.
 * Retorna { lat, lng, method, address? } ou { error }.
 */
async function resolveLocation(input, opts = {}) {
  const text = String(input || '').trim();
  if (!text) return { error: 'Entrada vazia' };

  const direct = extractCoords(text);
  if (direct) return { ...direct, method: 'coordenadas' };

  const short = text.match(SHORT_LINK);
  if (short) {
    try {
      const finalUrl = await resolveShortLink(short[0], opts);
      const c = extractCoords(finalUrl);
      if (c) return { ...c, method: 'link-curto' };
      // link de lugar sem coordenadas: tenta o nome do lugar contido na URL
      const place = finalUrl.match(/\/place\/([^/@?]+)/) || finalUrl.match(/[?&]q=([^&]+)/);
      if (place) {
        const name = decodeURIComponent(place[1].replace(/\+/g, ' '));
        const g = await geocode(name, opts);
        if (g) return { ...g, method: 'link-geocodificado' };
      }
      return { error: 'Não consegui ler as coordenadas desse link. Peça ao cliente para enviar a localização fixa (📎 → Localização).' };
    } catch (e) {
      return { error: `Falha ao abrir o link curto: ${e.message}` };
    }
  }

  if (ANY_URL.test(text) && !text.replace(ANY_URL, '').trim()) {
    return { error: 'Link sem coordenadas reconhecíveis.' };
  }

  try {
    const g = await geocode(text.replace(ANY_URL, '').trim(), opts);
    if (g) return { ...g, method: 'endereco' };
  } catch (e) {
    return { error: `Falha na geocodificação: ${e.message}` };
  }
  return { error: 'Endereço não encontrado. Confirme o ponto no mapa.' };
}

/**
 * Quebra um texto colado (várias mensagens do WhatsApp) em entradas individuais.
 * Cada linha com localização vira uma entrega; o texto antes do link vira o nome.
 * Também entende o formato de "exportar conversa": "21/11/2026 10:02 - Maria: localização: https://..."
 */
function splitBulk(text) {
  const items = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    let name = '';
    const exp = line.match(/^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\]?\s*-?\s*([^:]+):\s*(.*)$/);
    if (exp) { name = exp[1].trim(); line = exp[2].trim(); }
    line = line.replace(/^(localiza[cç][aã]o|location)\s*:\s*/i, '');
    let input = line;
    const url = line.match(ANY_URL);
    let coords = !url && line.match(BARE_COORDS);
    if (coords && !(coords[1].includes('.') && coords[2].includes('.'))) coords = null; // "Rua 12, 345" não é coordenada
    const cut = url ? url.index : coords ? coords.index + coords[0].indexOf(coords[1]) : -1;
    if (cut >= 0) {
      const before = line.slice(0, cut).replace(/[-–:|]+\s*$/, '').trim();
      if (!name && before) name = before;
    } else if (!name) {
      // "Nome - endereço" (sem link): separa no primeiro " - "
      const m = line.match(/^(.{2,60}?)\s+[-–|]\s+(.+)$/);
      if (m) { name = m[1].trim(); input = m[2].trim(); }
    }
    items.push({ name, input });
  }
  return items;
}

module.exports = { extractCoords, resolveLocation, resolveShortLink, geocode, splitBulk };
