/* Estrutura de mercado, tendência, níveis (S/R), zonas de oferta/demanda, máx/mín do dia/semana e sessões. */
(function (MA) {
  'use strict';
  const last = (a) => a[a.length - 1];
  const lastValid = (a) => { for (let i = a.length - 1; i >= 0; i--) if (!Number.isNaN(a[i])) return a[i]; return NaN; };

  /* Swing high/low (fractal): máxima maior que as n velas de cada lado. Só pivôs confirmados. */
  function swings(c, n = 3) {
    const out = [];
    for (let i = n; i < c.length - n; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= n; j++) {
        if (!(c[i].h > c[i - j].h && c[i].h >= c[i + j].h)) isH = false;
        if (!(c[i].l < c[i - j].l && c[i].l <= c[i + j].l)) isL = false;
      }
      if (isH) out.push({ i, t: c[i].t, price: c[i].h, type: 'H' });
      if (isL) out.push({ i, t: c[i].t, price: c[i].l, type: 'L' });
    }
    return out;
  }

  /* Topos/fundos: HH+HL = alta, LH+LL = baixa, resto = lateral. */
  function structure(sw) {
    const H = sw.filter((s) => s.type === 'H').slice(-2);
    const L = sw.filter((s) => s.type === 'L').slice(-2);
    if (H.length < 2 || L.length < 2) return 'lateral';
    const hh = H[1].price > H[0].price, hl = L[1].price > L[0].price;
    if (hh && hl) return 'alta';
    if (!hh && !hl) return 'baixa';
    return 'lateral';
  }

  /* Viés do timeframe: soma de 4 sinais (preço x EMA lenta, EMA rápida x lenta, inclinação, estrutura). */
  function bias(c, ind, sw) {
    const close = last(c).c, ef = lastValid(ind.emaFast), es = lastValid(ind.emaSlow);
    const esArr = ind.emaSlow, k = esArr.length - 1;
    const slope = !Number.isNaN(esArr[k - 10]) ? esArr[k] - esArr[k - 10] : 0;
    const st = structure(sw);
    let pts = 0;
    if (!Number.isNaN(es)) {
      pts += close > es ? 1 : -1;
      pts += ef > es ? 1 : -1;
      pts += slope > 0 ? 1 : slope < 0 ? -1 : 0;
    }
    pts += st === 'alta' ? 1 : st === 'baixa' ? -1 : 0;
    const dir = pts >= 3 ? 'alta' : pts <= -3 ? 'baixa' : 'neutro';
    return { dir, points: pts, structure: st, adx: lastValid(ind.adx), close, emaFast: ef, emaSlow: es };
  }

  /* Suportes/resistências: agrupa swing points próximos (tolerância em ATR). touches = quantas vezes respeitado. */
  function levels(sw, atrNow, price, tolAtr = 0.35, maxEach = 6) {
    const tol = atrNow * tolAtr;
    const pts = sw.map((s) => ({ ...s })).sort((a, b) => a.price - b.price);
    const groups = [];
    for (const p of pts) {
      const g = last(groups);
      if (g && p.price - g.mean <= tol) {
        g.items.push(p);
        g.mean = g.items.reduce((s, x) => s + x.price, 0) / g.items.length;
      } else groups.push({ items: [p], mean: p.price });
    }
    const lv = groups.map((g) => ({
      price: g.mean,
      touches: g.items.length,
      lastT: Math.max(...g.items.map((x) => x.t)),
      kind: g.mean >= price ? 'R' : 'S',
    }));
    const pick = (arr) => arr
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, maxEach);
    return [...pick(lv.filter((l) => l.kind === 'S')), ...pick(lv.filter((l) => l.kind === 'R'))];
  }

  /* Zonas de oferta/demanda: vela-base (corpo pequeno) seguida de vela de impulso forte.
     demanda: impulso de alta -> zona = [mínima da base, topo do corpo da base]
     oferta : impulso de baixa -> zona = [base do corpo da base, máxima da base]
     Zona é invalidada quando um fechamento ultrapassa o lado distal. tests = quantas vezes o preço voltou nela. */
  function zones(c, atrArr, opts = {}) {
    const impulseAtr = opts.impulseAtr || 1.5, baseBodyAtr = opts.baseBodyAtr || 0.5, maxZones = opts.max || 6;
    const out = [];
    for (let i = 1; i < c.length; i++) {
      const a = atrArr[i - 1];
      if (Number.isNaN(a)) continue;
      const imp = c[i], base = c[i - 1];
      const body = Math.abs(imp.c - imp.o), baseBody = Math.abs(base.c - base.o);
      if (body < impulseAtr * a || baseBody > baseBodyAtr * a) continue;
      const demand = imp.c > imp.o;
      const z = demand
        ? { type: 'demanda', low: base.l, high: Math.max(base.o, base.c) }
        : { type: 'oferta', low: Math.min(base.o, base.c), high: base.h };
      if (z.high - z.low < 0.05 * a) continue;
      z.t = base.t; z.i = i - 1; z.strength = body / a; z.tests = 0; z.broken = false;
      let away = true; // precisa sair da zona antes de contar novo teste
      for (let j = i + 1; j < c.length; j++) {
        const k = c[j];
        if (demand ? k.c < z.low : k.c > z.high) { z.broken = true; break; }
        const inside = demand ? k.l <= z.high : k.h >= z.low;
        if (inside && away) { z.tests++; away = false; }
        if (!inside) away = true;
      }
      if (!z.broken) out.push(z);
    }
    // remove sobreposições (mantém a mais recente) e limita quantidade
    const res = [];
    for (const z of out.reverse()) {
      if (res.some((r) => r.type === z.type && z.low <= r.high && z.high >= r.low)) continue;
      res.push(z);
      if (res.length >= maxZones) break;
    }
    return res;
  }

  /* Máx/mín do dia anterior (última vela D1 fechada) e da semana anterior (semana ISO, seg-dom). */
  function periodLevels(d1, nowSec = Date.now() / 1000) {
    const out = {};
    if (d1.length) { const y = last(d1); out.pdh = y.h; out.pdl = y.l; }
    const weekStart = (t) => { const d = new Date(t * 1000); const dow = (d.getUTCDay() + 6) % 7; return Math.floor(t / 86400) * 86400 - dow * 86400; };
    const thisWeek = weekStart(nowSec);
    const prev = d1.filter((k) => weekStart(k.t) === thisWeek - 7 * 86400);
    if (prev.length) { out.pwh = Math.max(...prev.map((k) => k.h)); out.pwl = Math.min(...prev.map((k) => k.l)); }
    return out;
  }

  /* Sessões em UTC (aproximadas, sem horário de verão): Ásia 00-09, Londres 07-16, Nova York 12-21. */
  function sessions(nowSec = Date.now() / 1000) {
    const d = new Date(nowSec * 1000), h = d.getUTCHours(), dow = d.getUTCDay();
    const act = [];
    if (dow === 6 || (dow === 0 && h < 21) || (dow === 5 && h >= 21)) return { active: [], label: 'Mercado fechado', good: false };
    if (h < 9) act.push('Ásia');
    if (h >= 7 && h < 16) act.push('Londres');
    if (h >= 12 && h < 21) act.push('Nova York');
    return { active: act, label: act.join(' + ') || 'Entre sessões', good: act.includes('Londres') || act.includes('Nova York') };
  }

  /* Divergência de RSI entre os 2 últimos topos (baixista) ou fundos (altista). */
  function rsiDivergence(c, rsiArr, sw) {
    const H = sw.filter((s) => s.type === 'H').slice(-2), L = sw.filter((s) => s.type === 'L').slice(-2);
    const recent = c.length - 30;
    if (H.length === 2 && H[1].i > recent && H[1].price > H[0].price && rsiArr[H[1].i] < rsiArr[H[0].i]) return 'baixista';
    if (L.length === 2 && L[1].i > recent && L[1].price < L[0].price && rsiArr[L[1].i] > rsiArr[L[0].i]) return 'altista';
    return null;
  }

  /* Análise completa de um timeframe. */
  function analyzeTF(c, cfg) {
    const ind = MA.ind.compute(c, cfg);
    const sw = swings(c, 3);
    const atrNow = lastValid(ind.atr);
    const price = last(c).c;
    return {
      candles: c, ind, swings: sw, atr: atrNow, price,
      bias: bias(c, ind, sw),
      levels: levels(sw.slice(-60), atrNow, price),
      zones: zones(c, ind.atr),
      divergence: rsiDivergence(c, ind.rsi, sw),
    };
  }

  MA.an = { swings, structure, bias, levels, zones, periodLevels, sessions, rsiDivergence, analyzeTF, lastValid };
})(globalThis.MA = globalThis.MA || {});
