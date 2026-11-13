/* Backtest: reproduz o motor vela a vela no histórico (sem olhar o futuro) e simula cada sinal.
   - A cada vela M15 fechada, o motor só enxerga velas já fechadas naquele instante.
   - Entrada no fechamento da vela do gatilho; custo = spread do ativo.
   - SL e alvo na mesma vela => conta como SL (conservador). Sem saída em 24h => fecha a mercado.
   Variantes de saída (todas medidas sobre o MESMO sinal):
     tp05 = alvo 0,5R | tp1 = alvo 1R | tp2 = TP2 do plano | tp3 = TP3 do plano
     parcial = metade no TP1, stop vai para a entrada, resto no TP2 */
(function (MA) {
  'use strict';
  const TF = { M15: 900, H1: 3600, H4: 14400, D1: 86400 };
  const WIN = { M15: 500, H1: 1200, H4: 300, D1: 400 };   // mesmas janelas da análise ao vivo
  const MAX_BARS = 96;                                    // 24h em M15
  const VARIANTS = ['tp05', 'tp1', 'tp2', 'tp3', 'parcial'];

  /* Quantidade de velas fechadas até o instante T (velas em ordem crescente). */
  function closedCount(c, T, sec) {
    let lo = 0, hi = c.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c[m].t + sec <= T) lo = m + 1; else hi = m; }
    return lo;
  }

  /* Simula uma saída a partir da vela seguinte ao sinal. Devolve {r, exitT, bars}. */
  function simulate(m15, i, sig, variant, costR) {
    const s = sig.dir === 'compra' ? 1 : -1, R = sig.R, e = sig.entry;
    const tgt = { tp05: e + s * 0.5 * R, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, parcial: sig.tp1 }[variant];
    let stop = sig.sl, banked = 0, half = false;
    const end = Math.min(m15.length - 1, i + MAX_BARS);
    for (let j = i + 1; j <= end; j++) {
      const k = m15[j];
      const hitSL = s > 0 ? k.l <= stop : k.h >= stop;
      const target = variant === 'parcial' && half ? sig.tp2 : tgt;
      const hitTP = s > 0 ? k.h >= target : k.l <= target;
      if (hitSL) {
        const r = half ? banked : -1;                      // após parcial o stop está na entrada
        return { r: r - costR, exitT: k.t + TF.M15, bars: j - i };
      }
      if (hitTP) {
        if (variant === 'parcial' && !half) { half = true; banked = 0.5; stop = e; continue; }
        const r = variant === 'parcial' ? banked + 0.5 * s * (sig.tp2 - e) / R : s * (target - e) / R;
        return { r: r - costR, exitT: k.t + TF.M15, bars: j - i };
      }
    }
    if (end <= i) return null;                              // sem velas futuras: sinal não avaliável
    const last = m15[end], open = s * (last.c - e) / R;
    const r = variant === 'parcial' && half ? banked + 0.5 * open : open;
    return { r: r - costR, exitT: last.t + TF.M15, bars: end - i, timeout: true };
  }

  /* Percorre o histórico e registra todo gatilho (com ou sem travas) e o resultado de cada variante. */
  function run(asset, full, settings, onProgress) {
    const H4full = MA.data.resample(full.H1, TF.H4, TF.H1, Infinity);
    const cfg = settings.indicators, cache = {}, signals = [];
    const lastSig = {};
    const m15 = full.M15;
    const startTime = Math.max(full.H1[Math.min(full.H1.length - 1, 300)].t, full.D1[Math.min(full.D1.length - 1, 210)].t);
    let i0 = Math.max(WIN.M15, closedCount(m15, startTime, 0));
    for (let i = i0; i < m15.length - 1; i++) {
      const T = m15[i].t + TF.M15;
      const data = {};
      for (const [k, src] of [['M15', m15], ['H1', full.H1], ['H4', H4full], ['D1', full.D1]]) {
        const n = k === 'M15' ? i + 1 : closedCount(src, T, TF[k]);
        data[k] = src.slice(Math.max(0, n - WIN[k]), n);
      }
      if (data.H4.length < 60 || data.D1.length < 60 || data.H1.length < 60) continue;
      const tf = { M15: MA.an.analyzeTF(data.M15, cfg) };
      for (const k of ['H1', 'H4', 'D1']) {
        const key = k + data[k][data[k].length - 1].t;
        if (!cache[key]) { for (const old in cache) if (old.startsWith(k)) delete cache[old]; cache[key] = MA.an.analyzeTF(data[k], cfg); }
        tf[k] = cache[key];
      }
      const res = MA.setups.analyzeFromTF(asset, tf, data, settings, T);
      for (const c of res.candidates) {
        if (!c.triggered) continue;
        const id = c.name + c.dir;
        if (lastSig[id] != null && i - lastSig[id] < 8) continue;   // mesmo gatilho repetido em velas seguidas
        lastSig[id] = i;
        const p = c.plan;
        const sig = { t: T, i, asset: asset.name, setup: c.name, dir: c.dir, score: c.score, status: c.status,
          sessionGood: res.session.good, rrNext: p.rrNext, entry: p.entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, tp3: p.tp3, R: p.R,
          align: c.breakdown.alinhamento, out: {} };
        const costR = (asset.spread || 0) / p.R;
        for (const v of VARIANTS) sig.out[v] = simulate(m15, i, sig, v, costR);
        if (sig.out.tp1) signals.push(sig);
      }
      if (onProgress && i % 250 === 0) onProgress((i - i0) / (m15.length - i0));
    }
    return signals;
  }

  /* Estatísticas de uma lista de sinais, com no máximo uma posição aberta por ativo ao mesmo tempo. */
  function stats(signals, variant, filter = () => true) {
    const busyUntil = {}, rs = [];
    for (const s of [...signals].sort((a, b) => a.t - b.t)) {
      if (!filter(s) || !s.out[variant]) continue;
      if (busyUntil[s.asset] && s.t < busyUntil[s.asset]) continue;
      busyUntil[s.asset] = s.out[variant].exitT;
      rs.push(s.out[variant].r);
    }
    let eq = 0, peak = 0, dd = 0, gp = 0, gl = 0;
    for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (r > 0) gp += r; else gl -= r; }
    const n = rs.length, wins = rs.filter((r) => r > 0).length;
    return { n, wins, winRate: n ? wins / n : 0, avgR: n ? eq / n : 0, totalR: eq, pf: gl ? gp / gl : (gp ? Infinity : 0), maxDD: dd };
  }

  /* "Aprendizado" honesto: escolhe filtro + saída no período de treino (70% inicial)
     e mede no período de teste (30% final), que a escolha nunca viu. */
  function optimize(signals, minTrades = 12) {
    if (!signals.length) return null;
    const ts = signals.map((s) => s.t).sort((a, b) => a - b);
    const cut = ts[Math.floor(ts.length * 0.7)];
    const train = signals.filter((s) => s.t < cut), test = signals.filter((s) => s.t >= cut);
    const grid = [];
    for (const minScore of [55, 65, 75])
      for (const session of [false, true])
        for (const minRR of [0, 1, 1.5])
          for (const align of [0, 18, 30])
            for (const v of VARIANTS) {
              const f = (s) => s.score >= minScore && (!session || s.sessionGood) && s.rrNext >= minRR && s.align >= align;
              const tr = stats(train, v, f);
              if (tr.n >= minTrades) grid.push({ minScore, session, minRR, align, variant: v, train: tr, filter: f });
            }
    grid.sort((a, b) => b.train.avgR - a.train.avgR);
    const best = grid[0];
    if (!best) return { cut, best: null };
    return { cut, best: { ...best, test: stats(test, best.variant, best.filter), filter: undefined } };
  }

  MA.backtest = { run, stats, optimize, simulate, VARIANTS };
})(globalThis.MA = globalThis.MA || {});
