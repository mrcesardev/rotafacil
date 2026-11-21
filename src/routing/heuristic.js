'use strict';
/**
 * Otimizador embutido da ordem de paradas de UM entregador (problema do
 * caixeiro-viajante, com volta ao início opcional). Usado quando o VROOM
 * não está disponível.
 *
 * 1. Inserção mais distante: monta o contorno da rota pelas paradas extremas
 *    e encaixa as demais onde aumentam menos o tempo.
 * 2. Busca local: realocação de paradas (or-opt) e 2-opt até não melhorar.
 *
 * Índice 0 da matriz = ponto de partida. Paradas = 1..n.
 */

const END = -1;

function solve({ durations, nJobs, returnToDepot = false, maxIterations = 500 }) {
  const cost = (a, b) => (b === END ? (returnToDepot ? durations[a][0] : 0) : durations[a][b]);
  const at = (r, i) => (i < 0 ? 0 : i >= r.length ? END : r[i]);
  const routeCost = (r) => {
    let c = 0;
    for (let i = 0; i <= r.length; i++) c += cost(at(r, i - 1), at(r, i));
    return r.length ? c : 0;
  };
  const insertDelta = (r, pos, x) => cost(at(r, pos - 1), x) + cost(x, at(r, pos)) - cost(at(r, pos - 1), at(r, pos));
  const removeDelta = (r, pos) => cost(at(r, pos - 1), at(r, pos + 1)) - cost(at(r, pos - 1), r[pos]) - cost(r[pos], at(r, pos + 1));

  const route = [];
  const left = new Set(Array.from({ length: nJobs }, (_, i) => i + 1));

  // 1. inserção mais distante
  while (left.size) {
    let far = null;
    let farScore = -1;
    for (const j of left) {
      const score = Math.min(durations[0][j] + durations[j][0], ...route.map((k) => durations[k][j] + durations[j][k]));
      if (score > farScore) { farScore = score; far = j; }
    }
    let bestPos = 0;
    let best = Infinity;
    for (let p = 0; p <= route.length; p++) {
      const d = insertDelta(route, p, far);
      if (d < best) { best = d; bestPos = p; }
    }
    route.splice(bestPos, 0, far);
    left.delete(far);
  }

  // 2. busca local
  const EPS = 1e-6;
  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;

    // realocação: tira uma parada e coloca em outra posição
    for (let i = 0; i < route.length && !improved; i++) {
      const x = route[i];
      const gain = removeDelta(route, i);
      const rest = route.filter((_, k) => k !== i);
      for (let p = 0; p <= rest.length; p++) {
        if (p === i) continue;
        if (gain + insertDelta(rest, p, x) < -EPS) {
          rest.splice(p, 0, x);
          route.splice(0, route.length, ...rest);
          improved = true;
          break;
        }
      }
    }

    // 2-opt: inverte um trecho (desfaz cruzamentos)
    let base = routeCost(route);
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const cand = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
        const c = routeCost(cand);
        if (c < base - EPS) { route.splice(0, route.length, ...cand); base = c; improved = true; }
      }
    }
    if (!improved) break;
  }

  return { order: route, cost: routeCost(route) };
}

module.exports = { solve };
