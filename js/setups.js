/* Setups, score e classificação. Tudo determinístico: mesmas velas -> mesmo resultado.
   Setups do MVP: (1) Pullback na tendência  (2) Rompimento com reteste.
   Score 0-100: alinhamento 30 | zona/nível 20 | momento 15 | R:R 15 | volatilidade 10 | sessão 10. */
(function (MA) {
  'use strict';
  const { lastValid } = MA.an;
  const last = (a) => a[a.length - 1];
  const sgn = (dir) => (dir === 'compra' ? 1 : -1);
  const opposite = (b) => (b === 'alta' ? 'baixa' : 'alta');
  const want = (dir) => (dir === 'compra' ? 'alta' : 'baixa');

  function alignment(dir, tf) {
    const w = want(dir), b = [tf.D1.bias.dir, tf.H4.bias.dir];
    if (b.includes(opposite(w))) return { pts: 0, text: 'D1/H4 contra a direção' };
    const n = b.filter((x) => x === w).length;
    if (n === 2) return { pts: 30, text: 'D1 e H4 alinhados (' + w + ')' };
    if (n === 1) return { pts: 18, text: 'Um de D1/H4 em ' + w + ', outro neutro' };
    return { pts: 8, text: 'D1 e H4 neutros' };
  }

  function rsiTrigger(dir, rsi) {
    const n = rsi.length, now = rsi[n - 1], prev = rsi[n - 2];
    const win = rsi.slice(-9, -1);
    if (dir === 'compra') return Math.min(...win) < 30 && now > 30 && now > prev;
    return Math.max(...win) > 70 && now < 70 && now < prev;
  }

  function momentum(dir, m15, triggerOk) {
    const s = sgn(dir), h = m15.ind.macdHist, n = h.length;
    let pts = triggerOk ? 8 : 0;
    const txt = [];
    if (triggerOk) txt.push('RSI M15 saindo de ' + (dir === 'compra' ? 'sobrevenda' : 'sobrecompra'));
    if (s * h[n - 1] > 0 && s * (h[n - 1] - h[n - 2]) > 0) { pts += 7; txt.push('MACD M15 a favor e acelerando'); }
    else if (s * (h[n - 1] - h[n - 2]) > 0) { pts += 4; txt.push('Histograma MACD M15 virando a favor'); }
    return { pts, txt };
  }

  function rrPts(rr) { return rr >= 3 ? 15 : rr >= 2 ? 11 : rr >= 1.5 ? 7 : rr >= 1 ? 3 : 0; }

  function volatility(h1) {
    const a = h1.ind.atr.filter((x) => !Number.isNaN(x)).slice(-100).sort((x, y) => x - y);
    const med = a[Math.floor(a.length / 2)], ratio = h1.atr / med;
    if (ratio >= 0.7 && ratio <= 1.8) return { pts: 10, ratio, text: 'Volatilidade normal (ATR H1 ' + ratio.toFixed(2) + '× a mediana)' };
    if (ratio >= 0.5 && ratio <= 2.5) return { pts: 5, ratio, text: 'Volatilidade ' + (ratio < 1 ? 'baixa' : 'alta') + ' (' + ratio.toFixed(2) + '×)' };
    return { pts: 0, ratio, text: 'Volatilidade fora do normal (' + ratio.toFixed(2) + '×)' };
  }

  function sessionPts(asset, ses) {
    if (ses.good) return { pts: 10, text: 'Sessão ' + ses.label };
    if (ses.active.includes('Ásia') && /JPY|AUD|XAU/.test(asset.name)) return { pts: 5, text: 'Sessão asiática (ativo ligado à Ásia)' };
    return { pts: 0, text: ses.label + ' — evitar gatilho em M15' };
  }

  function zoneQuality(area) {
    if (area.kind === 'zona') {
      const t = area.tests;
      return t === 0 ? 20 : t === 1 ? 16 : t === 2 ? 11 : 6;
    }
    const t = area.touches;
    return t >= 4 ? 18 : t === 3 ? 15 : t === 2 ? 11 : 6;
  }

  /* Áreas candidatas para pullback: zonas de demanda/oferta e S/R de H1 do lado certo do preço. */
  function pullbackAreas(dir, h1, price) {
    const s = sgn(dir), a = h1.atr, out = [];
    for (const z of h1.zones) {
      if (z.type !== (dir === 'compra' ? 'demanda' : 'oferta')) continue;
      const proximal = dir === 'compra' ? z.high : z.low, distal = dir === 'compra' ? z.low : z.high;
      if (s * (price - distal) < 0) continue; // preço já além da zona
      out.push({ kind: 'zona', low: z.low, high: z.high, proximal, distal, tests: z.tests, t: z.t,
        desc: 'Zona de ' + z.type + ' H1 (' + (z.tests === 0 ? 'nunca testada' : z.tests + ' teste(s)') + ')' });
    }
    for (const l of h1.levels) {
      if (l.touches < 2) continue;
      if (s * (price - l.price) < -0.25 * a) continue;
      const low = l.price - 0.25 * a, high = l.price + 0.25 * a;
      out.push({ kind: 'nivel', low, high, proximal: dir === 'compra' ? high : low, distal: dir === 'compra' ? low : high,
        touches: l.touches, price: l.price, desc: (dir === 'compra' ? 'Suporte' : 'Resistência') + ' H1 (' + l.touches + ' toques)' });
    }
    for (const ar of out) ar.distAtr = Math.max(0, s * (price - ar.proximal)) / a;
    return out.sort((x, y) => x.distAtr - y.distAtr);
  }

  function setupPullback(dir, ctx) {
    const { tf, price } = ctx, h1 = tf.H1, m15 = tf.M15, a = h1.atr, s = sgn(dir);
    const al = alignment(dir, tf);
    if (al.pts < 18) return null; // pullback exige tendência
    const area = pullbackAreas(dir, h1, price)[0];
    if (!area || area.distAtr > 3) return null;
    const recent = m15.candles.slice(-8);
    const touched = dir === 'compra'
      ? Math.min(...recent.map((k) => k.l)) <= area.high + 0.1 * a
      : Math.max(...recent.map((k) => k.h)) >= area.low - 0.1 * a;
    const held = s * (price - area.distal) > 0;
    const trig = rsiTrigger(dir, m15.ind.rsi);
    const conf = [al.text, area.desc];
    if (touched && held) conf.push('Preço testou a área e segue acima/abaixo do lado distal');
    return {
      name: 'Pullback na tendência', dir, area, align: al,
      inArea: touched && held, rsiOk: trig,
      triggered: touched && held && trig,
      entryWatch: area.proximal, invalidation: area.distal, conf,
    };
  }

  function setupBreakout(dir, ctx) {
    const { tf, price } = ctx, h1 = tf.H1, m15 = tf.M15, c = h1.candles, s = sgn(dir);
    const atrArr = h1.ind.atr, a = h1.atr;
    let best = null;
    for (const l of h1.levels) {
      if (l.touches < 2) continue;
      const L = l.price;
      for (let j = c.length - 1; j >= Math.max(1, c.length - 24); j--) {
        const k = c[j], p = c[j - 1], rng = k.h - k.l, body = Math.abs(k.c - k.o);
        const crossed = s * (p.c - L) <= 0 && s * (k.c - L) > 0;
        if (!crossed || body < 0.6 * rng || rng < 1.0 * atrArr[j] || s * (k.c - k.o) <= 0) continue;
        const failed = c.slice(j + 1).some((x) => s * (x.c - L) < -0.3 * a);
        if (failed) break;
        if (!best || j > best.j) best = { j, L, touches: l.touches, t: k.t };
        break;
      }
    }
    if (!best) return null;
    const L = best.L;
    if (s * (price - L) < -0.3 * a) return null;
    const recent = m15.candles.slice(-4), lk = last(m15.candles);
    const retested = dir === 'compra' ? Math.min(...recent.map((k) => k.l)) <= L + 0.25 * a : Math.max(...recent.map((k) => k.h)) >= L - 0.25 * a;
    const confirm = s * (lk.c - L) > 0 && s * (lk.c - lk.o) > 0;
    const al = alignment(dir, tf);
    const area = { kind: 'nivel', low: L - 0.25 * a, high: L + 0.25 * a, price: L, touches: best.touches,
      proximal: L, distal: L - s * 0.3 * a, distAtr: Math.max(0, s * (price - L)) / a,
      desc: 'Nível H1 rompido (' + best.touches + ' toques) com vela forte' };
    return {
      name: 'Rompimento com reteste', dir, area, align: al, breakT: best.t,
      inArea: retested, rsiOk: s * (last(m15.ind.rsi) - 50) > 0,
      triggered: retested && confirm,
      entryWatch: L, invalidation: L - s * 0.3 * a,
      conf: [al.text, area.desc].concat(retested ? ['Reteste em M15' + (confirm ? ' com vela de confirmação' : ' (aguardando confirmação)')] : []),
    };
  }

  function levelsAhead(dir, ctx, entry, htf) {
    const s = sgn(dir), { tf, period } = ctx, out = [];
    const src = htf ? [tf.H4, tf.D1] : [tf.H1];
    for (const t of src) {
      for (const l of t.levels) out.push(l.price);
      for (const z of t.zones) if (z.type === (dir === 'compra' ? 'oferta' : 'demanda')) out.push(dir === 'compra' ? z.low : z.high);
    }
    if (!htf) for (const k of ['pdh', 'pdl', 'pwh', 'pwl']) if (period[k] != null) out.push(period[k]);
    return out.filter((p) => s * (p - entry) > 0);
  }

  /* Níveis fortes contrários à operação: S/R H1 com 4+ toques, S/R H4 com 3+ toques, máx/mín do dia e da semana. */
  function strongObstacles(dir, ctx, entry) {
    const s = sgn(dir), out = [];
    for (const l of ctx.tf.H1.levels) if (l.touches >= 4) out.push({ price: l.price, desc: 'H1 ' + l.price.toFixed(2) + ', ' + l.touches + ' toques' });
    for (const l of ctx.tf.H4.levels) if (l.touches >= 3) out.push({ price: l.price, desc: 'H4 ' + l.price.toFixed(2) + ', ' + l.touches + ' toques' });
    const names = { pdh: 'máxima de ontem', pdl: 'mínima de ontem', pwh: 'máxima da semana passada', pwl: 'mínima da semana passada' };
    for (const k in names) if (ctx.period[k] != null) out.push({ price: ctx.period[k], desc: names[k] + ' ' + ctx.period[k].toFixed(2) });
    return out.filter((o) => s * (o.price - entry) > 0);
  }

  function evaluate(setup, ctx, asset, settings) {
    const { tf, price, session } = ctx;
    const entry = setup.triggered ? price : setup.entryWatch;
    const plan = MA.risk.sltp({
      dir: setup.dir, entry, invalidation: setup.invalidation, atr: tf.H1.atr,
      levelsAhead: levelsAhead(setup.dir, ctx, entry, false),
      htfLevelsAhead: levelsAhead(setup.dir, ctx, entry, true),
      risk: settings.risk,
    });
    const mom = momentum(setup.dir, tf.M15, setup.name.startsWith('Pullback') ? setup.rsiOk : false);
    if (setup.name.startsWith('Rompimento') && setup.rsiOk) { mom.pts = Math.min(15, mom.pts + 8); mom.txt.unshift('RSI M15 do lado do rompimento'); }
    const vol = volatility(tf.H1), ses = sessionPts(asset, session);
    const zq = zoneQuality(setup.area);
    const breakdown = {
      alinhamento: setup.align.pts, zona: zq, momento: Math.min(15, mom.pts), rr: rrPts(plan.rrNext), volatilidade: vol.pts, sessao: ses.pts,
    };
    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const sc = settings.score;
    // Travas de ENTRADA: score alto não basta. Sem espaço até o alvo, fora de Londres/NY ou operando
    // contra um nível forte logo à frente, o sinal fica no máximo em OBSERVAR.
    const s = sgn(setup.dir);
    const strong = strongObstacles(setup.dir, ctx, entry)
      .map((o) => ({ ...o, r: s * (o.price - entry) / plan.R }))
      .filter((o) => o.r > 0 && o.r < 1.5)
      .sort((a, b) => a.r - b.r);
    const blocks = [];
    if (!session.good) blocks.push('fora das sessões de Londres/Nova York (' + session.label + ')');
    if (plan.rrNext < 1) blocks.push('o próximo nível contrário está a só ' + plan.rrNext.toFixed(2) + 'R (o risco é maior que o caminho livre)');
    if (strong.length) blocks.push((setup.dir === 'venda' ? 'suporte' : 'resistência') + ' forte (' + strong[0].desc + ') a ' + strong[0].r.toFixed(2) + 'R da entrada');
    let status = 'SEM SETUP';
    if (setup.triggered && score >= sc.entryMin && !blocks.length) status = 'ENTRADA';
    else if (score >= sc.watchMin || setup.area.distAtr <= 1.5) status = 'OBSERVAR';
    if (setup.align.pts === 0 && status !== 'SEM SETUP' && score < sc.watchMin) status = 'SEM SETUP';
    const size = MA.risk.positionSize({ entry: plan.entry, sl: plan.sl, pip: asset.pip, pipValue: asset.pipValue, accountSize: settings.accountSize, riskPct: settings.riskPct });
    const warnings = [...plan.notes];
    if (setup.triggered && blocks.length) warnings.unshift('Gatilho ocorreu, mas ENTRADA bloqueada: ' + blocks.join('; ') + '.');
    if (ses.pts === 0) warnings.push(ses.text);
    if (vol.pts === 0) warnings.push(vol.text);
    if (plan.rrNext < 1.5) warnings.push('Pouco espaço até o próximo nível contrário (R:R ' + plan.rrNext.toFixed(2) + ').');
    return {
      ...setup, entry, plan, size, score, breakdown, status,
      confirmations: setup.conf.concat(mom.txt, vol.pts > 0 ? [vol.text] : [], ses.pts > 0 ? [ses.text] : []),
      warnings,
    };
  }

  /* Análise completa de um ativo a partir das velas {M15,H1,H4,D1}. */
  function analyzeAsset(asset, data, settings, nowSec = Date.now() / 1000) {
    const cfg = settings.indicators, tf = {};
    for (const k of ['D1', 'H4', 'H1', 'M15']) {
      if (!data[k] || data[k].length < 60) throw new Error('Poucas velas em ' + k + ' para ' + asset.name);
      tf[k] = MA.an.analyzeTF(data[k], cfg);
    }
    const ctx = { tf, price: tf.M15.price, period: MA.an.periodLevels(data.D1, nowSec), session: MA.an.sessions(nowSec) };
    const candidates = [];
    for (const dir of ['compra', 'venda']) {
      for (const fn of [setupPullback, setupBreakout]) {
        const s = fn(dir, ctx);
        if (s) candidates.push(evaluate(s, ctx, asset, settings));
      }
    }
    const rank = { ENTRADA: 2, OBSERVAR: 1, 'SEM SETUP': 0 };
    candidates.sort((a, b) => rank[b.status] - rank[a.status] || b.score - a.score);
    const best = candidates[0] || null;
    return {
      asset: asset.name, digits: asset.digits, price: ctx.price, updated: last(data.M15).t,
      bias: { D1: tf.D1.bias, H4: tf.H4.bias, H1: tf.H1.bias, M15: tf.M15.bias },
      rsi: { H1: lastValid(tf.H1.ind.rsi), M15: lastValid(tf.M15.ind.rsi) },
      atr: { H1: tf.H1.atr, M15: tf.M15.atr },
      divergence: { H1: tf.H1.divergence, H4: tf.H4.divergence },
      session: ctx.session, period: ctx.period, tf, best, candidates,
      status: best ? best.status : 'SEM SETUP', score: best ? best.score : 0,
    };
  }

  /* "Calcular SL/TP para minha entrada": invalidação = swing H1 mais próximo além da entrada. */
  function planForEntry(result, asset, settings, dir, entry) {
    const s = sgn(dir), h1 = result.tf.H1;
    const sw = h1.swings.filter((x) => x.type === (dir === 'compra' ? 'L' : 'H') && s * (entry - x.price) > 0.2 * h1.atr);
    sw.sort((a, b) => s * (b.price - a.price));
    const inval = sw.length ? sw[0].price : null;
    const ctx = { tf: result.tf, period: result.period };
    const plan = MA.risk.sltp({ dir, entry, invalidation: inval, atr: h1.atr,
      levelsAhead: levelsAhead(dir, ctx, entry, false), htfLevelsAhead: levelsAhead(dir, ctx, entry, true), risk: settings.risk });
    const size = MA.risk.positionSize({ entry, sl: plan.sl, pip: asset.pip, pipValue: asset.pipValue, accountSize: settings.accountSize, riskPct: settings.riskPct });
    return { plan, size, invalidation: inval };
  }

  MA.setups = { analyzeAsset, planForEntry, alignment, rsiTrigger, pullbackAreas };
})(globalThis.MA = globalThis.MA || {});
