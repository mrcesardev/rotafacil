'use strict';
/**
 * Otimizador embutido para vários entregadores (VRP com capacidade),
 * sem dependências externas. Usado quando o VROOM não está disponível.
 *
 * 1. Sementes: as paradas mais distantes entre si iniciam cada rota.
 * 2. Inserção por arrependimento (regret-2): insere primeiro as paradas que
 *    mais "perderiam" se não fossem para a melhor rota.
 * 3. Busca local: realocação entre rotas, troca entre rotas e 2-opt.
 *
 * Índice 0 da matriz = base (depósito). Paradas = 1..n.
 */

const END = -1;

function solve({ durations, nJobs, vehicles, returnToDepot = true, maxIterations = 200 }) {
  const cost = (a, b) => {
    if (b === END) return returnToDepot ? durations[a][0] : 0;
    return durations[a][b];
  };
  const routeCost = (r) => {
    if (!r.length) return 0;
    let c = cost(0, r[0]);
    for (let i = 0; i < r.length - 1; i++) c += cost(r[i], r[i + 1]);
    return c + cost(r[r.length - 1], END);
  };
  const at = (r, i) => (i < 0 ? 0 : i >= r.length ? END : r[i]);
  const insertDelta = (r, pos, x) => {
    const p = at(r, pos - 1);
    const n = at(r, pos);
    return cost(p, x) + cost(x, n) - cost(p, n);
  };
  const removeDelta = (r, pos) => {
    const p = at(r, pos - 1);
    const x = r[pos];
    const n = at(r, pos + 1);
    return cost(p, n) - cost(p, x) - cost(x, n);
  };

  const K = vehicles.length;
  const routes = vehicles.map(() => []);
  const caps = vehicles.map((v) => v.capacity ?? Infinity);
  const mins = vehicles.map((v) => Math.min(v.min ?? 0, v.capacity ?? Infinity));
  if (nJobs === 0 || K === 0) return { routes, unassigned: [] };

  // 1. sementes bem espalhadas (só usa tantos veículos quanto paradas)
  const unrouted = new Set(Array.from({ length: nJobs }, (_, i) => i + 1));
  const seeds = [];
  const seedCount = Math.min(K, nJobs);
  while (seeds.length < seedCount) {
    let best = null;
    let bestScore = -1;
    for (const j of unrouted) {
      const score = seeds.length === 0
        ? durations[0][j] + durations[j][0]
        : Math.min(...seeds.map((s) => durations[s][j] + durations[j][s]));
      if (score > bestScore) { bestScore = score; best = j; }
    }
    seeds.push(best);
    unrouted.delete(best);
  }
  // atribui cada semente ao veículo com maior capacidade livre
  const order = vehicles.map((_, k) => k).sort((a, b) => caps[b] - caps[a]);
  seeds.forEach((s, i) => routes[order[i]].push(s));

  // 2. inserção por arrependimento
  const unassigned = [];
  while (unrouted.size) {
    let pick = null;
    for (const j of unrouted) {
      const options = [];
      for (let k = 0; k < K; k++) {
        if (routes[k].length >= caps[k]) continue;
        let best = Infinity;
        let bestPos = 0;
        for (let p = 0; p <= routes[k].length; p++) {
          const d = insertDelta(routes[k], p, j);
          if (d < best) { best = d; bestPos = p; }
        }
        options.push({ k, pos: bestPos, d: best });
      }
      if (!options.length) continue;
      options.sort((a, b) => a.d - b.d);
      const regret = options.length > 1 ? options[1].d - options[0].d : Infinity;
      if (!pick || regret > pick.regret || (regret === pick.regret && options[0].d < pick.d)) {
        pick = { j, regret, ...options[0] };
      }
    }
    if (!pick) { unassigned.push(...unrouted); break; }
    routes[pick.k].splice(pick.pos, 0, pick.j);
    unrouted.delete(pick.j);
  }

  // 2b. garante o mínimo de paradas por entregador (modo equilibrado):
  // puxa, para a rota com falta, a parada mais barata de mover de uma rota com sobra.
  for (let guard = 0; guard < nJobs * K; guard++) {
    const k = routes.findIndex((r, i) => r.length < mins[i]);
    if (k < 0) break;
    let best = null;
    for (let a = 0; a < K; a++) {
      if (a === k || routes[a].length <= mins[a]) continue;
      for (let i = 0; i < routes[a].length; i++) {
        const gain = removeDelta(routes[a], i);
        for (let p = 0; p <= routes[k].length; p++) {
          const d = gain + insertDelta(routes[k], p, routes[a][i]);
          if (!best || d < best.d) best = { a, i, p, d };
        }
      }
    }
    if (!best) break;
    const [x] = routes[best.a].splice(best.i, 1);
    routes[k].splice(best.p, 0, x);
  }

  // 3. busca local
  const EPS = 1e-6;
  const twoOpt = (r) => {
    let improved = true;
    let base = routeCost(r);
    while (improved) {
      improved = false;
      for (let i = 0; i < r.length - 1; i++) {
        for (let j = i + 1; j < r.length; j++) {
          const cand = r.slice(0, i).concat(r.slice(i, j + 1).reverse(), r.slice(j + 1));
          const c = routeCost(cand);
          if (c < base - EPS) { r.splice(0, r.length, ...cand); base = c; improved = true; }
        }
      }
    }
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;

    // realocação: move uma parada para outra posição/rota
    for (let a = 0; a < K && !improved; a++) {
      for (let i = 0; i < routes[a].length && !improved; i++) {
        const x = routes[a][i];
        const canLeave = routes[a].length > mins[a];
        const gain = removeDelta(routes[a], i);
        for (let b = 0; b < K && !improved; b++) {
          if (b !== a && (routes[b].length >= caps[b] || !canLeave)) continue;
          const target = b === a ? routes[a].filter((_, idx) => idx !== i) : routes[b];
          for (let p = 0; p <= target.length; p++) {
            if (b === a && p === i) continue;
            if (gain + insertDelta(target, p, x) < -EPS) {
              routes[a].splice(i, 1);
              routes[b].splice(p, 0, x);
              improved = true;
              break;
            }
          }
        }
      }
    }

    // troca: duas paradas de rotas diferentes trocam de lugar
    for (let a = 0; a < K && !improved; a++) {
      for (let b = a + 1; b < K && !improved; b++) {
        const before = routeCost(routes[a]) + routeCost(routes[b]);
        for (let i = 0; i < routes[a].length && !improved; i++) {
          for (let j = 0; j < routes[b].length && !improved; j++) {
            const ra = routes[a].slice(); const rb = routes[b].slice();
            [ra[i], rb[j]] = [rb[j], ra[i]];
            if (routeCost(ra) + routeCost(rb) < before - EPS) {
              routes[a] = ra; routes[b] = rb; improved = true;
            }
          }
        }
      }
    }

    for (const r of routes) {
      const before = routeCost(r);
      twoOpt(r);
      if (routeCost(r) < before - EPS) improved = true;
    }
    if (!improved) break;
  }

  return { routes, unassigned, cost: routes.reduce((s, r) => s + routeCost(r), 0) };
}

module.exports = { solve };
