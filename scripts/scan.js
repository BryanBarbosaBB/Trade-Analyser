/* Varredura automática (GitHub Actions, a cada 30 min das 08:00 às 03:00 de Brasília; horários em agenda.js).
   Uso: TD_KEY=... NTFY_TOPIC=... node scripts/scan.js <pasta-de-dados>

   A pasta de dados é o ramo `dados` do repositório. O script lê o que já estava lá, busca na Twelve Data
   só as velas que podem ter mudado, roda o MESMO motor do site e grava:
     scan.json          resumo de todos os ativos, histórico de sinais e controle de alertas
     velas/<ATIVO>.json velas M15/H1/D1 usadas na análise (o site refaz a análise com elas e mostra o gráfico)
   Para cada ENTRADA nova, manda notificação no celular (ntfy). */
'use strict';
const fs = require('fs');
const path = require('path');

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ['config', 'indicators', 'data', 'analysis', 'risk', 'setups']) require('../js/' + f + '.js');
const MA = globalThis.MA;

const INTERVAL = { M15: '15min', H1: '1h', D1: '1day' };
const TF_SEC = MA.data.TF_SEC;
const PER_MIN = 7;                    // plano grátis: 8 requisições por minuto
const HISTORY_MAX = 300;              // sinais guardados no histórico
const SITE = process.env.SITE_URL || 'https://bryanbarbosabb.github.io/Trade-Analyser/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } };
const pack = (c) => c.map((k) => [k.t, k.o, k.h, k.l, k.c]);
const unpack = (a) => (a || []).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));

const { needsFetch, marketOpen, isDayLimit } = MA.data;

function makeThrottle(perMin = PER_MIN) {
  const calls = [];
  return async () => {
    for (;;) {
      const t = Date.now();
      while (calls.length && t - calls[0] > 60000) calls.shift();
      if (calls.length < perMin) { calls.push(t); return; }
      await sleep(60000 - (t - calls[0]) + 250);
    }
  };
}

async function fetchTD(fetchFn, throttle, key, symbol, tf, size, now) {
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(symbol) + '&interval=' + INTERVAL[tf] +
    '&outputsize=' + size + '&timezone=UTC&order=asc&apikey=' + encodeURIComponent(key);
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const json = await (await fetchFn(url)).json();
    if (json && json.code === 429 && attempt === 0 && !isDayLimit(json)) { await sleep(61000); continue; } // limite por minuto: tenta uma vez
    return MA.data.parse(json, tf, now);
  }
}

async function notify(fetchFn, topic, title, message, click) {
  if (!topic) return false;
  try {
    const res = await fetchFn('https://ntfy.sh/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, priority: 5, tags: ['chart_with_upwards_trend'], click }),
    });
    return res.ok;
  } catch (e) { return false; }
}

const { summarize } = MA.setups;

/* O limite de 8 consultas/min faz a varredura durar até ~3 min: começa por quem está mais perto de uma ENTRADA
   (D1 e H4 alinhados na última varredura, depois maior score), para o aviso dele sair primeiro. */
function scanOrder(assets, prevAssets) {
  const rank = (a) => {
    const p = (prevAssets || []).find((x) => x.name === a.name);
    if (!p) return 0;
    const aligned = p.bias && p.bias.D1 !== 'neutro' && p.bias.D1 === p.bias.H4;
    return (aligned ? 1000 : 0) + (p.score || 0);
  };
  return assets.map((a, i) => ({ a, i, k: rank(a) })).sort((x, y) => y.k - x.k || x.i - y.i).map((x) => x.a);
}

async function runScan({ dir, key, topic, fetchFn = fetch, now = Math.floor(Date.now() / 1000), throttle = makeThrottle(), log = console.log }) {
  if (!key) throw new Error('Falta a chave da Twelve Data (secret TD_KEY).');
  fs.mkdirSync(path.join(dir, 'velas'), { recursive: true });
  const prev = readJson(path.join(dir, 'scan.json'), {});
  const settings = structuredClone(MA.DEFAULT_SETTINGS);
  settings.asiaSignals = true; // escolha do usuário: sinais da Ásia também (marcados como não validados)
  const assets = scanOrder(MA.DEFAULT_ASSETS.filter((a) => a.enabled), prev.assets);
  const out = {
    t: now, source: 'Twelve Data', assets: [], errors: {}, requests: 0,
    history: prev.history || [], alerted: Object.assign({}, prev.alerted),
  };
  /* Controle de alertas ("rearmar"): o mesmo ativo/setup/direção fica em silêncio só enquanto continua ENTRADA.
     Se numa varredura ele deixa de ser ENTRADA, o aviso rearma e o próximo gatilho notifica de novo. */
  const active = new Set(), analyzed = new Set();

  for (const asset of assets) {
    const file = path.join(dir, 'velas', asset.name + '.json');
    const stored = readJson(file, {});
    const data = {};
    try {
      for (const tf of ['M15', 'H1', 'D1']) {
        let c = unpack(stored[tf]);
        if (needsFetch(c, tf, now) && (marketOpen(asset, now) || !c.length)) {
          try {
            c = await fetchTD(fetchFn, throttle, key, asset.td, tf, settings.candles[tf], now);
            out.requests++;
          } catch (e) {
            if (!c.length) throw e;
            out.errors[asset.name] = tf + ': ' + e.message + ' (usando velas anteriores)';
          }
        }
        if (!c.length) throw new Error('sem velas ' + tf);
        data[tf] = c;
      }
      fs.writeFileSync(file, JSON.stringify({ t: now, M15: pack(data.M15), H1: pack(data.H1), D1: pack(data.D1) }));
      data.H4 = MA.data.resample(data.H1, TF_SEC.H4, TF_SEC.H1, now);
      const r = MA.setups.analyzeAsset(asset, data, settings, now);
      const s = summarize(asset, r);
      out.assets.push(s);
      analyzed.add(asset.name);
      log(asset.name.padEnd(7), String(s.score).padStart(3), s.status, s.best ? s.best.name + ' ' + s.best.dir : '');

      const b = s.best;
      if (b && b.status === 'ENTRADA') {
        const k = asset.name + '|' + b.name + '|' + b.dir;
        active.add(k);
        if (!out.alerted[k]) {
          out.alerted[k] = now;
          out.history.unshift({ t: now, candle: s.updated, asset: asset.name, setup: b.name, dir: b.dir, score: b.score, digits: s.digits, asia: b.asia,
            entry: b.entry, sl: b.sl, tp1: b.tp1, tp2: b.tp2, tp3: b.tp3, triggered: b.triggered });
          const fx = (x) => (x == null ? '—' : x.toFixed(s.digits));
          const sent = await notify(fetchFn, topic, (b.asia ? 'ÁSIA (não validado) ' : '') + 'ENTRADA ' + b.dir.toUpperCase() + ' ' + asset.name + ' (score ' + b.score + ')',
            [b.dir.toUpperCase() + ' ' + asset.name + ' @ ' + fx(b.entry) + (asset.proxy ? ' (' + asset.td + ')' : ''),
              'SL ' + fx(b.sl) + ' | TP1 ' + fx(b.tp1) + ' | TP3 ' + fx(b.tp3), b.name].join('\n'),
            SITE + '#' + asset.name);
          log('  -> ENTRADA, alerta', sent ? 'enviado' : 'NÃO enviado');
        }
      }
    } catch (e) {
      out.errors[asset.name] = e.message;
      log(asset.name.padEnd(7), 'ERRO', e.message);
      const old = (prev.assets || []).find((a) => a.name === asset.name);
      if (old) out.assets.push(Object.assign({}, old, { stale: true }));
    }
  }
  // rearma: sinal avisado que não está mais em ENTRADA num ativo analisado nesta rodada (ativo com erro não rearma)
  for (const k of Object.keys(out.alerted)) if (analyzed.has(k.split('|')[0]) && !active.has(k)) delete out.alerted[k];
  out.history = out.history.slice(0, HISTORY_MAX);
  fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify(out));
  log('Requisições Twelve Data:', out.requests, '| erros:', Object.keys(out.errors).length);
  return out;
}

module.exports = { runScan, needsFetch, marketOpen, summarize, scanOrder };

if (require.main === module) {
  const dir = process.argv[2] || 'dados';
  runScan({ dir, key: process.env.TD_KEY, topic: (process.env.NTFY_TOPIC || '').trim() })
    .then((o) => { if (o.assets.length === 0) process.exit(1); })
    .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
