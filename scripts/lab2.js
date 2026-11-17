/* Laboratório 2: estratégias diárias "clássicas" nos índices (e ouro), que operam com mais frequência.
   Mesma disciplina do lab.js: parâmetros e ativos escolhidos SÓ no TREINO (< 2025-07-01); medida no TESTE.
   Resultado em R e em US$ com LOTE MÍNIMO FIXO (0,1 USTEC/US30 = US$ 0,10 por ponto; 0,01 XAUUSD = US$ 1 por US$ 1).
   Uso: node scripts/lab2.js */
const fs = require('fs');
const path = require('path');
const { sma, rsi, atr, usDst, sim, stats, SPREAD, SPLIT, DIR } = require('./lab.js');

const ASSETS = ['NAS100', 'US30', 'XAUUSD'];
const USD_PER_PT = { NAS100: 0.1, US30: 0.1, XAUUSD: 1.0 }; // order_calc_profit na MetaQuotes-Demo (lote mínimo)
const SWAP_PCT_NIGHT = 0.0002; // suposição: swap de compra em índice/ouro ≈ 0,02% do preço por noite (quarta = 3 noites)

const data = {};
for (const n of ASSETS) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8'));
  data[n] = { d, a: { name: n, spread: Math.max(d.spread || 0, SPREAD[n] || 0) } };
}
const END = Math.max(...ASSETS.map((n) => data[n].d.M15.at(-1).t));
const wd = (t) => new Date((t + 6 * 3600) * 1000).getUTCDay(); // dia de servidor da vela diária (abre ~21-22h UTC do dia anterior)
const nights = (ti, tj) => { let k = 0; for (let t = ti; t < tj; t += 86400) { k += wd(t) === 3 ? 3 : 1; } return k; };

// trade: {t, R, pts (resultado em pontos já com spread e swap), risk (pontos)}
function mk(B, i, dir, e, sl, last, a, exitFn, swapNightsFn) {
  const s = sim(B, i, dir, e, sl, null, last, a.spread, exitFn);
  if (!s) return null;
  const risk = Math.abs(e - sl);
  const swap = dir > 0 ? swapNightsFn(s.exitIdx) * SWAP_PCT_NIGHT * e : 0;
  const pts = s.R * risk - swap;
  return { t: B[i].t, R: pts / risk, pts, risk, exitIdx: s.exitIdx };
}

function dailyPrep(d) {
  const B = d.D1, c = B.map((b) => b.c);
  return { B, c, r: rsi(c, 2), s200: sma(c, 200), s5: sma(c, 5), a: atr(B, 14),
    ibs: B.map((b) => (b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5)) };
}

// estratégia diária genérica: entra na abertura do dia seguinte ao sinal
function dailyLoop(a, x, entryFn, exitFnFactory, stopAtr, maxDays) {
  const B = x.B, out = []; let busy = -1;
  for (let i = 200; i < B.length - 1; i++) {
    if (i <= busy || !entryFn(i)) continue;
    const e = B[i + 1].o, sl = e - stopAtr * x.a[i];
    const t = mk(B, i + 1, 1, e, sl, i + maxDays, a, exitFnFactory(i), (j) => nights(B[i + 1].t, B[j].t));
    if (t) { out.push(t); busy = t.exitIdx; }
  }
  return out;
}

const grid = (o) => Object.entries(o).reduce((acc, [k, vs]) => acc.flatMap((g) => vs.map((v) => ({ ...g, [k]: v }))), [{}]);

const STRATS = [
  { key: 'rsi2', name: 'RSI(2) atual (referência, sem otimizar)', daily: true,
    grid: [{ th: 10, stop: 3 }],
    run: (a, d, p, x) => dailyLoop(a, x, (i) => x.c[i] > x.s200[i] && x.r[i] < p.th, () => (j) => x.c[j] > x.s5[j], p.stop, 10) },
  { key: 'ibs', name: 'IBS: compra fechamento fraco (IBS baixo)', daily: true,
    grid: grid({ th: [0.1, 0.2, 0.3], f200: [true, false], exit: ['nextclose', 'ibs08', 'prevhigh'], stop: [1.5, 3] }),
    run: (a, d, p, x) => dailyLoop(a, x, (i) => x.ibs[i] < p.th && (!p.f200 || x.c[i] > x.s200[i]),
      (i) => (j) => p.exit === 'nextclose' ? true : p.exit === 'ibs08' ? x.ibs[j] > 0.8 : x.c[j] > x.B[j - 1].h, p.stop, 10) },
  { key: 'd7', name: 'Connors Double 7s', daily: true,
    grid: grid({ stop: [2, 3, 5] }),
    run: (a, d, p, x) => dailyLoop(a, x, (i) => x.c[i] > x.s200[i] && x.c[i] <= Math.min(...x.c.slice(i - 6, i + 1)),
      () => (j) => x.c[j] >= Math.max(...x.c.slice(j - 6, j + 1)), p.stop, 15) },
  { key: 'tom', name: 'Virada do mês (4º último dia útil -> 3º dia útil)', daily: true,
    grid: grid({ stop: [2, 3, 5], f200: [true, false] }),
    run(a, d, p, x) {
      const B = x.B, out = [], mon = B.map((b) => new Date((b.t + 6 * 3600) * 1000).getUTCMonth());
      for (let i = 200; i < B.length - 4; i++) {
        // i é o 4º último dia do mês se B[i+4] já é de outro mês e B[i+3] não
        if (!(mon[i + 3] === mon[i] && mon[i + 4] !== mon[i])) continue;
        if (p.f200 && !(x.c[i] > x.s200[i])) continue;
        const exitIdx = i + 3 + 3; // 3 dias do mês atual restantes + 3 dias do mês seguinte
        const e = B[i + 1].o, sl = e - p.stop * x.a[i];
        const t = mk(B, i + 1, 1, e, sl, exitIdx, a, null, (j) => nights(B[i + 1].t, B[j].t));
        if (t) out.push(t);
      }
      return out;
    } },
  { key: 'overnight', name: 'Overnight: compra no fechamento do pregão dos EUA, vende na abertura', daily: false,
    grid: grid({ stop: [1, 2], f200: [true, false], skipFri: [true, false] }),
    run(a, d, p, x) {
      const M = d.M15, out = [], D = x.B; let k = 0;
      for (let i = 1; i < M.length - 1; i++) {
        const t = M[i].t, dst = usDst(t), closeT = (dst ? 20 : 21) * 3600, openT = dst ? 13.5 * 3600 : 14.5 * 3600;
        if (((t + 900) % 86400) !== closeT) continue; // vela que fecha no fechamento do pregão
        const dow = new Date(t * 1000).getUTCDay();
        if (dow === 0 || dow === 6 || (p.skipFri && dow === 5)) continue;
        while (k + 1 < D.length && D[k + 1].t + 86400 <= t) k++;
        if (!(x.a[k] > 0) || (p.f200 && !(x.c[k] > x.s200[k]))) continue;
        // próxima abertura do pregão (dia útil seguinte): sai no fechamento da vela que termina nesse horário
        let target = Math.floor((t + 900) / 86400) * 86400 + 86400 + openT;
        while ([0, 6].includes(new Date(target * 1000).getUTCDay())) target += 86400;
        let last = i + 1; while (last + 1 < M.length && M[last + 1].t + 900 <= target) last++;
        if (last + 1 >= M.length) break;
        if (M[last].t + 900 !== target) continue; // buraco nos dados
        const e = M[i].c, sl = e - p.stop * x.a[k];
        const n = dow === 5 ? 3 : dow === 3 ? 3 : 1;
        // sai na abertura da vela seguinte a "last" (≈ abertura do pregão): aproxima com o fechamento de last
        const tr = mk(M, i + 1, 1, e, sl, last, a, null, () => n);
        if (tr) { out.push({ ...tr, t }); i = tr.exitIdx; }
      }
      return out;
    } },
];

const days = (a, b) => ((b - a) / 86400) * (5 / 7);
const usd = (n, x) => x.pts * USD_PER_PT[n];
function ddUsd(trs) { let tot = 0, pk = 0, dd = 0; for (const x of [...trs].sort((a, b) => a.t - b.t)) { tot += x.usd; pk = Math.max(pk, tot); dd = Math.max(dd, pk - tot); } return { tot, dd }; }
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const f = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);

const prep = {}; for (const n of ASSETS) prep[n] = dailyPrep(data[n].d);
const summary = [];
for (const S of STRATS) {
  const trainStart = S.daily ? Math.max(...ASSETS.map((n) => data[n].d.D1[200].t)) : Math.max(...ASSETS.map((n) => data[n].d.M15[0].t));
  let best = null;
  for (const p of S.grid) {
    const per = {}; for (const n of ASSETS) per[n] = S.run(data[n].a, data[n].d, p, prep[n]).map((x) => ({ ...x, asset: n, usd: usd(n, x) }));
    const tr = (n) => per[n].filter((x) => x.t < SPLIT && x.t >= trainStart);
    const chosen = ASSETS.filter((n) => { const s = stats(tr(n)); return s.n >= 8 && s.avg > 0.05; });
    const train = chosen.flatMap(tr);
    if (train.length < 20 && S.grid.length > 1) continue;
    const score = stats(train).tot;
    if (!best || score > best.score) best = { p, per, chosen: chosen.length ? chosen : ASSETS, score };
  }
  if (!best) { console.log('\n=== ' + S.name + ': nada positivo no treino'); continue; }
  const train = best.chosen.flatMap((n) => best.per[n].filter((x) => x.t < SPLIT && x.t >= trainStart));
  const test = best.chosen.flatMap((n) => best.per[n].filter((x) => x.t >= SPLIT));
  const dTr = days(trainStart, SPLIT), dTe = days(SPLIT, END);
  console.log('\n=== ' + S.name + ' ===\n  parâmetros ' + JSON.stringify(best.p) + '  ativos ' + best.chosen.join(','));
  for (const n of ASSETS) {
    const tt = best.per[n].filter((x) => x.t >= SPLIT), s = stats(tt), tn = stats(best.per[n].filter((x) => x.t < SPLIT && x.t >= trainStart));
    console.log('    ' + n.padEnd(7) + 'treino ' + String(tn.n).padStart(3) + ' tr ' + f(tn.avg) + 'R | teste ' + String(s.n).padStart(3) + ' tr ' + f(s.avg) + 'R  US$ ' + f(ddUsd(tt).tot, 0));
  }
  for (const [lbl, trs, dd] of [['TREINO', train, dTr], ['TESTE', test, dTe]]) {
    const s = stats(trs), u = ddUsd(trs);
    console.log('  ' + lbl.padEnd(7) + String(s.n).padStart(4) + ' tr  ' + (s.n / (dd / 21)).toFixed(1).padStart(4) + '/mês  acerto ' + (100 * s.win).toFixed(0) + '%  média ' + f(s.avg) +
      'R  PF ' + (isFinite(s.pf) ? s.pf.toFixed(2) : '∞') + '  DD ' + s.dd.toFixed(1) + 'R  | lote mín: US$ ' + f(u.tot, 0) + ' (' + f(u.tot / dd, 2) + '/dia)  DD US$ ' + u.dd.toFixed(0) +
      '  risco mediano US$ ' + med(trs.map((x) => x.risk * USD_PER_PT[x.asset])).toFixed(0));
    if (lbl === 'TESTE') summary.push({ key: S.key, name: S.name, train: stats(train), test: s, testTrades: trs, usdDay: u.tot / dd, ddUsd: u.dd });
  }
}
const pass = summary.filter((s) => s.train.avg > 0 && s.test.avg > 0 && s.key !== 'rsi2');
const all = pass.flatMap((s) => s.testTrades), u = ddUsd(all);
console.log('\n=== CARTEIRA (aprovadas no treino E no teste, sem a RSI2): ' + pass.map((s) => s.key).join(', ') + ' ===');
console.log('  ' + all.length + ' trades no teste  US$ ' + f(u.tot, 0) + ' (' + f(u.tot / days(SPLIT, END), 2) + '/dia) pior queda US$ ' + u.dd.toFixed(0));
const all2 = summary.filter((s) => s.test.avg > 0 && s.train.avg > 0).flatMap((s) => s.testTrades), u2 = ddUsd(all2);
console.log('  com RSI2: ' + all2.length + ' trades  US$ ' + f(u2.tot, 0) + ' (' + f(u2.tot / days(SPLIT, END), 2) + '/dia) pior queda US$ ' + u2.dd.toFixed(0));
console.log('  período de teste ' + new Date(SPLIT * 1000).toISOString().slice(0, 10) + ' a ' + new Date(END * 1000).toISOString().slice(0, 10) + '. Swap suposto: 0,02% do preço por noite na compra.');
