/* Laboratório de estratégias: testa ideias diferentes no histórico do MT5 (.bt-data-mt5).
   Para cada estratégia: escolhe parâmetros e ativos SÓ no TREINO (até 2025-07-01) e mede no TESTE (depois, nunca visto).
   Uso: node scripts/lab.js            (grava lab-result.json) */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '.bt-data-mt5');
const SPLIT = Date.UTC(2025, 6, 1) / 1000;
// custo por operação (preço): o maior entre o registrado e uma estimativa conservadora
const SPREAD = { XAUUSD: 0.35, NAS100: 2, US30: 3, GBPJPY: 0.025, CADJPY: 0.025, AUDJPY: 0.02, EURJPY: 0.02, USDJPY: 0.015,
  EURUSD: 0.00012, GBPUSD: 0.00015, AUDUSD: 0.00014, USDCAD: 0.0002 };
const INDEX = new Set(['NAS100', 'US30']);

// ---------- indicadores ----------
const sma = (v, n) => { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const rsi = (c, n) => { const o = new Array(c.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
  if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } } return o; };
const atr = (b, n) => { const o = new Array(b.length).fill(NaN); let a = 0; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  if (i <= n) { a += tr / n; if (i === n) o[i] = a; } else { a = (a * (n - 1) + tr) / n; o[i] = a; } } return o; };
const stdev = (v, n) => { const m = sma(v, n), o = new Array(v.length).fill(NaN); for (let i = n - 1; i < v.length; i++) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += (v[k] - m[i]) ** 2; o[i] = Math.sqrt(s / n); } return o; };

// ---------- horários ----------
const nthSun = (y, m, n) => { const d = new Date(Date.UTC(y, m, 1)); const first = 1 + ((7 - d.getUTCDay()) % 7); return Date.UTC(y, m, first + 7 * (n - 1)) / 1000; };
const lastSun = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay()) / 1000; };
const usDst = (t) => { const y = new Date(t * 1000).getUTCFullYear(); return t >= nthSun(y, 2, 2) + 7 * 3600 && t < nthSun(y, 10, 1) + 6 * 3600; };
const ukDst = (t) => { const y = new Date(t * 1000).getUTCFullYear(); return t >= lastSun(y, 2) + 3600 && t < lastSun(y, 9) + 3600; };

// ---------- simulação de uma operação ----------
// entra em bars[i] ao preço entry; sai no SL (prioridade), TP, exitFn(j) no fechamento, ou no fechamento de lastIdx
function sim(bars, i, dir, entry, sl, tp, lastIdx, spread, exitFn) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  let exit = null, j = i;
  for (; j <= lastIdx && j < bars.length; j++) {
    const b = bars[j];
    if (dir > 0) {
      if (b.l <= sl) { exit = j > i && b.o < sl ? b.o : sl; break; }
      if (tp && b.h >= tp) { exit = j > i && b.o > tp ? b.o : tp; break; }
    } else {
      if (b.h >= sl) { exit = j > i && b.o > sl ? b.o : sl; break; }
      if (tp && b.l <= tp) { exit = j > i && b.o < tp ? b.o : tp; break; }
    }
    if (exitFn && exitFn(j)) { exit = b.c; break; }
  }
  if (exit == null) { j = Math.min(lastIdx, bars.length - 1); exit = bars[j].c; }
  return { R: ((exit - entry) * dir - spread) / risk, exitIdx: j };
}

// ---------- estratégias ----------
// cada uma: grid de parâmetros e run(asset, data, p) -> [{t, R}]
const STRATS = [
  {
    key: 'rsi2_d1', daily: true, name: 'Reversão RSI(2) no diário (compra queda em alta / vende alta em baixa)',
    grid: (() => { const g = []; for (const th of [5, 10, 20]) for (const stop of [2, 3, 5]) for (const exit of ['sma5', 'rsi70']) for (const side of ['long', 'both']) g.push({ th, stop, exit, side }); return g; })(),
    prep(d) { const c = d.D1.map((b) => b.c); return { c, r: rsi(c, 2), s200: sma(c, 200), s5: sma(c, 5), a: atr(d.D1, 14) }; },
    run(a, d, p, x) {
      const B = d.D1, out = []; let busy = -1;
      for (let i = 200; i < B.length - 1; i++) {
        if (i <= busy) continue;
        let dir = 0;
        if (x.c[i] > x.s200[i] && x.r[i] < p.th) dir = 1;
        else if (p.side === 'both' && x.c[i] < x.s200[i] && x.r[i] > 100 - p.th) dir = -1;
        if (!dir) continue;
        const e = B[i + 1].o, sl = e - dir * p.stop * x.a[i];
        const ex = p.exit === 'sma5' ? (j) => (dir > 0 ? x.c[j] > x.s5[j] : x.c[j] < x.s5[j]) : (j) => (dir > 0 ? x.r[j] > 70 : x.r[j] < 30);
        const s = sim(B, i + 1, dir, e, sl, null, i + 10, a.spread, ex);
        if (s) { out.push({ t: B[i + 1].t, R: s.R }); busy = s.exitIdx; }
      }
      return out;
    },
  },
  {
    key: 'rsi2_h1', name: 'Reversão RSI(2) no H1 a favor da tendência do diário',
    grid: (() => { const g = []; for (const th of [5, 10]) for (const stop of [1.5, 3]) for (const tp of [0, 1]) g.push({ th, stop, tp }); return g; })(),
    prep(d) { const c = d.H1.map((b) => b.c); const dc = d.D1.map((b) => b.c); return { c, r: rsi(c, 2), s5: sma(c, 5), a: atr(d.H1, 14), dt: d.D1.map((b) => b.t), d50: sma(dc, 50), dc }; },
    run(a, d, p, x) {
      const B = d.H1, out = []; let busy = -1, k = 0;
      for (let i = 20; i < B.length - 1; i++) {
        while (k + 1 < x.dt.length && x.dt[k + 1] + 86400 <= B[i].t) k++;
        if (i <= busy || !(x.d50[k] > 0)) continue;
        const up = x.dc[k] > x.d50[k];
        let dir = 0;
        if (up && x.r[i] < p.th) dir = 1; else if (!up && x.r[i] > 100 - p.th) dir = -1;
        if (!dir) continue;
        const e = B[i + 1].o, sl = e - dir * p.stop * x.a[i], tp = p.tp ? e + dir * p.tp * p.stop * x.a[i] : null;
        const s = sim(B, i + 1, dir, e, sl, tp, i + 24, a.spread, (j) => (dir > 0 ? x.c[j] > x.s5[j] : x.c[j] < x.s5[j]));
        if (s) { out.push({ t: B[i + 1].t, R: s.R }); busy = s.exitIdx; }
      }
      return out;
    },
  },
  {
    key: 'orb', name: 'Rompimento da abertura (NY para índices, Londres para o resto)',
    grid: (() => { const g = []; for (const mins of [15, 30, 60]) for (const tp of [1, 1.5, 2, 0]) for (const trend of [false, true]) g.push({ mins, tp, trend }); return g; })(),
    prep(d) { const dc = d.D1.map((b) => b.c); return { dt: d.D1.map((b) => b.t), d20: sma(dc, 20), dc }; },
    run(a, d, p, x) {
      const B = d.M15, out = []; let k = 0, i = 0;
      const byT = new Map(B.map((b, n) => [b.t, n]));
      const days = [...new Set(B.map((b) => Math.floor(b.t / 86400)))];
      for (const day of days) {
        const d0 = day * 86400;
        const wd = new Date(d0 * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
        const open = INDEX.has(a.name) ? d0 + (usDst(d0 + 43200) ? 13.5 : 14.5) * 3600 : d0 + (ukDst(d0 + 43200) ? 7 : 8) * 3600;
        const close = open + (INDEX.has(a.name) ? 6.25 : 8) * 3600;
        const nR = p.mins / 15, idx = [];
        for (let n = 0; n < nR; n++) { const j = byT.get(open + n * 900); if (j == null) break; idx.push(j); }
        if (idx.length < nR) continue;
        const rh = Math.max(...idx.map((j) => B[j].h)), rl = Math.min(...idx.map((j) => B[j].l));
        while (k + 1 < x.dt.length && x.dt[k + 1] + 86400 <= open) k++;
        const trendUp = x.dc[k] > x.d20[k];
        let last = idx.at(-1); while (last + 1 < B.length && B[last + 1].t + 900 <= close) last++;
        const winEnd = open + p.mins * 60 + 3 * 3600; // só aceita rompimento nas 3h seguintes
        for (let j = idx.at(-1) + 1; j <= last && B[j].t < winEnd; j++) {
          const b = B[j]; const upB = b.h > rh, dnB = b.l < rl;
          if (upB && dnB) break; // ambíguo: ignora o dia
          if (!upB && !dnB) continue;
          const dir = upB ? 1 : -1;
          if (p.trend && (dir > 0) !== trendUp) break;
          const e = dir > 0 ? Math.max(rh, b.o) : Math.min(rl, b.o), sl = dir > 0 ? rl : rh;
          const tp = p.tp ? e + dir * p.tp * Math.abs(e - sl) : null;
          const s = sim(B, j, dir, e, sl, tp, last, a.spread);
          if (s) out.push({ t: b.t, R: s.R });
          break;
        }
      }
      return out;
    },
  },
  {
    key: 'donchian', daily: true, name: 'Seguir tendência no diário (rompimento de máxima/mínima de N dias)',
    grid: (() => { const g = []; for (const n of [20, 55]) for (const stop of [2, 3]) for (const ex of [10, 20]) g.push({ n, stop, ex }); return g; })(),
    prep(d) { return { a: atr(d.D1, 20) }; },
    run(a, d, p, x) {
      const B = d.D1, out = []; let busy = -1;
      const hh = (i, n) => Math.max(...B.slice(i - n, i).map((b) => b.h)), ll = (i, n) => Math.min(...B.slice(i - n, i).map((b) => b.l));
      for (let i = p.n + 1; i < B.length - 1; i++) {
        if (i <= busy) continue;
        const dir = B[i].c > hh(i, p.n) ? 1 : B[i].c < ll(i, p.n) ? -1 : 0;
        if (!dir) continue;
        const e = B[i + 1].o, sl = e - dir * p.stop * x.a[i];
        const s = sim(B, i + 1, dir, e, sl, null, i + 250, a.spread, (j) => (dir > 0 ? B[j].c < ll(j, p.ex) : B[j].c > hh(j, p.ex)));
        if (s) { out.push({ t: B[i + 1].t, R: s.R }); busy = s.exitIdx; }
      }
      return out;
    },
  },
  {
    key: 'bb_asia', name: 'Reversão nas Bandas de Bollinger na sessão asiática (M15)',
    grid: (() => { const g = []; for (const dev of [2, 2.5]) for (const stop of [1, 2, 3]) g.push({ dev, stop }); return g; })(),
    prep(d) { const c = d.M15.map((b) => b.c); return { c, m: sma(c, 20), sd: stdev(c, 20), a: atr(d.M15, 14) }; },
    run(a, d, p, x) {
      const B = d.M15, out = []; let busy = -1;
      if (INDEX.has(a.name)) return out;
      for (let i = 30; i < B.length - 1; i++) {
        if (i <= busy) continue;
        const h = new Date(B[i].t * 1000).getUTCHours();
        if (!(h >= 23 || h < 6)) continue;
        const up = x.m[i] + p.dev * x.sd[i], dn = x.m[i] - p.dev * x.sd[i];
        const dir = x.c[i] < dn ? 1 : x.c[i] > up ? -1 : 0;
        if (!dir) continue;
        const e = B[i + 1].o, sl = e - dir * p.stop * x.a[i];
        let last = i + 1; while (last + 1 < B.length && B[last + 1].t < B[i].t + 6 * 3600) last++;
        const s = sim(B, i + 1, dir, e, sl, null, last, a.spread, (j) => (dir > 0 ? x.c[j] >= x.m[j] : x.c[j] <= x.m[j]));
        if (s) { out.push({ t: B[i + 1].t, R: s.R }); busy = s.exitIdx; }
      }
      return out;
    },
  },
];

// ---------- estatística ----------
function stats(tr) {
  tr = [...tr].sort((a, b) => a.t - b.t);
  let tot = 0, peak = 0, dd = 0, w = 0, gw = 0, gl = 0;
  for (const x of tr) { tot += x.R; peak = Math.max(peak, tot); dd = Math.max(dd, peak - tot); if (x.R > 0) { w++; gw += x.R; } else gl -= x.R; }
  return { n: tr.length, win: tr.length ? w / tr.length : 0, avg: tr.length ? tot / tr.length : 0, tot, pf: gl ? gw / gl : Infinity, dd };
}
const fx = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
const line = (lbl, s, days) => console.log('  ' + lbl.padEnd(22) + String(s.n).padStart(5) + ' trades  acerto ' + (100 * s.win).toFixed(0).padStart(3) + '%  média ' + fx(s.avg) + 'R  total ' + fx(s.tot, 1).padStart(7) +
  'R  PF ' + (isFinite(s.pf) ? s.pf.toFixed(2) : '∞') + '  pior queda ' + s.dd.toFixed(1) + 'R' + (days ? '  ≈ US$ ' + fx((s.tot * 100) / days, 2) + '/dia (1% de 10k)' : ''));

module.exports = { sma, rsi, atr, stdev, usDst, ukDst, sim, stats, line, fx, SPREAD, INDEX, SPLIT, DIR };
if (require.main !== module) return;
// ---------- main ----------
const assets = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
const data = {};
for (const n of assets) { const d = JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8')); data[n] = { d, a: { name: n, spread: Math.max(d.spread || 0, SPREAD[n] || 0) } }; }
const END = Math.max(...assets.map((n) => data[n].d.M15.at(-1).t));
const testDays = ((END - SPLIT) / 86400) * (5 / 7);
const result = {};

for (const S of STRATS) {
  console.log('\n=== ' + S.name + ' ===');
  const prep = {}; for (const n of assets) prep[n] = S.prep(data[n].d);
  let best = null;
  for (const p of S.grid) {
    const per = {};
    for (const n of assets) per[n] = S.run(data[n].a, data[n].d, p, prep[n]);
    const trainStart = S.daily ? 0 : Math.max(...assets.map((n) => data[n].d.M15[0].t)); // diário usa o histórico diário inteiro
    const tr = (n) => per[n].filter((x) => x.t < SPLIT && x.t >= trainStart);
    const chosen = assets.filter((n) => { const s = stats(tr(n)); return s.n >= 8 && s.avg > 0.05; });
    const train = stats(chosen.flatMap(tr));
    if (train.n < 30) continue;
    const score = train.tot;
    if (!best || score > best.score) best = { p, chosen, per, train, score };
  }
  if (!best) { console.log('  Nenhuma combinação positiva no treino.'); result[S.key] = null; continue; }
  const test = stats(best.chosen.flatMap((n) => best.per[n].filter((x) => x.t >= SPLIT)));
  const testAll = stats(assets.flatMap((n) => best.per[n].filter((x) => x.t >= SPLIT)));
  console.log('  parâmetros: ' + JSON.stringify(best.p) + '  ativos (escolhidos no treino): ' + best.chosen.join(', '));
  line('TREINO', best.train);
  line('TESTE (o que vale)', test, testDays);
  line('teste, todos os ativos', testAll, testDays);
  result[S.key] = { name: S.name, params: best.p, assets: best.chosen, train: best.train, test, testAll,
    testTrades: best.chosen.flatMap((n) => best.per[n].filter((x) => x.t >= SPLIT).map((x) => ({ ...x, asset: n }))) };
}

const all = Object.values(result).filter((r) => r && r.train.avg > 0).flatMap((r) => r.testTrades);
console.log('\n=== CARTEIRA: todas as estratégias positivas no treino, juntas, no TESTE ===');
line('carteira', stats(all), testDays);
console.log('  período de teste: ' + new Date(SPLIT * 1000).toISOString().slice(0, 10) + ' a ' + new Date(END * 1000).toISOString().slice(0, 10) + ' (' + testDays.toFixed(0) + ' dias úteis)');
fs.writeFileSync(path.join(__dirname, '..', 'lab-result.json'), JSON.stringify(result));
