/* Configuração padrão. O usuário pode sobrescrever tudo na tela Configurações (salvo no navegador).
   td = símbolo no Twelve Data; pip = tamanho de 1 pip/ponto; pipValue = USD por pip por 1 lote padrão
   (aproximado; pares JPY/CAD variam com o câmbio — ajuste conforme sua corretora).
   NAS100/US30: o plano grátis do Twelve Data não tem os índices; usamos os ETFs QQQ/DIA como referência
   de tendência e estrutura. Os preços são do ETF, por isso o lote não é calculado (pipValue 0). */
(function (MA) {
  'use strict';

  MA.DEFAULT_ASSETS = [
    { name: 'XAUUSD', td: 'XAU/USD', pip: 0.1,    pipValue: 10,  digits: 2, enabled: true },
    { name: 'NAS100', td: 'QQQ',     pip: 0.01,   pipValue: 0,   digits: 2, enabled: true, proxy: 'ETF QQQ (preço ≠ índice)' },
    { name: 'US30',   td: 'DIA',     pip: 0.01,   pipValue: 0,   digits: 2, enabled: true, proxy: 'ETF DIA (preço ≠ índice)' },
    { name: 'GBPJPY', td: 'GBP/JPY', pip: 0.01,   pipValue: 6.5, digits: 3, enabled: true },
    { name: 'CADJPY', td: 'CAD/JPY', pip: 0.01,   pipValue: 6.5, digits: 3, enabled: true },
    { name: 'AUDJPY', td: 'AUD/JPY', pip: 0.01,   pipValue: 6.5, digits: 3, enabled: true },
    { name: 'EURJPY', td: 'EUR/JPY', pip: 0.01,   pipValue: 6.5, digits: 3, enabled: true },
    { name: 'USDJPY', td: 'USD/JPY', pip: 0.01,   pipValue: 6.5, digits: 3, enabled: true },
    { name: 'EURUSD', td: 'EUR/USD', pip: 0.0001, pipValue: 10,  digits: 5, enabled: true },
    { name: 'GBPUSD', td: 'GBP/USD', pip: 0.0001, pipValue: 10,  digits: 5, enabled: true },
    { name: 'AUDUSD', td: 'AUD/USD', pip: 0.0001, pipValue: 10,  digits: 5, enabled: true },
    { name: 'USDCAD', td: 'USD/CAD', pip: 0.0001, pipValue: 7.3, digits: 5, enabled: true },
    { name: 'BTCUSD', td: 'BTC/USD', pip: 1,      pipValue: 1,   digits: 1, enabled: false },
  ];

  MA.DEFAULT_SETTINGS = {
    tdKey: '',
    geminiKey: '',
    geminiModel: 'gemini-flash-latest',
    accountSize: 10000,
    riskPct: 1,
    risk: { slBufferAtr: 0.2, slMinAtr: 0.8, slMaxAtr: 2.5, tp2MinRR: 1.5, tp3RR: 3 },
    score: { entryMin: 75, watchMin: 55 },
    indicators: { emaFast: 50, emaSlow: 200, rsi: 14, atr: 14, adx: 14, macd: [12, 26, 9] },
    candles: { M15: 500, H1: 1200, D1: 400 }, // H4 é montado a partir do H1 (1200 H1 ≈ 300 H4)
    assets: MA.DEFAULT_ASSETS,
  };

  const KEY = 'ma.settings.v1';

  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    const s = Object.assign({}, structuredClone(MA.DEFAULT_SETTINGS), saved);
    // mescla ativos salvos com os padrão (mantém novos ativos adicionados no código)
    const byName = Object.fromEntries((saved.assets || []).map((a) => [a.name, a]));
    // migração: símbolos de índice que não existem no plano grátis voltam para o padrão (ETF)
    const OBSOLETE = { NAS100: ['NDX'], US30: ['DJI'] };
    s.assets = MA.DEFAULT_ASSETS.map((a) => {
      const sv = byName[a.name];
      if (sv && (OBSOLETE[a.name] || []).includes(sv.td)) return Object.assign({}, a, { enabled: sv.enabled });
      return Object.assign({}, a, sv || {});
    });
    return s;
  }

  /* Sem "lembrar neste aparelho", as chaves ficam só na memória da aba (não vão para o armazenamento). */
  function save(s) {
    const out = Object.assign({}, s);
    if (MA.auth && !MA.auth.remember()) { out.tdKey = ''; out.geminiKey = ''; }
    try { localStorage.setItem(KEY, JSON.stringify(out)); return true; } catch (e) { return false; }
  }

  MA.settings = { load, save };
})(globalThis.MA = globalThis.MA || {});
