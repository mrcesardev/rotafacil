'use strict';
/**
 * Matriz de tempos/distâncias entre pontos.
 * Usa OSRM (ruas reais) quando OSRM_URL está definido; senão, estimativa
 * em linha reta corrigida por um fator de desvio urbano.
 */

const DETOUR_FACTOR = Number(process.env.DETOUR_FACTOR || 1.35);
const FALLBACK_SPEED_KMH = Number(process.env.FALLBACK_SPEED_KMH || 25);

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function estimateMatrix(points) {
  const speed = (FALLBACK_SPEED_KMH * 1000) / 3600;
  const n = points.length;
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));
  const durations = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversine(points[i], points[j]) * DETOUR_FACTOR;
      distances[i][j] = distances[j][i] = Math.round(d);
      durations[i][j] = durations[j][i] = Math.round(d / speed);
    }
  }
  return { distances, durations, source: 'estimativa' };
}

async function osrmMatrix(points, base) {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${base}/table/v1/driving/${coords}?annotations=duration,distance`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`OSRM respondeu ${res.status}`);
  const body = await res.json();
  if (body.code !== 'Ok') throw new Error(`OSRM: ${body.code} ${body.message || ''}`);
  // pontos sem rota (ex.: ilha, área sem ruas mapeadas) vêm como null
  const fix = (m, est) => m.map((row, i) => row.map((v, j) => (v == null ? est[i][j] * 3 : Math.round(v))));
  const est = estimateMatrix(points);
  return { durations: fix(body.durations, est.durations), distances: fix(body.distances, est.distances), source: 'osrm' };
}

async function buildMatrix(points) {
  const base = process.env.OSRM_URL;
  if (base && points.length > 1) {
    try {
      return await osrmMatrix(points, base.replace(/\/$/, ''));
    } catch (e) {
      console.warn(`[matrix] OSRM indisponível (${e.message}); usando estimativa.`);
    }
  }
  return estimateMatrix(points);
}

/** Traçado da rota pelas ruas (GeoJSON LineString) ou linhas retas como fallback. */
async function routeGeometry(points) {
  const base = process.env.OSRM_URL;
  const straight = { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) };
  if (!base || points.length < 2) return straight;
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${base.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson`, {
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json();
    if (body.code === 'Ok' && body.routes?.[0]) return body.routes[0].geometry;
  } catch (e) {
    console.warn(`[geometry] OSRM indisponível (${e.message}).`);
  }
  return straight;
}

module.exports = { buildMatrix, estimateMatrix, routeGeometry, haversine };
