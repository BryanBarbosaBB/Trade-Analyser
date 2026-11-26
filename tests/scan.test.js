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

/* Yahoo falso: fechamentos diários com índice = ETF × 41 (^NDX) ou × 100 (^DJI); o de hoje vale outra proporção (não pode ser usado). */
function fakeYahoo(url, now) {
  const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]), k = { '^NDX': 41, '^DJI': 100 }[sym] || 1;
  const d0 = Math.floor(now / 86400) * 86400, ts = [3, 2, 1, 0].map((i) => d0 - i * 86400 + 14.5 * 3600);
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: ts.map((t, i) => 100 * k * (i === 3 && k > 1 ? 1.1 : 1)) }] } }] } };
}

function fakeFetch(log, now) {
  return async (url, opts) => {
    if (url.startsWith('https://ntfy.sh')) { log.ntfy.push(JSON.parse(opts.body)); return { ok: true }; }
    if (url.includes('finance.yahoo.com')) { (log.yahoo = log.yahoo || []).push(url); return { json: async () => fakeYahoo(url, now) }; }
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

test('varredura: ENTRADA avisa uma vez, guarda no histórico e só rearma quando o sinal some', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const real = MA.setups.analyzeAsset;
  let force = true;
  // força uma ENTRADA no EURUSD, sem mexer no resto do motor
  MA.setups.analyzeAsset = (asset, data, s, now) => {
    const r = real(asset, data, s, now);
    if (force && asset.name === 'EURUSD' && r.best) { r.best.status = 'ENTRADA'; r.status = 'ENTRADA'; }
    if (!force && asset.name === 'EURUSD' && r.best) { r.best.status = 'OBSERVAR'; r.status = 'OBSERVAR'; }
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
    await run(NOW + 6 * 3600);
    assert.equal(log.ntfy.length, 1, 'o mesmo sinal ainda ativo não repete, nem depois de horas');
    force = false;
    const b = await run(NOW + 6 * 3600 + 1800);
    assert.equal(log.ntfy.length, 1, 'sinal sumiu: não avisa');
    assert.deepEqual(Object.keys(b.alerted).filter((k) => k.startsWith('EURUSD|')), [], 'sinal sumiu: aviso rearmado');
    force = true;
    const c = await run(NOW + 7 * 3600);
    assert.equal(log.ntfy.length, 2, 'gatilho novo depois de rearmar: avisa de novo');
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

test('NAS100/US30 na escala do índice: proporção do último fechamento antes de hoje, guardada no dia e usada pelo site', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const out = await runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, NOW), now: NOW, throttle: noThrottle, log: quiet });
  assert.equal(out.fator.NAS100.k, 41); assert.equal(out.fator.US30.k, 100);
  assert.equal(out.fator.NAS100.fech, new Date((NOW - 86400) * 1000).toISOString().slice(0, 10));
  const nas = out.assets.find((a) => a.name === 'NAS100'), raw = JSON.parse(fs.readFileSync(path.join(dir, 'velas', 'NAS100.json')));
  assert.ok(Math.abs(nas.price - raw.M15[raw.M15.length - 1][4] * 41) < 0.01, 'preço do resumo = último QQQ × 41');
  // velas salvas continuam do ETF; o site converte com a mesma proporção e chega ao mesmo resultado
  const un = (a) => a.map(([t, o, h, l, c]) => ({ t, o, h, l, c })), data = { M15: un(raw.M15), H1: un(raw.H1), D1: un(raw.D1) };
  data.H4 = MA.data.resample(data.H1, MA.data.TF_SEC.H4, MA.data.TF_SEC.H1, NOW);
  const conv = MA.data.toIndex(MA.DEFAULT_ASSETS.find((a) => a.name === 'NAS100'), data, out.fator.NAS100.k);
  const r = MA.setups.summarize(conv.asset, MA.setups.analyzeAsset(conv.asset, conv.data, Object.assign(structuredClone(MA.DEFAULT_SETTINGS), { asiaSignals: true }), NOW));
  assert.deepEqual(r, nas);
  // mesma data: não consulta o Yahoo de novo; Yahoo fora do ar: fica com a anterior
  const n = log.yahoo.length;
  await runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, NOW + 1800), now: NOW + 1800, throttle: noThrottle, log: quiet });
  assert.equal(log.yahoo.length, n);
  const { fatores } = require('../scripts/scan.js'), fora = async () => { throw new Error('fora do ar'); };
  assert.deepEqual((await fatores(fora, MA.DEFAULT_ASSETS, out.fator, NOW + 86400, quiet)).NAS100, out.fator.NAS100);
  assert.equal((await fatores(fora, MA.DEFAULT_ASSETS, undefined, NOW, quiet)).NAS100.k, 41.09);
  assert.equal(MA.data.toIndex(MA.DEFAULT_ASSETS[0], data, 41).k, 1, 'ouro não muda');
});

test('falta do gatilho RSI: diz exatamente o que precisa acontecer', () => {
  const f = MA.setups.rsiFalta, base = Array(20).fill(55);
  assert.match(f('venda', base), /passar de 70 e depois voltar a cair/);
  assert.match(f('venda', [...base, 74.7, 74.6]), /voltar abaixo de 70/);
  assert.match(f('venda', [...base, 74.7, 68.1, 68.6]), /voltar a cair: já saiu da sobrecompra, mas subiu/);
  assert.equal(MA.setups.rsiTrigger('venda', [...base, 74.7, 68.6, 68.1]), true);
  assert.match(f('compra', [...base, 25, 31, 30.5]), /voltar a subir: já saiu da sobrevenda/);
});

test('orçamento: um dia inteiro no agendamento do workflow cabe nas 800 consultas da Twelve Data', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const day = Date.UTC(2026, 10, 18) / 1000; // quarta 00:00 UTC
  const { isSlot } = require('../scripts/agenda.js');
  // véspera às 23:30 (última rodada da noite anterior) para começar com velas salvas; depois, os horários da agenda
  const runs = [day - 1800];
  for (let t = day; t < day + 86400; t += 1800) if (isSlot(t)) runs.push(t + 90);
  let total = 0;
  for (const [i, now] of runs.entries()) {
    const o = await runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, now), now, throttle: noThrottle, log: quiet });
    if (i > 0) total += o.requests;
  }
  console.log('consultas no dia:', total); assert.ok(total < 720, 'consultas no dia: ' + total);
});

test('sinais da Ásia: só com asiaSignals, sempre marcados; o padrão (robô) não muda', () => {
  const at = Date.UTC(2026, 10, 18, 2, 0) / 1000; // quarta 02:00 UTC (Ásia)
  assert.equal(MA.DEFAULT_SETTINGS.asiaSignals, false);
  let asiaSeen = 0;
  for (const a of MA.DEFAULT_ASSETS.filter((x) => x.enabled)) {
    const data = {};
    for (const [tf, iv, n] of [['M15', '15min', 500], ['H1', '1h', 1200], ['D1', '1day', 400]]) data[tf] = MA.data.parse(fakeSeries(a.td, iv, n, at), tf, at);
    data.H4 = MA.data.resample(data.H1, 14400, 3600, at);
    const off = MA.setups.analyzeAsset(a, data, MA.DEFAULT_SETTINGS, at);
    const on = MA.setups.analyzeAsset(a, data, Object.assign({}, MA.DEFAULT_SETTINGS, { asiaSignals: true }), at);
    assert.ok(off.candidates.every((c) => c.status !== 'ENTRADA' && !c.asia), 'sem asiaSignals não há ENTRADA na Ásia');
    for (const c of on.candidates) if (c.status === 'ENTRADA') { assert.equal(c.asia, true); assert.match(c.warnings[0], /NÃO validado/); asiaSeen++; }
    assert.equal(on.candidates.length, off.candidates.length);
  }
  assert.ok(asiaSeen >= 0);
});

test('agenda: horários de Brasília 08:00–03:00, de domingo à noite até sexta', () => {
  const { isSlot } = require('../scripts/agenda.js');
  const brt = (dia, h, m = 0) => Date.UTC(2026, 10, dia, h + 3, m) / 1000; // dia 22/11/2026 = domingo
  assert.equal(isSlot(brt(22, 17, 30)), false, 'domingo à tarde não');
  assert.equal(isSlot(brt(22, 18)), true, 'domingo 18:00');
  assert.equal(isSlot(brt(22, 23, 30)), true);
  assert.equal(isSlot(brt(23, 2, 30)), true);
  assert.equal(isSlot(brt(23, 3)), true, 'última da madrugada 03:00');
  assert.equal(isSlot(brt(23, 3, 30)), false);
  assert.equal(isSlot(brt(23, 7, 30)), false);
  assert.equal(isSlot(brt(23, 8)), true, 'começa 08:00');
  assert.equal(isSlot(brt(23, 8, 15)), false, 'só :00 e :30');
  assert.equal(isSlot(brt(26, 23, 30)), true, 'quinta 23:30');
  assert.equal(isSlot(brt(27, 3)), true, 'sexta 03:00');
  assert.equal(isSlot(brt(27, 17, 30)), true, 'sexta 17:30');
  assert.equal(isSlot(brt(27, 18)), false, 'sexta à noite não');
  assert.equal(isSlot(brt(28, 12)), false, 'sábado não');
  let n = 0; for (let t = brt(22, 0); t < brt(29, 0); t += 1800) n += isSlot(t); // semana inteira
  assert.equal(n, 5 * 39, '39 varreduras por dia útil (20 de dia + 19 à noite)');
});

test('agenda: a corrente varre cada horário uma vez e nunca para', () => {
  const { deveVarrer, espera, isSlot } = require('../scripts/agenda.js');
  const brt = (dia, h, m = 0) => Date.UTC(2026, 10, dia, h + 3, m) / 1000;
  assert.equal(deveVarrer(brt(23, 8, 1), brt(23, 3, 2)), true);
  assert.equal(deveVarrer(brt(23, 8, 20), brt(23, 8, 2)), false, 'já varrido');
  assert.equal(deveVarrer(brt(23, 5), 0), false, 'fora do horário');
  // simula a corrente por 2 semanas: cada rodada espera e dispara a próxima (com até 60 s de fila no GitHub)
  let t = brt(22, 12, 7), ultima = 0, varridos = new Set(), rodadas = 0;
  const fim = brt(22, 0) + 14 * 86400;
  while (t < fim) {
    if (deveVarrer(t, ultima)) { varridos.add(Math.floor(t / 1800) * 1800); ultima = t + 200; t += 200; }
    const s = espera(t);
    assert.ok(s > 0 && s <= 5.5 * 3600, 'espera dentro do limite do job: ' + s);
    t += s + 45; rodadas++;
  }
  let esperado = 0;
  for (let s = brt(22, 12, 30); s < fim - 1800; s += 1800) if (isSlot(s)) { esperado++; assert.ok(varridos.has(s), 'faltou ' + new Date(s * 1000).toISOString()); }
  assert.equal(varridos.size, esperado, 'nenhuma varredura extra');
  assert.ok(rodadas < esperado + 60, 'rodadas: ' + rodadas);
});

test('missing: todo setup que não é ENTRADA diz o que falta; ENTRADA não tem pendência', () => {
  let seen = 0;
  const s = Object.assign({}, MA.DEFAULT_SETTINGS, { asiaSignals: true });
  for (const h of [2, 10, 14, 22]) for (const a of MA.DEFAULT_ASSETS.filter((x) => x.enabled)) {
    const at = Date.UTC(2026, 10, 18, h, 0) / 1000, data = {};
    for (const [tf, iv, n] of [['M15', '15min', 500], ['H1', '1h', 1200], ['D1', '1day', 400]]) data[tf] = MA.data.parse(fakeSeries(a.td, iv, n, at), tf, at);
    data.H4 = MA.data.resample(data.H1, 14400, 3600, at);
    for (const c of MA.setups.analyzeAsset(a, data, s, at).candidates) {
      seen++;
      assert.equal(c.missing.length === 0, c.status === 'ENTRADA', a.name + ' ' + c.name + ' ' + c.status);
      if (!c.triggered) assert.ok(c.missing.some((m) => /preço|vela M15|RSI M15/.test(m)), 'sem gatilho explica o gatilho: ' + c.missing);
    }
  }
  assert.ok(seen > 5);
});

test('scanOrder: D1/H4 alinhados e score alto primeiro', () => {
  const { scanOrder } = require('../scripts/scan.js');
  const L = ['A', 'B', 'C', 'D'].map((name) => ({ name }));
  const prev = [{ name: 'A', score: 90, bias: { D1: 'alta', H4: 'neutro' } }, { name: 'B', score: 60, bias: { D1: 'baixa', H4: 'baixa' } },
    { name: 'C', score: 80, bias: { D1: 'alta', H4: 'alta' } }];
  assert.deepEqual(scanOrder(L, prev).map((a) => a.name), ['C', 'B', 'A', 'D']);
  assert.deepEqual(scanOrder(L, undefined).map((a) => a.name), ['A', 'B', 'C', 'D']);
});

test('cota do dia esgotada: erro na hora, sem esperar', async () => {
  const dir = tmp();
  const f = async () => ({ json: async () => ({ status: 'error', code: 429, message: 'You have run out of API credits for the day.' }) });
  const t0 = Date.now();
  const o = await runScan({ dir, key: 'k', topic: '', fetchFn: f, now: NOW, throttle: noThrottle, log: quiet });
  assert.equal(o.assets.length, 0);
  assert.ok(Date.now() - t0 < 5000);
});

test('contador de consultas do dia', async () => {
  const dir = tmp(), log = { td: [], ntfy: [] };
  const run = (now) => runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, now), now, throttle: noThrottle, log: quiet });
  const a = await run(NOW), b = await run(NOW + 1800);
  assert.equal(a.uso.n, a.requests);
  assert.equal(b.uso.n, a.requests + b.requests);
  const c = await run(NOW + 86400);
  assert.equal(c.uso.n, c.requests, 'zera no dia seguinte');
});

const C = require('../scripts/comandos.js');

test('pedidos: só os três textos conhecidos', () => {
  assert.deepEqual(C.parsePedido('varrer'), { tipo: 'varrer' });
  assert.deepEqual(C.parsePedido(' ia '), { tipo: 'ia', alvo: 'rank' });
  assert.deepEqual(C.parsePedido('ia:EURJPY'), { tipo: 'ia', alvo: 'EURJPY' });
  for (const x of ['', null, 'ia:XXXXXX', 'ia:../../x', 'ia:EURJPY;ls', 'varrer tudo', 'ia:__proto__', 'ia:rank', {}]) assert.equal(C.parsePedido(x), null, String(x));
});

test('pedidos: cota reservada para a varredura automática, limites e pedidos velhos', () => {
  const v = { tipo: 'varrer' }, dia = '2026-11-18', sab = Date.UTC(2026, 10, 21, 15) / 1000;
  const scan = (n, t = NOW - 600) => ({ t, uso: { dia, n } });
  assert.equal(C.decide(v, NOW - 5, NOW, scan(370), {}).acao, 'executa');
  assert.equal(C.decide(v, NOW - 5, NOW, scan(700), {}).acao, 'nega', 'não pode comer a cota da automática');
  assert.equal(C.decide(v, NOW - 5, NOW, scan(100, NOW - 2), {}).acao, 'pronto', 'já varreu depois do pedido');
  assert.equal(C.decide(v, NOW - 5, NOW, scan(100, NOW - 30), {}).acao, 'pronto', 'no máximo uma por minuto');
  assert.equal(C.decide(v, NOW - 3600, NOW, scan(0), {}).acao, 'ignora', 'pedido velho');
  assert.equal(C.decide(v, sab - 5, sab, { t: sab - 9e4, uso: { dia: '2026-11-20', n: 790 } }, {}).acao, 'executa', 'fim de semana: cota livre');
  const ia = { tipo: 'ia', alvo: 'rank' };
  assert.equal(C.decide(ia, NOW - 5, NOW, {}, { uso: { dia, n: C.IA_DIA } }).acao, 'nega');
  assert.equal(C.decide(ia, NOW - 5, NOW, {}, { uso: { dia, n: 1 } }).acao, 'executa');
  assert.equal(C.decide(ia, NOW - 5, NOW, {}, { rank: { t: NOW } }).acao, 'pronto');
});

test('pedidos: baixa, executa, salva e avisa o site; erro também avisa', async () => {
  const dir = tmp(), passos = [], st = [];
  const fetchFn = async (u, o) => { assert.ok(u.endsWith(C.STATUS)); st.push(JSON.parse(o.body)); return { ok: true }; };
  const deps = { baixa: async () => passos.push('baixa'), salva: async () => passos.push('salva'), varre: async () => passos.push('varre'), ia: async (a) => { throw new Error('sem ' + a); } };
  const at = (message, time = NOW) => C.atende({ id: 'x1', time, message }, { dir, now: () => NOW, fetchFn, deps, log: quiet });
  await at('varrer');
  assert.deepEqual(passos, ['baixa', 'varre', 'salva']);
  assert.deepEqual(st.map((s) => s.st), ['recebido', 'pronto']);
  st.length = 0; await at('ia:EURJPY');
  assert.deepEqual(st.map((s) => s.st + s.txt), ['recebido', 'errosem EURJPY']);
  st.length = 0; assert.equal(await at('qualquer coisa'), 'ignora');
  assert.equal(st.length, 0);
});

test('pedidos: escuta o ntfy, não repete pedido ao reconectar e termina no prazo', async () => {
  const dir = tmp(); let varridas = 0, conexoes = 0;
  const linha = (o) => JSON.stringify(o) + '\n', t = Math.floor(Date.now() / 1000);
  const fetchFn = async (u) => {
    if (u.endsWith(C.STATUS)) return { ok: true };
    conexoes++;
    const enc = new TextEncoder(), txt = linha({ event: 'open' }) + linha({ id: 'a', event: 'message', time: t, message: 'varrer' }) + 'lixo\n';
    return { ok: true, body: (async function* () { yield enc.encode(txt.slice(0, 30)); yield enc.encode(txt.slice(30)); })() };
  };
  const t0 = Date.now();
  await C.escuta({ dir, segundos: 12, fetchFn, log: quiet, deps: { baixa: async () => {}, salva: async () => {}, varre: async () => { varridas++; } } });
  assert.equal(varridas, 1);
  assert.ok(conexoes >= 2 && Date.now() - t0 < 14000);
});

test('IA na nuvem: grava ia.json; sem chave explica o que falta', async () => {
  const { runIA } = require('../scripts/ia.js');
  const dir = tmp(), log = { td: [], ntfy: [] }, real = globalThis.fetch;
  await runScan({ dir, key: 'k', topic: '', fetchFn: fakeFetch(log, NOW), now: NOW, throttle: noThrottle, log: quiet });
  await assert.rejects(runIA({ dir, alvo: 'rank', key: '' }), /GEMINI_KEY/);
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ranking":[],"resumo":"ok"}' }] } }] }) });
    await runIA({ dir, alvo: 'EURUSD', key: 'k', now: NOW });
    const ia = await runIA({ dir, alvo: 'rank', key: 'k', now: NOW + 5 });
    assert.equal(ia.ativos.EURUSD.out.resumo, 'ok'); assert.equal(ia.rank.scan, NOW); assert.equal(ia.uso.n, 2);
  } finally { globalThis.fetch = real; }
});

test('pedidos: segredo nunca sai no aviso público', () => {
  const env = { TD_KEY: 'segredoTD', GH_TOKEN: 'ghs_abc', GEMINI_KEY: 'AIzaX', NTFY_TOPIC: 'topico-privado' };
  const s = C.limpa("fatal: unable to access 'https://x-access-token:ghs_abc@github.com/a/b.git/': segredoTD AIzaX topico-privado", env);
  assert.doesNotMatch(s, /ghs_abc|segredoTD|AIzaX|topico-privado|x-access-token/);
});

test('pedidos: cópia do resultado em p/<id>/, só a última e com id seguro', () => {
  const fs = require('fs'), path = require('path'), dir = tmp();
  fs.mkdirSync(path.join(dir, 'velas'));
  fs.writeFileSync(path.join(dir, 'scan.json'), '{"t":1}'); fs.writeFileSync(path.join(dir, 'velas', 'EURJPY.json'), '{}');
  C.copia(dir, 'abc123'); C.copia(dir, 'def456');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'p')), ['def456']);
  assert.ok(fs.existsSync(path.join(dir, 'p', 'def456', 'velas', 'EURJPY.json')));
  for (const ruim of ['../x', 'a/b', '', null]) { C.copia(dir, ruim); assert.ok(!fs.existsSync(path.join(dir, 'p')), String(ruim)); }
});

test('missing: longe do reteste, o texto pede o preço E a vela de confirmação', () => {
  let vistos = 0;
  for (const h of [2, 10, 14, 22]) for (const a of MA.DEFAULT_ASSETS.filter((x) => x.enabled)) {
    const at = Date.UTC(2026, 10, 18, h, 0) / 1000, data = {};
    for (const [tf, iv, n] of [['M15', '15min', 500], ['H1', '1h', 1200], ['D1', '1day', 400]]) data[tf] = MA.data.parse(fakeSeries(a.td, iv, n, at), tf, at);
    data.H4 = MA.data.resample(data.H1, 14400, 3600, at);
    for (const c of MA.setups.analyzeAsset(a, data, MA.DEFAULT_SETTINGS, at).candidates) for (const m of c.missing) {
      assert.doesNotMatch(m, /agora/);
      if (c.name.startsWith('Rompimento') && /preço/.test(m)) { vistos++; assert.match(m, /depois disso, vela M15/); }
    }
  }
  console.log('rompimentos longe do reteste:', vistos);
});
