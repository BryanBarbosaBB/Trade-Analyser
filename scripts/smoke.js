/* Teste com dados reais: node scripts/smoke.js [CHAVE] [ATIVO]  (chave 'demo' só funciona p/ EUR/USD) */
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups', 'ai']) require('../js/' + f + '.js');
const MA = globalThis.MA;
(async () => {
  const s = structuredClone(MA.DEFAULT_SETTINGS); s.tdKey = process.argv[2] || 'demo';
  const asset = MA.DEFAULT_ASSETS.find((a) => a.name === (process.argv[3] || 'EURUSD'));
  const data = await MA.data.getAll(asset, s, (w) => process.stdout.write('aguardando ' + w + 's\r'));
  console.log(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length + ' velas, última ' + new Date(v.at(-1).t * 1000).toISOString()])));
  const r = MA.setups.analyzeAsset(asset, data, s);
  const p = MA.ai.payload(r);
  console.log(JSON.stringify({ tendencia: p.tendencia, rsi: p.rsi, atr: p.atr, maxmin: p.maxmin, zonas_H1: p.zonas_H1, setup: p.setup, status: r.status }, null, 1));
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
