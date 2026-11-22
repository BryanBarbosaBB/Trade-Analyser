/* Varredura automática (GitHub Actions, a cada 30 min no horário de Londres/NY).
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
const ALERT_COOLDOWN = 4 * 3600;      // mesmo ativo/setup/direção não avisa de novo por 4 h
const HISTORY_MAX = 300;              // sinais guardados no histórico
const SITE = process.env.SITE_URL || 'https://bryanbarbosabb.github.io/Trade-Analyser/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } };
const pack = (c) => c.map((k) => [k.t, k.o, k.h, k.l, k.c]);
const unpack = (a) => (a || []).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));

/* Precisa buscar de novo se uma vela nova pode ter fechado desde a última busca. */
function needsFetch(candles, tf, now) {
  if (!candles || !candles.length) return true;
  return now >= candles[candles.length - 1].t + 2 * TF_SEC[tf];
}

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
    if (json && json.code === 429 && attempt === 0) { await sleep(61000); continue; } // limite por minuto: tenta uma vez
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

const round = (x, d) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

/* Resumo de um ativo para a lista do painel (o detalhe completo o site recalcula com as velas). */
function summarize(asset, r) {
  const b = r.best, d = r.digits;
  return {
    name: asset.name, td: asset.td, proxy: asset.proxy || null, price: round(r.price, d), digits: d,
    score: r.score, status: r.status, updated: r.updated, session: r.session.label,
    bias: Object.fromEntries(['D1', 'H4', 'H1', 'M15'].map((k) => [k, r.bias[k].dir])),
    best: b ? {
      name: b.name, dir: b.dir, status: b.status, score: b.score, triggered: b.triggered, distAtr: round(b.area.distAtr, 2),
      entry: round(b.plan.entry, d), sl: round(b.plan.sl, d), tp1: round(b.plan.tp1, d), tp2: round(b.plan.tp2, d), tp3: round(b.plan.tp3, d),
    } : null,
  };
}

async function runScan({ dir, key, topic, fetchFn = fetch, now = Math.floor(Date.now() / 1000), throttle = makeThrottle(), log = console.log }) {
  if (!key) throw new Error('Falta a chave da Twelve Data (secret TD_KEY).');
  fs.mkdirSync(path.join(dir, 'velas'), { recursive: true });
  const prev = readJson(path.join(dir, 'scan.json'), {});
  const settings = structuredClone(MA.DEFAULT_SETTINGS);
  const assets = MA.DEFAULT_ASSETS.filter((a) => a.enabled);
  const out = {
    t: now, source: 'Twelve Data', assets: [], errors: {}, requests: 0,
    history: prev.history || [], alerted: {},
  };
  // controle de alertas: mantém só os recentes
  for (const [k, t] of Object.entries(prev.alerted || {})) if (now - t < ALERT_COOLDOWN) out.alerted[k] = t;

  for (const asset of assets) {
    const file = path.join(dir, 'velas', asset.name + '.json');
    const stored = readJson(file, {});
    const data = {};
    try {
      for (const tf of ['M15', 'H1', 'D1']) {
        let c = unpack(stored[tf]);
        if (needsFetch(c, tf, now)) {
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
      log(asset.name.padEnd(7), String(s.score).padStart(3), s.status, s.best ? s.best.name + ' ' + s.best.dir : '');

      const b = s.best;
      if (b && b.status === 'ENTRADA') {
        const k = asset.name + '|' + b.name + '|' + b.dir;
        if (!out.alerted[k]) {
          out.alerted[k] = now;
          out.history.unshift({ t: now, candle: s.updated, asset: asset.name, setup: b.name, dir: b.dir, score: b.score, digits: s.digits,
            entry: b.entry, sl: b.sl, tp1: b.tp1, tp2: b.tp2, tp3: b.tp3, triggered: b.triggered });
          const fx = (x) => (x == null ? '—' : x.toFixed(s.digits));
          const sent = await notify(fetchFn, topic, 'ENTRADA ' + b.dir.toUpperCase() + ' ' + asset.name + ' (score ' + b.score + ')',
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
  out.history = out.history.slice(0, HISTORY_MAX);
  fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify(out));
  log('Requisições Twelve Data:', out.requests, '| erros:', Object.keys(out.errors).length);
  return out;
}

module.exports = { runScan, needsFetch, summarize };

if (require.main === module) {
  const dir = process.argv[2] || 'dados';
  runScan({ dir, key: process.env.TD_KEY, topic: (process.env.NTFY_TOPIC || '').trim() })
    .then((o) => { if (o.assets.length === 0) process.exit(1); })
    .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
