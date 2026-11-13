/* Testes do motor (rodar: node --test tests/) */
const test = require('node:test');
const assert = require('node:assert/strict');
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups', 'ai']) require('../js/' + f + '.js');
const MA = globalThis.MA;

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/* Gera velas a partir de fechamentos; abertura = fechamento anterior. */
function candles(closes, spread = 1, stepSec = 900, t0 = 1736121600) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: t0 + i * stepSec, o, h: Math.max(o, c) + spread / 2, l: Math.min(o, c) - spread / 2, c };
  });
}
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

// ---------------- indicadores ----------------
test('EMA = recursão manual', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], e = MA.ind.ema(x, 3);
  let m = 1; const exp = [1];
  for (let i = 1; i < x.length; i++) { m = 0.5 * x[i] + 0.5 * m; exp.push(m); }
  assert.ok(Number.isNaN(e[0]) && Number.isNaN(e[1]));
  for (let i = 2; i < x.length; i++) close(e[i], exp[i]);
});

test('Wilder: semente SMA e depois recursivo', () => {
  const w = MA.ind.wilder([1, 2, 3, 4, 5], 3);
  close(w[2], 2); close(w[3], 2 + (4 - 2) / 3);
});

test('RSI valor de referência (exato 70.464; StockCharts arredonda para 70.53)', () => {
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const r = MA.ind.rsi(c, 14);
  assert.ok(Number.isNaN(r[13]));
  close(r[14], 70.464, 0.01);
  close(r[19], 57.9, 0.3);
});

test('RSI extremos e limites', () => {
  close(MA.ind.rsi(lin(100, 200, 100)).at(-1), 100);
  close(MA.ind.rsi(lin(200, 100, 100)).at(-1), 0);
});

test('ATR com range constante', () => {
  close(MA.ind.atr(candles(new Array(50).fill(100), 2)).at(-1), 2);
});

test('ADX forte e direção correta', () => {
  const up = MA.ind.adx(candles(lin(100, 200, 300))), dn = MA.ind.adx(candles(lin(200, 100, 300)));
  assert.ok(up.adx.at(-1) > 25 && up.pdi.at(-1) > up.mdi.at(-1));
  assert.ok(dn.adx.at(-1) > 25 && dn.mdi.at(-1) > dn.pdi.at(-1));
});

test('MACD acompanha a tendência', () => {
  assert.ok(MA.ind.macd(lin(100, 200, 300)).macd.at(-1) > 0);
  assert.ok(MA.ind.macd(lin(200, 100, 300)).macd.at(-1) < 0);
});

// ---------------- dados ----------------
test('parse Twelve Data: ordena, converte UTC e descarta vela aberta', () => {
  const json = { status: 'ok', values: [
    { datetime: '2025-01-06 00:15:00', open: '1.2', high: '1.3', low: '1.1', close: '1.25' },
    { datetime: '2025-01-06 00:00:00', open: '1.1', high: '1.2', low: '1.0', close: '1.2' },
  ] };
  const t0 = Date.parse('2025-01-06T00:00:00Z') / 1000;
  const c = MA.data.parse(json, 'M15', t0 + 900 + 60); // 2ª vela ainda aberta
  assert.equal(c.length, 1);
  assert.equal(c[0].t, t0);
  assert.equal(c[0].c, 1.2);
  assert.throws(() => MA.data.parse({ status: 'error', message: 'x', code: 400 }, 'M15'));
});

test('resample H1 -> H4 e descarte do grupo incompleto', () => {
  const h1 = candles([1, 2, 3, 4, 5, 6, 7], 1, 3600, 1736121600);
  const now = h1.at(-1).t + 3600 + 10;
  const h4 = MA.data.resample(h1, 14400, 3600, now);
  assert.equal(h4.length, 1); // segundo grupo (3 velas) incompleto
  assert.equal(h4[0].o, h1[0].o); assert.equal(h4[0].c, h1[3].c);
  assert.equal(h4[0].h, Math.max(...h1.slice(0, 4).map((k) => k.h)));
  const later = MA.data.resample(h1, 14400, 3600, h1[0].t + 8 * 3600); // horário do grupo já passou
  assert.equal(later.length, 2);
});

// ---------------- análise ----------------
test('swings e estrutura de alta', () => {
  const zig = [];
  for (let k = 0; k < 6; k++) zig.push(...lin(100 + k * 10, 120 + k * 10, 8).slice(0, -1), ...lin(120 + k * 10, 110 + k * 10, 8).slice(0, -1));
  const sw = MA.an.swings(candles(zig, 0.5), 3);
  assert.ok(sw.some((s) => s.type === 'H') && sw.some((s) => s.type === 'L'));
  assert.equal(MA.an.structure(sw), 'alta');
});

test('níveis agrupam swings próximos', () => {
  const sw = [100, 100.2, 99.9, 110, 110.1].map((p, i) => ({ price: p, t: i, type: 'H' }));
  const lv = MA.an.levels(sw, 1, 105);
  const s = lv.find((l) => l.kind === 'S'), r = lv.find((l) => l.kind === 'R');
  assert.equal(s.touches, 3); assert.equal(r.touches, 2);
  close(s.price, 100.0333, 1e-3);
});

test('zona de demanda: base + impulso, teste conta, rompimento invalida', () => {
  const c = candles(new Array(30).fill(100), 1); // ATR ~1
  c.push({ t: c.at(-1).t + 900, o: 100, h: 100.6, l: 99.5, c: 100.1 });     // base
  c.push({ t: c.at(-1).t + 900, o: 100.1, h: 103.2, l: 100, c: 103 });      // impulso
  c.push({ t: c.at(-1).t + 900, o: 103, h: 103.5, l: 102.5, c: 103.2 });
  c.push({ t: c.at(-1).t + 900, o: 103.2, h: 103.3, l: 100.05, c: 101 });   // volta na zona (teste)
  const z = MA.an.zones(c, MA.ind.atr(c)).find((x) => x.type === 'demanda');
  assert.ok(z); close(z.low, 99.5); close(z.high, 100.1); assert.equal(z.tests, 1);
  c.push({ t: c.at(-1).t + 900, o: 101, h: 101, l: 98, c: 99 });            // fecha abaixo -> invalida
  assert.ok(!MA.an.zones(c, MA.ind.atr(c)).some((x) => x.type === 'demanda' && x.low === 99.5));
});

test('máx/mín do dia e da semana anteriores', () => {
  const mon = Date.parse('2025-01-06T00:00:00Z') / 1000; // segunda
  const d1 = [];
  for (let i = 0; i < 12; i++) d1.push({ t: mon + i * 86400, o: 10 + i, h: 11 + i, l: 9 + i, c: 10 + i });
  const p = MA.an.periodLevels(d1.slice(0, 11), mon + 10 * 86400 + 3600); // quinta da semana 2
  assert.equal(p.pdh, 21); assert.equal(p.pwh, 17); assert.equal(p.pwl, 9);
});

test('sessões', () => {
  const at = (h, day = '2025-01-07') => Date.parse(day + 'T' + String(h).padStart(2, '0') + ':00:00Z') / 1000;
  assert.deepEqual(MA.an.sessions(at(3)).active, ['Ásia']);
  assert.ok(MA.an.sessions(at(13)).good);
  assert.equal(MA.an.sessions(at(12, '2025-01-11')).label, 'Mercado fechado'); // sábado
});

// ---------------- risco ----------------
test('SL além da invalidação + buffer, limitado por min/max ATR; TPs', () => {
  const p = MA.risk.sltp({ dir: 'compra', entry: 100, invalidation: 99, atr: 1, levelsAhead: [101, 102, 103.5], htfLevelsAhead: [104] });
  close(p.sl, 98.8); close(p.R, 1.2); close(p.tp1, 101.2);
  close(p.tp2, 102);       // 1º nível com RR ≥ 1.5 (2/1.2 = 1.67)
  close(p.tp3, 104);       // nível HTF com RR 3.33 (entre 2.5 e 4.5)
  close(p.rrNext, 1 / 1.2);
  const tight = MA.risk.sltp({ dir: 'venda', entry: 100, invalidation: 100.1, atr: 1 });
  close(tight.sl, 100.8);  // mínimo 0.8 ATR
  const wide = MA.risk.sltp({ dir: 'compra', entry: 100, invalidation: 95, atr: 1 });
  close(wide.sl, 97.5);    // máximo 2.5 ATR
  close(wide.tp3, 100 + 3 * 2.5);
});

test('tamanho de posição', () => {
  // EURUSD: conta 10k, 1% = 100 USD; SL 20 pips × 10 USD/pip/lote = 200 por lote -> 0.5 lote
  const s = MA.risk.positionSize({ entry: 1.1000, sl: 1.0980, pip: 0.0001, pipValue: 10, accountSize: 10000, riskPct: 1 });
  close(s.pips, 20, 1e-6); assert.equal(s.lots, 0.5); assert.equal(s.riskUsd, 100);
});

// ---------------- setups (integração) ----------------
function trendData(dir = 1) {
  // tendência de alta com pullbacks regulares, gerada de forma determinística
  const mk = (n, step, sec, start, amp) => {
    const x = []; let p = start;
    for (let i = 0; i < n; i++) { p += dir * step + Math.sin(i / 3) * amp; x.push(p); }
    return candles(x, amp, sec, 1736121600);
  };
  return { D1: mk(300, 0.5, 86400, 100, 1), H4: mk(300, 0.12, 14400, 100, 0.4), H1: mk(400, 0.03, 3600, 100, 0.2), M15: mk(300, 0.008, 900, 100, 0.08) };
}

test('analyzeAsset: estrutura do resultado e determinismo', () => {
  const s = MA.settings.load ? MA.DEFAULT_SETTINGS : null;
  const asset = MA.DEFAULT_ASSETS.find((a) => a.name === 'EURUSD');
  const data = trendData(1), now = data.M15.at(-1).t + 1800;
  const r1 = MA.setups.analyzeAsset(asset, data, s, now), r2 = MA.setups.analyzeAsset(asset, data, s, now);
  assert.equal(r1.bias.D1.dir, 'alta'); assert.equal(r1.bias.H4.dir, 'alta');
  assert.ok(['ENTRADA', 'OBSERVAR', 'SEM SETUP'].includes(r1.status));
  assert.ok(r1.score >= 0 && r1.score <= 100);
  assert.equal(JSON.stringify(MA.ai.payload(r1)), JSON.stringify(MA.ai.payload(r2)));
  for (const c of r1.candidates) {
    const sg = c.dir === 'compra' ? 1 : -1;
    assert.ok(sg * (c.plan.entry - c.plan.sl) > 0, 'SL do lado certo');
    assert.ok(sg * (c.plan.tp2 - c.plan.tp1) >= 0 && sg * (c.plan.tp3 - c.plan.tp2) > 0, 'TPs em ordem');
  }
});

test('alinhamento', () => {
  const tf = (d1, h4) => ({ D1: { bias: { dir: d1 } }, H4: { bias: { dir: h4 } } });
  assert.equal(MA.setups.alignment('compra', tf('alta', 'alta')).pts, 30);
  assert.equal(MA.setups.alignment('compra', tf('alta', 'neutro')).pts, 18);
  assert.equal(MA.setups.alignment('compra', tf('baixa', 'alta')).pts, 0);
  assert.equal(MA.setups.alignment('venda', tf('baixa', 'baixa')).pts, 30);
});

test('gatilho RSI', () => {
  assert.ok(MA.setups.rsiTrigger('compra', [40, 35, 28, 25, 27, 29, 31, 30, 33]));
  assert.ok(!MA.setups.rsiTrigger('compra', [40, 41, 42, 43, 44, 45, 46, 47, 48]));
  assert.ok(MA.setups.rsiTrigger('venda', [60, 72, 75, 73, 71, 72, 70, 71, 68]));
});

// ---------------- cofre ----------------
require('../js/auth.js');
test('cofre: criptografa e abre com usuário/senha corretos, recusa errados', async () => {
  const data = { tdKey: 'td-123', geminiKey: 'gm-456' };
  const v = await MA.auth.encrypt(data, 'Bryan', 'senha-forte-123!', 1000);
  assert.ok(!JSON.stringify(v).includes('td-123'), 'chave não aparece em texto puro');
  assert.deepEqual(await MA.auth.decrypt(v, 'bryan ', 'senha-forte-123!'), data); // usuário sem diferenciar maiúsc./espaço
  assert.equal(await MA.auth.decrypt(v, 'bryan', 'senha-errada'), null);
  assert.equal(await MA.auth.decrypt(v, 'outro', 'senha-forte-123!'), null);
});
