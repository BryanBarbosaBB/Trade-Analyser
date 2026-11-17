/* Método do usuário: tendência na semana/dia/hora + médias simples 9/21/50, entrada no gráfico de minutos.
   Escolhe a variante SÓ no treino (até 07/2025) e mede no teste (depois).
   Uso: node scripts/lab_mm.js [M15|M5] */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const ETF = process.argv[2] || 'M15';
const SEC = { M5: 300, M15: 900 }[ETF];
const RISK_USD = 50; // 0,5% de 10k

const stack = (c, s9, s21, s50, i) => (s9[i] > s21[i] && s21[i] > s50[i] && c[i] > s50[i] ? 1 : s9[i] < s21[i] && s21[i] < s50[i] && c[i] < s50[i] ? -1 : 0);

function weekly(D1) {
  const out = [];
  for (const b of D1) {
    const k = Math.floor((b.t - 4 * 86400 + 3 * 3600) / 604800);
    if (out.length && out.at(-1).k === k) { const w = out.at(-1); w.h = Math.max(w.h, b.h); w.l = Math.min(w.l, b.l); w.c = b.c; }
    else out.push({ k, t: (k * 604800) + 4 * 86400 - 3 * 3600, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}

function prepTF(B) { const c = B.map((b) => b.c); return { B, c, s9: L.sma(c, 9), s21: L.sma(c, 21), s50: L.sma(c, 50) }; }
// tendência da última vela FECHADA do tempo maior no instante t
function makeTrend(X, dur) {
  let k = 0;
  return (t) => { while (k + 1 < X.B.length && X.B[k + 1].t + dur <= t) k++; if (X.B[k].t + dur > t) return 0; return stack(X.c, X.s9, X.s21, X.s50, k); };
}

function run(name, d, p) {
  const B = d[ETF], E = prepTF(B), a = L.atr(B, 14);
  const W = prepTF(weekly(d.D1)), D = prepTF(d.D1), H = prepTF(d.H1);
  const tW = makeTrend(W, 7 * 86400), tD = makeTrend(D, 86400), tH = makeTrend(H, 3600);
  const spread = Math.max(d.spread || 0, L.SPREAD[name] || 0);
  const out = []; let busy = -1;
  for (let i = 60; i < B.length - 1; i++) {
    if (i <= busy) continue;
    const t = B[i].t + SEC; // instante do fechamento da vela i
    const h = new Date(t * 1000).getUTCHours();
    if (h < 7 || h >= 20) continue;
    const dir = tH(t);
    if (!dir) continue;
    if (p.htf >= 2 && tD(t) !== dir) continue;
    if (p.htf >= 3 && tW(t) !== dir) continue;
    let sig = false;
    if (p.entry === 'cross') sig = (E.s9[i] - E.s21[i]) * dir > 0 && (E.s9[i - 1] - E.s21[i - 1]) * dir <= 0 && (E.c[i] - E.s50[i]) * dir > 0;
    else if (p.entry === 'pullback') {
      const touched = dir > 0 ? B[i - 1].l <= E.s21[i - 1] || B[i].l <= E.s21[i] : B[i - 1].h >= E.s21[i - 1] || B[i].h >= E.s21[i];
      sig = stack(E.c, E.s9, E.s21, E.s50, i) === dir && touched && (E.c[i] - E.s9[i]) * dir > 0 && (B[i].c - B[i].o) * dir > 0;
    }
    if (!sig) continue;
    const e = B[i + 1].o;
    const sl = p.sl === 'sma50' ? E.s50[i] - dir * 0.3 * a[i] : e - dir * p.sl * a[i];
    if ((e - sl) * dir < 0.5 * a[i]) continue; // stop curto demais: o spread engole
    const tp = e + dir * p.tp * Math.abs(e - sl);
    let last = i + 1; while (last + 1 < B.length && B[last + 1].t < B[i].t + p.hold * 3600) last++;
    const s = L.sim(B, i + 1, dir, e, sl, tp, last, spread);
    if (s) { out.push({ t: B[i + 1].t, R: s.R, asset: name }); busy = s.exitIdx; }
  }
  return out;
}

const grid = [];
for (const htf of [1, 2, 3]) for (const entry of ['cross', 'pullback']) for (const sl of ['sma50', 1, 1.5]) for (const tp of [1, 1.5, 2]) for (const hold of [4, 8]) grid.push({ htf, entry, sl, tp, hold });

const assets = fs.readdirSync(L.DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
const data = {};
for (const n of assets) {
  const d = JSON.parse(fs.readFileSync(path.join(L.DIR, n + '.json'), 'utf8'));
  if (ETF === 'M5') { const f = path.join(L.DIR, 'M5', n + '.json'); if (!fs.existsSync(f)) continue; d.M5 = JSON.parse(fs.readFileSync(f, 'utf8')); }
  data[n] = d;
}
const names = Object.keys(data);
const start = Math.max(...names.map((n) => data[n][ETF][0].t)), end = Math.max(...names.map((n) => data[n][ETF].at(-1).t));
const split = ETF === 'M5' ? start + 0.6 * (end - start) : L.SPLIT;
const days = (a, b) => ((b - a) / 86400) * (5 / 7);
const usd = (s, dd) => '≈ US$ ' + L.fx((s.tot * RISK_USD) / dd, 1) + '/dia';

console.log(`Método MM 9/21/50, entrada no ${ETF}, ${names.length} ativos, ${new Date(start * 1000).toISOString().slice(0, 10)} a ${new Date(end * 1000).toISOString().slice(0, 10)}; teste a partir de ${new Date(split * 1000).toISOString().slice(0, 10)}`);
const rows = [];
for (const p of grid) {
  const all = names.flatMap((n) => run(n, data[n], p));
  const tr = all.filter((x) => x.t < split), te = all.filter((x) => x.t >= split);
  rows.push({ p, all, train: L.stats(tr), test: L.stats(te) });
}
rows.sort((a, b) => b.train.tot - a.train.tot);
console.log('\nTop 8 variantes pelo TREINO (todos os ativos), com o resultado no TESTE:');
for (const r of rows.slice(0, 8)) {
  console.log('  ' + JSON.stringify(r.p));
  L.line('treino', r.train, null); L.line('teste', r.test, null);
  console.log('     ' + usd(r.test, days(split, end)) + ' com US$ ' + RISK_USD + ' de risco por trade, ' + (r.test.n / days(split, end)).toFixed(1) + ' trades/dia');
}
const best = rows[0];
// ativos escolhidos no treino com a melhor variante
const pick = names.filter((n) => { const s = L.stats(best.all.filter((x) => x.asset === n && x.t < split)); return s.n >= 15 && s.avg > 0.05; });
const te = L.stats(best.all.filter((x) => pick.includes(x.asset) && x.t >= split));
console.log('\nMelhor variante + só ativos que foram bem no treino (' + pick.join(', ') + '):');
L.line('teste', te, null); console.log('     ' + usd(te, days(split, end)));
const pos = rows.filter((r) => r.train.avg > 0);
console.log(`\nVariantes positivas no treino: ${pos.length}/${rows.length}; dessas, positivas também no teste: ${pos.filter((r) => r.test.avg > 0).length}`);
console.log('Melhor variante no TESTE (só para referência, escolher por aqui é trapaça):');
const bt = [...rows].sort((a, b) => b.test.tot - a.test.tot)[0]; console.log('  ' + JSON.stringify(bt.p)); L.line('teste', bt.test, null);
