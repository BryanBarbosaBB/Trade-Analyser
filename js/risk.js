/* SL, TPs e tamanho de posição. dir: 'compra' | 'venda'. */
(function (MA) {
  'use strict';

  /* levelsAhead / htfLevelsAhead: preços de níveis contrários (resistências na compra, suportes na venda). */
  function sltp({ dir, entry, invalidation, atr, levelsAhead = [], htfLevelsAhead = [], risk }) {
    const r = Object.assign({ slBufferAtr: 0.2, slMinAtr: 0.8, slMaxAtr: 2.5, tp2MinRR: 1.5, tp3RR: 3 }, risk || {});
    const s = dir === 'compra' ? 1 : -1;
    const notes = [];
    let dist = invalidation == null ? NaN : s * (entry - invalidation) + r.slBufferAtr * atr;
    if (!(dist > 0)) { dist = r.slMinAtr * atr; notes.push('Sem nível de invalidação válido: SL mínimo (' + r.slMinAtr + ' ATR).'); }
    if (dist < r.slMinAtr * atr) { dist = r.slMinAtr * atr; notes.push('SL ampliado para o mínimo de ' + r.slMinAtr + ' ATR.'); }
    if (dist > r.slMaxAtr * atr) { dist = r.slMaxAtr * atr; notes.push('SL limitado ao máximo de ' + r.slMaxAtr + ' ATR (dentro da zona de invalidação).'); }
    const R = dist;
    const sl = entry - s * R;
    const rrOf = (p) => s * (p - entry) / R;
    const ahead = levelsAhead.filter((p) => rrOf(p) > 0.1).sort((a, b) => rrOf(a) - rrOf(b));
    const htf = htfLevelsAhead.filter((p) => rrOf(p) > 0.1).sort((a, b) => rrOf(a) - rrOf(b));

    const tp1 = entry + s * R;
    const tp2Level = ahead.find((p) => rrOf(p) >= r.tp2MinRR);
    const tp2 = tp2Level != null ? tp2Level : entry + s * r.tp2MinRR * R;
    if (tp2Level == null) notes.push('Sem nível contrário com R:R ≥ ' + r.tp2MinRR + ': TP2 em ' + r.tp2MinRR + 'R.');
    const htfTp3 = htf.find((p) => rrOf(p) >= 2.5 && rrOf(p) <= 4.5 && rrOf(p) > rrOf(tp2));
    let tp3 = htfTp3 != null ? htfTp3 : entry + s * r.tp3RR * R;
    if (rrOf(tp3) <= rrOf(tp2)) tp3 = entry + s * Math.max(r.tp3RR, rrOf(tp2) + 1) * R;

    // R:R disponível até o próximo nível contrário (usado no score). Sem nível à frente = espaço livre (4R).
    const rrNext = ahead.length ? rrOf(ahead[0]) : 4;
    return { dir, entry, sl, tp1, tp2, tp3, R, rr: { tp1: 1, tp2: rrOf(tp2), tp3: rrOf(tp3) }, rrNext, notes };
  }

  /* Lote: risco em USD / (distância do SL em pips × valor do pip por lote). Arredonda para baixo em 0,01. */
  function positionSize({ entry, sl, pip, pipValue, accountSize, riskPct }) {
    const riskUsd = accountSize * riskPct / 100;
    const pips = Math.abs(entry - sl) / pip;
    if (!(pips > 0) || !(pipValue > 0)) return { lots: 0, riskUsd, pips };
    const lots = Math.floor((riskUsd / (pips * pipValue)) * 100 + 1e-9) / 100;
    return { lots, riskUsd, pips };
  }

  MA.risk = { sltp, positionSize };
})(globalThis.MA = globalThis.MA || {});
