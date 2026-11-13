/* Ponte para o robô MT5: lê do stdin {asset, data:{M15,H1,D1}, nowSec} e devolve no stdout a análise
   (mesmo motor do site). As velas já devem estar em UTC e só conter velas fechadas. */
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups']) require('../js/' + f + '.js');
const MA = globalThis.MA;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(input);
    const s = structuredClone(MA.DEFAULT_SETTINGS);
    const asset = Object.assign({}, MA.DEFAULT_ASSETS.find((a) => a.name === req.asset) || { name: req.asset, pip: 0.0001, pipValue: 10, digits: 5 });
    const data = { M15: req.data.M15, H1: req.data.H1, D1: req.data.D1 };
    data.H4 = MA.data.resample(data.H1, 14400, 3600, req.nowSec);
    const r = MA.setups.analyzeAsset(asset, data, s, req.nowSec);
    const pick = (c) => c && ({
      name: c.name, dir: c.dir, status: c.status, score: c.score, triggered: c.triggered,
      entry: c.plan.entry, sl: c.plan.sl, tp1: c.plan.tp1, tp2: c.plan.tp2, tp3: c.plan.tp3, R: c.plan.R, rrNext: c.plan.rrNext,
      align: c.breakdown.alinhamento, confirmations: c.confirmations, warnings: c.warnings,
    });
    process.stdout.write(JSON.stringify({
      ok: true, asset: r.asset, price: r.price, session: r.session, sessionGood: r.session.good,
      bias: Object.fromEntries(Object.entries(r.bias).map(([k, v]) => [k, v.dir])),
      best: pick(r.best), candidates: r.candidates.map(pick),
    }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
});
