/* Testes da varredura automática (rodar: node --test tests/) com uma Twelve Data falsa. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScan, needsFetch } = require('../scripts/scan.js');
const MA = globalThis.MA;

const STEP = { '15min': 900, '1h': 3600, '1day': 86400 };
const NOW = Date.UTC(2026, 10, 18, 14, 0, 0) / 1000; // quarta, 14:00 UTC (Londres + NY)

/* Passeio aleatório determinístico por símbolo, com vela ainda aberta no fim (deve ser descartada). */
function fakeSeries(symbol, interval, size, now) {
  let seed = [...symbol + interval].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const step = STEP[interval], last = Math.floor(now / step) * step;
  let p = 100;
  const values = [];
  for (let i = size - 1; i >= 0; i--) {
    const t = last - i * step, o = p;
    p = Math.max(1, p * (1 + (rnd() - 0.48) * 0.004 * Math.sqrt(step / 900)));
    const iso = new Date(t * 1000).toISOString();
    values.push({ datetime: interval === '1day' ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' '),
      open: String(o), high: String(Math.max(o, p) * 1.0005), low: String(Math.min(o, p) * 0.9995), close: String(p) });
  }
  return { status: 'ok', values };
}

function fakeFetch(log, now) {
  return async (url, opts) => {
    if (url.startsWith('https://ntfy.sh')) { log.ntfy.push(JSON.parse(opts.body)); return { ok: true }; }
    const q = new URL(url).searchParams;
    log.td.push(q.get('symbol') + ' ' + q.get('interval'));
    return { json: async () => fakeSeries(q.get('symbol'), q.get('interval'), +q.get('outputsize'), now) };
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
const quiet = () => {};
const noThrottle = async () => {};

test('needsFetch: só busca quando uma vela nova pode ter fechado', () => {
  const c = [{ t: 1000 * 900 }];
  assert.equal(needsFetch([], 'M15', 0), true);
  assert.equal(needsFetch(c, 'M15', 1000 * 900 + 1799), false);
  assert.equal(needsFetch(c, 'M15', 1000 * 900 + 1800), true);
});

test('varredura: grava resumo e velas, e o site reproduz a mesma análise', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const out = await runScan({ dir, key: 'k', topic: 't', fetchFn: fakeFetch(log, NOW), now: NOW, throttle: noThrottle, log: quiet });
  const enabled = MA.DEFAULT_ASSETS.filter((a) => a.enabled);
  assert.equal(out.assets.length, enabled.length);
  assert.equal(out.requests, enabled.length * 3);
  assert.deepEqual(out.errors, {});
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8'));
  assert.equal(saved.t, NOW);

  // o que o site faz (js/app.js fullResult): refaz a análise com as velas salvas e o horário da varredura
  for (const s of saved.assets) {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'velas', s.name + '.json'), 'utf8'));
    const un = (a) => a.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    const data = { M15: un(v.M15), H1: un(v.H1), D1: un(v.D1) };
    assert.ok(data.M15.at(-1).t + 900 <= NOW, 'vela aberta descartada');
    data.H4 = MA.data.resample(data.H1, 14400, 3600, saved.t);
    const r = MA.setups.analyzeAsset(MA.DEFAULT_ASSETS.find((a) => a.name === s.name), data, MA.DEFAULT_SETTINGS, saved.t);
    assert.equal(r.score, s.score, s.name);
    assert.equal(r.status, s.status, s.name);
    assert.equal(r.best ? r.best.name + r.best.dir : null, s.best ? s.best.name + s.best.dir : null, s.name);
  }

  // mesma hora de novo: nada para buscar
  const again = await runScan({ dir, key: 'k', topic: 't', fetchFn: fakeFetch(log, NOW), now: NOW, throttle: noThrottle, log: quiet });
  assert.equal(again.requests, 0);
  // 30 min depois: só M15 (o H1 ainda não fechou outra vela, o D1 é do mesmo dia)
  const later = await runScan({ dir, key: 'k', topic: 't', fetchFn: fakeFetch(log, NOW + 1800), now: NOW + 1800, throttle: noThrottle, log: quiet });
  assert.equal(later.requests, enabled.length);
  // 1 h depois: M15 + H1
  const hour = await runScan({ dir, key: 'k', topic: 't', fetchFn: fakeFetch(log, NOW + 3600), now: NOW + 3600, throttle: noThrottle, log: quiet });
  assert.equal(hour.requests, enabled.length * 2);
});

test('varredura: ENTRADA avisa uma vez, guarda no histórico e não repete por 4 h', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const real = MA.setups.analyzeAsset;
  // força uma ENTRADA no EURUSD, sem mexer no resto do motor
  MA.setups.analyzeAsset = (asset, data, s, now) => {
    const r = real(asset, data, s, now);
    if (asset.name === 'EURUSD' && r.best) { r.best.status = 'ENTRADA'; r.status = 'ENTRADA'; }
    return r;
  };
  try {
    const run = (now) => runScan({ dir, key: 'k', topic: 't', fetchFn: fakeFetch(log, now), now, throttle: noThrottle, log: quiet });
    const a = await run(NOW);
    assert.ok(a.assets.find((x) => x.name === 'EURUSD').best, 'dados sintéticos precisam ter setup no EURUSD');
    assert.equal(log.ntfy.length, 1);
    assert.match(log.ntfy[0].title, /^ENTRADA .* EURUSD/);
    assert.equal(log.ntfy[0].topic, 't');
    assert.equal(a.history.length, 1);
    await run(NOW + 1800);
    assert.equal(log.ntfy.length, 1, 'não repete dentro de 4 h');
    const c = await run(NOW + 4 * 3600 + 60);
    assert.equal(log.ntfy.length, 2, 'avisa de novo depois de 4 h');
    assert.equal(c.history.length, 2);
  } finally { MA.setups.analyzeAsset = real; }
});

test('varredura: erro de um ativo usa as velas anteriores e não derruba os outros', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  await runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, NOW), now: NOW, throttle: noThrottle, log: quiet });
  const ok = fakeFetch(log, NOW + 1800);
  const flaky = async (url, o) => (url.includes('XAU') ? { json: async () => ({ status: 'error', code: 400, message: 'falhou' }) } : ok(url, o));
  const out = await runScan({ dir, key: 'k', topic: '', fetchFn: flaky, now: NOW + 1800, throttle: noThrottle, log: quiet });
  assert.match(out.errors.XAUUSD, /falhou/);
  assert.equal(out.assets.length, MA.DEFAULT_ASSETS.filter((a) => a.enabled).length);
});

test('ETFs só gastam consulta no pregão americano', () => {
  const { marketOpen } = require('../scripts/scan.js');
  const qqq = MA.DEFAULT_ASSETS.find((a) => a.name === 'NAS100'), eur = MA.DEFAULT_ASSETS.find((a) => a.name === 'EURUSD');
  const at = (h, m = 0) => Date.UTC(2026, 10, 18, h, m) / 1000; // quarta
  assert.equal(marketOpen(qqq, at(3)), false);
  assert.equal(marketOpen(qqq, at(15)), true);
  assert.equal(marketOpen(eur, at(3)), true);
});

test('orçamento: um dia inteiro no agendamento do workflow cabe nas 800 consultas da Twelve Data', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const day = Date.UTC(2026, 10, 18) / 1000; // quarta 00:00 UTC
  // véspera às 23:00 (última rodada da noite anterior) para começar com velas salvas
  const runs = [day - 3600];
  for (let h = 0; h < 24; h++) {
    if (h <= 6 || h >= 21) runs.push(day + h * 3600);                // Ásia: de hora em hora
    else { runs.push(day + h * 3600); runs.push(day + h * 3600 + 1800); } // Londres/NY: 30 em 30 min
  }
  let total = 0;
  for (const [i, now] of runs.entries()) {
    const o = await runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, now), now, throttle: noThrottle, log: quiet });
    if (i > 0) total += o.requests;
  }
  console.log('consultas no dia:', total); assert.ok(total < 720, 'consultas no dia: ' + total);
});
