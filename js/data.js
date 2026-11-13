/* Fonte de dados: Twelve Data (plano grátis: 8 req/min, 800 req/dia).
   Velas no formato {t (segundos UTC, abertura), o, h, l, c}, ordem crescente, SOMENTE velas fechadas. */
(function (MA) {
  'use strict';
  const INTERVAL = { M15: '15min', H1: '1h', D1: '1day' };
  const TF_SEC = { M15: 900, H1: 3600, H4: 14400, D1: 86400 };
  const PER_MIN = 7;           // margem abaixo do limite de 8/min
  const MIN_CACHE_SEC = 300;   // não rebusca antes de 5 min (fins de semana, mercado fechado)
  const calls = [];            // timestamps (ms) das últimas chamadas

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function throttle(onWait) {
    for (;;) {
      const now = Date.now();
      while (calls.length && now - calls[0] > 60000) calls.shift();
      if (calls.length < PER_MIN) { calls.push(now); return; }
      const wait = 60000 - (now - calls[0]) + 250;
      if (onWait) onWait(Math.ceil(wait / 1000));
      await sleep(Math.min(wait, 1000));
    }
  }

  function parseTime(s) {
    const iso = s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z';
    return Math.floor(Date.parse(iso) / 1000);
  }

  /* Converte resposta da API e descarta a vela ainda aberta. */
  function parse(json, tf, nowSec = Date.now() / 1000) {
    if (!json || json.status === 'error') {
      const err = new Error((json && json.message) || 'Resposta inválida do Twelve Data');
      err.code = json && json.code;
      throw err;
    }
    const c = (json.values || []).map((v) => ({
      t: parseTime(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close,
    })).filter((k) => [k.o, k.h, k.l, k.c].every(Number.isFinite));
    c.sort((a, b) => a.t - b.t);
    const dedup = c.filter((k, i) => i === 0 || k.t !== c[i - 1].t);
    while (dedup.length && dedup[dedup.length - 1].t + TF_SEC[tf] > nowSec) dedup.pop();
    return dedup;
  }

  /* Agrupa velas em um timeframe maior (ex.: H1 -> H4). Descarta o último grupo se incompleto. */
  function resample(c, tfSec, srcSec, nowSec = Date.now() / 1000) {
    const out = [];
    for (const k of c) {
      const b = Math.floor(k.t / tfSec) * tfSec;
      const last = out[out.length - 1];
      if (last && last.t === b) {
        last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last._end = k.t + srcSec;
      } else out.push({ t: b, o: k.o, h: k.h, l: k.l, c: k.c, _end: k.t + srcSec });
    }
    // último grupo está completo se a última vela menor fecha no fim do grupo, ou se o horário do grupo já passou
    if (out.length) {
      const last = out[out.length - 1];
      const end = last.t + tfSec;
      if (last._end < end && nowSec < end) out.pop();
    }
    return out.map(({ _end, ...k }) => k);
  }

  function clearCache() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('ma.c.') || k.startsWith('ma.ai.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
  }

  function cacheKey(symbol, tf) { return 'ma.c.' + symbol + '.' + tf; }

  function readCache(symbol, tf) {
    try {
      const raw = localStorage.getItem(cacheKey(symbol, tf));
      if (!raw) return null;
      const o = JSON.parse(raw);
      return { fetchedAt: o.f, candles: o.d.map(([t, op, h, l, cl]) => ({ t, o: op, h, l, c: cl })) };
    } catch (e) { return null; }
  }

  function writeCache(symbol, tf, candles) {
    try {
      localStorage.setItem(cacheKey(symbol, tf), JSON.stringify({
        f: Math.floor(Date.now() / 1000), d: candles.map((k) => [k.t, k.o, k.h, k.l, k.c]),
      }));
    } catch (e) { /* cota cheia ou storage bloqueado: segue sem cache */ }
  }

  /* Cache válido enquanto nenhuma vela nova pode ter fechado desde a busca. */
  function isFresh(entry, tf, nowSec = Date.now() / 1000) {
    if (!entry || !entry.candles.length) return false;
    const last = entry.candles[entry.candles.length - 1];
    const nextClose = last.t + 2 * TF_SEC[tf];
    return nowSec < nextClose || nowSec - entry.fetchedAt < MIN_CACHE_SEC;
  }

  async function fetchSeries(symbol, tf, opts) {
    const { key, size, onWait, force, cacheOnly } = opts;
    const cached = readCache(symbol, tf);
    if (cacheOnly) { if (cached) return cached.candles; throw new Error('sem cache'); }
    if (!force && isFresh(cached, tf)) return cached.candles;
    if (!key) throw new Error('Configure a chave do Twelve Data em Configurações.');
    await throttle(onWait);
    const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(symbol) +
      '&interval=' + INTERVAL[tf] + '&outputsize=' + size + '&timezone=UTC&order=asc&apikey=' + encodeURIComponent(key);
    let json;
    try {
      json = await (await fetch(url)).json();
    } catch (e) {
      if (cached) return cached.candles;
      throw new Error('Falha de rede ao buscar ' + symbol + ' ' + tf);
    }
    if (json && json.code === 429) { // limite por minuto estourado: espera e tenta uma vez
      if (onWait) onWait(60);
      await sleep(61000);
      json = await (await fetch(url)).json();
    }
    const candles = parse(json, tf);
    writeCache(symbol, tf, candles);
    return candles;
  }

  /* Busca M15, H1, D1 e monta H4 a partir do H1. 3 requisições por ativo (ou 0, se em cache). */
  async function getAll(asset, settings, onWait, force, cacheOnly) {
    const key = settings.tdKey;
    const sz = settings.candles;
    const o = (size) => ({ key, size, onWait, force, cacheOnly });
    const M15 = await fetchSeries(asset.td, 'M15', o(sz.M15));
    const H1 = await fetchSeries(asset.td, 'H1', o(sz.H1));
    const D1 = await fetchSeries(asset.td, 'D1', o(sz.D1));
    const H4 = resample(H1, TF_SEC.H4, TF_SEC.H1);
    return { M15, H1, H4, D1 };
  }

  MA.data = { parse, resample, isFresh, getAll, clearCache, TF_SEC };
})(globalThis.MA = globalThis.MA || {});
