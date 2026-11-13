/* Backtest de todos os ativos.  TD_KEY=sua_chave node scripts/backtest.js [ATIVO ...]
   Baixa o histórico do Twelve Data (guarda em .bt-data/ para não gastar requisições de novo),
   roda o motor vela a vela e grava o resultado em backtest-result.json. */
const fs = require('fs');
const path = require('path');
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups', 'backtest']) require('../js/' + f + '.js');
const MA = globalThis.MA;
const DIR = path.join(__dirname, '..', '.bt-data');
const pct = (x) => (100 * x).toFixed(0) + '%';
const fx = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

async function load(asset, s) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, asset.name + '.json');
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = await MA.data.getAll(asset, s, (w) => process.stdout.write('  limite da API, aguardando ' + w + 's   \r'), true);
  const out = { M15: d.M15, H1: d.H1, D1: d.D1 };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

const line = (name, st) => console.log('  ' + name.padEnd(30) + String(st.n).padStart(4) + ' trades  acerto ' + pct(st.winRate).padStart(4) +
  '  média ' + fx(st.avgR) + 'R  total ' + fx(st.totalR, 1).padStart(6) + 'R  PF ' + (Number.isFinite(st.pf) ? st.pf.toFixed(2) : '∞') + '  pior queda ' + st.maxDD.toFixed(1) + 'R');

(async () => {
  const s = structuredClone(MA.DEFAULT_SETTINGS);
  s.tdKey = process.env.TD_KEY;
  s.candles = { M15: 5000, H1: 5000, D1: 1000 };
  const names = process.argv.slice(2);
  const assets = MA.DEFAULT_ASSETS.filter((a) => (names.length ? names.includes(a.name) : a.enabled));
  const all = [];
  for (const a of assets) {
    process.stdout.write(a.name + ': baixando...\r');
    let full;
    try { full = await load(a, s); } catch (e) { console.log(a.name + ': ERRO ' + e.message); continue; }
    const t0 = Date.now();
    const sigs = MA.backtest.run(a, full, s, (p) => process.stdout.write(a.name + ': ' + pct(p) + '      \r'));
    const from = new Date(full.M15[0].t * 1000).toISOString().slice(0, 10), to = new Date(full.M15.at(-1).t * 1000).toISOString().slice(0, 10);
    console.log(a.name + ' (' + from + ' a ' + to + ', ' + ((Date.now() - t0) / 1000).toFixed(0) + 's): ' + sigs.length + ' gatilhos');
    all.push(...sigs);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'backtest-result.json'), JSON.stringify(all));

  console.log('\n=== TODOS OS ATIVOS — regra atual (status ENTRADA) ===');
  for (const v of MA.backtest.VARIANTS) line('saída ' + v, MA.backtest.stats(all, v, (x) => x.status === 'ENTRADA'));
  console.log('\n=== TODOS OS GATILHOS (sem travas) ===');
  for (const v of MA.backtest.VARIANTS) line('saída ' + v, MA.backtest.stats(all, v));
  console.log('\n=== POR ATIVO — gatilhos sem travas, saída parcial ===');
  for (const a of assets) line(a.name, MA.backtest.stats(all.filter((x) => x.asset === a.name), 'parcial'));
  console.log('\n=== POR SETUP — saída parcial ===');
  for (const st of ['Pullback na tendência', 'Rompimento com reteste']) line(st, MA.backtest.stats(all.filter((x) => x.setup === st), 'parcial'));

  const opt = MA.backtest.optimize(all);
  console.log('\n=== OTIMIZAÇÃO: escolhe no TREINO (70% inicial), mede no TESTE (30% final, nunca visto) ===');
  if (!opt || !opt.best) console.log('  Poucos sinais para otimizar.');
  else {
    const b = opt.best;
    console.log('  Melhor no treino: score ≥ ' + b.minScore + (b.session ? ', só Londres/NY' : '') + ', caminho livre ≥ ' + b.minRR + 'R, alinhamento ≥ ' + b.align + ', saída ' + b.variant);
    line('TREINO', b.train); line('TESTE (o que vale)', b.test);
  }
})().catch((e) => { console.error('ERRO:', e); process.exit(1); });
