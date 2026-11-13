/* Gráfico (TradingView Lightweight Charts v4) + camada de zonas desenhada em canvas. */
(function (MA) {
  'use strict';
  let chart = null, rsiChart = null, candleSeries = null, overlayState = null, ro = null;

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(t, withDate = true) {
    const d = new Date(t * 1000);
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return withDate ? pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hm : hm;
  }

  function baseOptions() {
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: css('--panel') }, textColor: css('--muted'), fontSize: 11 },
      grid: { vertLines: { color: css('--line') + '55' }, horzLines: { color: css('--line') + '55' } },
      rightPriceScale: { borderColor: css('--line') },
      timeScale: {
        borderColor: css('--line'), timeVisible: true, secondsVisible: false, rightOffset: 8,
        tickMarkFormatter: (t, type) => {
          const d = new Date(t * 1000);
          if (type <= 1) return pad(d.getMonth() + 1) + '/' + d.getFullYear();
          if (type === 2) return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
          return pad(d.getHours()) + ':' + pad(d.getMinutes());
        },
      },
      localization: { locale: 'pt-BR', timeFormatter: (t) => fmtTime(t) },
      crosshair: { mode: 0 },
    };
  }

  function destroy() {
    if (ro) { ro.disconnect(); ro = null; }
    if (chart) { chart.remove(); chart = null; }
    if (rsiChart) { rsiChart.remove(); rsiChart = null; }
    candleSeries = null; overlayState = null;
  }

  function firstIndexAtOrAfter(c, t) {
    let lo = 0, hi = c.length - 1, ans = c.length;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].t >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  }

  function drawOverlay() {
    const cv = document.getElementById('overlay');
    if (!cv || !chart || !overlayState) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const { zones, candles } = overlayState;
    const plotW = w - chart.priceScale('right').width();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, h); ctx.clip();
    for (const z of zones) {
      const idx = firstIndexAtOrAfter(candles, z.t);
      let x0 = idx >= candles.length ? null : chart.timeScale().logicalToCoordinate(idx);
      if (x0 == null || x0 < 0) x0 = 0;
      const y1 = candleSeries.priceToCoordinate(z.high), y2 = candleSeries.priceToCoordinate(z.low);
      if (y1 == null || y2 == null) continue;
      ctx.fillStyle = z.type === 'demanda' ? css('--demand') : css('--supply');
      const top = Math.min(y1, y2), hgt = Math.max(3, Math.abs(y2 - y1));
      ctx.fillRect(x0, top, plotW - x0, hgt);
      ctx.strokeStyle = z.type === 'demanda' ? css('--up') : css('--down');
      ctx.globalAlpha = 0.6; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, top + 0.5, plotW - x0 - 1, hgt - 1); ctx.globalAlpha = 1;
      ctx.fillStyle = z.type === 'demanda' ? css('--up') : css('--down');
      ctx.font = '10px system-ui';
      ctx.fillText((z.type === 'demanda' ? 'Demanda ' : 'Oferta ') + (z.tf || ''), x0 + 4, Math.min(y1, y2) + 11);
    }
    ctx.restore();
  }

  /* result: análise do ativo; tf: 'D1'|'H4'|'H1'|'M15'; plan: {entry,sl,tp1,tp2,tp3,dir} opcional. */
  function render(result, tf, plan, opts) {
    destroy();
    const LC = window.LightweightCharts;
    const el = document.getElementById('chart'), rsiEl = document.getElementById('rsi-chart');
    const a = result.tf[tf], c = a.candles, d = result.digits;
    const priceFormat = { type: 'price', precision: d, minMove: Math.pow(10, -d) };

    chart = LC.createChart(el, baseOptions());
    candleSeries = chart.addCandlestickSeries({
      upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down'),
      borderVisible: false, priceFormat,
    });
    candleSeries.setData(c.map((k) => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c })));

    if (opts.ema) {
      const line = (arr, color) => {
        const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat });
        s.setData(c.map((k, i) => (Number.isNaN(arr[i]) ? { time: k.t } : { time: k.t, value: arr[i] })));
      };
      line(a.ind.emaFast, '#f0b429'); line(a.ind.emaSlow, '#a371f7');
    }

    const pl = (price, color, title, style = LC.LineStyle.Dashed, width = 1) => price != null && candleSeries.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });

    // níveis: D1/H4 mostram os próprios; H1/M15 mostram os de H1 (TF de estrutura)
    const lvSrc = tf === 'D1' || tf === 'H4' ? result.tf[tf] : result.tf.H1;
    if (opts.levels) {
      for (const l of lvSrc.levels) pl(l.price, css('--muted'), (l.kind === 'S' ? 'S' : 'R') + l.touches, LC.LineStyle.Dotted);
      const p = result.period;
      pl(p.pdh, '#6e7681', 'PDH', LC.LineStyle.SparseDotted); pl(p.pdl, '#6e7681', 'PDL', LC.LineStyle.SparseDotted);
      pl(p.pwh, '#6e7681', 'PWH', LC.LineStyle.SparseDotted); pl(p.pwl, '#6e7681', 'PWL', LC.LineStyle.SparseDotted);
    }
    if (plan) {
      pl(plan.entry, css('--entry'), 'Entrada', LC.LineStyle.Solid, 2);
      pl(plan.sl, css('--sl'), 'SL', LC.LineStyle.Solid, 2);
      pl(plan.tp1, css('--tp'), 'TP1'); pl(plan.tp2, css('--tp'), 'TP2', LC.LineStyle.Solid, 1); pl(plan.tp3, css('--tp'), 'TP3');
    }

    // marcadores: swings recentes + setup
    const markers = [];
    for (const s of a.swings.slice(-12)) markers.push({ time: s.t, position: s.type === 'H' ? 'aboveBar' : 'belowBar', color: css('--muted'), shape: 'circle', size: 0.4 });
    const b = result.best;
    if (b && b.status !== 'SEM SETUP') {
      const buy = b.dir === 'compra';
      markers.push({ time: c[c.length - 1].t, position: buy ? 'belowBar' : 'aboveBar', color: buy ? css('--up') : css('--down'),
        shape: buy ? 'arrowUp' : 'arrowDown', text: (b.triggered ? 'GATILHO ' : 'OBSERVAR ') + b.dir });
      if (b.breakT) { const i = firstIndexAtOrAfter(c, b.breakT); if (i < c.length) markers.push({ time: c[i].t, position: buy ? 'belowBar' : 'aboveBar', color: css('--accent'), shape: 'square', text: 'Rompimento' }); }
    }
    markers.sort((x, y) => x.time - y.time);
    candleSeries.setMarkers(markers);

    const zones = !opts.zones ? [] : (tf === 'D1' || tf === 'H4' ? a.zones.map((z) => ({ ...z, tf })) : result.tf.H1.zones.map((z) => ({ ...z, tf: 'H1' })));
    overlayState = { zones, candles: c };

    // RSI
    rsiChart = LC.createChart(rsiEl, Object.assign(baseOptions(), { timeScale: Object.assign(baseOptions().timeScale, { visible: false }) }));
    const rs = rsiChart.addLineSeries({ color: '#a371f7', lineWidth: 1, priceLineVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
    rs.setData(c.map((k, i) => (Number.isNaN(a.ind.rsi[i]) ? { time: k.t } : { time: k.t, value: a.ind.rsi[i] })));
    rs.createPriceLine({ price: 70, color: css('--down'), lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: '70' });
    rs.createPriceLine({ price: 30, color: css('--up'), lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: '30' });
    rsiChart.priceScale('right').applyOptions({ minimumWidth: 70 });
    chart.priceScale('right').applyOptions({ minimumWidth: 70 });

    // sincroniza zoom/rolagem e redesenha zonas
    let syncing = false;
    const sync = (src, dst) => src.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return; syncing = true; dst.timeScale().setVisibleLogicalRange(r); syncing = false;
    });
    sync(chart, rsiChart); sync(rsiChart, chart);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(drawOverlay));
    chart.subscribeCrosshairMove(() => requestAnimationFrame(drawOverlay));
    ro = new ResizeObserver(() => requestAnimationFrame(drawOverlay)); ro.observe(el);

    const n = c.length, show = tf === 'D1' ? 120 : 160;
    chart.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 6 });
    requestAnimationFrame(drawOverlay);
    setTimeout(drawOverlay, 150);
  }

  MA.chart = { render, destroy, fmtTime };
})(globalThis.MA = globalThis.MA || {});
