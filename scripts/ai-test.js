/* Teste ponta a ponta com IA: TD_KEY=... GEMINI_KEY=... node scripts/ai-test.js XAUUSD */
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups', 'ai']) require('../js/' + f + '.js');
const MA = globalThis.MA;
(async () => {
  const s = structuredClone(MA.DEFAULT_SETTINGS);
  s.tdKey = process.env.TD_KEY; s.geminiKey = process.env.GEMINI_KEY;
  const asset = MA.DEFAULT_ASSETS.find((a) => a.name === (process.argv[2] || 'XAUUSD'));
  const r = MA.setups.analyzeAsset(asset, await MA.data.getAll(asset, s), s);
  const b = r.best;
  console.log(asset.name, r.price, '| D1', r.bias.D1.dir, 'H4', r.bias.H4.dir, 'H1', r.bias.H1.dir, '|', r.status, 'score', r.score,
    b ? '| ' + b.name + ' ' + b.dir + ' entrada ' + b.plan.entry.toFixed(r.digits) + ' SL ' + b.plan.sl.toFixed(r.digits) + ' TP2 ' + b.plan.tp2.toFixed(r.digits) : '');
  const t0 = Date.now();
  console.log(JSON.stringify(await MA.ai.analyze(r, s), null, 1));
  console.log('IA respondeu em', ((Date.now() - t0) / 1000).toFixed(1) + 's');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
