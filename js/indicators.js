/* Indicadores técnicos (determinísticos). Suavizações de Wilder em RSI/ATR/ADX, como TradingView/MT5.
   Todas as funções recebem arrays de números e devolvem arrays do mesmo tamanho (NaN onde não há dado). */
(function (MA) {
  'use strict';
  const NaNs = (n) => new Array(n).fill(NaN);

  function ema(x, p) {
    const out = NaNs(x.length), a = 2 / (p + 1);
    let prev = NaN, started = false, count = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (Number.isNaN(v)) { if (started) out[i] = prev; continue; }
      prev = started ? a * v + (1 - a) * prev : v;
      started = true; count++;
      if (count >= p) out[i] = prev;
    }
    return out;
  }

  function sma(x, p) {
    const out = NaNs(x.length);
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      sum += x[i];
      if (i >= p) sum -= x[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  /* Média de Wilder (RMA): semente = média dos primeiros p valores válidos, depois prev += (v - prev)/p */
  function wilder(x, p) {
    const out = NaNs(x.length);
    let n = 0, sum = 0, prev = NaN;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (Number.isNaN(prev)) {
        if (Number.isNaN(v)) continue;
        sum += v; n++;
        if (n === p) { prev = sum / p; out[i] = prev; }
      } else {
        if (!Number.isNaN(v)) prev += (v - prev) / p;
        out[i] = prev;
      }
    }
    return out;
  }

  function rsi(close, p = 14) {
    const gain = NaNs(close.length), loss = NaNs(close.length);
    for (let i = 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      gain[i] = Math.max(d, 0); loss[i] = Math.max(-d, 0);
    }
    const g = wilder(gain, p), l = wilder(loss, p);
    return g.map((gv, i) => {
      const lv = l[i];
      if (Number.isNaN(gv)) return NaN;
      if (gv === 0 && lv === 0) return 50;
      if (lv === 0) return 100;
      return 100 - 100 / (1 + gv / lv);
    });
  }

  function trueRange(c) {
    return c.map((k, i) => {
      if (i === 0) return k.h - k.l;
      const pc = c[i - 1].c;
      return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    });
  }

  const atr = (c, p = 14) => wilder(trueRange(c), p);

  function macd(close, f = 12, s = 26, sig = 9) {
    const ef = ema(close, f), es = ema(close, s);
    const line = ef.map((v, i) => v - es[i]);
    const signal = ema(line, sig);
    return { macd: line, signal, hist: line.map((v, i) => v - signal[i]) };
  }

  function adx(c, p = 14) {
    const n = c.length, pdm = NaNs(n), mdm = NaNs(n), tr = NaNs(n);
    const trAll = trueRange(c);
    for (let i = 1; i < n; i++) {
      const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
      pdm[i] = up > dn && up > 0 ? up : 0;
      mdm[i] = dn > up && dn > 0 ? dn : 0;
      tr[i] = trAll[i];
    }
    const atr_ = wilder(tr, p), sp = wilder(pdm, p), sm = wilder(mdm, p);
    const pdi = sp.map((v, i) => 100 * v / atr_[i]);
    const mdi = sm.map((v, i) => 100 * v / atr_[i]);
    const dx = pdi.map((v, i) => {
      const s = v + mdi[i];
      return s === 0 || Number.isNaN(s) ? NaN : 100 * Math.abs(v - mdi[i]) / s;
    });
    return { adx: wilder(dx, p), pdi, mdi };
  }

  /* Calcula todos os indicadores de uma série de velas {t,o,h,l,c}. */
  function compute(c, cfg = {}) {
    const close = c.map((k) => k.c);
    const m = macd(close, ...(cfg.macd || [12, 26, 9]));
    const a = adx(c, cfg.adx || 14);
    return {
      emaFast: ema(close, cfg.emaFast || 50),
      emaSlow: ema(close, cfg.emaSlow || 200),
      rsi: rsi(close, cfg.rsi || 14),
      atr: atr(c, cfg.atr || 14),
      macd: m.macd, macdSignal: m.signal, macdHist: m.hist,
      adx: a.adx, pdi: a.pdi, mdi: a.mdi,
    };
  }

  MA.ind = { ema, sma, wilder, rsi, trueRange, atr, macd, adx, compute };
})(globalThis.MA = globalThis.MA || {});
